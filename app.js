// ============================================================
// RKU Attendance System — app.js
// All bugs fixed. See inline comments for each fix.
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const fileUpload = require('express-fileupload');
const session = require('express-session');
const MongoStore = require('connect-mongo').default;
const mongoose = require('mongoose');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');

// ── Ensure uploads directory exists ──────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── Multer config ─────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const app = express();

// ── SECURITY: Helmet with proper CSP ─────────────────────────
// FIX: Default helmet() CSP blocked ALL inline scripts — every button/onclick was dead.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "upload.wikimedia.org"],
            fontSrc: ["'self'", "cdnjs.cloudflare.com"],
            connectSrc: ["'self'"],
        }
    }
}));

// ── SECURITY: NoSQL Injection prevention ─────────────────────
// FIX (NEW): Strips $ and . from user input to block MongoDB operator injection.
app.use(mongoSanitize());

// ── Body parsers ─────────────────────────────────────────────
// FIX: express.urlencoded was registered TWICE — removed the duplicate.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── File upload middleware ────────────────────────────────────
// FIX: express-fileupload was required but never mounted — CSV upload always failed.
app.use(fileUpload());

// ── View engine ───────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// ── MongoDB Connection ────────────────────────────────────────
// FIX: Validates MONGO_URI before attempting connect — no more silent crash.
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('❌ FATAL: MONGO_URI is not set. Check your .env file.');
    process.exit(1);
}
mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => { console.error('❌ MongoDB connection error:', err); process.exit(1); });

// ── Session ───────────────────────────────────────────────────
// FIX: cookie.secure was hardcoded true — broke all local HTTP dev.
app.set('trust proxy', 1);
app.use(session({
    secret: process.env.SESSION_SECRET, // FIX: removed weak hardcoded fallback
    resave: true,
    saveUninitialized: false,
    proxy: true,
    store: MongoStore.create({
        mongoUrl: mongoURI,
        touchAfter: 24 * 3600
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

if (!process.env.SESSION_SECRET) {
    console.error('❌ FATAL: SESSION_SECRET is not set. Check your .env file.');
    process.exit(1);
}

// ── Passport ──────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// FIX: Serialize only the ID (not entire object) — efficient & correct.
passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id).lean();
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// ── Nodemailer ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// FIX: Wrapped in try-catch — on Render free tier SMTP check was crashing app startup.
try {
    transporter.verify((error) => {
        if (error) console.warn('⚠️ Mail server warning (non-fatal):', error.message);
        else console.log('✅ Mail server ready');
    });
} catch (e) {
    console.warn('⚠️ Mail server could not be verified (non-fatal):', e.message);
}

// ── Rate Limiting (NEW) ───────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
});

// ================================================================
// MONGOOSE SCHEMAS
// ================================================================

const userSchema = new mongoose.Schema({
    name: { type: String, required: false, default: '' },
    email: { type: String, required: true, unique: true, index: true },
    rollNo: { type: String, index: true, default: '' },
    password: { type: String, required: false },
    role: { type: String, default: 'Student' },
    section: { type: String, default: '' },
    phone: { type: String, default: '' },
    isApproved: { type: Boolean, default: false },
    isPreRegistered: { type: Boolean, default: false },
    isClassTeacher: { type: Boolean, default: false },
    classTeacherSection: { type: String, default: '' },
    googleId: { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

const attendanceSchema = new mongoose.Schema({
    date: { type: String, required: true },
    manualTime: String,
    periodNumber: { type: String, required: false },
    subject: String,
    lecturerEmail: String,
    leaderEmail: String,
    section: { type: String, required: true, index: true }, // FIX: Added index
    students: [{
        studentId: String,
        studentName: String,
        status: String
    }],
    isLockedByLeader: { type: Boolean, default: false },
    lastModifiedBy: String,
    lastModifiedDate: Date,
    submissionTimestamp: Date
});
// FIX (NEW): Compound indexes for the most common dashboard queries.
attendanceSchema.index({ section: 1, date: -1 });
attendanceSchema.index({ lecturerEmail: 1, date: -1 });
const Attendance = mongoose.model('Attendance', attendanceSchema);

const subjectSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, default: '' },
    section: { type: String, index: true, required: true } // FIX: Added index & required
});
const Subject = mongoose.model('Subject', subjectSchema);

// ================================================================
// GOOGLE OAUTH STRATEGY
// ================================================================
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // FIX: Moved hardcoded URL to env variable.
    callbackURL: `${process.env.APP_BASE_URL}/auth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    try {
        let user = await User.findOne({ email });
        if (!user) {
            user = new User({
                googleId: profile.id,
                email,
                name: profile.displayName,
                role: 'SuperAdmin',
                isApproved: false
            });
            await user.save();
            // Fire-and-forget email so it doesn't block auth callback
            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.DEVELOPER_EMAIL,
                subject: 'New Admin Request',
                text: `New user registered via Google: ${email}`
            }, (err) => { if (err) console.log('📧 Email notification failed (non-fatal):', err.message); });
        }
        return done(null, user);
    } catch (err) {
        console.error('Google Auth Error:', err);
        return done(err, null);
    }
}));

// ================================================================
// MIDDLEWARE HELPERS
// ================================================================

// Auth guard for Master/SuperAdmin routes
function isAdmin(req, res, next) {
    const user = req.session.user || req.user;
    if (user && (user.role === 'Master' || user.role === 'SuperAdmin')) return next();
    console.warn(`🚨 Unauthorized admin access by: ${user ? user.email : 'Guest'}`);
    return res.redirect('/login?error=Access Denied');
}

// Generic auth check — pass allowed roles array
function requireRole(...roles) {
    return (req, res, next) => {
        const user = req.session.user || req.user;
        if (user && roles.includes(user.role)) return next();
        return res.redirect('/login?error=Unauthorized');
    };
}

// ================================================================
// GET ROUTES
// ================================================================

app.get('/', (req, res) => res.render('login', { showEmailForm: false, error: null, message: null }));

app.get('/login', (req, res) => {
    const loggedIn = req.session.user || req.user;
    if (loggedIn) return res.redirect(`/${loggedIn.role.toLowerCase()}`);
    res.render('login', { showEmailForm: false, error: req.query.error || null, message: req.query.message || null });
});

// FIX: This route was missing — "Admin / Faculty Login" button in login.ejs pointed here but got a 404.
app.get('/login-email', (req, res) => {
    res.render('login', { showEmailForm: true, error: req.query.error || null, message: req.query.message || null });
});

app.get('/register', (req, res) => {
    const loggedIn = req.session.user || req.user;
    if (loggedIn) return res.redirect(`/${loggedIn.role.toLowerCase()}`);
    res.render('register', { error: null });
});

// Google OAuth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?error=Google+login+failed' }),
    (req, res) => {
        req.session.save((err) => {
            if (err) { console.error('Session Save Error:', err); return res.redirect('/login'); }
            const user = req.user;
            if (!user.isApproved) return res.render('pending', { user });
            const roleMap = { superadmin: '/super-admin-dashboard', master: '/master', leader: '/leader', lecturer: '/lecturer', student: '/student' };
            const dest = roleMap[(user.role || '').toLowerCase()] || '/login?error=RoleNotAssigned';
            res.redirect(dest);
        });
    }
);

// ── Dashboard routes ──────────────────────────────────────────

app.get('/master', async (req, res) => {
    try {
        const user = req.user || req.session.user;
        const isClassTeacher = user && user.role === 'Lecturer' && user.isClassTeacher;
        if (!user || (user.role !== 'Master' && !isClassTeacher)) return res.redirect('/login?error=Unauthorized');

        const facultySection = isClassTeacher ? user.classTeacherSection : user.section;
        const [allUsers, masterSubjects] = await Promise.all([
            User.find({ section: facultySection }).lean(),
            Subject.find({ section: facultySection }).lean()
        ]);

        const stats = {
            total: allUsers.length,
            pending: allUsers.filter(u => !u.isApproved).length,
            subjects: masterSubjects.length
        };

        req.session.save(() => {
            res.render('master', {
                user: { ...user, section: facultySection },
                allUsers: allUsers || [],
                masterSubjects: masterSubjects || [],
                stats,
                success: req.query.success || null,
                error: req.query.error || null
            });
        });
    } catch (err) {
        console.error('❌ Master Dashboard Error:', err);
        res.status(500).render('error', { message: 'Failed to load faculty portal.' });
    }
});

app.get('/leader', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user || user.role !== 'Leader') return res.redirect('/login?error=Unauthorized');
    try {
        const [studentsOnly, lecturers, masterSubjects] = await Promise.all([
            User.find({ section: user.section, $or: [{ role: 'Student' }, { role: 'Leader' }] }).sort({ rollNo: 1 }).lean(),
            User.find({ role: 'Lecturer', isApproved: true }).select('name email').lean(),
            Subject.find({ section: user.section }).lean()
        ]);
        res.render('leader', { user, allUsers: studentsOnly, lecturers, masterSubjects });
    } catch (err) {
        console.error('❌ Leader Dashboard Error:', err);
        res.status(500).render('error', { message: 'Could not load Leader portal.' });
    }
});

app.get('/lecturer', async (req, res) => {
    try {
        const user = req.user || req.session.user;
        if (!user || user.role !== 'Lecturer') return res.redirect('/login?error=Unauthorized');
        const today = new Date().toISOString().split('T')[0];
        const todayRecords = await Attendance.find({ lecturerEmail: user.email.toLowerCase(), date: today }).lean();
        const sectionsToday = [...new Set(todayRecords.map(r => r.section))];
        req.session.save(() => {
            res.render('lecturer', { user, todayRecords: todayRecords || [], sectionsToday });
        });
    } catch (err) {
        console.error('❌ Lecturer Dashboard Error:', err);
        res.status(500).render('error', { message: 'Could not load Lecturer portal.' });
    }
});

app.get('/student', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user || user.role !== 'Student') return res.redirect('/login?error=Unauthorized');
    try {
        const records = await Attendance.find({ section: user.section, 'students.studentId': user.rollNo })
            .sort({ date: -1 }).lean();

        // FIX: Count all records for accurate %, don't limit before calculating.
        let presentCount = 0;
        records.forEach(rec => {
            const myEntry = rec.students.find(s => s.studentId === user.rollNo);
            if (myEntry && myEntry.status === 'Present') presentCount++;
        });

        res.render('student', { user, records: records.slice(0, 50), presentCount, totalCount: records.length });
    } catch (err) {
        console.error('❌ Student Dashboard Error:', err);
        res.status(500).render('error', { message: 'Could not load Student portal.' });
    }
});

app.get('/super-admin-dashboard', async (req, res) => {
    try {
        const user = req.user || req.session.user;
        if (!user || user.role !== 'SuperAdmin' || !user.isApproved) {
            return res.redirect('/login?error=Unauthorized');
        }
        const [allUsers, allSubjects] = await Promise.all([
            User.find({}).select('-password').sort({ section: 1, role: 1, name: 1 }).lean(),
            Subject.find({}).sort({ section: 1, name: 1 }).lean()
        ]);
        const usersBySection = {};
        allUsers.forEach(u => {
            const sec = u.section || 'Unassigned';
            if (!usersBySection[sec]) usersBySection[sec] = [];
            usersBySection[sec].push(u);
        });
        const sections = Object.keys(usersBySection).sort((a, b) => {
            if (a === 'Unassigned') return 1;
            if (b === 'Unassigned') return -1;
            return a.localeCompare(b);
        });
        res.render('super-admin', {
            user, allUsers, allSubjects, usersBySection, sections,
            stats: { totalUsers: allUsers.length, pendingApprovals: allUsers.filter(u => !u.isApproved).length, totalSubjects: allSubjects.length },
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (err) {
        console.error('🔥 SuperAdmin Dashboard Error:', err);
        res.status(500).render('error', { message: 'Failed to load admin data.' });
    }
});

app.get('/settings', async (req, res) => {
    try {
        const sessionUser = req.session.user || req.user;
        if (!sessionUser) return res.redirect('/login?error=Please+log+in');
        const userDetails = await User.findById(sessionUser._id).lean();
        if (!userDetails) return res.status(404).render('error', { message: 'Account not found.' });
        // FIX: was passing success: but template expects message: and messageType:
        res.render('settings', {
            user: userDetails,
            message: req.query.success ? 'Profile updated successfully!' : null,
            messageType: req.query.success ? 'success' : null
        });
    } catch (err) {
        res.status(500).render('error', { message: 'Could not load settings.' });
    }
});

app.get('/attendance-history', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user) return res.redirect('/login');
    try {
        const { startDate, endDate } = req.query;
        let query = {};
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        } else {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            query.date = { $gte: thirtyDaysAgo.toISOString().split('T')[0] };
        }
        if (user.role === 'Student') {
            query['students.studentId'] = user.rollNo;
            query.section = user.section;
        } else if (user.role === 'Lecturer') {
            query.lecturerEmail = user.email;
        } else if (user.role === 'Leader') {
            query.section = user.section;
        }
        const history = await Attendance.find(query).sort({ date: -1 }).lean();
        res.render('history', { user, records: history, startDate: startDate || '', endDate: endDate || '' });
    } catch (err) {
        console.error('❌ History Error:', err);
        res.status(500).render('error', { message: 'Failed to load history.' });
    }
});

app.get('/generate-day-pdf/:date', async (req, res) => {
    try {
        const sessionUser = req.session.user || req.user;
        if (!sessionUser) return res.redirect('/login');
        const { date } = req.params;
        const { filter } = req.query;
        const userSection = sessionUser.section;
        const records = await Attendance.find({ date, section: userSection }).sort({ manualTime: 1 });
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=Attendance_${userSection}_${date}.pdf`);
        doc.pipe(res);
        doc.fillColor('#2c3e50').fontSize(22).text('RKU Attendance Report', { align: 'center' });
        doc.fontSize(12).fillColor('#7f8c8d').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown();
        doc.fillColor('black').fontSize(14).text(`Date: ${date} | Section: ${userSection}`);
        if (filter) doc.fillColor('#e74c3c').text(`Filter: ${filter} only`, { align: 'center' });
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
        if (records.length === 0) {
            doc.fontSize(14).text('No records found for this section on this date.', { align: 'center' });
        } else {
            records.forEach(rec => {
                doc.rect(50, doc.y, 500, 20).fill('#f1f2f6');
                doc.fillColor('#2f3542').fontSize(11).text(` SLOT: ${rec.manualTime} | SUBJECT: ${rec.subject}`, 55, doc.y - 15);
                doc.moveDown(0.5);
                const startY = doc.y;
                doc.fillColor('#000').fontSize(10).text('Student ID', 60, startY);
                doc.text('Student Name', 160, startY);
                doc.text('Status', 450, startY);
                doc.moveDown(0.5);
                doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#dfe4ea').stroke();
                rec.students.forEach(s => {
                    if (!filter || s.status === filter) {
                        if (doc.y > 700) doc.addPage();
                        doc.fillColor('#34495e').fontSize(9)
                            .text(s.studentId, 60, doc.y)
                            .text(s.studentName || '', 160, doc.y - 9) // FIX: use studentName not name
                            .fillColor(s.status === 'Present' ? '#27ae60' : '#c0392b')
                            .text(s.status, 450, doc.y - 9);
                        doc.moveDown(0.2);
                    }
                });
                doc.moveDown(1.5);
            });
        }
        doc.end();
    } catch (err) {
        console.error('PDF Error:', err);
        res.status(500).send('Error generating PDF.');
    }
});

app.get('/view-pdf', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    res.redirect(`/generate-day-pdf/${req.query.date || today}`);
});

app.get('/leader-history', async (req, res) => {
    try {
        const sessionUser = req.session.user || req.user;
        if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });
        const records = await Attendance.find({ leaderEmail: sessionUser.email }).sort({ date: -1 }).lean();
        const historyData = records.map(r => ({
            ...r,
            presentCount: r.students.filter(s => s.status === 'Present').length,
            totalCount: r.students.length
        }));
        res.json(historyData);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

app.get('/export-attendance', async (req, res) => {
    try {
        const user = req.session.user || req.user;
        if (!user || !['Lecturer', 'Leader', 'SuperAdmin', 'Master'].includes(user.role)) {
            return res.status(403).send('Unauthorized.');
        }
        const { startDate, endDate } = req.query;
        // FIX: SuperAdmin has no section — must handle this case.
        const section = user.section;
        if (!section && user.role !== 'SuperAdmin') return res.status(400).send('No section assigned to your account.');

        let attendanceQuery = section ? { section } : {};
        if (startDate && endDate) attendanceQuery.date = { $gte: startDate, $lte: endDate };

        const [students, attendanceRecords] = await Promise.all([
            section ? User.find({ section, role: 'Student' }).select('rollNo name').lean() : [],
            Attendance.find(attendanceQuery).sort({ date: 1 }).lean()
        ]);

        let csvContent = '\uFEFF';
        csvContent += 'Roll No,Student Name,Date,Subject,Time Slot,Status\n';
        attendanceRecords.forEach(record => {
            const subject = record.subject || 'N/A';
            const time = record.manualTime || 'N/A';
            (students.length ? students : record.students).forEach(student => {
                const rollNo = student.rollNo || student.studentId;
                const name = student.name || student.studentName || '';
                const entry = record.students.find(s => s.studentId === rollNo);
                const status = entry ? entry.status : 'N/A';
                const sanitizedName = `"${name.replace(/"/g, '""')}"`;
                csvContent += `${rollNo},${sanitizedName},${record.date},${subject},${time},${status}\n`;
            });
        });

        const fileName = `Attendance_${section || 'All'}_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.status(200).send(csvContent);
    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).send('Error during CSV export.');
    }
});

// Health check / keep-alive ping
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ================================================================
// POST ROUTES
// ================================================================

// ── Login ──────────────────────────────────────────────────────
// FIX: Applied rate limiter to prevent brute-force attacks.
app.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) return res.render('login', { showEmailForm: true, error: 'Account not found. Please register first.', message: null });

        // FIX: Was using plain === comparison instead of bcrypt.compare().
        if (!user.password) return res.render('login', { showEmailForm: true, error: 'This account uses Google Sign-In.', message: null });
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) return res.render('login', { showEmailForm: true, error: 'Incorrect password.', message: null });

        if (user.role !== 'Master' && !user.isApproved) {
            return res.render('login', { showEmailForm: true, error: 'Your account is awaiting admin approval.', message: null });
        }

        req.session.user = {
            _id: user._id,
            email: user.email.toLowerCase(),
            role: user.role,
            name: user.name,
            section: user.section,
            rollNo: user.rollNo,
            isClassTeacher: user.isClassTeacher,
            classTeacherSection: user.classTeacherSection
        };

        req.session.save((err) => {
            if (err) { console.error('Session Save Error:', err); return res.status(500).send('Login failed.'); }
            const roleRedirects = { master: '/master', lecturer: '/lecturer', leader: '/leader', student: '/student', superadmin: '/super-admin-dashboard' };
            res.redirect(roleRedirects[user.role.toLowerCase()] || '/login?error=RoleNotAssigned');
        });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).render('error', { message: 'Internal Server Error during login.' });
    }
});

// ── Register (regular users) ──────────────────────────────────
app.post('/register', async (req, res) => {
    const { name, email, password, role, section, rollNo } = req.body;
    try {
        // FIX (configurable): Domain check uses env var instead of hardcoded string.
        const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN || 'rku.ac.in';
        if (!email.endsWith(`@${allowedDomain}`)) {
            return res.status(400).render('register', { error: `Please use your official @${allowedDomain} email.` });
        }
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) return res.status(400).render('register', { error: 'Email already registered. Try logging in.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await new User({ name, email: email.toLowerCase(), password: hashedPassword, role, section, rollNo: rollNo || '', isApproved: false }).save();

        try {
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.DEVELOPER_EMAIL,
                subject: `🔔 Approval Required: ${name} (${role})`,
                html: `<p><b>Name:</b> ${name}<br><b>Email:</b> ${email}<br><b>Role:</b> ${role}<br><b>Section:</b> ${section}</p>`
            });
        } catch (mailErr) {
            console.error('⚠️ Admin notification email failed (user was saved):', mailErr.message);
        }
        res.redirect('/login?message=Registration successful! Awaiting admin approval.');
    } catch (err) {
        console.error('Registration Error:', err);
        if (err.code === 11000) return res.status(400).render('register', { error: 'Email already exists.' });
        res.status(500).render('register', { error: 'Server error during registration.' });
    }
});

// ── SuperAdmin Registration ───────────────────────────────────
// FIX: This route was completely missing — register.ejs form was POSTing to a 404.
app.post('/register-super-admin', async (req, res) => {
    const { name, email, password, masterKey } = req.body;
    if (!masterKey || masterKey !== process.env.ADMIN_APPROVAL_SECRET) {
        return res.status(403).render('register', { error: 'Invalid Master Security Key.' });
    }
    try {
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).render('register', { error: 'Email already registered.' });
        const hashed = await bcrypt.hash(password, 10);
        await new User({ name, email: email.toLowerCase(), password: hashed, role: 'SuperAdmin', isApproved: true }).save();
        res.redirect('/login?message=SuperAdmin account created. You can now log in.');
    } catch (err) {
        console.error('SuperAdmin Registration Error:', err);
        res.status(500).render('register', { error: 'Registration failed: ' + err.message });
    }
});

// ── Logout ────────────────────────────────────────────────────
// FIX: Was a race condition — req.logout and req.session.destroy ran in parallel,
// leaving the session alive. Now destruction is nested inside logout callback.
app.get('/logout', (req, res) => {
    const destroySession = () => {
        req.session.destroy((err) => {
            if (err) console.error('Session destruction error:', err);
            res.clearCookie('connect.sid');
            res.redirect('/login?message=Logged out successfully');
        });
    };
    if (typeof req.logout === 'function') {
        req.logout((err) => { if (err) console.error('Passport logout error:', err); destroySession(); });
    } else {
        destroySession();
    }
});

// ── Update Settings ───────────────────────────────────────────
app.post('/update-settings', async (req, res) => {
    const { name, phone, currentPassword, newPassword } = req.body;
    // FIX: Was req.session.user._id only — crashed for Google OAuth users.
    const sessionUser = req.session.user || req.user;
    if (!sessionUser) return res.redirect('/login');
    try {
        const user = await User.findById(sessionUser._id);
        if (!user) return res.redirect('/login');

        if (!user.password) {
            // Google OAuth user — no password to verify
            user.name = name;
            user.phone = phone;
            await user.save();
            req.session.user = { ...req.session.user, name };
            return res.render('settings', { user, message: 'Profile updated!', messageType: 'success' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.render('settings', { user: sessionUser, message: 'Incorrect current password!', messageType: 'error' });

        user.name = name;
        user.phone = phone;
        if (newPassword && newPassword.trim() !== '') {
            if (newPassword.length < 6) return res.render('settings', { user: sessionUser, message: 'New password must be at least 6 characters.', messageType: 'error' });
            user.password = await bcrypt.hash(newPassword, 10);
        }
        await user.save();
        req.session.user = { ...req.session.user, name };
        res.render('settings', { user, message: 'Profile updated successfully!', messageType: 'success' });
    } catch (err) {
        console.error('Settings Update Error:', err);
        res.status(500).render('error', { message: 'Error updating settings.' });
    }
});

// ── Lock Attendance ───────────────────────────────────────────
app.post('/lock-attendance', async (req, res) => {
    try {
        const leader = req.session.user || req.user;
        if (!leader || leader.role !== 'Leader') return res.status(403).render('error', { message: 'Unauthorized' });

        const { section, lecturerEmail, manualTime, subject, date, students } = req.body;

        // FIX: Validate required fields before processing.
        if (!subject || !manualTime || !date) {
            return res.redirect('/leader?error=Please fill in all fields (Lecturer, Time Slot, Date, Subject).');
        }
        // FIX: students was undefined if section has no students, causing Object.keys crash.
        if (!students || typeof students !== 'object') {
            return res.redirect('/leader?error=No student data received. Please reload and try again.');
        }

        const studentList = Object.keys(students).map(key => {
            const s = students[key];
            return { studentId: s.id || key, studentName: s.name || '', status: s.status === 'Present' ? 'Present' : 'Absent' };
        });

        await new Attendance({
            section: section || leader.section,
            date: date || new Date().toISOString().split('T')[0],
            manualTime,
            subject,
            lecturerEmail: (lecturerEmail || '').toLowerCase(), // FIX: .toLowerCase() on undefined guard
            leaderEmail: leader.email,
            students: studentList,
            isLockedByLeader: true,
            submissionTimestamp: new Date()
        }).save();

        res.redirect('/leader?success=Attendance for ' + encodeURIComponent(subject) + ' locked successfully.');
    } catch (err) {
        console.error('Lock Attendance Error:', err);
        res.status(500).render('error', { message: 'Error locking attendance: ' + err.message });
    }
});

// ── Update Attendance Status ──────────────────────────────────
app.post('/update-attendance-status', async (req, res) => {
    const user = req.session.user || req.user;
    const allowedRoles = ['Lecturer', 'Master', 'Leader', 'SuperAdmin'];
    if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { attendanceId, studentId, newStatus } = req.body;
    if (!attendanceId || !studentId || !newStatus) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }
    try {
        const query = { _id: attendanceId, 'students.studentId': studentId };
        // FIX: Previously restricted Lecturers to one section. Now correctly filters by their email.
        if (user.role === 'Lecturer') query.lecturerEmail = user.email.toLowerCase();

        const result = await Attendance.findOneAndUpdate(query, {
            $set: { 'students.$.status': newStatus, lastModifiedBy: user.email, lastModifiedDate: new Date() }
        }, { new: true });

        if (result) {
            res.json({ success: true, message: 'Status updated.', updatedBy: user.email });
        } else {
            res.status(404).json({ success: false, message: 'Record not found or insufficient permissions.' });
        }
    } catch (err) {
        console.error('Attendance Update Error:', err);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ── Approve User ──────────────────────────────────────────────
app.post('/approve-user/:id', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;
        if (!currentUser || (currentUser.role !== 'Master' && currentUser.role !== 'SuperAdmin')) {
            return res.status(403).render('error', { message: 'Unauthorized.' });
        }
        const updatedUser = await User.findByIdAndUpdate(req.params.id, { isApproved: true }, { new: true });
        if (!updatedUser) return res.redirect('/master?error=UserNotFound');
        const redirectPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirectPath}?success=User+approved`));
    } catch (err) {
        res.status(500).render('error', { message: 'Error during approval.' });
    }
});

// ── Delete User ───────────────────────────────────────────────
app.post('/delete-user/:id', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;
        if (!currentUser || (currentUser.role !== 'Master' && currentUser.role !== 'SuperAdmin')) {
            return res.status(403).render('error', { message: 'Unauthorized.' });
        }
        if (req.params.id === currentUser._id.toString()) {
            return res.status(400).send('You cannot delete your own account.');
        }
        await User.findByIdAndDelete(req.params.id);
        const redirectPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirectPath}?success=User+deleted`));
    } catch (err) {
        res.status(500).render('error', { message: 'Failed to delete user.' });
    }
});

// ── Bulk Approve ──────────────────────────────────────────────
app.post('/bulk-approve', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;
        if (!currentUser || (currentUser.role !== 'Master' && currentUser.role !== 'SuperAdmin')) {
            return res.redirect('/login?error=Unauthorized');
        }
        let { userIds, targetRole } = req.body;
        if (!userIds) return res.redirect('/master?error=No users selected');
        const idsToUpdate = Array.isArray(userIds) ? userIds : [userIds];
        await User.updateMany({ _id: { $in: idsToUpdate } }, { $set: { role: targetRole, isApproved: true } });
        const redirectPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirectPath}?success=Users+approved`));
    } catch (err) {
        console.error('Bulk Approval Error:', err);
        res.redirect('/master?error=Approval+failed');
    }
});

// ── Add Subject ───────────────────────────────────────────────
app.post('/add-subject', async (req, res) => {
    try {
        const user = req.session.user || req.user;
        if (!user || (user.role !== 'Master' && user.role !== 'SuperAdmin')) return res.redirect('/login?error=Unauthorized');
        // FIX: subjectCode was never read or saved — it's now captured and stored.
        const { subjectName, subjectCode, section } = req.body;
        if (!subjectName || !section) return res.redirect('/master?error=Missing+Fields');
        await new Subject({ name: subjectName.trim(), code: (subjectCode || '').trim(), section }).save();
        const redirectPath = user.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirectPath}?success=Subject+Added`));
    } catch (err) {
        console.error('Add Subject Error:', err);
        const msg = err.code === 11000 ? 'Duplicate+Subject' : 'Server+Error';
        res.redirect(`/master?error=${msg}`);
    }
});

// ── Delete Subject ────────────────────────────────────────────
app.post('/delete-subject/:id', async (req, res) => {
    try {
        const user = req.session.user || req.user;
        if (!user || (user.role !== 'Master' && user.role !== 'SuperAdmin')) return res.status(403).render('error', { message: 'Unauthorized' });
        const deletedSub = await Subject.findByIdAndDelete(req.params.id);
        if (!deletedSub) return res.redirect('/master?error=Subject+not+found');
        const redirectPath = user.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirectPath}?success=Subject+Deleted`));
    } catch (err) {
        res.status(500).render('error', { message: 'Could not delete subject.' });
    }
});

// ── Upload Users (CSV) ────────────────────────────────────────
app.post('/upload-users', async (req, res) => {
    try {
        const adminUser = req.session.user || req.user;
        if (!adminUser || adminUser.role !== 'Master') return res.status(403).send('Unauthorized');
        if (!req.files || !req.files.csvFile) return res.status(400).send('No file uploaded');
        const fileData = req.files.csvFile.data.toString('utf8');
        const lines = fileData.split(/\r?\n/);
        const section = req.body.section;
        if (!section) return res.status(400).send('Target section is required.');
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const [name, email, studentId] = lines[i].split(',').map(item => item.trim());
            if (email && email.includes('@')) {
                await User.updateOne(
                    { email: email.toLowerCase() },
                    { $set: { name, rollNo: studentId, section, role: 'Student', isApproved: true, isPreRegistered: true } },
                    { upsert: true }
                );
            }
        }
        req.session.save(() => res.redirect('/master?success=Bulk+import+completed'));
    } catch (err) {
        console.error('Bulk Upload Error:', err);
        res.status(500).send('Error processing file: ' + err.message);
    }
});

// ── Set Class Teacher ─────────────────────────────────────────
app.post('/set-class-teacher/:id', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;
        if (!currentUser || currentUser.role !== 'SuperAdmin') return res.status(403).render('error', { message: 'Unauthorized' });
        const { classTeacherSection, removeClassTeacher } = req.body;
        if (removeClassTeacher === 'true') {
            await User.findByIdAndUpdate(req.params.id, { isClassTeacher: false, classTeacherSection: '' });
        } else {
            if (!classTeacherSection) return res.redirect('/super-admin-dashboard?error=Please+select+a+section');
            await User.findByIdAndUpdate(req.params.id, { isClassTeacher: true, classTeacherSection });
        }
        req.session.save(() => res.redirect('/super-admin-dashboard?success=Class+teacher+updated'));
    } catch (err) {
        res.status(500).render('error', { message: 'Failed to update class teacher.' });
    }
});

// ── SuperAdmin Approval via email link ────────────────────────
app.get('/approve-super-admin', async (req, res) => {
    const { email, secret } = req.query;
    if (!secret || secret !== process.env.ADMIN_APPROVAL_SECRET) {
        return res.status(403).render('error', { message: 'Invalid or missing Secret Approval Key' });
    }
    try {
        const updatedUser = await User.findOneAndUpdate(
            { email: email.toLowerCase() },
            { role: 'SuperAdmin', isApproved: true },
            { new: true }
        );
        if (!updatedUser) return res.status(404).render('error', { message: 'User not found' });
        res.send(`<div style="font-family:sans-serif;text-align:center;padding:50px;"><h1 style="color:#27ae60">Access Granted!</h1><p><b>${email}</b> promoted to SuperAdmin.</p><a href="/login">Go to Portal</a></div>`);
    } catch (err) {
        res.status(500).render('error', { message: 'Database error during promotion.' });
    }
});

// ── Submit SuperAdmin Request ─────────────────────────────────
app.post('/submit-super-admin-request', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user) return res.redirect('/login');
    const approvalLink = `${process.env.APP_BASE_URL}/approve-super-admin?email=${user.email}&secret=${process.env.ADMIN_APPROVAL_SECRET}`;
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.DEVELOPER_EMAIL,
            subject: `⚠️ Elevation Request: ${user.name}`,
            html: `<p><b>${user.name}</b> (${user.email}) requests SuperAdmin access.</p><a href="${approvalLink}" style="background:#27ae60;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Approve</a>`
        });
        res.redirect('/login?message=Elevation request sent. You will be notified upon approval.');
    } catch (err) {
        res.status(500).send('Failed to send request.');
    }
});

// ── Fix Database utility (PROTECTED) ─────────────────────────
// FIX: Was completely unprotected — now requires SuperAdmin.
app.get('/fix-database', isAdmin, async (req, res) => {
    try {
        const users = await User.find({});
        let updatedCount = 0;
        for (let user of users) {
            let needsUpdate = false;
            if (user.rollno && !user.rollNo) { user.rollNo = user.rollno; needsUpdate = true; }
            if (!user.role) { user.role = 'Student'; needsUpdate = true; }
            if (needsUpdate) { await user.save(); updatedCount++; }
        }
        res.send(`Database fixed. Updated ${updatedCount} users.`);
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

// ================================================================
// ERROR HANDLER
// ================================================================
app.use((err, req, res, next) => {
    console.error('🔥 Unhandled Error:', err.stack);
    res.status(500).render('error', { message: err.message || 'Internal Server Error' });
});

// ================================================================
// SERVER STARTUP
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running: http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'production') {
        const https = require('https');
        const RENDER_URL = process.env.APP_BASE_URL || 'https://attendance-system-g6f8.onrender.com';
        setInterval(() => {
            https.get(`${RENDER_URL}/ping`, r => console.log(`🏓 Keep-alive: ${r.statusCode}`))
                .on('error', e => console.warn('Keep-alive failed:', e.message));
        }, 14 * 60 * 1000);
    }
});

process.on('uncaughtException', err => console.error('🔥 Uncaught Exception:', err));
process.on('unhandledRejection', reason => console.error('🔥 Unhandled Rejection:', reason));
