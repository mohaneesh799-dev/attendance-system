const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const session = require('express-session'); 
const MongoStore = require('connect-mongo'); // FIXED: Removed .default for compatibility
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

// --- DATABASE CONNECTION ---
const mongoURI = process.env.MONGO_URI || "mongodb+srv://mohaneesh799:Mohan0354@cluster0.0jkiiez.mongodb.net/attendanceDB"; 
mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ Connection error:', err));

// --- SETTINGS & MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('trust proxy', 1); // Required for cookies to work on Render HTTPS
app.use(helmet({ contentSecurityPolicy: false })); // Permissive CSP for Google Icons
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SESSION CONFIGURATION (MUST be before Passport) ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,                
    saveUninitialized: false,    
    proxy: true,                 
    store: MongoStore.create({ 
        mongoUrl: mongoURI,
        touchAfter: 24 * 3600    
    }),
    cookie: { 
        secure: true, // Set to true for Render HTTPS           
        httpOnly: true, 
        sameSite: 'lax',         
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// --- PASSPORT INITIALIZATION ---
app.use(passport.initialize());
app.use(passport.session());

// --- MAIL CONFIGURATION ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587, // Port 587 is more stable for Render than 465
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: { type: String, default: '' }, 
    email: { type: String, required: true, unique: true, index: true },
    rollNo: { type: String, index: true, default: '' },
    password: { type: String, required: false }, 
    role: { type: String, default: 'Student' }, 
    section: { type: String, default: '' },
    googleId: String,
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

// --- AUTH STRATEGY ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "https://attendance-system-g6f8.onrender.com/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
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

            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: 'mohaneesh799@gmail.com',
                subject: 'New Admin Request',
                text: `Approve user: ${email}`
            }).catch(e => console.log("📧 Background email failed."));
        }
        return done(null, user); 
    } catch (err) {
        return done(err, null);
    }
}));

// --- MULTER SETUP ---
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    })
});

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
      const role = (req.user.role || "student").toLowerCase();
      res.redirect(`/${role}`);
    });
  }
);

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user) return res.send("<script>alert('Account not found.'); window.location.href='/login';</script>");
        
        // Note: For security, use bcrypt.compare(password, user.password) if using hashed passwords
        if (user.password !== password) return res.send("<script>alert('Invalid Password'); window.location.href='/login';</script>");

        if (user.role !== 'Master' && !user.isApproved) {
            return res.send("<script>alert('Pending approval.'); window.location.href='/login';</script>");
        }

        req.session.user = {
            _id: user._id,
            email: user.email,
            role: user.role,
            section: user.section,
            rollNo: user.rollNo
        };

        req.session.save(() => {
            const path = user.role.toLowerCase();
            res.redirect(`/${path}`);
        });
    } catch (err) {
        res.status(500).send("Login Error");
    }
});

// --- DASHBOARDS ---

app.get('/master', async (req, res) => {
    const user = req.user || req.session.user;
    if (!user || user.role !== 'Master') return res.redirect('/login');
    
    const allUsers = await User.find({ section: user.section }).lean();
    const masterSubjects = await Subject.find({ section: user.section }).lean();
    res.render('master', { user, allUsers, masterSubjects });
});

app.get('/leader', async (req, res) => {
    const user = req.user || req.session.user;
    if (!user || user.role !== 'Leader') return res.redirect('/login');

    const studentsOnly = await User.find({ section: user.section, role: { $in: ['Student', 'Leader'] } }).lean();
    const lecturers = await User.find({ role: 'Lecturer', isApproved: true }).lean();
    const masterSubjects = await Subject.find({ section: user.section }).lean();
    res.render('leader', { user, allUsers: studentsOnly, lecturers, masterSubjects });
});

// --- PDF GENERATION (FIXED: No duplicate PDFDocument declaration) ---
app.get('/generate-day-pdf/:date', async (req, res) => {
    try {
        const user = req.user || req.session.user;
        if (!user) return res.redirect('/login');

        const { date } = req.params;
        const records = await Attendance.find({ date: date, section: user.section }).sort({ manualTime: 1 });

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        res.setHeader('Content-Type', 'application/pdf');
        doc.pipe(res);

        doc.fontSize(20).text(`Attendance Report - ${date}`, { align: 'center' });
        doc.moveDown();

        records.forEach(rec => {
            doc.fontSize(12).text(`Subject: ${rec.subject} | Time: ${rec.manualTime}`);
            rec.students.forEach(s => {
                doc.fontSize(10).text(`${s.studentId} - ${s.studentName}: ${s.status}`);
            });
            doc.moveDown();
        });

        doc.end();
    } catch (err) {
        res.status(500).send("PDF Generation Error");
    }
});

// --- SERVER START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});