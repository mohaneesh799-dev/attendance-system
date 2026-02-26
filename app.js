const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const fileUpload = require('express-fileupload'); // FIXED: was imported in package.json but never required/mounted

const upload = multer({ dest: 'uploads/' });
const session = require('express-session'); 
const MongoStore = require('connect-mongo').default;
const mongoose = require('mongoose');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs'); 






// --- ADD THIS CODE HERE ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}


const app = express();

// FIXED: helmet() default CSP blocks ALL inline <script> tags, onclick attributes,
// and addEventListener calls — silently. Every JS feature on every page was dead.
// Configured to allow 'unsafe-inline' scripts while keeping all other security headers.
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
app.use(fileUpload()); // FIXED: express-fileupload must be mounted for /upload-users to work



// --- SECTION 1: SESSION SETTINGS ---
app.set('trust proxy', 1); // Place this right above the session config

app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: true,                
    saveUninitialized: false,    
    proxy: true,                 
    store: MongoStore.create({ 
        mongoUrl: process.env.MONGO_URI,
        touchAfter: 24 * 3600    
    }),
    cookie: { 
        secure: process.env.NODE_ENV === 'production', // FIXED: was always true, which breaks local HTTP dev
        httpOnly: true, 
        sameSite: 'lax',         
        maxAge: 24 * 60 * 60 * 1000 
    }
}));


// Your existing lines 13 and 14 follow
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// ----------------------------------

// -- The Bridge (MongoDB Connection) -- (Current line 10)


// --- The Bridge (MongoDB Connection) ---
// IMPORTANT: Ensure you have added 0.0.0.0/0 in MongoDB Atlas Network Access!
// FIXED: Use environment variable — never hardcode credentials in source code.
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error("❌ FATAL: MONGO_URI environment variable is not set. Check your .env file.");
    process.exit(1);
}

mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ Connection error:', err));


const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;


const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});



app.use(passport.initialize());
app.use(passport.session());


passport.serializeUser((user, done) => {
    // This ensures the whole user object or at least the ID is saved to session
    done(null, user); 
});

passport.deserializeUser((user, done) => {
    done(null, user);
});



passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "https://attendance-system-g6f8.onrender.com/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;

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

            // DO NOT USE AWAIT HERE. This prevents the "Bad Request" timeout.
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.DEVELOPER_EMAIL,
                subject: 'New Admin Request',
                text: `Approve user: ${email}`
            };

            transporter.sendMail(mailOptions, (err) => {
                if (err) console.log("📧 Email blocked by Render Free Tier (Expected).");
            });
        }
        
        // IMMEDIATELY finish the login process
        return done(null, user); 

    } catch (err) {
        console.error("Google Auth Error:", err);
        return done(err, null);
    }
}));




// Line 37 in app.js
const userSchema = new mongoose.Schema({
    // Change 'required' to false or provide a default
    name: { type: String, required: false, default: '' }, 
    email: { type: String, required: true, unique: true, index: true },
    rollNo: { type: String, index: true, default: '' },
    
    // This is correct: required: false allows Google Login to work
    password: { type: String, required: false }, 
    
    role: { type: String, default: 'Student' }, 
    section: { type: String, default: '' },
    isApproved: { type: Boolean, default: false },
    isPreRegistered: { type: Boolean, default: false },
    // Lecturer who also manages a division as class teacher
    isClassTeacher: { type: Boolean, default: false },
    classTeacherSection: { type: String, default: '' }
});

const User = mongoose.model('User', userSchema);

// --- Updated Attendance Schema ---
const attendanceSchema = new mongoose.Schema({
    date: String,
    manualTime: String, // New field for manual entry
    periodNumber: { type: String, required: false }, // Made optional to fix the error in image 1c6329
    subject: String,
    lecturerEmail: String,
    leaderEmail: String,
    section: { type: String, required: true }, // Crucial for filtering
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
    section: { type: String, index: true } // FIXED: was missing; every Subject.find() filters by section
});
const Subject = mongoose.model('Subject', subjectSchema);


// 3. Define the storage configuration (This is the "mandatory" part for stability)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir); // Uses the absolute path created above
    },
    filename: (req, file, cb) => {
        // Gives each file a unique name to prevent overwriting
        cb(null, Date.now() + '-' + file.originalname);
    }
});



app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));




// Verify connection configuration on startup
// FIXED: Wrapped in try-catch — on Render free tier, if Gmail blocks the SMTP
// connection check, this was throwing and crashing the app before any routes loaded.
try {
    transporter.verify((error, success) => {
        if (error) {
            console.warn("⚠️ Mail Server Warning (non-fatal): " + error.message);
        } else {
            console.log("✅ Mail Server is ready to send approval links");
        }
    });
} catch (e) {
    console.warn("⚠️ Mail Server could not be verified (non-fatal):", e.message);
}



// --- GET ROUTES (To show pages) ---
app.get('/', (req, res) => {
    res.render('login', { showEmailForm: false, error: null, message: null });
});

// ADD THIS NOW:
app.get('/login', (req, res) => {
    res.render('login', { showEmailForm: false, error: req.query.error || null, message: req.query.message || null });
});

// FIXED: This route was missing — login.ejs "Admin / Faculty Login" button pointed here but got a 404
app.get('/login-email', (req, res) => {
    res.render('login', { showEmailForm: true, error: req.query.error || null, message: req.query.message || null });
});

// FIXED: This route was missing — register.ejs form posts here but got a 404
app.post('/register-super-admin', async (req, res) => {
    const { name, email, password, masterKey } = req.body;

    if (!masterKey || masterKey !== process.env.ADMIN_APPROVAL_SECRET) {
        return res.status(403).send("<script>alert('Invalid Master Security Key.'); window.history.back();</script>");
    }

    try {
        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(400).send("<script>alert('Email already registered.'); window.history.back();</script>");
        }
        const hashed = await bcrypt.hash(password, 10);
        await new User({ name, email: email.toLowerCase(), password: hashed, role: 'SuperAdmin', isApproved: true }).save();
        res.redirect('/login?message=SuperAdmin account created. You can now log in.');
    } catch (err) {
        console.error("SuperAdmin Registration Error:", err);
        res.status(500).send("Registration failed: " + err.message);
    }
});

app.get('/auth/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account' // This helps if you have multiple Gmails logged in
  })
);


app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    // Force session save to MongoDB before redirecting
    req.session.save((err) => {
      if (err) {
          console.error("Session Save Error:", err);
          return res.redirect('/login');
      }

      const user = req.user;
      
      // 1. Handle Unapproved Users
      if (!user.isApproved) {
          return res.render('pending', { user });
      }

      // 2. Role-Based Routing
      const role = (user.role || "").toLowerCase().trim();
      console.log(`User ${user.email} authenticated. Role: ${role}`);

      switch(role) {
          case 'superadmin':
              res.redirect('/super-admin-dashboard');
              break;
          case 'master':
              res.redirect('/master');
              break;
          case 'leader':
              res.redirect('/leader');
              break;
          case 'lecturer':
              res.redirect('/lecturer');
              break;
          case 'student':
              res.redirect('/student');
              break;
          default:
              res.redirect('/login?error=RoleNotAssigned');
      }
    });
  }
);




app.get('/master', async (req, res) => {
    try {
        const user = req.user || req.session.user;

        // FIXED: A Lecturer who is also a class teacher (isClassTeacher:true) must be able
        // to access this dashboard for their assigned division.
        const isClassTeacher = user && user.role === 'Lecturer' && user.isClassTeacher;

        if (!user || (user.role !== 'Master' && !isClassTeacher)) {
            return res.redirect('/login?error=unauthorized');
        }

        // Use classTeacherSection for lecturer-class-teachers, section for Masters
        const facultySection = isClassTeacher ? user.classTeacherSection : user.section;

        const [allUsers, masterSubjects] = await Promise.all([
            User.find({ section: facultySection }).lean(),
            Subject.find({ section: facultySection }).lean()
        ]);

        const stats = {
            total: allUsers.length || 0,
            pending: allUsers.filter(u => {
                const status = u.isApproved !== undefined ? u.isApproved : u.approved;
                return status === false;
            }).length,
            subjects: masterSubjects.length || 0
        };

        req.session.save(() => {
            res.render('master', { 
                user: { ...user, section: facultySection }, // pass effective section to template
                allUsers: allUsers || [], 
                masterSubjects: masterSubjects || [], 
                stats: stats 
            });
        });

    } catch (err) {
        console.error("❌ Master Dashboard Error:", err);
        res.status(500).send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px;">
                <h2>Internal Server Error</h2>
                <p>Failed to load faculty portal.</p>
                <a href="/login">Return to Login</a>
            </div>
        `);
    }
});


app.get('/leader', async (req, res) => {
    // 1. Safety Check: Ensure user is logged in and is a Leader
    const user = req.session.user || req.user;
    if (!user || user.role !== 'Leader') {
        return res.redirect('/login?error=Unauthorized');
    }

    try {
        // 2. Fetch Students and Leaders ONLY from the specific section
        // This prevents a Leader from Section A seeing students from Section B
        const studentsOnly = await User.find({
            section: user.section, 
            $or: [
                { role: 'Student' },
                { role: 'Leader' }
            ]
        }).sort({ rollNo: 1 }).lean();

        // 3. Fetch Lecturers (needed for the "Choose Lecturer" dropdown)
        // Note: Lecturers usually aren't tied to a specific section in the User model,
        // so we fetch all approved lecturers.
        const lecturers = await User.find({ 
            role: 'Lecturer', 
            isApproved: true 
        }).select('name email').lean();

        // 4. Fetch Subjects assigned to this specific section
        const masterSubjects = await Subject.find({ 
            section: user.section 
        }).lean();

        // 5. Render with all required data
        res.render('leader', { 
            user: user, 
            allUsers: studentsOnly,     // The list of students to mark
            lecturers: lecturers,       // For the lecturer dropdown
            masterSubjects: masterSubjects 
        });

    } catch (err) {
        console.error("❌ Leader Dashboard Route Error:", err);
        res.status(500).send("Internal Server Error: Could not load the Leader Entry portal.");
    }
});

app.get('/lecturer', async (req, res) => {
    try {
        const user = req.user || req.session.user;

        if (!user || user.role !== 'Lecturer') {
            return res.redirect('/login?error=Unauthorized');
        }

        const today = new Date().toISOString().split('T')[0];

        // FIXED: was { section: user.section } — only showed ONE division.
        // A lecturer teaches multiple divisions; querying by their email shows ALL.
        const todayRecords = await Attendance.find({
            lecturerEmail: user.email.toLowerCase(),
            date: today
        }).lean();

        // Collect the distinct sections this lecturer has taught today for display
        const sectionsToday = [...new Set(todayRecords.map(r => r.section))];

        const safeRecords = todayRecords || [];

        req.session.save(() => {
            res.render('lecturer', { 
                user: user, 
                todayRecords: safeRecords,
                sectionsToday: sectionsToday
            });
        });

    } catch (err) {
        console.error("❌ Lecturer Dashboard Error:", err);
        res.status(500).send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px;">
                <h2>Dashboard Error</h2>
                <p>Could not retrieve attendance logs for today.</p>
                <a href="/login">Try Logging in Again</a>
            </div>
        `);
    }
});


app.get('/student', async (req, res) => {
    // 1. Unified User Detection (Passport or Session)
    const user = req.session.user || req.user;

    // 2. Security Check: Redirect if not logged in or wrong role
    if (!user || user.role !== 'Student') {
        return res.redirect('/login?error=Unauthorized');
    }

    try {
        const userRoll = user.rollNo;
        const userSection = user.section;

        // 3. Optimized Database Query
        // We filter by section AND rollNo to ensure data isolation.
        // .lean() is used for faster read-only performance.
        const records = await Attendance.find({
            section: userSection,
            "students.studentId": userRoll 
        })
        .sort({ date: -1 })
        .limit(50) // Optional: limit to recent 50 records for performance
        .lean();

        // 4. Efficient Stats Calculation
        let presentCount = 0;
        records.forEach(rec => {
            const myEntry = rec.students.find(s => s.studentId === userRoll);
            if (myEntry && myEntry.status === 'Present') {
                presentCount++;
            }
        });

        // 5. Render with calculated variables
        res.render('student', { 
            user: user, 
            records: records, 
            presentCount: presentCount, 
            totalCount: records.length 
        });

    } catch (err) {
        console.error("❌ Student Dashboard Error:", err);
        res.status(500).send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px;">
                <h2>Database Error</h2>
                <p>We couldn't retrieve your attendance stats. Please try again later.</p>
                <a href="/login">Back to Login</a>
            </div>
        `);
    }
});


app.get('/super-admin-dashboard', async (req, res) => {
    try {
        const user = req.user || req.session.user;

        if (!user || user.role !== 'SuperAdmin' || user.isApproved !== true) {
            console.warn(`🛑 Unauthorized access attempt to SuperAdmin by: ${user ? user.email : 'Unknown'}`);
            return res.redirect('/login?error=Unauthorized Access');
        }

        const [allUsers, allSubjects] = await Promise.all([
            User.find({}).select('-password').sort({ section: 1, role: 1, name: 1 }).lean(),
            Subject.find({}).sort({ section: 1, name: 1 }).lean()
        ]);

        // Group users by section for division-wise display
        const usersBySection = {};
        allUsers.forEach(u => {
            const sec = u.section || 'Unassigned';
            if (!usersBySection[sec]) usersBySection[sec] = [];
            usersBySection[sec].push(u);
        });

        // Sorted section keys: Unassigned goes last
        const sections = Object.keys(usersBySection).sort((a, b) => {
            if (a === 'Unassigned') return 1;
            if (b === 'Unassigned') return -1;
            return a.localeCompare(b);
        });

        res.render('super-admin', { 
            user, 
            allUsers, 
            allSubjects,
            usersBySection,
            sections,
            stats: {
                totalUsers: allUsers.length,
                pendingApprovals: allUsers.filter(u => !u.isApproved).length,
                totalSubjects: allSubjects.length
            }
        });

    } catch (err) {
        console.error("🔥 SuperAdmin Dashboard Critical Error:", err);
        res.status(500).render('error', { 
            message: "System was unable to load administrative data. Please check database logs." 
        });
    }
});



app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // 1. Find user with basic sanitization
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user) {
            return res.send("<script>alert('Account not found. Please register first.'); window.location.href='/login';</script>");
        }

        // 2. Password Check — FIXED: was using plain === comparison, bypassing bcrypt hashing entirely
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.send("<script>alert('Invalid credentials. Please try again.'); window.location.href='/login';</script>");
        }

        // 3. Approval Gate
        // Masters bypass approval; all other roles (Student, Lecturer, Leader) must be approved
        if (user.role !== 'Master' && !user.isApproved) {
            return res.send("<script>alert('Your account is awaiting approval from the Master.'); window.location.href='/login';</script>");
        }

        // 4. Set Session Data
        // Storing the ID and RollNo is essential for attendance indexing
        req.session.user = {
            _id: user._id,
            email: user.email.toLowerCase(),
            role: user.role,
            name: user.name,
            section: user.section,
            rollNo: user.rollNo
        };

        // 5. Explicitly save session before redirecting
        // This prevents the "Login Loop" error common on platforms like Render or Heroku
        req.session.save((err) => {
            if (err) {
                console.error("Session Save Error:", err);
                return res.status(500).send("Login failed: Session could not be initialized.");
            }

            // 6. Dynamic Redirect based on Role
            const roleRedirects = {
                'master': '/master',
                'lecturer': '/lecturer',
                'leader': '/leader',
                'student': '/student'
            };

            const targetPath = roleRedirects[user.role.toLowerCase()] || '/student';
            res.redirect(targetPath);
        });

    } catch (err) {
        console.error("Login System Error:", err);
        res.status(500).render('error', { message: "Internal Server Error during the authentication process." });
    }
});

// --- Logout Route ---
app.get('/logout', (req, res) => {
    // FIXED: Previously req.logout() ran fire-and-forget while req.session.destroy()
    // ran in parallel — a race condition that left the session alive, so the redirect
    // sent the user back with an active session cookie = "logout not working".
    // Now session destruction is fully nested inside req.logout's callback.

    const destroySession = () => {
        req.session.destroy((err) => {
            if (err) console.error("Session destruction error:", err);
            res.clearCookie('connect.sid');
            res.redirect('/login?message=Logged out successfully');
        });
    };

    if (typeof req.logout === 'function') {
        req.logout((err) => {
            if (err) console.error("Passport logout error:", err);
            destroySession(); // Only destroy session AFTER passport clears its state
        });
    } else {
        destroySession();
    }
});



// --- Registration Page Route ---
app.get('/register', (req, res) => {
    // If user is already logged in, redirect them away from register page
    const loggedIn = req.session.user || req.user;
    if (loggedIn) {
        return res.redirect(`/${loggedIn.role.toLowerCase()}`);
    }
    res.render('register', { error: null }); 
});

// --- Settings Page Route ---
app.get('/settings', async (req, res) => {
    try {
        // 1. Auth Check: Ensure we know WHO is asking for settings
        const sessionUser = req.session.user || req.user;
        
        if (!sessionUser) {
            return res.redirect('/login?error=Please log in to access settings');
        }

        // 2. Fetch fresh data from DB (instead of just using session data)
        // This ensures if their role or status changed, it reflects here
        const userDetails = await User.findById(sessionUser._id).lean();

        if (!userDetails) {
            return res.status(404).render('error', { message: "Account no longer exists." });
        }

        // 3. Render settings with the specific user's data
        // FIXED: was passing `success:` but EJS template expects `message:` and `messageType:`
        res.render('settings', { 
            user: userDetails,
            message: req.query.success ? 'Profile updated successfully!' : null,
            messageType: req.query.success ? 'success' : null
        }); 

    } catch (err) {
        console.error("Settings Load Error:", err);
        res.status(500).render('error', { message: "Internal Server Error loading settings." });
    }
});

app.post('/update-settings', async (req, res) => {
    const { name, phone, currentPassword, newPassword } = req.body;
    // FIXED: was req.session.user._id only — crashes for Google OAuth users
    const sessionUser = req.session.user || req.user;
    if (!sessionUser) return res.redirect('/login');
    const userId = sessionUser._id;

    try {
        const user = await User.findById(userId);

        if (!user) return res.redirect('/login');

        // 1. Verify Current Password
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.render('settings', { 
                user: sessionUser, 
                message: "Incorrect current password!", 
                messageType: 'error' 
            });
        }

        // 2. Update Basic Info
        user.name = name;
        user.phone = phone;

        // 3. Update Password if provided
        if (newPassword && newPassword.trim() !== "") {
            if (newPassword.length < 6) {
                return res.render('settings', { 
                    user: sessionUser, 
                    message: "New password must be at least 6 characters.", 
                    messageType: 'error' 
                });
            }
            user.password = await bcrypt.hash(newPassword, 10);
        }

        await user.save();

        // 4. Update the session so the dashboard shows new name
        req.session.user = user; 

        res.render('settings', { 
            user: user, 
            message: "Profile updated successfully!", 
            messageType: 'success' 
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating settings.");
    }
});



app.post('/register', async (req, res) => {
    // Destructure all required fields from the registration form
    const { name, email, password, role, section, rollNo } = req.body;

    try {
        // 1. Basic Validation
        if (!email.endsWith('@rku.ac.in')) {
            return res.status(400).send("Please use your official @rku.ac.in email.");
        }

        // 2. Security: Check if user already exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).send("Email is already registered. Try logging in.");
        }

        // 3. Password Hashing
        const hashedPassword = await bcrypt.hash(password, 10);

        // 4. Create New User Object
        const newUser = new User({
            name: name,
            email: email.toLowerCase(),
            password: hashedPassword,
            role: role,
            section: section, // Crucial for dashboard data isolation
            rollNo: rollNo || "", // Optional for faculty, required for students
            isApproved: false,
            isPreRegistered: false
        });

        await newUser.save();
        console.log(`✅ New registration request: ${email} (${role})`);

        // 5. Notification System (Admin Email)
        try {
            const approvalLink = `${req.protocol}://${req.get('host')}/super-admin-dashboard`;
            
            const mailOptions = {
                from: process.env.EMAIL_USER || process.env.DEVELOPER_EMAIL,
                to: process.env.DEVELOPER_EMAIL, // Primary Admin Email
                subject: `🔔 Approval Required: ${name} (${role})`,
                html: `
                    <div style="font-family: sans-serif; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
                        <h2 style="color: #2c3e50;">New User Registration</h2>
                        <p><strong>Name:</strong> ${name}</p>
                        <p><strong>Email:</strong> ${email}</p>
                        <p><strong>Role:</strong> ${role}</p>
                        <p><strong>Section/Dept:</strong> ${section}</p>
                        <p><strong>Roll No:</strong> ${rollNo || 'N/A'}</p>
                        <hr>
                        <p>Please log in to the SuperAdmin dashboard to approve this user.</p>
                        <a href="${approvalLink}" style="background: #3498db; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Open Admin Panel</a>
                    </div>
                `
            };
            await transporter.sendMail(mailOptions);
        } catch (mailErr) {
            console.error("⚠️ Mailer Error: User saved, but admin notification failed.");
        }

        // 6. Success Response
        res.redirect('/login?message=Registration successful! Your account is pending admin approval.');

    } catch (err) {
        console.error("❌ Registration Error:", err);
        if (err.code === 11000) return res.status(400).send("Email or Roll Number already exists.");
        res.status(500).send("Critical error during registration.");
    }
});





app.post('/upload-users', async (req, res) => {
    try {
        const adminUser = req.session.user || req.user;
        if (!adminUser || adminUser.role !== 'Master') return res.status(403).send("Unauthorized");

        if (!req.files || !req.files.csvFile) return res.status(400).send("No file uploaded");
        
        const fileData = req.files.csvFile.data.toString('utf8');
        const lines = fileData.split(/\r?\n/); // Handles both Windows and Unix line endings
        const section = req.body.section;

        if (!section) return res.status(400).send("Target section is required.");

        // Loop through rows (skipping header)
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue; // Skip empty lines

            const [name, email, studentId] = lines[i].split(',').map(item => item.trim());
            
            if (email && email.includes('@')) {
                await User.updateOne(
                    { email: email.toLowerCase() },
                    { 
                        $set: {
                            name: name, 
                            rollNo: studentId, // Ensure field names match your schema (rollNo vs studentId)
                            section: section,
                            role: 'Student',
                            isApproved: true,
                            isPreRegistered: true // Tag to differentiate bulk-uploaded students
                        }
                    },
                    { upsert: true }
                );
            }
        }

        req.session.save(() => {
            res.redirect('/master?success=Bulk import completed');
        });
    } catch (err) {
        console.error("Bulk Upload Error:", err);
        res.status(500).send("Error processing file: " + err.message);
    }
});


function isAdmin(req, res, next) {
    const user = req.session.user || req.user;
    
    // Allow both Master and SuperAdmin roles
    if (user && (user.role === 'Master' || user.role === 'SuperAdmin')) {
        return next();
    }

    console.warn(`🚨 Unauthorized access attempt by: ${user ? user.email : 'Guest'}`);
    
    req.session.save(() => {
        res.redirect('/login?error=Access Denied');
    });
}



app.post('/lock-attendance', async (req, res) => {
    try {
        // FIXED: was req.session.user only — Google OAuth users only have req.user (Passport).
        // This was the cause of the "Unauthorized" error for all Google-logged-in Leaders.
        const leader = req.session.user || req.user;
        if (!leader || leader.role !== 'Leader') return res.status(403).send("Unauthorized");

        const { section, lecturerEmail, manualTime, subject, date, students } = req.body;

        // FIXED: Validate required fields before processing — previously would throw
        // unhandled errors like "Cannot convert undefined to object" crashing the route
        if (!subject || !manualTime || !date) {
            return res.status(400).send("<script>alert('Please fill in all fields (Lecturer, Time Slot, Date, Subject).'); window.history.back();</script>");
        }

        // FIXED: students was undefined if section has no students, causing Object.keys crash
        if (!students || typeof students !== 'object') {
            return res.status(400).send("<script>alert('No student data received. Please reload and try again.'); window.history.back();</script>");
        }

        // 1. Data Transformation
        const studentList = Object.keys(students).map(key => {
            const s = students[key];
            return {
                studentId: s.id || key,
                studentName: s.name || '',
                status: s.status === 'Present' ? 'Present' : 'Absent'
            };
        });

        // 2. Create the locked record
        const newAttendance = new Attendance({
            section: section || leader.section,
            date: date || new Date().toISOString().split('T')[0],
            manualTime, 
            subject,
            lecturerEmail: (lecturerEmail || '').toLowerCase(), // FIXED: was .toLowerCase() on undefined if blank
            leaderEmail: leader.email,
            students: studentList,
            isLockedByLeader: true,
            submissionTimestamp: new Date()
        });

        await newAttendance.save();
        
        // 3. User Feedback
        res.send(`
            <script>
                alert('Attendance for ${subject} has been locked and saved.');
                window.location.href='/leader';
            </script>
        `);

    } catch (err) { 
        console.error("Locking Error:", err);
        res.status(500).send("Error locking attendance: " + err.message); 
    }
});


app.post('/approve-user/:id', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;

        // 1. Unified Authorization Check
        // Checks if user exists and has administrative privileges
        if (!currentUser || (currentUser.role !== 'Master' && currentUser.role !== 'SuperAdmin')) {
            return res.status(403).render('error', { message: "Unauthorized: Administrative access required." });
        }

        const targetUserId = req.params.id;

        // 2. Execution: Update user and return the document to verify it existed
        const updatedUser = await User.findByIdAndUpdate(
            targetUserId, 
            { isApproved: true }, 
            { new: true }
        );

        if (!updatedUser) {
            const failPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
            return res.redirect(`${failPath}?error=UserNotFound`);
        }

        console.log(`✅ User Approved: ${updatedUser.email} by ${currentUser.email}`);

        // 3. Session Synchronization & Redirect
        // req.session.save ensures the redirect happens only after the session store is updated
        req.session.save((err) => {
            if (err) {
                console.error("Session Save Error:", err);
            }
            
            const successPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
            res.redirect(`${successPath}?success=UserApproved&name=${encodeURIComponent(updatedUser.name || updatedUser.email)}`);
        });

    } catch (err) {
        console.error("❌ Approval Route Error:", err);
        res.status(500).render('error', { message: "Internal Server Error during user approval." });
    }
});



// --- Delete User Route ---
app.post('/delete-user/:id', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;

        // 1. Authorization: Only Master or SuperAdmin can delete
        if (!currentUser || (currentUser.role !== 'Master' && currentUser.role !== 'SuperAdmin')) {
            return res.status(403).render('error', { message: "Unauthorized: Access Denied" });
        }

        // 2. Execution
        const targetId = req.params.id;
        
        // Prevent accidental self-deletion
        if (targetId === currentUser._id.toString()) {
            return res.status(400).send("Security Error: You cannot delete your own account.");
        }

        await User.findByIdAndDelete(targetId);
        console.log(`🗑️ User ${targetId} deleted by ${currentUser.email}`);

        // 3. Dynamic Redirect based on role
        req.session.save(() => {
            const redirectPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
            res.redirect(`${redirectPath}?success=User deleted`);
        });

    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).render('error', { message: "Failed to delete user." });
    }
});



// --- Bulk Approval Route ---
app.post('/bulk-approve', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;

        // 1. Authorization Check
        if (!currentUser || (currentUser.role !== 'Master' && currentUser.role !== 'SuperAdmin')) {
            return res.redirect('/login?error=Unauthorized');
        }

        let { userIds, targetRole } = req.body;

        // 2. Data Sanitization: Convert single ID string to Array if necessary
        if (!userIds) return res.redirect('/master?error=No users selected');
        const idsToUpdate = Array.isArray(userIds) ? userIds : [userIds];

        // 3. Update Operation
        // We set both isApproved and approved to true to satisfy different schema versions
        await User.updateMany(
            { _id: { $in: idsToUpdate } },
            { 
                $set: { 
                    role: targetRole, 
                    isApproved: true, 
                    approved: true 
                } 
            }
        );
        
        console.log(`✅ Bulk Approved ${idsToUpdate.length} users as ${targetRole}`);

        // 4. Session sync and Redirect
        req.session.save(() => {
            const redirectPath = currentUser.role === 'SuperAdmin' ? '/super-admin-dashboard' : '/master';
            res.redirect(`${redirectPath}?success=Users approved successfully`);
        });

    } catch (err) {
        console.error("Bulk Approval Error:", err);
        const redirectPath = (req.session.user && req.session.user.role === 'SuperAdmin') ? '/super-admin-dashboard' : '/master';
        res.redirect(`${redirectPath}?error=Approval failed`);
    }
});



app.get('/generate-day-pdf/:date', async (req, res) => {
    try {
        // FIXED: was req.session.user only — breaks for Google OAuth users
        const sessionUser = req.session.user || req.user;
        if (!sessionUser) return res.redirect('/login');

        const { date } = req.params;
        const { filter } = req.query;
        const userSection = sessionUser.section;

        const records = await Attendance.find({ 
            date: date, 
            section: userSection 
        }).sort({ manualTime: 1 });

        const doc = new PDFDocument({ margin: 50, size: 'A4' });

        // Stream the PDF directly to the browser
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=Attendance_${userSection}_${date}.pdf`);
        doc.pipe(res);

        // --- Header Section ---
        doc.fillColor('#2c3e50').fontSize(22).text('RKU Attendance Report', { align: 'center' });
        doc.fontSize(12).fillColor('#7f8c8d').text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown();

        doc.fillColor('black').fontSize(14).text(`Date: ${date}`, { continued: true });
        doc.text(` | Section: ${userSection}`, { align: 'right' });
        if (filter) doc.fillColor('#e74c3c').text(`Filter: Showing ${filter} only`, { align: 'center' });
        
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();

        if (records.length === 0) {
            doc.fontSize(14).text("No records found for this section on this date.", { align: 'center' });
        } else {
            records.forEach((rec, index) => {
                // Background for slot header
                doc.rect(50, doc.y, 500, 20).fill('#f1f2f6');
                doc.fillColor('#2f3542').fontSize(11).text(` SLOT: ${rec.manualTime} | SUBJECT: ${rec.subject}`, 55, doc.y - 15);
                doc.moveDown(0.5);

                // Table Headers
                const startY = doc.y;
                doc.fillColor('#000').fontSize(10).text('Student ID', 60, startY, { bold: true });
                doc.text('Student Name', 160, startY);
                doc.text('Status', 450, startY);
                doc.moveDown(0.5);
                doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#dfe4ea').stroke();

                // List Students
                rec.students.forEach(s => {
                    if (!filter || s.status === filter) {
                        // Check for page overflow
                        if (doc.y > 700) doc.addPage();

                        doc.fillColor('#34495e').fontSize(9)
                           .text(s.studentId, 60, doc.y)
                           .text(s.name || s.studentName, 160, doc.y - 9)
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
        console.error("PDF Error:", err);
        res.status(500).send("Error generating PDF.");
    }
});

app.get('/leader-history', async (req, res) => {
    try {
        // FIXED: was req.session.user only
        const sessionUser = req.session.user || req.user;
        if (!sessionUser) return res.status(401).json({ error: "Unauthorized" });

        const records = await Attendance.find({ 
            leaderEmail: sessionUser.email 
        })
        .sort({ date: -1 })
        .lean();

        // Optional: Map data to include a quick summary count
        const historyData = records.map(r => ({
            ...r,
            presentCount: r.students.filter(s => s.status === 'Present').length,
            totalCount: r.students.length
        }));

        res.json(historyData);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

app.get('/view-pdf', (req, res) => {
    // We get the date from the query or default to today
    const today = new Date().toISOString().split('T')[0];
    const targetDate = req.query.date || today;
    
    // Redirect to the dynamic generator route
    res.redirect(`/generate-day-pdf/${targetDate}`);
});


app.post('/update-attendance-status', async (req, res) => {
    // 1. Enhanced Authorization (Allow both Lecturer and Master)
    const user = req.session.user || req.user;
    const allowedRoles = ['Lecturer', 'Master', 'SuperAdmin'];
    
    if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).json({ success: false, message: "Unauthorized: Insufficient Permissions" });
    }

    const { attendanceId, studentId, newStatus } = req.body;

    // 2. Input Validation
    if (!attendanceId || !studentId || !newStatus) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    try {
        // 3. Precision Update using Positional Operator ($)
        // We verify the ID, the specific student in the array, and the section for security
        const query = { 
            _id: attendanceId, 
            "students.studentId": studentId 
        };

        // FIXED: Previously restricted Lecturers to only their one registered section.
        // A lecturer who teaches multiple divisions must be able to update any record
        // where they are the assigned lecturer, regardless of section.
        if (user.role === 'Lecturer') {
            query.lecturerEmail = user.email.toLowerCase(); // they can only edit their own records
        }

        const update = {
            $set: {
                "students.$.status": newStatus,
                "lastModifiedBy": user.email,
                "lastModifiedDate": new Date()
            }
        };

        

        const result = await Attendance.findOneAndUpdate(query, update, { new: true });

        if (result) {
            console.log(`✅ Attendance Updated: Student ${studentId} marked ${newStatus} by ${user.email}`);
            res.json({ 
                success: true, 
                message: "Status updated successfully",
                updatedBy: user.email 
            });
        } else {
            // If result is null, either the Attendance ID is wrong or that student isn't in this specific record
            res.status(404).json({ 
                success: false, 
                message: "Record not found. Ensure the student is part of this attendance sheet." 
            });
        }
    } catch (err) {
        console.error("🔥 Attendance Update Error:", err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

// --- Add Subject Route ---
app.post('/add-subject', async (req, res) => {
    try {
        // 1. Consistent Auth Check
        const user = req.session.user || req.user;
        if (!user || user.role !== 'Master') {
            return res.redirect('/login?error=Unauthorized');
        }

        const { subjectName, subjectCode, section } = req.body; // FIXED: was missing subjectCode

        // 2. Validation: Prevent empty subject names
        if (!subjectName || !section) {
            return res.redirect('/master?error=Missing Fields');
        }

        // 3. Create and Save
        const newSub = new Subject({ 
            name: subjectName.trim(), 
            code: (subjectCode || '').trim(), // FIXED: code was never saved
            section: section 
        });
        await newSub.save();
        
        // 4. Manual Session Save
        // This ensures the database update and session state are in sync before the redirect
        req.session.save((err) => {
            if (err) console.error("Session Save Error:", err);
            res.redirect('/master?success=Subject Added');
        });

    } catch (err) {
        console.error("Add Subject Error:", err);
        // Handle duplicate subject names if you have a unique index
        const msg = err.code === 11000 ? 'Duplicate Subject' : 'Server Error';
        res.redirect(`/master?error=${msg}`);
    }
});



// --- Delete Subject Route ---
app.post('/delete-subject/:id', async (req, res) => {
    try {
        // 1. Consistent Auth Check
        const user = req.session.user || req.user;
        if (!user || user.role !== 'Master') {
            return res.status(403).send("Unauthorized Access");
        }

        // 2. Execution
        const deletedSub = await Subject.findByIdAndDelete(req.params.id);

        if (!deletedSub) {
            return res.redirect('/master?error=Subject not found');
        }

        // 3. Save session before redirecting to refresh state
        req.session.save(() => {
            res.redirect('/master?success=Subject Deleted');
        });

    } catch (err) {
        console.error("Delete Subject Error:", err);
        res.status(500).render('error', { message: "Could not remove subject from database." });
    }
});


// --- Set/Unset Class Teacher for a Lecturer ---
app.post('/set-class-teacher/:id', async (req, res) => {
    try {
        const currentUser = req.session.user || req.user;
        if (!currentUser || currentUser.role !== 'SuperAdmin') {
            return res.status(403).render('error', { message: "Unauthorized" });
        }

        const { classTeacherSection, removeClassTeacher } = req.body;

        if (removeClassTeacher === 'true') {
            await User.findByIdAndUpdate(req.params.id, {
                isClassTeacher: false,
                classTeacherSection: ''
            });
        } else {
            if (!classTeacherSection) {
                return res.redirect('/super-admin-dashboard?error=Please select a section');
            }
            await User.findByIdAndUpdate(req.params.id, {
                isClassTeacher: true,
                classTeacherSection: classTeacherSection
            });
        }

        req.session.save(() => {
            res.redirect('/super-admin-dashboard?success=Class teacher status updated');
        });
    } catch (err) {
        console.error("Set Class Teacher Error:", err);
        res.status(500).render('error', { message: "Failed to update class teacher status." });
    }
});


app.get('/fix-database', async (req, res) => {
    try {
        const users = await User.find({});
        let updatedCount = 0;

        for (let user of users) {
            let needsUpdate = false;

            // 1. Fix Roll Number capitalization if it was uploaded wrong
            if (user.rollno && !user.rollNo) {
                user.rollNo = user.rollno;
                needsUpdate = true;
            }

            // 2. Ensure everyone has a role (Default to Student if missing)
            if (!user.role) {
                user.role = 'Student';
                needsUpdate = true;
            }

            if (needsUpdate) {
                await user.save();
                updatedCount++;
            }
        }
        res.send(`Database Fixed! Updated ${updatedCount} users. Now check your Leader Board.`);
    } catch (err) {
        res.status(500).send("Error fixing database: " + err.message);
    }
});


app.get('/attendance-history', async (req, res) => {
    // 1. Authentication Gate
    const user = req.session.user || req.user;
    if (!user) return res.redirect('/login');

    try {
        const { startDate, endDate } = req.query;
        let query = {};

        // 2. Optimized Date Filtering
        // If no dates are provided, default to the last 30 days to prevent loading massive datasets
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        } else {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            query.date = { $gte: thirtyDaysAgo.toISOString().split('T')[0] };
        }

        // 3. Security: Role-Based Data Isolation
        if (user.role === 'Student') {
            // Students only see records containing their Roll Number
            query["students.studentId"] = user.rollNo;
            query.section = user.section; // Double security: ensure it's their section
        } 
        else if (user.role === 'Lecturer') {
            // Lecturers see only what they personally marked
            query.lecturerEmail = user.email;
        } 
        else if (user.role === 'Leader') {
            // Leaders see everything for their assigned section
            query.section = user.section;
        }
        // Masters (SuperAdmins) fall through and see everything by default

        // 4. Fetching Data with Lean for Performance
        const history = await Attendance.find(query)
            .sort({ date: -1 })
            .lean(); // Returns plain JS objects, making rendering significantly faster

        // 5. Render Response
        res.render('history', { 
            user: user, 
            records: history,
            startDate: startDate || "",
            endDate: endDate || ""
        });

    } catch (err) {
        console.error("❌ History Fetch Error:", err);
        res.status(500).render('error', { message: "Failed to load attendance logs." });
    }
});



// FIXED: Removed duplicate /super-admin-dashboard route that was here.
// The first definition (above) is more robust; duplicate routes are a bug.


app.post('/submit-super-admin-request', async (req, res) => {
    const user = req.session.user || req.user;
    if (!user) return res.redirect('/login');

    // Create a secure approval link using your environment secret
    const approvalLink = `${req.protocol}://${req.get('host')}/approve-super-admin?email=${user.email}&secret=${process.env.ADMIN_APPROVAL_SECRET}`;

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.DEVELOPER_EMAIL,
        subject: `⚠️ Access Elevation Request: ${user.name}`,
        html: `
            <h3>Elevation Request</h3>
            <p><strong>User:</strong> ${user.name} (${user.email})</p>
            <p>The user above has requested SuperAdmin privileges.</p>
            <br>
            <a href="${approvalLink}" style="padding: 10px 20px; background-color: #27ae60; color: white; text-decoration: none; border-radius: 5px;">
                Approve as SuperAdmin
            </a>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        res.send("<script>alert('Elevation request sent to developer. You will be notified via email upon approval.'); window.location='/login';</script>");
    } catch (err) {
        console.error("Mail Error:", err);
        res.status(500).send("Failed to send request. Contact developer directly.");
    }
});



app.get('/approve-super-admin', async (req, res) => {
    const { email, secret } = req.query;

    // 1. Verify the secret key from your .env file
    if (!secret || secret !== process.env.ADMIN_APPROVAL_SECRET) {
        return res.status(403).render('error', { message: "Invalid or missing Secret Approval Key" });
    }

    try {
        // 2. Find user, change role to SuperAdmin AND set isApproved to true
        const updatedUser = await User.findOneAndUpdate(
            { email: email.toLowerCase() },
            { 
                role: 'SuperAdmin', 
                isApproved: true 
            },
            { new: true }
        );

        if (!updatedUser) return res.status(404).render('error', { message: "User not found" });

        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #27ae60;">Access Granted!</h1>
                <p><strong>${email}</strong> has been promoted to <b>SuperAdmin</b>.</p>
                <p>They can now log in to the admin dashboard.</p>
                <a href="/login">Go to Portal</a>
            </div>
        `);
    } catch (err) {
        res.status(500).render('error', { message: "Critical Database Error during promotion." });
    }
});



app.get('/export-attendance', async (req, res) => {
    try {
        const user = req.session.user || req.user;
        const { startDate, endDate } = req.query;

        // 1. Authorization Check
        if (!user || !['Lecturer', 'Leader', 'SuperAdmin'].includes(user.role)) {
            return res.status(403).send("Unauthorized to export data.");
        }

        const section = user.section;

        // 2. Build Query with Optional Date Filtering
        let attendanceQuery = { section };
        if (startDate && endDate) {
            attendanceQuery.date = { $gte: startDate, $lte: endDate };
        }

        // 3. Fetch Data in Parallel
        const [students, attendanceRecords] = await Promise.all([
            User.find({ section, role: 'Student' }).select('rollNo name').lean(),
            Attendance.find(attendanceQuery).sort({ date: 1 }).lean()
        ]);

        // 4. Construct CSV with sanitization
        // Using "Roll No" and "Name" first for a cleaner spreadsheet layout
        let csv = "\uFEFF"; // UTF-8 BOM for Excel compatibility (prevents encoding issues)
        csv += "Roll No,Student Name,Date,Subject,Time Slot,Status\n";

        attendanceRecords.forEach(record => {
            const formattedDate = record.date; // Assuming YYYY-MM-DD string
            const subject = record.subject || "N/A";
            const time = record.manualTime || "N/A";

            students.forEach(student => {
                // Check if this student exists in the record's student array
                const attendanceEntry = record.students.find(s => s.studentId === student.rollNo);
                const status = attendanceEntry ? attendanceEntry.status : 'N/A';
                
                // Sanitize name to prevent CSV injection (escapes quotes and handles commas)
                const sanitizedName = `"${student.name.replace(/"/g, '""')}"`;

                csv += `${student.rollNo},${sanitizedName},${formattedDate},${subject},${time},${status}\n`;
            });
        });

        // 5. Send File
        const fileName = `Attendance_${section}_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.status(200).send(csv);

    } catch (err) {
        console.error("Export Error:", err);
        res.status(500).send("Critical error during CSV generation.");
    }
});


// Add this at the very bottom of app.js
app.use((err, req, res, next) => {
    console.error("🔥 Server Error:", err.stack);
    res.status(500).send(`<h2>Internal Server Error</h2><p>${err.message}</p><a href="/login">Back to Login</a>`);
});

// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);

    // ---------------------------------------------------------------
    // RENDER FREE TIER FIX: Self-ping every 14 minutes.
    // Render spins down free services after 15 min of inactivity,
    // causing a 30-60 second cold-start 503 on the next request.
    // Pinging ourselves keeps the dyno warm continuously.
    // ---------------------------------------------------------------
    if (process.env.NODE_ENV === 'production') {
        const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://attendance-system-g6f8.onrender.com`;
        setInterval(() => {
            const https = require('https');
            https.get(`${RENDER_URL}/ping`, (res) => {
                console.log(`🏓 Keep-alive ping: ${res.statusCode}`);
            }).on('error', (err) => {
                console.warn('Keep-alive ping failed (non-critical):', err.message);
            });
        }, 14 * 60 * 1000); // every 14 minutes
    }
});

// Health-check endpoint (used by keep-alive ping and Render's own monitor)
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ---------------------------------------------------------------
// PREVENT FULL CRASH on unhandled errors (another 503 cause).
// Without these, a single unhandled Promise rejection crashes the
// Node process and Render shows 503 until it restarts the dyno.
// ---------------------------------------------------------------
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🔥 Unhandled Promise Rejection (server kept alive):', reason);
});