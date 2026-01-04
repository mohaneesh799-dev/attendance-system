const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const session = require('express-session'); 
const MongoStore = require('connect-mongo').default;
const mongoose = require('mongoose');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs'); 
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
require('dotenv').config();

const app = express();

// --- DIRECTORY SETUP ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// --- DATABASE CONNECTION ---
const mongoURI = "mongodb+srv://mohaneesh799:Mohan0354@cluster0.0jkiiez.mongodb.net/attendanceDB"; 
mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ Connection error:', err));

// --- SCHEMAS & MODELS ---
const userSchema = new mongoose.Schema({
    name: { type: String, required: false, default: '' }, 
    email: { type: String, required: true, unique: true, index: true },
    rollNo: { type: String, index: true, default: '' },
    password: { type: String, required: false }, 
    role: { type: String, default: 'Student' }, 
    section: { type: String, default: '' },
    isApproved: { type: Boolean, default: false },
    isPreRegistered: { type: Boolean, default: false },
    theme: { type: String, default: '#007bff' }
});
const User = mongoose.model('User', userSchema);

const attendanceSchema = new mongoose.Schema({
    date: String,
    manualTime: String,
    periodNumber: { type: String, required: false },
    subject: String,
    lecturerEmail: String,
    leaderEmail: String,
    section: { type: String, required: true },
    students: [{
        studentId: String,
        studentName: String,
        status: String
    }],
    isLockedByLeader: { type: Boolean, default: false },
    lastModifiedBy: String,
    lastModifiedDate: Date
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

const subjectSchema = new mongoose.Schema({
    name: String,
    code: String,
    section: String
});
const Subject = mongoose.model('Subject', subjectSchema);

// --- MIDDLEWARE ---
app.use(helmet());
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SESSION CONFIGURATION ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'attendance_system_secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI, // Ensure this matches your Render Env Var name
        collectionName: 'sessions'
    }),
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        httpOnly: true, 
        maxAge: 24 * 60 * 60 * 1000 
    }
}));




app.use(passport.initialize());
app.use(passport.session());

// --- PASSPORT SERIALIZATION (The Bridge) ---
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});



// --- GOOGLE STRATEGY ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "https://attendance-system-g6f8.onrender.com/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    if (!email.endsWith('@rku.ac.in')) {
        return done(null, false, { message: 'Use official @rku.ac.in email' });
    }
    try {
        let user = await User.findOne({ email: email });
        if (!user) {
            user = new User({
                googleId: profile.id,
                email: email,
                name: profile.displayName,
                role: "SuperAdmin", 
                isApproved: false 
            });
            await user.save();
            const approvalLink = `https://attendance-system-g6f8.onrender.com/approve-super-admin?email=${email}&secret=${process.env.ADMIN_APPROVAL_SECRET}`;
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: 'mohaneesh799@gmail.com',
                subject: 'URGENT: SuperAdmin Approval Request',
                html: `<h3>New Admin Request</h3><p>User: ${profile.displayName}</p><a href="${approvalLink}">Approve Now</a>`
            };
            transporter.sendMail(mailOptions).catch(err => console.error("Mail Error:", err));
        }
        return done(null, user);
    } catch (err) { return done(err, null); }
}));

// --- UTILITIES ---
const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
})});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // use SSL
    auth: { 
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS 
    }
});

// --- GET ROUTES ---
app.get('/', (req, res) => res.render('login'));
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));

app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
        // Ensure the user object is assigned to the session
        req.session.user = req.user; 
        
        req.session.save((err) => {
            if (err) return res.redirect('/login');
            
            // Case-insensitive role check
            const role = req.user.role.toLowerCase();
            if (role === 'superadmin') return res.redirect('/super-admin-dashboard');
            if (role === 'master') return res.redirect('/master');
            if (role === 'lecturer') return res.redirect('/lecturer');
            if (role === 'leader') return res.redirect('/leader');
            res.redirect('/student');
        });
    }
);

app.get('/master', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user) return res.redirect('/login');
    const allowedRoles = ['Master', 'SuperAdmin'];
    if (!allowedRoles.includes(user.role) || user.isApproved === false) {
        return res.redirect('/login?error=Access Denied.');
    }
    try {
        const userSection = user.section || "";
        const users = await User.find({ section: userSection });
        const subjects = await Subject.find({ section: userSection });
        res.render('master', { user, allUsers: users, masterSubjects: subjects });
    } catch (err) { res.status(500).send("Error loading Master board."); }
});

app.get('/leader', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Leader') return res.redirect('/login');
    try {
        const studentsOnly = await User.find({
            section: req.session.user.section,
            $or: [{ role: 'Student' }, { role: 'Leader' }, { isPreRegistered: true }]
        }).sort({ rollNo: 1 });
        const masterSubjects = await Subject.find({ section: req.session.user.section });
        res.render('leader', { user: req.session.user, allUsers: studentsOnly, masterSubjects: masterSubjects });
    } catch (err) { res.status(500).send("Error loading leader board."); }
});

app.get('/lecturer', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    try {
        const today = new Date().toISOString().split('T')[0];
        const todayRecords = await Attendance.find({
            section: req.session.user.section,
            lecturerEmail: req.session.user.email,
            date: today
        });
        res.render('lecturer', { user: req.session.user, todayRecords: todayRecords });
    } catch (err) { res.status(500).send("Error loading Lecturer Dashboard"); }
});

app.get('/student', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Student') return res.redirect('/login');
    try {
        const userRoll = req.session.user.rollNo;
        const records = await Attendance.find({
            section: req.session.user.section,
            "students": { $elemMatch: { studentId: userRoll } }
        }).sort({ date: -1 });
        let present = 0;
        records.forEach(rec => {
            const me = rec.students.find(s => s.studentId === userRoll);
            if (me && me.status === 'Present') present++;
        });
        res.render('student', { user: req.session.user, records, presentCount: present, totalCount: records.length });
    } catch (err) { res.status(500).send("Error loading student board."); }
});

app.get('/super-admin-dashboard', async (req, res) => {
    const user = req.user || req.session.user;
    if (!user || user.role !== 'SuperAdmin' || user.isApproved === false) { 
        return res.redirect('/login?error=Access Denied: Pending Approval');
    }
    try {
        const allUsers = await User.find({});
        const allSubjects = await Subject.find({});
        res.render('super-admin', { user, allUsers, allSubjects });
    } catch (err) { res.status(500).send("Database Error."); }
});

// --- UPDATED LOGIN ROUTE FOR CLARITY ---
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user) {
            return res.send("<script>alert('User not found.'); window.location.href='/login';</script>");
        }

        // Check isApproved field based on your MongoDB screenshot
        if (user.isApproved === false) {
            return res.send("<script>alert('Your account is pending approval by the owner.'); window.location.href='/login';</script>");
        }

        if (user.password !== password) {
            return res.send("<script>alert('Invalid Password'); window.location.href='/login';</script>");
        }

        // Create session
        req.session.user = { 
            id: user._id, 
            email: user.email, 
            role: user.role, 
            section: user.section, 
            rollNo: user.rollNo 
        };

        // Redirect based on role
        if (user.role === 'SuperAdmin') return res.redirect('/super-admin-dashboard');
        if (user.role === 'Master') return res.redirect('/master');
        if (user.role === 'Lecturer') return res.redirect('/lecturer');
        if (user.role === 'Leader') return res.redirect('/leader');
        res.redirect('/student');

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).send("Login error occurred.");
    }
});
app.post('/register', async (req, res) => {
    const { email, password, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ email, password: hashedPassword, role, isApproved: false });
        await newUser.save();
        const approvalLink = `${req.protocol}://${req.get('host')}/approve-user/${newUser._id}`;
        const mailOptions = { from: process.env.EMAIL_USER, to: 'mohaneesh799@gmail.com', subject: 'New Register', html: `<a href="${approvalLink}">Approve</a>` };
        transporter.sendMail(mailOptions).catch(e => console.log("Mail fail"));
        res.redirect('/login?message=Waiting approval');
    } catch (err) { res.status(500).send("Register error"); }
});

app.post('/upload-users', upload.single('csvFile'), async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");
    const targetSection = req.body.section;
    const users = [];
    try {
        const workbook = new ExcelJS.Workbook();
        if (req.file.originalname.endsWith('.csv')) await workbook.csv.readFile(req.file.path);
        else await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.getWorksheet(1);
        worksheet.eachRow((row, rowNum) => {
            if (rowNum > 1) {
                const email = row.getCell(3).value;
                if (email) users.push({
                    rollNo: row.getCell(1).value?.toString() || '',
                    name: row.getCell(2).value?.toString() || 'New User',
                    email: email.toString().toLowerCase().trim(),
                    role: 'Student', section: targetSection, isApproved: true, isPreRegistered: true
                });
            }
        });
        if (users.length > 0) await User.insertMany(users, { ordered: false });
        fs.unlinkSync(req.file.path);
        res.send("<script>alert('Success!'); window.location.href='/master';</script>");
    } catch (err) { res.status(500).send("Upload error"); }
});

app.post('/lock-attendance', async (req, res) => {
    try {
        const { section, lecturerEmail, manualTime, subject, date, students } = req.body;
        const newAttendance = new Attendance({
            section, date, manualTime, subject, lecturerEmail,
            leaderEmail: req.session.user.email,
            students: Object.values(students).map(s => ({ studentId: s.id, studentName: s.name, status: s.status || 'Absent' })),
            isLockedByLeader: true
        });
        await newAttendance.save();
        res.send("<script>alert('Locked!'); window.location.href='/leader';</script>");
    } catch (err) { res.status(500).send(err.message); }
});

// --- SETTINGS & UPDATES ---
app.get('/settings', async (req, res) => {
    if(!req.session.user) return res.redirect('/login');
    const currentUser = await User.findOne({ email: req.session.user.email });
    res.render('settings', { user: currentUser });
});

app.post('/update-settings', async (req, res) => {
    const { name, rollNo, themeColor, email } = req.body;
    await User.findOneAndUpdate({ email }, { $set: { name, rollNo, theme: themeColor } });
    res.send("<script>alert('Updated!'); window.location.href='/student';</script>");
});

app.get('/approve-user/:id', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { isApproved: true });
    res.send("Approved!");
});

app.post('/delete-user/:id', async (req, res) => {
    await User.findByIdAndDelete(req.params.id);
    res.redirect('/master');
});

app.post('/bulk-approve', async (req, res) => {
    const { userIds, targetRole } = req.body;
    await User.updateMany({ _id: { $in: userIds } }, { role: targetRole, isApproved: true });
    res.redirect('/master');
});

app.post('/add-subject', async (req, res) => {
    const { subjectName, section } = req.body;
    const newSubject = new Subject({ name: subjectName.trim(), section });
    await newSubject.save();
    res.redirect('/master');
});

app.post('/delete-subject/:id', async (req, res) => {
    await Subject.findByIdAndDelete(req.params.id);
    res.redirect('/master');
});

// --- PDF & HISTORY ---
app.get('/generate-day-pdf/:date', async (req, res) => {
    const { date } = req.params;
    const userSection = req.session.user.section;
    const records = await Attendance.find({ date, section: userSection }).sort({ manualTime: 1 });
    const doc = new PDFDocument({ margin: 30 });
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(20).text(`Attendance Report: ${date}`, { align: 'center' });
    doc.text(`Section: ${userSection}`, { align: 'center' });
    records.forEach(rec => {
        doc.moveDown().fontSize(14).text(`Slot: ${rec.manualTime} | Subject: ${rec.subject}`, { underline: true });
        rec.students.forEach(s => doc.fontSize(10).text(`${s.studentName} (${s.studentId}): ${s.status}`));
    });
    doc.end();
});

app.get('/view-pdf', (req, res) => {
    const filePath = path.join(__dirname, 'daily_attendance.pdf');
    if (fs.existsSync(filePath)) {
        res.contentType("application/pdf");
        fs.createReadStream(filePath).pipe(res);
    } else res.send("Not found");
});

app.get('/attendance-history', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { startDate, endDate } = req.query;
    let query = {};
    if (startDate && endDate) query.date = { $gte: startDate, $lte: endDate };
    if (req.session.user.role === 'Student') query["students.studentId"] = req.session.user.rollNo;
    else if (req.session.user.role === 'Lecturer') query.lecturerEmail = req.session.user.email;
    else if (req.session.user.role === 'Leader') query.section = req.session.user.section;
    const history = await Attendance.find(query).sort({ date: -1 });
    res.render('history', { user: req.session.user, records: history, startDate, endDate });
});

// --- ADMIN REQUESTS ---
app.get('/request-super-admin', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const allUsers = await User.find({}); 
    const allSubjects = await Subject.find({}); 
    res.render('super-admin', { user: req.session.user, allUsers, allSubjects });
});

app.post('/submit-super-admin-request', async (req, res) => {
    const user = req.session.user;
    const mailOptions = { from: 'mohaneesh799@gmail.com', to: 'mohaneesh799@gmail.com', subject: 'Req', text: `User ${user.email} req.` };
    await transporter.sendMail(mailOptions);
    res.send("<script>alert('Sent'); window.location='/super-admin-dashboard';</script>");
});

app.get('/approve-super-admin', async (req, res) => {
    const { email, secret } = req.query;
    if (secret !== process.env.ADMIN_APPROVAL_SECRET) return res.status(403).send("Wrong Secret");
    await User.findOneAndUpdate({ email }, { isApproved: true, role: 'SuperAdmin' });
    res.send("Approved!");
});

// --- LECTURER UPDATES ---
app.post('/update-attendance-status', async (req, res) => {
    const { attendanceId, studentId, newStatus } = req.body;
    await Attendance.updateOne(
        { _id: attendanceId, "students.studentId": studentId, section: req.session.user.section },
        { $set: { "students.$.status": newStatus, lastModifiedBy: req.session.user.email, lastModifiedDate: new Date() } }
    );
    res.json({ success: true });
});

// --- MAINTENANCE ---
app.get('/fix-database', async (req, res) => {
    const users = await User.find({});
    for (let user of users) {
        if (user.rollno && !user.rollNo) user.rollNo = user.rollno;
        if (!user.role) user.role = 'Student';
        await user.save();
    }
    res.send("Database Fixed!");
});

// --- LOGOUT & ERROR ---
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', { message: "Something went wrong!", user: req.session.user || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server: http://localhost:${PORT}`));