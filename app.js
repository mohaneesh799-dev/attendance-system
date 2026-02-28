// ============================================================
// RKU Attendance System — app.js  (multi-role update)
// ============================================================

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const express    = require('express');
const bcrypt     = require('bcrypt');
const multer     = require('multer');
const fileUpload = require('express-fileupload');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose   = require('mongoose');
const helmet     = require('helmet');
const nodemailer = require('nodemailer');
const ExcelJS    = require('exceljs');
const PDFDocument= require('pdfkit');
const passport   = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const rateLimit  = require('express-rate-limit');

// ── Uploads dir ──────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
const app = express();

// ── Helmet ───────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            styleSrc:   ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
            imgSrc:     ["'self'", "data:", "upload.wikimedia.org"],
            fontSrc:    ["'self'", "cdnjs.cloudflare.com"],
            connectSrc: ["'self'"],
        }
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// ── MongoDB ───────────────────────────────────────────────────
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) { console.error('❌ FATAL: MONGO_URI not set.'); process.exit(1); }
mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => { console.error('❌ MongoDB error:', err); process.exit(1); });

// ── Session ───────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) { console.error('❌ FATAL: SESSION_SECRET not set.'); process.exit(1); }
app.set('trust proxy', 1);
const isProd = process.env.NODE_ENV === 'production';
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    name: 'rku.sid',
    store: MongoStore.create({
        mongoUrl: mongoURI,
        touchAfter: 24 * 3600,
        ttl: 24 * 60 * 60,
        autoRemove: 'interval',
        autoRemoveInterval: 60
    }),
    cookie: {
        secure: isProd,
        httpOnly: true,
        sameSite: isProd ? 'none' : 'lax',  // 'none' required on Render proxy
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// ── Passport ──────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id).lean();
        done(null, user || null);  // null on not found — clears stale passport session
    }
    catch(e) { done(null, null); }  // null on error — prevents crashes
});

// ── Nodemailer ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
try {
    transporter.verify(err => {
        if (err) console.warn('⚠️ Mail warning (non-fatal):', err.message);
        else console.log('✅ Mail server ready');
    });
} catch(e) { console.warn('⚠️ Mail verify failed:', e.message); }

// ── Rate limit ────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    message: 'Too many login attempts. Try again in 15 minutes.'
});

// ================================================================
// SCHEMAS
// ================================================================

const userSchema = new mongoose.Schema({
    name:               { type: String, default: '' },
    email:              { type: String, required: true, unique: true, index: true },
    rollNo:             { type: String, index: true, default: '' },
    password:           { type: String },
    // ── Multi-role support ──
    // `roles` = all assigned roles (array), `role` = currently active / primary role
    role:               { type: String, default: 'Student' },
    roles:              { type: [String], default: [] },
    // ─────────────────────────
    section:            { type: String, default: '' },
    sections:           { type: [String], default: [] },  // for Master: all managed sections
    phone:              { type: String, default: '' },
    isApproved:         { type: Boolean, default: false },
    isPreRegistered:    { type: Boolean, default: false },
    isClassTeacher:     { type: Boolean, default: false },
    classTeacherSection:{ type: String, default: '' },
    googleId:           { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

const attendanceSchema = new mongoose.Schema({
    date:             { type: String, required: true },
    manualTime:       String,
    subject:          String,
    lecturerEmail:    String,
    leaderEmail:      String,
    section:          { type: String, required: true, index: true },
    students:         [{ studentId: String, studentName: String, status: String }],
    isLockedByLeader: { type: Boolean, default: false },
    lastModifiedBy:   String,
    lastModifiedDate: Date,
    submissionTimestamp: Date
});
attendanceSchema.index({ section: 1, date: -1 });
attendanceSchema.index({ lecturerEmail: 1, date: -1 });
const Attendance = mongoose.model('Attendance', attendanceSchema);

const subjectSchema = new mongoose.Schema({
    name:    { type: String, required: true },
    code:    { type: String, default: '' },
    section: { type: String, index: true, required: true }
});
const Subject = mongoose.model('Subject', subjectSchema);

const divisionSchema = new mongoose.Schema({
    name:        { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    createdAt:   { type: Date, default: Date.now }
});
const Division = mongoose.model('Division', divisionSchema);

// ================================================================
// HELPERS
// ================================================================

function getUser(req) {
    const u = req.session.user || req.user;
    if (!u || !u.role) return null;
    return u;
}

// Build session user object — includes ALL roles for role-switcher
function buildSessionUser(user, activeRole) {
    const sections = user.sections && user.sections.length
        ? user.sections
        : (user.section ? [user.section] : []);
    return {
        _id:     user._id,
        email:   user.email.toLowerCase(),
        role:    activeRole || user.role,
        roles:   user.roles && user.roles.length ? user.roles : [user.role],
        section: user.section || '',
        sections,
        name:    user.name,
        rollNo:  user.rollNo,
        isApproved:          user.isApproved,
        isClassTeacher:      user.isClassTeacher,
        classTeacherSection: user.classTeacherSection
    };
}

// Role → dashboard URL map
const ROLE_PATHS = {
    superadmin: '/super-admin-dashboard',
    master:     '/master',
    leader:     '/leader',
    lecturer:   '/lecturer',
    student:    '/student'
};

function roleToPath(role) {
    return ROLE_PATHS[(role || '').toLowerCase()] || '/role-error';
}

// ── Middleware ────────────────────────────────────────────────
function isAdmin(req, res, next) {
    const u = getUser(req);
    if (u && (u.role === 'Master' || u.role === 'SuperAdmin')) return next();
    return res.redirect('/login?error=Access+Denied');
}

function isSuperAdmin(req, res, next) {
    const u = getUser(req);
    if (!u) return res.redirect('/login?error=Please+log+in');
    if (u.role !== 'SuperAdmin') return res.redirect('/login?error=SuperAdmin+access+required');
    // isApproved may be undefined in old sessions — check DB to heal it
    if (u.isApproved === undefined || u.isApproved === null) {
        return User.findById(u._id).lean().then(dbUser => {
            if (!dbUser || !dbUser.isApproved) return res.redirect('/login?error=Account+not+approved');
            if (req.session.user) { req.session.user.isApproved = true; }
            req.session.save(() => next());
        }).catch(() => res.redirect('/login?error=Session+error'));
    }
    if (!u.isApproved) return res.redirect('/login?error=Account+not+approved');
    return next();
}

// ================================================================
// GOOGLE OAUTH
// ================================================================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_BASE_URL) {
    passport.use(new GoogleStrategy({
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  `${process.env.APP_BASE_URL}/auth/google/callback`
    }, async (accessToken, refreshToken, profile, done) => {
        const email = profile.emails[0].value;
        try {
            let user = await User.findOne({ email });
            if (!user) {
                user = new User({ googleId: profile.id, email, name: profile.displayName, role: 'SuperAdmin', roles: ['SuperAdmin'], isApproved: false });
                await user.save();
                transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.DEVELOPER_EMAIL, subject: 'New Admin Request', text: `New Google login: ${email}` }, err => { if (err) console.log('📧 Email failed:', err.message); });
            }
            return done(null, user);
        } catch(err) { return done(err, null); }
    }));
} else {
    console.warn('⚠️ Google OAuth not configured — GOOGLE_CLIENT_ID/SECRET or APP_BASE_URL missing');
}

// ================================================================
// GET ROUTES
// ================================================================

app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
    const u = getUser(req);
    if (u && u.role && ROLE_PATHS[(u.role || '').toLowerCase()]) {
        // SuperAdmin: only redirect if approved
        if (u.role === 'SuperAdmin' && !u.isApproved) {
            req.session.destroy(() => {});
            return res.render('login', { error: 'Your SuperAdmin account is not yet approved.', message: null });
        }
        return res.redirect(roleToPath(u.role));
    }
    if (u) req.session.destroy(() => {}); // Destroy corrupt/invalid sessions
    res.render('login', { error: req.query.error || null, message: req.query.message || null });
});

app.get('/register', (req, res) => res.render('register', { error: null }));

// ── Role Error page (prevents redirect loops for unknown roles) ──
app.get('/role-error', (req, res) => {
    const u = getUser(req);
    res.status(400).render('error', { message: `Role "${u ? u.role : 'unknown'}" is not configured. Ask your administrator to assign a valid role.` });
});

// ── Emergency session clear ──
app.get('/clear-session', (req, res) => {
    req.session.destroy(err => {
        if (err) console.error('Session destroy error:', err);
        res.clearCookie('rku.sid');
        res.clearCookie('connect.sid');
        res.redirect('/login?message=Session+cleared.+Please+log+in+again.');
    });
});

// ── Google OAuth ──────────────────────────────────────────────
app.get('/auth/google', (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login?error=Google+Sign-In+not+configured');
    passport.authenticate('google', { scope: ['profile','email'], prompt: 'select_account' })(req, res, next);
});
app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', { failureRedirect: '/login?error=Google+login+failed' }, async (err, user) => {
        if (err) { console.error('Google OAuth error:', err.message); return res.redirect('/login?error=Google+authentication+failed'); }
        if (!user) return res.redirect('/login?error=Google+login+failed');
        // req.logout is async in Passport v0.6+ — must nest everything in its callback
        if (!user.isApproved) {
            return req.logout(e => {
                if (e) console.error('Logout error:', e);
                res.render('pending', { user });
            });
        }
        const roles = user.roles && user.roles.length ? user.roles : [user.role];
        if (roles.length > 1) {
            return req.logout(e => {
                if (e) console.error('Logout error:', e);
                req.session.pendingUserId = user._id.toString();
                req.session.save(err2 => {
                    if (err2) return res.redirect('/login?error=Session+error');
                    res.redirect('/select-role');
                });
            });
        }
        const sessionUser = buildSessionUser(user, roles[0]);
        req.logout(e => {
            if (e) console.error('Logout error:', e);
            req.session.user = sessionUser;
            req.session.save(err2 => {
                if (err2) return res.redirect('/login?error=Session+error');
                res.redirect(roleToPath(roles[0]));
            });
        });
    })(req, res, next);
});

// ── Dashboards ────────────────────────────────────────────────

app.get('/super-admin-dashboard', isSuperAdmin, async (req, res) => {
    try {
        const user = getUser(req);
        const [allUsers, allSubjects, allDivisions] = await Promise.all([
            User.find({}).select('-password').sort({ section:1, role:1, name:1 }).lean(),
            Subject.find({}).sort({ section:1, name:1 }).lean(),
            Division.find({}).sort({ name:1 }).lean()
        ]);

        // Group users by section
        const usersBySection = {};
        allUsers.forEach(u => {
            const sec = u.section || 'Unassigned';
            if (!usersBySection[sec]) usersBySection[sec] = [];
            usersBySection[sec].push(u);
        });
        const sections = Object.keys(usersBySection).filter(s => s !== 'Unassigned').sort();
        if (usersBySection['Unassigned']) sections.push('Unassigned');

        res.render('super-admin', {
            user, allUsers, allSubjects, allDivisions, usersBySection, sections,
            stats: {
                totalUsers: allUsers.length,
                pendingApprovals: allUsers.filter(u => !u.isApproved).length,
                totalSubjects: allSubjects.length
            },
            success: req.query.success || null,
            error:   req.query.error   || null
        });
    } catch(err) {
        console.error('SuperAdmin Dashboard Error:', err);
        res.status(500).render('error', { message: 'Failed to load admin dashboard.' });
    }
});

app.get('/master', async (req, res) => {
    try {
        const user = getUser(req);
        const isClassTeacher = user && user.role === 'Lecturer' && user.isClassTeacher;
        if (!user || (user.role !== 'Master' && !isClassTeacher)) return res.redirect('/login?error=Unauthorized');
        const facultySection = isClassTeacher ? user.classTeacherSection : user.section;
        const [allUsers, masterSubjects, allDivisions] = await Promise.all([
            User.find({ section: facultySection }).lean(),
            Subject.find({ section: facultySection }).lean(),
            Division.find({}).sort({ name:1 }).lean()
        ]);

        // Group users by role within section
        const usersByRole = {};
        allUsers.forEach(u => {
            const r = u.role || 'Unknown';
            if (!usersByRole[r]) usersByRole[r] = [];
            usersByRole[r].push(u);
        });

        const stats = {
            total: allUsers.length,
            pending: allUsers.filter(u => !u.isApproved).length,
            subjects: masterSubjects.length,
            students: allUsers.filter(u => u.role === 'Student').length
        };

        req.session.save(() => res.render('master', {
            user: { ...user, section: facultySection },
            allUsers: allUsers || [],
            usersByRole,
            masterSubjects: masterSubjects || [],
            allDivisions,
            stats,
            success: req.query.success || null,
            error: req.query.error || null
        }));
    } catch(err) {
        console.error('Master Error:', err);
        res.status(500).render('error', { message: 'Failed to load faculty portal.' });
    }
});

app.get('/leader', async (req, res) => {
    const user = getUser(req);
    if (!user || user.role !== 'Leader') return res.redirect('/login?error=Unauthorized');
    try {
        const [studentsOnly, lecturers, masterSubjects] = await Promise.all([
            User.find({ section: user.section, $or: [{ role:'Student' }, { role:'Leader' }] }).sort({ rollNo:1 }).lean(),
            User.find({ $or: [{ role:'Lecturer' }, { roles: 'Lecturer' }], isApproved: true }).select('name email').lean(),
            Subject.find({ section: user.section }).lean()
        ]);
        res.render('leader', { user, allUsers: studentsOnly, lecturers, masterSubjects,
            success: req.query.success || null, error: req.query.error || null });
    } catch(err) {
        res.status(500).render('error', { message: 'Could not load Leader portal.' });
    }
});

app.get('/lecturer', async (req, res) => {
    try {
        const user = getUser(req);
        if (!user || user.role !== 'Lecturer') return res.redirect('/login?error=Unauthorized');
        const today = new Date().toISOString().split('T')[0];
        const todayRecords = await Attendance.find({ lecturerEmail: user.email.toLowerCase(), date: today }).lean();
        const sectionsToday = [...new Set(todayRecords.map(r => r.section))];
        req.session.save(() => res.render('lecturer', { user, todayRecords: todayRecords||[], sectionsToday }));
    } catch(err) {
        res.status(500).render('error', { message: 'Could not load Lecturer portal.' });
    }
});

app.get('/student', async (req, res) => {
    const user = getUser(req);
    if (!user || user.role !== 'Student') return res.redirect('/login?error=Unauthorized');
    try {
        const records = await Attendance.find({
            section: user.section, 'students.studentId': user.rollNo
        }).sort({ date: -1 }).lean();

        let presentCount = 0;
        const subjectMap = {};
        records.forEach(rec => {
            const sub = (rec.subject || 'Unknown').trim();
            if (!subjectMap[sub]) subjectMap[sub] = { present: 0, total: 0 };
            subjectMap[sub].total++;
            const entry = rec.students.find(s => s.studentId === user.rollNo);
            if (entry && entry.status === 'Present') {
                presentCount++;
                subjectMap[sub].present++;
            }
        });
        const subjectStats = Object.entries(subjectMap)
            .map(([subject, d]) => ({
                subject, present: d.present, total: d.total,
                absent: d.total - d.present,
                percentage: d.total > 0 ? +((d.present / d.total) * 100).toFixed(1) : 0
            }))
            .sort((a, b) => a.subject.localeCompare(b.subject));

        res.render('student', {
            user, records: records.slice(0, 50),
            presentCount, totalCount: records.length, subjectStats
        });
    } catch(err) {
        res.status(500).render('error', { message: 'Could not load Student portal.' });
    }
});

app.get('/settings', async (req, res) => {
    try {
        const su = getUser(req);
        if (!su) return res.redirect('/login?error=Please+log+in');
        const userDetails = await User.findById(su._id).lean();
        if (!userDetails) return res.status(404).render('error', { message: 'Account not found.' });
        res.render('settings', {
            user: userDetails,
            message: req.query.success ? 'Profile updated successfully!' : null,
            messageType: req.query.success ? 'success' : null
        });
    } catch(err) { res.status(500).render('error', { message: 'Could not load settings.' }); }
});

app.get('/attendance-history', async (req, res) => {
    const user = getUser(req);
    if (!user) return res.redirect('/login');
    try {
        const { startDate, endDate } = req.query;
        let query = {};
        if (startDate && endDate) { query.date = { $gte: startDate, $lte: endDate }; }
        else {
            const d = new Date(); d.setDate(d.getDate() - 30);
            query.date = { $gte: d.toISOString().split('T')[0] };
        }
        if (user.role === 'Student')   { query['students.studentId'] = user.rollNo; query.section = user.section; }
        else if (user.role === 'Lecturer') { query.lecturerEmail = user.email; }
        else if (user.role === 'Leader')   { query.section = user.section; }
        const history = await Attendance.find(query).sort({ date: -1 }).lean();
        res.render('history', { user, records: history, startDate: startDate||'', endDate: endDate||'' });
    } catch(err) { res.status(500).render('error', { message: 'Failed to load history.' }); }
});

app.get('/generate-day-pdf/:date', async (req, res) => {
    try {
        const user = getUser(req);
        if (!user) return res.redirect('/login');
        const { date } = req.params;
        const { filter } = req.query;
        const records = await Attendance.find({ date, section: user.section }).sort({ manualTime:1 });
        const doc = new PDFDocument({ margin:50, size:'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=Attendance_${user.section}_${date}.pdf`);
        doc.pipe(res);
        doc.fillColor('#2c3e50').fontSize(22).text('RKU Attendance Report', { align:'center' });
        doc.fontSize(12).fillColor('#7f8c8d').text(`Generated: ${new Date().toLocaleString()}`, { align:'center' });
        doc.moveDown();
        doc.fillColor('black').fontSize(14).text(`Date: ${date} | Section: ${user.section}`);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
        if (!records.length) {
            doc.fontSize(14).text('No records found for this section on this date.', { align:'center' });
        } else {
            records.forEach(rec => {
                doc.rect(50, doc.y, 500, 20).fill('#f1f2f6');
                doc.fillColor('#2f3542').fontSize(11).text(` ${rec.manualTime} | ${rec.subject}`, 55, doc.y-15);
                doc.moveDown(0.5);
                const sy = doc.y;
                doc.fillColor('#000').fontSize(10).text('Student ID',60,sy).text('Name',160,sy).text('Status',450,sy);
                doc.moveDown(0.5);
                doc.moveTo(50,doc.y).lineTo(550,doc.y).strokeColor('#dfe4ea').stroke();
                rec.students.forEach(s => {
                    if (!filter || s.status === filter) {
                        if (doc.y > 700) doc.addPage();
                        doc.fillColor('#34495e').fontSize(9)
                            .text(s.studentId,60,doc.y).text(s.studentName||'',160,doc.y-9)
                            .fillColor(s.status==='Present'?'#27ae60':'#c0392b').text(s.status,450,doc.y-9);
                        doc.moveDown(0.2);
                    }
                });
                doc.moveDown(1.5);
            });
        }
        doc.end();
    } catch(err) { res.status(500).send('Error generating PDF.'); }
});

app.get('/export-attendance', async (req, res) => {
    try {
        const user = getUser(req);
        if (!user || !['Lecturer','Leader','SuperAdmin','Master'].includes(user.role)) return res.status(403).send('Unauthorized.');
        const { startDate, endDate } = req.query;
        const section = user.section;
        let attendanceQuery = section ? { section } : {};
        if (startDate && endDate) attendanceQuery.date = { $gte: startDate, $lte: endDate };
        const [students, attendanceRecords] = await Promise.all([
            section ? User.find({ section, role:'Student' }).select('rollNo name').lean() : [],
            Attendance.find(attendanceQuery).sort({ date:1 }).lean()
        ]);
        let csv = '\uFEFF';
        csv += 'Roll No,Student Name,Date,Subject,Time Slot,Status\n';
        attendanceRecords.forEach(record => {
            (students.length ? students : record.students).forEach(student => {
                const rollNo = student.rollNo || student.studentId;
                const name   = student.name   || student.studentName || '';
                const entry  = record.students.find(s => s.studentId === rollNo);
                const status = entry ? entry.status : 'N/A';
                csv += `${rollNo},"${name.replace(/"/g,'""')}",${record.date},${record.subject||''},${record.manualTime||''},${status}\n`;
            });
        });
        const fileName = `Attendance_${section||'All'}_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.send(csv);
    } catch(err) { res.status(500).send('Export error: ' + err.message); }
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

// ── Role Selection (for multi-role users) ──
app.get('/select-role', (req, res) => {
    if (!req.session.pendingUserId) return res.redirect('/login?error=Session+expired.+Please+log+in+again.');
    User.findById(req.session.pendingUserId).lean()
        .then(user => {
            if (!user) return res.redirect('/login?error=User+not+found');
            const roles = user.roles && user.roles.length ? user.roles : [user.role];
            res.render('choose-role', { user, roles, error: req.query.error || null });
        })
        .catch(() => res.redirect('/login?error=Session+error'));
});

// ================================================================
// POST ROUTES
// ================================================================

// ── Login ─────────────────────────────────────────────────────
app.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.render('login', { error: 'Email and password are required.', message: null });
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) return res.render('login', { error: 'Account not found. Please register first.', message: null });
        if (!user.password) return res.render('login', { error: 'This account uses Google Sign-In. Use the Google button.', message: null });
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return res.render('login', { error: 'Incorrect password. Please try again.', message: null });

        // SuperAdmin and Master are always allowed; others need approval
        const skipApproval = ['SuperAdmin', 'Master'].includes(user.role);
        if (!user.isApproved && !skipApproval) {
            return res.render('login', { error: 'Your account is awaiting admin approval.', message: null });
        }

        // Multi-role: show inline role switcher (no separate page needed)
        const roles = user.roles && user.roles.length > 0 ? user.roles : [user.role];
        if (roles.length > 1) {
            req.session.pendingUserId = user._id.toString();
            return req.session.save(err => {
                if (err) return res.status(500).send('Session error.');
                res.redirect('/select-role');
            });
        }

        req.session.user = buildSessionUser(user, roles[0]);
        req.session.save(err => {
            if (err) return res.status(500).send('Login failed — session error.');
            res.redirect(roleToPath(roles[0]));
        });
    } catch(err) {
        console.error('Login error:', err);
        res.status(500).render('error', { message: 'Internal Server Error during login.' });
    }
});

// ── Select Role / Choose Role (POST) ─────────────────────────
// choose-role.ejs posts to /choose-role — register BOTH to handle either
async function handleRoleSelection(req, res) {
    try {
        if (!req.session.pendingUserId) return res.redirect('/login?error=Session+expired.+Please+log+in+again.');
        const { selectedRole } = req.body;
        if (!selectedRole) return res.redirect('/select-role?error=Please+select+a+role+to+continue.');
        const user = await User.findById(req.session.pendingUserId);
        if (!user) return res.redirect('/login?error=User+not+found');
        const roles = user.roles && user.roles.length ? user.roles : [user.role];
        if (!roles.includes(selectedRole)) {
            return res.redirect('/select-role?error=Invalid+role.+Please+choose+one+of+your+assigned+roles.');
        }
        delete req.session.pendingUserId;
        req.session.user = buildSessionUser(user, selectedRole);
        req.session.save(err => {
            if (err) { console.error('Session save error:', err); return res.status(500).send('Session error.'); }
            res.redirect(roleToPath(selectedRole));
        });
    } catch(err) {
        console.error('Role selection error:', err);
        res.status(500).render('error', { message: 'Role selection failed. Please try again.' });
    }
}
app.post('/select-role', handleRoleSelection);   // internal redirect path
app.post('/choose-role', handleRoleSelection);   // ← choose-role.ejs form action

// ── Switch Role (while logged in) ────────────────────────────
app.post('/switch-role', async (req, res) => {
    try {
        const user = getUser(req);
        if (!user) return res.redirect('/login');
        const { targetRole } = req.body;
        if (!targetRole) return res.redirect('back');
        const dbUser = await User.findById(user._id);
        if (!dbUser) return res.redirect('/login');
        const roles = dbUser.roles && dbUser.roles.length ? dbUser.roles : [dbUser.role];
        if (!roles.includes(targetRole)) return res.redirect('/login?error=Role+not+assigned');
        req.session.user = buildSessionUser(dbUser, targetRole);
        req.session.save(err => {
            if (err) return res.redirect('/login?error=Session+error');
            res.redirect(roleToPath(targetRole));
        });
    } catch(err) {
        console.error('Switch role error:', err);
        res.redirect('/login?error=Switch+failed');
    }
});

// ── Register ──────────────────────────────────────────────────
app.post('/register', async (req, res) => {
    const { name, email, password, role, section, rollNo } = req.body;
    try {
        const domain = process.env.ALLOWED_EMAIL_DOMAIN || 'rku.ac.in';
        if (!email.endsWith(`@${domain}`)) return res.status(400).render('register', { error: `Use your official @${domain} email.` });
        if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).render('register', { error: 'Email already registered.' });
        const hashed = await bcrypt.hash(password, 10);
        await new User({ name, email: email.toLowerCase(), password: hashed, role, roles: [role], section, rollNo: rollNo||'', isApproved: false }).save();
        try {
            await transporter.sendMail({
                from: process.env.EMAIL_USER, to: process.env.DEVELOPER_EMAIL,
                subject: `🔔 Approval Required: ${name} (${role})`,
                html: `<p><b>${name}</b> (${email}) registered as <b>${role}</b> in section <b>${section}</b>.</p>`
            });
        } catch(e) { console.error('Email notification failed (non-fatal):', e.message); }
        res.redirect('/login?message=Registration successful! Awaiting admin approval.');
    } catch(err) {
        if (err.code===11000) return res.status(400).render('register', { error: 'Email already exists.' });
        res.status(500).render('register', { error: 'Server error: ' + err.message });
    }
});

// ── SuperAdmin Registration ───────────────────────────────────
app.post('/register-super-admin', async (req, res) => {
    const { name, email, password, masterKey } = req.body;
    if (!masterKey || masterKey !== process.env.ADMIN_APPROVAL_SECRET)
        return res.status(403).render('register', { error: 'Invalid Master Security Key.' });
    try {
        if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).render('register', { error: 'Email already registered.' });
        const hashed = await bcrypt.hash(password, 10);
        await new User({ name, email: email.toLowerCase(), password: hashed, role: 'SuperAdmin', roles: ['SuperAdmin'], isApproved: true }).save();
        res.redirect('/login?message=SuperAdmin account created. You can now log in.');
    } catch(err) { res.status(500).render('register', { error: 'Registration failed: ' + err.message }); }
});

// ── Logout ────────────────────────────────────────────────────
app.get('/logout', (req, res) => {
    const destroy = () => req.session.destroy(err => {
        if (err) console.error('Session destroy error:', err);
        res.clearCookie('rku.sid');       // actual session cookie name
        res.clearCookie('connect.sid');   // legacy fallback
        res.redirect('/login?message=Logged out successfully');
    });
    if (typeof req.logout === 'function') req.logout(err => { if(err) console.error(err); destroy(); });
    else destroy();
});

// ── Settings Update ───────────────────────────────────────────
app.post('/update-settings', async (req, res) => {
    const { name, phone, currentPassword, newPassword } = req.body;
    const su = getUser(req);
    if (!su) return res.redirect('/login');
    try {
        const user = await User.findById(su._id);
        if (!user) return res.redirect('/login');
        if (!user.password) {
            user.name = (name || user.name).trim();
            user.phone = phone || '';
            await user.save();
            if (req.session.user) req.session.user.name = user.name;
            return res.render('settings', { user: user.toObject(), message: 'Profile updated successfully!', messageType: 'success' });
        }
        if (!currentPassword) return res.render('settings', { user: user.toObject(), message: 'Please enter your current password to save changes.', messageType: 'error' });
        const ok = await bcrypt.compare(currentPassword, user.password);
        if (!ok) return res.render('settings', { user: user.toObject(), message: 'Incorrect current password.', messageType: 'error' });
        user.name = (name || user.name).trim();
        user.phone = phone || '';
        if (newPassword && newPassword.trim()) {
            if (newPassword.trim().length < 6) return res.render('settings', { user: user.toObject(), message: 'New password must be at least 6 characters.', messageType: 'error' });
            user.password = await bcrypt.hash(newPassword.trim(), 10);
        }
        await user.save();
        if (req.session.user) req.session.user.name = user.name;
        res.render('settings', { user: user.toObject(), message: 'Profile updated successfully!', messageType: 'success' });
    } catch(err) {
        res.status(500).render('error', { message: 'Error updating settings.' });
    }
});

// ── Lock Attendance ───────────────────────────────────────────
app.post('/lock-attendance', async (req, res) => {
    try {
        const leader = getUser(req);
        if (!leader || leader.role !== 'Leader') return res.status(403).render('error', { message: 'Unauthorized' });
        const { section, lecturerEmail, manualTime, subject, date, students } = req.body;
        if (!subject || !manualTime || !date) return res.redirect('/leader?error=Please fill in all fields.');
        if (!students || typeof students !== 'object') return res.redirect('/leader?error=No student data received.');
        const studentList = Object.keys(students).map(k => ({
            studentId: students[k].id || k,
            studentName: students[k].name || '',
            status: students[k].status === 'Present' ? 'Present' : 'Absent'
        }));
        await new Attendance({
            section: section || leader.section,
            date: date || new Date().toISOString().split('T')[0],
            manualTime, subject,
            lecturerEmail: (lecturerEmail||'').toLowerCase(),
            leaderEmail: leader.email,
            students: studentList,
            isLockedByLeader: true,
            submissionTimestamp: new Date()
        }).save();
        res.redirect('/leader?success=Attendance+locked+successfully.');
    } catch(err) { res.status(500).render('error', { message: 'Error locking attendance: ' + err.message }); }
});

// ── Update Attendance Status ──────────────────────────────────
app.post('/update-attendance-status', async (req, res) => {
    const user = getUser(req);
    if (!user || !['Lecturer','Master','Leader','SuperAdmin'].includes(user.role))
        return res.status(403).json({ success:false, message:'Unauthorized' });
    const { attendanceId, studentId, newStatus } = req.body;
    if (!attendanceId || !studentId || !newStatus) return res.status(400).json({ success:false, message:'Missing fields.' });
    try {
        const q = { _id: attendanceId, 'students.studentId': studentId };
        if (user.role === 'Lecturer') q.lecturerEmail = user.email.toLowerCase();
        const result = await Attendance.findOneAndUpdate(q,
            { $set: { 'students.$.status': newStatus, lastModifiedBy: user.email, lastModifiedDate: new Date() } },
            { new: true }
        );
        if (result) res.json({ success:true, message:'Status updated.' });
        else        res.status(404).json({ success:false, message:'Record not found or insufficient permissions.' });
    } catch(err) { res.status(500).json({ success:false, message:'Internal Server Error' }); }
});

// ================================================================
// DIVISION MANAGEMENT (SuperAdmin only)
// ================================================================

app.post('/create-division', isSuperAdmin, async (req, res) => {
    const { divisionName, description } = req.body;
    if (!divisionName || !divisionName.trim())
        return res.redirect('/super-admin-dashboard?error=Division+name+is+required.');
    try {
        const name = divisionName.trim().toUpperCase();
        if (await Division.findOne({ name })) return res.redirect('/super-admin-dashboard?error=Division+already+exists.');
        await new Division({ name, description: description||'' }).save();
        res.redirect('/super-admin-dashboard?success=Division+' + encodeURIComponent(name) + '+created.');
    } catch(err) {
        if (err.code === 11000) return res.redirect('/super-admin-dashboard?error=Division+already+exists.');
        res.redirect('/super-admin-dashboard?error=Failed+to+create+division.');
    }
});

app.post('/delete-division/:id', isSuperAdmin, async (req, res) => {
    try {
        const div = await Division.findByIdAndDelete(req.params.id);
        if (!div) return res.redirect('/super-admin-dashboard?error=Division+not+found.');
        await User.updateMany({ section: div.name }, { $set: { section: '' } });
        res.redirect('/super-admin-dashboard?success=Division+deleted.+Users+moved+to+Unassigned.');
    } catch(err) { res.redirect('/super-admin-dashboard?error=Failed+to+delete+division.'); }
});

// ================================================================
// ASSIGN USER — SUPPORTS MULTIPLE ROLES
// ================================================================

app.post('/assign-user/:id', isSuperAdmin, async (req, res) => {
    try {
        let { roles, primaryRole, section, sections, rollNo } = req.body;

        // Normalise roles to array
        let rolesArray = Array.isArray(roles) ? roles : (roles ? [roles] : []);
        if (!rolesArray.length && primaryRole) rolesArray = [primaryRole];
        if (!rolesArray.length) rolesArray = ['Student'];
        const activePrimaryRole = (primaryRole && rolesArray.includes(primaryRole)) ? primaryRole : rolesArray[0];

        // Normalise sections to array (multi-select checkboxes for Master)
        let sectionsArray = Array.isArray(sections) ? sections : (sections ? [sections] : []);
        if (section && !sectionsArray.includes(section)) sectionsArray.push(section);
        sectionsArray = [...new Set(sectionsArray.filter(Boolean))];
        const primarySection = sectionsArray[0] || '';

        const updateData = {
            roles:    rolesArray,
            role:     activePrimaryRole,
            sections: sectionsArray,
            section:  primarySection,
            isApproved: true
        };
        if (['Student', 'Leader'].includes(activePrimaryRole) && rollNo && rollNo.trim()) {
            updateData.rollNo = rollNo.trim();
        }

        const updatedUser = await User.findByIdAndUpdate(req.params.id, { $set: updateData }, { new: true });
        if (!updatedUser) return res.redirect('/super-admin-dashboard?error=User+not+found.');

        const secLabel = sectionsArray.length > 1 ? sectionsArray.join(', ') : (primarySection || 'no section');
        res.redirect(`/super-admin-dashboard?success=${encodeURIComponent(updatedUser.name)}+assigned+as+${rolesArray.join('+&+')}+in+${encodeURIComponent(secLabel)}.`);
    } catch(err) {
        console.error('Assign user error:', err);
        res.redirect('/super-admin-dashboard?error=Failed+to+assign+user.');
    }
});

// ── Approve User ──────────────────────────────────────────────
app.post('/approve-user/:id', isAdmin, async (req, res) => {
    try {
        const cu = getUser(req);
        await User.findByIdAndUpdate(req.params.id, { isApproved: true });
        const redirect = cu.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirect}?success=User+approved`));
    } catch(err) { res.status(500).render('error', { message: 'Error during approval.' }); }
});

// ── Delete User ───────────────────────────────────────────────
app.post('/delete-user/:id', isAdmin, async (req, res) => {
    try {
        const cu = getUser(req);
        if (req.params.id === cu._id.toString()) return res.status(400).send('Cannot delete your own account.');
        await User.findByIdAndDelete(req.params.id);
        const redirect = cu.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirect}?success=User+deleted`));
    } catch(err) { res.status(500).render('error', { message: 'Failed to delete user.' }); }
});

// ── Bulk Approve ──────────────────────────────────────────────
app.post('/bulk-approve', isAdmin, async (req, res) => {
    try {
        const cu = getUser(req);
        let { userIds, targetRole } = req.body;
        if (!userIds) return res.redirect('/master?error=No+users+selected');
        const ids = Array.isArray(userIds) ? userIds : [userIds];
        await User.updateMany({ _id: { $in: ids } }, { $set: { role: targetRole, roles: [targetRole], isApproved: true } });
        const redirect = cu.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirect}?success=Users+approved`));
    } catch(err) { res.redirect('/master?error=Approval+failed'); }
});

// ── Add Subject ───────────────────────────────────────────────
app.post('/add-subject', isAdmin, async (req, res) => {
    try {
        const cu = getUser(req);
        const { subjectName, subjectCode, section } = req.body;
        if (!subjectName || !section) return res.redirect('/super-admin-dashboard?error=Missing+Fields');
        await new Subject({ name: subjectName.trim(), code: (subjectCode||'').trim(), section }).save();
        const redirect = cu.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirect}?success=Subject+Added`));
    } catch(err) {
        const redirect = getUser(req)?.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        res.redirect(`${redirect}?error=` + (err.code===11000 ? 'Duplicate+Subject' : 'Server+Error'));
    }
});

// ── Delete Subject ────────────────────────────────────────────
app.post('/delete-subject/:id', isAdmin, async (req, res) => {
    try {
        const cu = getUser(req);
        await Subject.findByIdAndDelete(req.params.id);
        const redirect = cu.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
        req.session.save(() => res.redirect(`${redirect}?success=Subject+Deleted`));
    } catch(err) { res.status(500).render('error', { message: 'Could not delete subject.' }); }
});

// ── Set Class Teacher ─────────────────────────────────────────
app.post('/set-class-teacher/:id', isSuperAdmin, async (req, res) => {
    try {
        const { classTeacherSection, removeClassTeacher } = req.body;
        if (removeClassTeacher === 'true') {
            await User.findByIdAndUpdate(req.params.id, { isClassTeacher: false, classTeacherSection: '' });
        } else {
            if (!classTeacherSection) return res.redirect('/super-admin-dashboard?error=Please+select+a+division');
            await User.findByIdAndUpdate(req.params.id, { isClassTeacher: true, classTeacherSection });
        }
        req.session.save(() => res.redirect('/super-admin-dashboard?success=Class+teacher+updated'));
    } catch(err) { res.status(500).render('error', { message: 'Failed to update class teacher.' }); }
});

// ── CSV Upload ────────────────────────────────────────────────
app.post('/upload-users', isAdmin, async (req, res) => {
    try {
        const adminUser = getUser(req);
        if (adminUser.role !== 'Master') return res.status(403).send('Only Masters can bulk import.');
        if (!req.files || !req.files.csvFile) return res.status(400).send('No file uploaded');
        const lines = req.files.csvFile.data.toString('utf8').split(/\r?\n/);
        const section = req.body.section;
        if (!section) return res.status(400).send('Target section is required.');
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const [name, email, studentId] = lines[i].split(',').map(s => s.trim());
            if (email && email.includes('@')) {
                await User.updateOne({ email: email.toLowerCase() },
                    { $set: { name, rollNo: studentId, section, role: 'Student', roles: ['Student'], isApproved: true, isPreRegistered: true } },
                    { upsert: true }
                );
            }
        }
        req.session.save(() => res.redirect('/master?success=Bulk+import+completed'));
    } catch(err) { res.status(500).send('Error processing file: ' + err.message); }
});

// ── SuperAdmin Approval via email link ────────────────────────
app.get('/approve-super-admin', async (req, res) => {
    const { email, secret } = req.query;
    if (!secret || secret !== process.env.ADMIN_APPROVAL_SECRET)
        return res.status(403).render('error', { message: 'Invalid Secret Key' });
    try {
        const u = await User.findOneAndUpdate(
            { email: email.toLowerCase() },
            { role:'SuperAdmin', roles:['SuperAdmin'], isApproved:true },
            { new:true }
        );
        if (!u) return res.status(404).render('error', { message: 'User not found' });
        res.send(`<div style="font-family:sans-serif;text-align:center;padding:50px;"><h1 style="color:#27ae60">Access Granted!</h1><p><b>${email}</b> promoted to SuperAdmin.</p><a href="/login">Go to Portal</a></div>`);
    } catch(err) { res.status(500).render('error', { message: 'DB error during promotion.' }); }
});

// ── Fix Database ──────────────────────────────────────────────
app.get('/fix-database', isSuperAdmin, async (req, res) => {
    try {
        const users = await User.find({});
        let count = 0;
        for (let u of users) {
            let changed = false;
            if (u.rollno && !u.rollNo) { u.rollNo = u.rollno; changed = true; }
            if (!u.role) { u.role = 'Student'; changed = true; }
            if (!u.roles || u.roles.length === 0) { u.roles = [u.role]; changed = true; }
            // Migrate: populate sections[] from section string
            if ((!u.sections || u.sections.length === 0) && u.section) {
                u.sections = [u.section]; changed = true;
            }
            if (changed) { await u.save(); count++; }
        }
        res.send(`✅ Database fixed. Updated ${count} users. Reload the page and test login.`);
    } catch(err) { res.status(500).send('Error: ' + err.message); }
});

// ================================================================
// ERROR HANDLER
// ================================================================
app.use((err, req, res, next) => {
    console.error('🔥 Unhandled Error:', err.stack);
    res.status(500).render('error', { message: err.message || 'Internal Server Error' });
});

// ================================================================
// START
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    if (process.env.NODE_ENV === 'production') {
        const https = require('https');
        const BASE = process.env.APP_BASE_URL || '';
        if (BASE) {
            setInterval(() => {
                https.get(`${BASE}/ping`, r => console.log(`🏓 Keep-alive: ${r.statusCode}`))
                    .on('error', e => console.warn('Keep-alive failed:', e.message));
            }, 14 * 60 * 1000);
        }
    }
});

process.on('uncaughtException',  err => console.error('🔥 Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('🔥 Unhandled Rejection:', err));