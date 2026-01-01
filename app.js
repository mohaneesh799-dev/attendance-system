const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
const upload = multer({ dest: 'uploads/' });
const session = require('express-session'); 


// --- ADD THIS CODE HERE ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}


const app = express();

// 2. PASTE THIS CONFIGURATION HERE (Before your routes)
app.use(session({
    secret: 'attendance_system_secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } 
}));

// Your existing lines 13 and 14 follow
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// ----------------------------------

// -- The Bridge (MongoDB Connection) -- (Current line 10)


// --- The Bridge (MongoDB Connection) ---
// IMPORTANT: Ensure you have added 0.0.0.0/0 in MongoDB Atlas Network Access!
const mongoURI = "mongodb+srv://mohaneesh799:Mohan0354@cluster0.0jkiiez.mongodb.net/attendanceDB"; 

mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ Connection error:', err));


const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID, // DO NOT paste the actual ID here
    clientSecret: process.env.GOOGLE_CLIENT_SECRET, // DO NOT paste the secret here
    callbackURL: "https://attendance-system-g6f8.onrender.com/auth/google/callback" 
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    // Force official university domain
    if (!email.endsWith('@rku.ac.in')) {
        return done(null, false, { message: 'Use official @rku.ac.in email' });
    }
    let user = await User.findOne({ email: email });
    if (!user) {
        user = new User({ 
            googleId: profile.id, 
            email: email, 
            name: profile.displayName,
            approved: false // New users still need Master approval
        });
        await user.save();
    }
    return done(null, user);
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    const user = await User.findById(id);
    done(null, user);
});


// Line 37 in app.js
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String }, // Optional for pre-registered students until they sign up
    role: { type: String, default: 'Student' },
    isApproved: { type: Boolean, default: false }, // Master must toggle this
    isPreRegistered: { type: Boolean, default: false }, // True if added via CSV
    name: String,
    rollNo: String
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
    code: String
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

// --- Nodemailer Setup ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // true for port 465, false for other ports
    auth: {
        user: 'mohaneesh799@gmail.com',
        pass: 'nebwuplytzeecwcy' // NO SPACES HERE
    }
});

// --- GET ROUTES (To show pages) ---
app.get('/', (req, res) => {
    res.render('login');
});

// ADD THIS NOW:
app.get('/login', (req, res) => {
    res.render('login');
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
    // 1. Refresh the local session user with the latest data from Passport
    req.session.user = req.user; 

    // 2. FORCE a save to the session store
    req.session.save((err) => {
      if (err) {
          console.error("Session save error:", err);
          return res.redirect('/login');
      }

      const user = req.session.user;

      // 3. Precise Role-Based Redirection
      if (user.role === 'Master') {
          res.redirect('/master');
      } else if (user.role === 'Lecturer') {
          res.redirect('/lecturer'); // Redirecting specifically for Lecturers
      } else if (user.role === 'Leader') {
          res.redirect('/leader');
      } else {
          res.redirect('/student'); // Default fallback
      }
    });
  }
);


app.get('/master', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Master') {
        return res.redirect('/login');
    }
    try {
        // Fetch ALL data required by the master.ejs template
        const users = await User.find({});
        const subjects = await Subject.find({}); 

        res.render('master', { 
            user: req.session.user,
            allUsers: users,          // MUST match the loop in master.ejs
            masterSubjects: subjects  // MUST match the loop in master.ejs
        });
    } catch (err) {
        console.error("Master Route Error:", err);
        res.status(500).send("Internal Server Error: Missing data for Master Dashboard.");
    }
});


app.get('/leader', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Leader') return res.redirect('/login');

    try {
        // Fetch all users and subjects
        const allUsers = await User.find({}); 
        const masterSubjects = await Subject.find({});

        res.render('leader', { 
            user: req.session.user, 
            allUsers: allUsers, 
            masterSubjects: masterSubjects 
        });
    } catch (err) {
        res.status(500).send("Error loading Leader Dashboard");
    }
});


// --- Get Lecturer's Locked Records ---
app.get('/lecturer', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Lecturer') return res.redirect('/login');

    try {
        // Filter by Lecturer Email AND ensure it is locked by the Leader
        const assignedRecords = await Attendance.find({ 
            lecturerEmail: req.session.user.email,
            isLockedByLeader: true 
        }).sort({ date: -1 });

        res.render('lecturer', { 
            user: req.session.user, 
            records: assignedRecords 
        });
    } catch (err) {
        res.status(500).send("Error loading dashboard.");
    }
});


app.get('/student', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Student') return res.redirect('/login');

    try {
        const userRoll = req.session.user.rollNo;

        // Use $elemMatch to find the student inside the array
        const records = await Attendance.find({
            "students": { $elemMatch: { studentId: userRoll } }
        }).sort({ date: -1 });

        // Calculate stats for the summary cards
        let present = 0;
        records.forEach(rec => {
            const me = rec.students.find(s => s.studentId === userRoll);
            if (me && me.status === 'Present') present++;
        });

        res.render('student', { 
            user: req.session.user, 
            records, 
            presentCount: present, 
            totalCount: records.length 
        });
    } catch (err) {
        res.status(500).send("Error loading board.");
    }
});


app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user) {
            return res.send("<script>alert('User not found.'); window.location.href='/login';</script>");
        }

        if (user.role !== 'Master' && !user.isApproved) {
            return res.send("<script>alert('Approval Pending. Please wait for the Master.'); window.location.href='/login';</script>");
        }

        if (user.password !== password) {
            return res.send("<script>alert('Invalid Password'); window.location.href='/login';</script>");
        }

        // SETTING SESSION - Crucial for lecturer data retrieval
        req.session.user = {
            id: user._id,
            email: user.email.toLowerCase(),
            role: user.role, // This will now be 'Lecturer' if updated by Master
            name: user.name
        };

     // Replace lines 299-307 in your app.js
const userRole = user.role.toLowerCase(); 
if (userRole === 'master') {
    res.redirect('/master');
} else if (userRole === 'lecturer') {
    res.redirect('/lecturer');
} else if (userRole === 'leader') {
    res.redirect('/leader');
} else {
    res.redirect('/student');
}

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).send("Internal Server Error during login.");
    }
});


app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { 
            return next(err); 
        }
        req.session.destroy(() => {
            res.clearCookie('connect.sid'); 
            res.redirect('/'); 
        });
    });
});


app.get('/settings', async (req, res) => {
    try {

    
        const currentUser = await User.findOne({ role: 'Student' }); 

        if (!currentUser) {
            return res.send("User not found. Please log in again.");
        }


        res.render('settings', { user: currentUser }); 
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading settings page.");
    }
});

app.post('/update-settings', async (req, res) => {
    try {
        const { name, rollNo, themeColor, email } = req.body;
       
        

      
        const userEmail = email; 

        await User.findOneAndUpdate(
            { email: userEmail },
            { $set: { name: name, rollNo: rollNo, theme: themeColor } }
        );

        res.send("<script>alert('Settings Updated!'); window.location.href='/student';</script>");
    } catch (err) {
        res.status(500).send("Update failed");
    }
});


// --- UPDATE FROM LINE 235 ---
app.post('/register', async (req, res) => {
    // 1. Capture ONLY email, password, and role
    const { email, password, role } = req.body; 
    
    try {
        // 2. Hash the password
        const hashedPassword = await bcrypt.hash(password, 10); 

        // 3. Create the new user with empty name and rollNo
        const newUser = new User({
            email,
            password: hashedPassword,
            role,
            approved: false,
            name: "",   // Initialized as empty
            rollNo: ""  // Initialized as empty
        });
        // 2. Save to MongoDB
        await newUser.save();
        console.log("✅ User saved to DB");

        // 3. Setup the approval link (This uses your Ngrok URL or Render URL)
        const approvalLink = `https://unwashable-giana-better.ngrok-free.dev/approve-user/${newUser._id}`;

        // 4. Send the notification email
        const mailOptions = {
            from: 'mohaneesh799@gmail.com',
            to: 'mohaneesh799@gmail.com', // Sending to yourself for approval
            subject: 'New User Registration Request',
            html: `<h3>New Registration</h3>
                   <p>Email: ${email}</p>
                   <p>Role: ${role}</p>
                   <a href="${approvalLink}">Click here to Approve this user</a>`
        };

        await transporter.sendMail(mailOptions);
        console.log("📧 Approval email sent");

        // 5. Tell the user it worked
        res.send("Registration successful! Please wait for admin approval.");

    } catch (err) {
        console.error("❌ Registration Error:", err);
        res.status(500).send("Registration failed. Error: " + err.message);
    }
});







app.post('/upload-users', upload.single('csvFile'), (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");

    const users = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (row) => {
            // Mapping CSV columns to your UserSchema
            if (row.email) {
                users.push({
                    rollNo: row.rollno ? row.rollno.trim() : '',
                    name: row.name ? row.name.trim() : 'New User',
                    email: row.email.toLowerCase().trim(),
                    role: 'Student', // Default until Master changes it
                    isApproved: false,
                    isPreRegistered: true // Match the field in your schema
                });
            }
        })
        .on('end', async () => {
            try {
                if (users.length > 0) {
                    // ordered: false allows continuing if some emails are duplicates
                    await User.insertMany(users, { ordered: false });
                }
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                res.send("<script>alert('CSV Uploaded! Check approval table.'); window.location.href='/master';</script>");
            } catch (err) {
                console.error("Upload Error:", err);
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                res.status(500).send("Upload failed. Ensure no duplicate emails exist.");
            }
        });
});

app.post('/lock-attendance', async (req, res) => {
    try {
        const { lecturerEmail, manualTime, subject, date, students } = req.body;
        const newAttendance = new Attendance({
            date,
            manualTime, // Save the manual text string
            subject,
            lecturerEmail,
            leaderEmail: req.session.user.email,
            students: Object.values(students).map(s => ({
                studentId: s.id,
                studentName: s.name,
                status: s.status || 'Absent'
            })),
            isLockedByLeader: true
        });
        // IMPORTANT: Ensure periodNumber is NOT required in your mongoose schema!
        await newAttendance.save();
        res.send("<script>alert('Locked!'); window.location.href='/leader';</script>");
    } catch (err) { res.status(500).send(err.message); }
});



app.post('/approve-user/:id', async (req, res) => {
    try {
        const { role } = req.body; // Captured from the <select name="role"> dropdown
        await User.findByIdAndUpdate(req.params.id, { 
            isApproved: true, 
            role: role 
        });
        res.redirect('/master');
    } catch (err) {
        res.status(500).send("Approval process failed.");
    }
});

// --- DELETE USER ROUTE ---
app.post('/delete-user/:id', async (req, res) => {
    try {
        // This removes the user from the MongoDB collection based on their unique ID
        await User.findByIdAndDelete(req.params.id);
        
        // After deletion, refresh the Master Dashboard to show the updated list
        res.redirect('/master');
    } catch (err) {
        console.error("Delete Error:", err);
        res.status(500).send("Failed to delete user: " + err.message);
    }
});


// --- BATCH APPROVAL ROUTE ---
app.post('/approve-multiple', async (req, res) => {
    try {
        let { userEmails } = req.body;

        // If only one user is selected, convert string to array
        if (typeof userEmails === 'string') {
            userEmails = [userEmails];
        }

        if (!userEmails || userEmails.length === 0) {
            return res.redirect('/master');
        }

        // Update all selected users at once
        await User.updateMany(
            { email: { $in: userEmails } }, 
            { $set: { approved: true } }
        );

        console.log(`✅ Batch approval successful for: ${userEmails.length} users`);
        res.redirect('/master');
    } catch (err) {
        console.error("Batch Approval Error:", err);
        res.status(500).send("Error processing batch approvals.");
    }
});


// UPDATED PDF GENERATION ROUTE
app.get('/generate-day-pdf/:date', async (req, res) => {
    try {
        const { date } = req.params;
        const { filter } = req.query; // Capture the 'filter' from the URL
        
        const records = await Attendance.find({ date: date }).sort({ manualTime: 1 });

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument();
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=Attendance_Report_${date}.pdf`);

        doc.fontSize(20).text(`Attendance Report: ${date}`, { align: 'center' });
        if (filter) doc.fontSize(12).text(`Filter Applied: ${filter}`, { align: 'center' });
        doc.moveDown();

        records.forEach(rec => {
            doc.fontSize(14).text(`Slot: ${rec.manualTime} | Subject: ${rec.subject}`, { underline: true });
            
            rec.students.forEach(s => {
                // Apply the filter logic
                if (!filter || s.status === filter) {
                    doc.fontSize(10).text(`${s.studentName} (${s.studentId}): ${s.status}`);
                }
            });
            doc.moveDown();
        });

        doc.pipe(res);
        doc.end();
    } catch (err) {
        console.error("PDF Error:", err);
        res.status(500).send("Error generating PDF");
    }
});

// History Route for Leader Dashboard
app.get('/leader-history', async (req, res) => {
    if (!req.session.user) return res.json([]);
    const records = await Attendance.find({ leaderEmail: req.session.user.email }).sort({ date: -1 });
    res.json(records);
});

// 2. ROUTE TO VIEW THE PDF (FOR THE "CHECK PDF" BUTTON)
app.get('/view-pdf', (req, res) => {
    const filePath = path.join(__dirname, 'daily_attendance.pdf');
    if (fs.existsSync(filePath)) {
        res.contentType("application/pdf");
        fs.createReadStream(filePath).pipe(res);
    } else {
        res.send("<script>alert('PDF not found. Please generate it first.'); window.location.href='/leader';</script>");
    }
});


// REPLACE your current route in app.js with this:
app.post('/update-attendance-status', async (req, res) => {
    // 1. Check if user is logged in as Lecturer
    if (!req.session.user || req.session.user.role !== 'Lecturer') {
        return res.status(403).json({ success: false });
    }

    const { attendanceId, studentId, newStatus } = req.body;

    try {
        // 2. Update ONLY the specific student's status in the array
        const result = await Attendance.updateOne(
            { 
                _id: attendanceId, 
                "students.studentId": studentId 
            },
            { 
                $set: { 
                    "students.$.status": newStatus,
                    lastModifiedBy: 'Lecturer',
                    lastModifiedDate: new Date()
                } 
            }
        );

        if (result.modifiedCount > 0) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, message: "No changes made" });
        }
    } catch (err) {
        console.error("Update Error:", err);
        res.status(500).json({ success: false });
    }
});


app.post('/add-subject', async (req, res) => {
    if (!req.body.name || req.body.name.trim() === "") return res.redirect('/master');
    const newSub = new Subject({ name: req.body.name.trim() });
    await newSub.save();
    res.redirect('/master');
});


app.post('/delete-subject/:id', async (req, res) => {
    try {
        if (!req.session.user || req.session.user.role !== 'Master') {
            return res.status(403).send("Unauthorized");
        }
        await Subject.findByIdAndDelete(req.params.id);
        res.redirect('/master');
    } catch (err) {
        res.status(500).send("Error deleting subject");
    }
});


// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});