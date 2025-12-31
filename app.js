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

const User = mongoose.model('User', userSchema); // Fixed: Only one declaration here


// --- ATTENDANCE SCHEMA (Added for daily periods) ---
const attendanceSchema = new mongoose.Schema({
    date: { type: String, required: true },
    periodNumber: { type: String, required: true },
    subject: { type: String, required: true },
    leaderEmail: String,
    students: [
        {
            studentId: String,
            status: String
        }
    ]
});

const Attendance = mongoose.model('Attendance', attendanceSchema);


const subjectSchema = new mongoose.Schema({
    name: String,
    code: String
});
const Subject = mongoose.model('Subject', subjectSchema);


// --- Middleware ---
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
    // Safety check: Only allow Master role
    if (!req.session.user || req.session.user.role !== 'Master') {
        return res.redirect('/login');
    }

    try {
        // Fetch subjects for the timetable section
        const subjects = await Subject.find();

        // FETCH ALL USERS: This is what prevents the Internal Server Error
        // We find everyone who is NOT the Master to show in your new management table
        const allUsers = await User.find({ role: { $ne: 'Master' } });

        res.render('master', { 
            subjects: subjects, 
            allUsers: allUsers // This variable MUST be passed for the EJS loop to work
        });
    } catch (err) {
        console.error("Master Route Error:", err);
        res.status(500).send("Internal Server Error: Missing 'allUsers' data.");
    }
});


// Change the name to /leader to match your portal URL
app.get('/leader', async (req, res) => {
if (!req.session.user || (req.session.user.role !== 'Class Leader' && req.session.user.role !== 'Leader')) {
    console.log("Access Denied: User role is", req.session.user ? req.session.user.role : "None");
    return res.redirect('/login');
}
    try {
        const students = await User.find({ role: 'Student' });
        const subjects = (await Subject.find()) || []; // Ensures it's at least an empty list
        const users = await User.find({ role: 'Lecturer', approved: true });
        res.render('leader', { students, subjects, users }); 
    } catch (err) {
        res.status(500).send("Error loading Leader page");
    }
});

app.get('/lecturer', async (req, res) => {
    // Security check: Only allow users with the 'Lecturer' role
    if (!req.session.user || req.session.user.role !== 'Lecturer') {
        return res.redirect('/login');
    }

    try {
        // Render your lecturer.ejs template
        res.render('lecturer', { user: req.session.user });
    } catch (err) {
        console.error("Lecturer Dashboard Error:", err);
        res.status(500).send("Internal Server Error: Dashboard failed to load.");
    }
});

app.get('/student', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    try {
        const userEmail = req.session.user.email;
        const allRecords = await Attendance.find(); //

        const subjectStats = {};
        const history = [];

        allRecords.forEach(rec => {
            // Find this student in the record's student array
            const sEntry = rec.students.find(s => s.email === userEmail);
            
            if (sEntry) {
                // Add to Day-wise History
                history.push({
                    date: rec.date,
                    subject: rec.subject,
                    status: sEntry.status
                });

                // Calculate Subject-wise stats
                if (!subjectStats[rec.subject]) {
                    subjectStats[rec.subject] = { total: 0, present: 0 };
                }
                subjectStats[rec.subject].total++;
                if (sEntry.status === 'Present') subjectStats[rec.subject].present++;
            }
        });

res.render('student', { 
            user: req.session.user, 
            subjectStats: subjectStats, 
            history: history           
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});


app.post('/login', async (req, res) => {

    try {
        const { email, password } = req.body;
        // Find user and handle case-sensitivity/whitespace
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user) {
            return res.send("<script>alert('User not found. Please contact the Master.'); window.location.href='/login';</script>");
        }


        if (user.role !== 'Master' && !user.isApproved) {
            return res.send("<script>alert('Approval Pending: Please wait for the Master to approve your account.'); window.location.href='/login';</script>");
        }


        // 2. PASSWORD CHECK (If you are using passwords)
        if (user.password && user.password !== password) {
            return res.send("<script>alert('Invalid Password'); window.location.href='/login';</script>");
        }


        req.session.user = {
            id: user._id,
            email: user.email,
            role: user.role, // This will now correctly be 'Master'
            name: user.name
        };


        if (user.role === 'Master') {
    res.redirect('/master');
} else if (user.role === 'Lecturer') {
    // Add this specific case
    res.redirect('/lecturer'); 
} else if (user.role === 'Leader') {
    res.redirect('/leader');
} else {
    // This is the default catch-all that was sending Lecturers to Student
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






app.post('/upload-students', upload.single('studentFile'), async (req, res) => {
    const studentsToUpload = [];
    if (!req.file) return res.status(400).send("No file uploaded.");

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => studentsToUpload.push(data))
        .on('end', async () => {
            try {
                for (let student of studentsToUpload) {
                   // Inside your csv().on('end') loop
await User.findOneAndUpdate(
    { email: student.email.toLowerCase().trim() }, 
    { 
        rollNo: student.rollNo, 
        name: student.name, 
        role: 'Student',
        isPreRegistered: true, // Mark as coming from the official file
        isApproved: false      // Must wait for Master's approval
    },
    { upsert: true }
);
                }
                fs.unlinkSync(req.file.path); // Deletes the temporary file
                res.send("<script>alert('Master student list updated!'); window.location.href='/master';</script>");
            } catch (err) {
                res.status(500).send("Upload Error: " + err.message);
            }
        });
});


app.post('/lock-period', async (req, res) => {
    // If this check fails, it redirects and looks like a refresh
    if (!req.session || !req.session.user) {
        console.log("Session missing!"); // Add this to debug
        return res.redirect('/login'); 
    }

   try {
    // We extract 'period' (from the form) and rename it to 'periodNumber' for the database
const { lecturerEmail, subject, date, students } = req.body; 
console.log("-> Lecturer Email received:", lecturerEmail);
const newAttendance = new Attendance({
    // 2. Use the date from the form or default to today's date
    date: date || new Date().toISOString().split('T')[0], 
    
    // 3. Keep this hardcoded as '1' so the database is satisfied
    periodNumber: '1', 
    
    subject: subject,
    leaderEmail: req.session.user.email,
    lecturerEmail: lecturerEmail,
    // 4. Add a fallback to '[]' to prevent JSON.parse from crashing if students is empty
    students: JSON.parse(students || '[]') 
});
    await newAttendance.save();
    console.log("✅ Record Saved!");
    res.send("<script>alert('Attendance Locked Successfully!'); window.location.href='/leader';</script>"); 
   } catch (err) {
        console.error("Save Error:", err);
        res.status(500).send(err.message);
    }
});


// --- KEEP ONLY THIS SINGLE BLOCK ---
app.post('/approve-user/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        
        // This 'role' name must match the <select name="role"> in master.ejs
        const assignedRole = req.body.role; 

        // Update the user: Approve them and set their new role simultaneously
        await User.findByIdAndUpdate(userId, { 
            isApproved: true, 
            role: assignedRole 
        });

        console.log(`User ${userId} approved as ${assignedRole}`);
        res.redirect('/master');

    } catch (err) {
        console.error("Approval Error:", err);
        res.status(500).send("Internal Server Error: Could not approve user.");
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


app.post('/generate-daily-pdf', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const allPeriods = await Attendance.find({ date: today }).sort({ periodNumber: 1 });

        if (allPeriods.length === 0) return res.send("No periods locked today.");

        const PDFDocument = require('pdfkit'); // Ensure this is installed
        const doc = new PDFDocument();
        
        // Loop through all periods to build one PDF
        doc.text(`Daily Attendance Report - ${today}`, { align: 'center' });
        allPeriods.forEach(p => {
            doc.moveDown().fontSize(14).text(`Period ${p.periodNumber}: ${p.subject}`);
            p.students.forEach(s => doc.fontSize(10).text(`- ${s.status}: ${s.studentId}`));
        });
        doc.end();

        // Send one email with the full report
        const mailOptions = {
            from: 'your-email@gmail.com',
            to: 'master-email@gmail.com', 
            subject: `Full Attendance Report - ${today}`,
            attachments: [{ filename: `Daily_Report.pdf`, content: doc }]
        };



// --- NEW ROUTE FOR TEACHER DASHBOARD ATTENDANCE SWITCHING ---
app.post('/edit-attendance', async (req, res) => {
    try {
        const { studentId, newStatus } = req.body; // Gets data from your lecturer.ejs

        // Update the student's status in MongoDB
        await User.findByIdAndUpdate(studentId, { status: newStatus });

        console.log(`✅ Attendance updated: ${studentId} is now ${newStatus}`);
        
        // Refresh the page so the teacher sees the new status
        res.redirect('back'); 
    } catch (err) {
        console.error("Edit Attendance Error:", err);
        res.status(500).send("Error updating attendance.");
    }
});


        await transporter.sendMail(mailOptions);
        res.send("Full Day PDF Sent Successfully!");
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});


// Add this in the POST routes section of app.js
app.post('/add-subject', async (req, res) => {
    try {
        const { name, code } = req.body;
        const newSubject = new Subject({ name, code });
        await newSubject.save();
        console.log("✅ Subject Added:", name);
        res.redirect('/master'); // Redirect back to master, NOT /master dashboard
    } catch (err) {
        console.error("Error adding subject:", err);
        res.status(500).send("Error adding subject");
    }
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