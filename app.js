const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const session = require('express-session'); 
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs'); 
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// --- DIRECTORY SETUP ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();
app.use(helmet());

// --- SECTION 1: SESSION SETTINGS ---
app.set('trust proxy', 1); 

app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: true,                
    saveUninitialized: false,    
    proxy: true,                 
    store: MongoStore.create({ 
        mongoUrl: "mongodb+srv://mohaneesh799:Mohan0354@cluster0.0jkiiez.mongodb.net/attendanceDB",
        touchAfter: 24 * 3600    
    }),
    cookie: { 
        secure: true, // Set to true if using HTTPS (Render/Heroku)
        httpOnly: true, 
        sameSite: 'lax',         
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

// --- MONGODB CONNECTION ---
const mongoURI = "mongodb+srv://mohaneesh799:Mohan0354@cluster0.0jkiiez.mongodb.net/attendanceDB"; 
mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ Connection error:', err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: { type: String, required: false, default: '' }, 
    email: { type: String, required: true, unique: true, index: true },
    rollNo: { type: String, index: true, default: '' },
    password: { type: String, required: false }, 
    role: { type: String, default: 'Student' }, 
    section: { type: String, default: '' },
    isApproved: { type: Boolean, default: false },
    isPreRegistered: { type: Boolean, default: false }
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
    isLockedByLeader: { type: Boolean, default: false }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

const subjectSchema = new mongoose.Schema({
    name: String,
    code: String,
    section: String
});
const Subject = mongoose.model('Subject', subjectSchema);

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- NODEMAILER ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- PASSPORT AUTH ---
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "https://attendance-system-g6f8.onrender.com/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    try {
        let user = await User.findOne({ email });
        if (!user) {
            user = new User({
                email,
                name: profile.displayName,
                role: "SuperAdmin", 
                isApproved: false 
            });
            await user.save();
        }
        return done(null, user); 
    } catch (err) {
        return done(err, null);
    }
}));

// --- ROUTES ---

app.get('/', (req, res) => res.render('login'));
app.get('/login', (req, res) => res.render('login'));

app.get('/auth/google', passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account' 
}));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    req.session.save((err) => {
      if (err) return res.redirect('/login');
      const user = req.user;
      if (!user.isApproved) return res.render('pending', { user });
      
      const role = (user.role || "").toLowerCase().trim();
      const redirects = { 
          'superadmin': '/super-admin-dashboard', 
          'master': '/master', 
          'leader': '/leader', 
          'lecturer': '/lecturer', 
          'student': '/student' 
      };
      res.redirect(redirects[role] || '/student');
    });
  }
);

// DASHBOARD ROUTES (MASTER, LEADER, LECTURER, STUDENT)
app.get('/master', async (req, res) => {
    const user = req.user || req.session.user;
    if (!user || user.role !== 'Master') return res.redirect('/login?error=unauthorized');
    try {
        const [allUsers, masterSubjects] = await Promise.all([
            User.find({ section: user.section }).lean(),
            Subject.find({ section: user.section }).lean()
        ]);
        res.render('master', { user, allUsers, masterSubjects, stats: { total: allUsers.length, subjects: masterSubjects.length } });
    } catch (err) { res.status(500).send("Master Portal Load Error"); }
});

app.get('/leader', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user || user.role !== 'Leader') return res.redirect('/login?error=Unauthorized');
    try {
        const studentsOnly = await User.find({ section: user.section, $or: [{ role: 'Student' }, { role: 'Leader' }] }).sort({ rollNo: 1 }).lean();
        const lecturers = await User.find({ role: 'Lecturer', isApproved: true }).select('name email').lean();
        const masterSubjects = await Subject.find({ section: user.section }).lean();
        res.render('leader', { user, allUsers: studentsOnly, lecturers, masterSubjects });
    } catch (err) { res.status(500).send("Leader Portal Load Error"); }
});

app.get('/lecturer', async (req, res) => {
    const user = req.user || req.session.user;
    if (!user || user.role !== 'Lecturer') return res.redirect('/login?error=Unauthorized');
    try {
        const today = new Date().toISOString().split('T')[0];
        const todayRecords = await Attendance.find({ section: user.section, date: today }).lean();
        res.render('lecturer', { user, todayRecords });
    } catch (err) { res.status(500).send("Lecturer Portal Load Error"); }
});

app.get('/student', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user || user.role !== 'Student') return res.redirect('/login?error=Unauthorized');
    try {
        const records = await Attendance.find({ section: user.section, "students.studentId": user.rollNo }).sort({ date: -1 }).lean();
        let presentCount = records.filter(rec => rec.students.find(s => s.studentId === user.rollNo && s.status === 'Present')).length;
        res.render('student', { user, records, presentCount, totalCount: records.length });
    } catch (err) { res.status(500).send("Student Portal Load Error"); }
});

app.get('/super-admin-dashboard', async (req, res) => {
    const user = req.user || req.session.user;
    if (!user || user.role !== 'SuperAdmin' || !user.isApproved) return res.redirect('/login?error=Unauthorized');
    try {
        const [allUsers, allSubjects] = await Promise.all([
            User.find({}).select('-password').sort({ role: 1 }).lean(),
            Subject.find({}).lean()
        ]);
        res.render('super-admin', { user, allUsers, allSubjects, stats: { totalUsers: allUsers.length, pendingApprovals: allUsers.filter(u => !u.isApproved).length } });
    } catch (err) { res.status(500).send("Admin Dashboard Load Error"); }
});

// AUTHENTICATION ROUTES
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user || user.password !== password) return res.send("<script>alert('Invalid credentials'); window.location.href='/login';</script>");
        if (user.role !== 'Master' && !user.isApproved) return res.send("<script>alert('Awaiting approval'); window.location.href='/login';</script>");
        
        req.session.user = user;
        req.session.save(() => res.redirect(`/${user.role.toLowerCase()}`));
    } catch (err) { res.status(500).send("Login Error"); }
});

app.post('/register', async (req, res) => {
    const { name, email, password, role, section, rollNo } = req.body;
    try {
        if (!email.endsWith('@rku.ac.in')) return res.status(400).send("Use @rku.ac.in email.");
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ name, email: email.toLowerCase(), password: hashedPassword, role, section, rollNo, isApproved: false });
        await newUser.save();
        res.redirect('/login?message=Registration successful! Pending approval.');
    } catch (err) { res.status(500).send("Registration Error"); }
});

app.get('/logout', (req, res) => {
    if (req.logout) req.logout(() => {});
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.listen(3000, () => console.log('🚀 Server started on http://localhost:3000'));