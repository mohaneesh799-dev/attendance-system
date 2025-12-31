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
const User = require('./models/User');
const Attendance = require('./models/Attendance');
const Subject = require('./models/Subject'); // Check if this file exists!
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



const attendanceSchema = new mongoose.Schema({
    date: { type: String, required: true },
    periodNumber: { type: String, required: true },
    subject: { type: String, required: true },
    leaderEmail: { type: String, required: true },
    lecturerEmail: { type: String, required: true }, // Crucial for Lecturer Dashboard
    timeSlot: String,
    students: [ // Named 'students' to match Atlas
        {
            studentId: String,
            studentName: String,
            status: { type: String, default: 'Absent' }
        }
    ],
    isLockedByLeader: { type: Boolean, default: true }
});



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
    try {
        const allUsers = await User.find({ role: { $in: ['Student', 'Lecturer'] } });
        const masterSubjects = await Subject.find({}); // Fetch the Master's fixed subjects
        const todayRecords = await Attendance.find({ 
            date: new Date().toISOString().split('T')[0] 
        });

        res.render('leader', { 
            user: req.session.user, 
            allUsers, 
            masterSubjects, // Pass fixed subjects to EJS
            todayRecords 
        });
    } catch (err) {
        res.status(500).send("Error loading dashboard");
    }
});


app.get('/lecturer', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Lecturer') {
        return res.redirect('/login');
    }
    try {
        // Use regex for case-insensitive email matching
        const records = await Attendance.find({ 
            lecturerEmail: { $regex: new RegExp("^" + req.session.user.email + "$", "i") } 
        }).sort({ date: -1 });

        res.render('lecturer', { 
            user: req.session.user, 
            attendanceRecords: records || [] 
        });
    } catch (err) {
        res.status(500).send("Internal Server Error: Could not load dashboard.");
    }
});



app.get('/student', async (req, res) => {
    try {
        // Query must search inside the 'records' array for the student's name
        const records = await Attendance.find({ 
            "records.studentName": req.session.user.name 
        });
        res.render('student', { user: req.session.user, attendanceRecords: records });
    } catch (err) {
        res.status(500).send("Error loading student data.");
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


app.post('/lock-attendance', async (req, res) => {
    try {
        // 1. Destructure exactly what comes from your leader dashboard form
        const { lecturerEmail, subject, date, students, periodNumber } = req.body;

        const newAttendance = new Attendance({
            date: date || new Date().toISOString().split('T')[0],
            periodNumber: periodNumber || "1",
            subject: subject,
            leaderEmail: req.session.user.email,
            lecturerEmail: lecturerEmail, // CRITICAL: Fixes blank Lecturer Dashboard
            
            // 2. Map the students array to match your Atlas schema
            students: Object.values(students).map(s => ({
                studentId: s.id,
                studentName: s.name,
                status: s.status || 'Absent'
            })),
            isLockedByLeader: true
        });

        await newAttendance.save();
        res.send("<script>alert('Locked Successfully!'); window.location.href='/leader';</script>");
    } catch (err) {
        console.error("Locking Error:", err);
        res.status(500).send("Error saving attendance: " + err.message);
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


// 1. ROUTE TO GENERATE/RE-GENERATE THE PDF
app.post('/generate-pdf', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        // Fetch all periods locked for today, sorted by time/period
        const allPeriods = await Attendance.find({ date: today }).sort({ periodNumber: 1 });

        if (allPeriods.length === 0) {
            return res.send("<script>alert('No periods locked today. Cannot generate PDF.'); window.location.href='/leader';</script>");
        }



        const doc = new PDFDocument();
        const filePath = path.join(__dirname, 'daily_attendance.pdf');
        
        // Save file to server so it can be viewed/checked
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // PDF Header
        doc.fontSize(20).text(`Daily Attendance Report - ${today}`, { align: 'center' });
        doc.moveDown();

        // Loop through each period locked by the leader
        allPeriods.forEach(p => {
            doc.fontSize(14).fillColor('blue').text(`Subject: ${p.subject} (Period: ${p.periodNumber || 'N/A'})`);
            doc.fontSize(10).fillColor('black').text(`Lecturer: ${p.lecturerEmail}`);
            
            // List students for this specific period
            p.students.forEach(s => {
                const statusColor = s.status === 'Present' ? 'green' : 'red';
                doc.fontSize(11).fillColor(statusColor).text(`  - ${s.studentId}: ${s.status}`);
            });
            doc.moveDown();
        });

        doc.end();

        // Wait for the file to finish writing before redirecting
        stream.on('finish', () => {
            res.send("<script>alert('PDF Generated Successfully! You can now check it.'); window.location.href='/leader';</script>");
        });

    } catch (err) {
        console.error("PDF Generation Error:", err);
        res.status(500).send("Error generating PDF: " + err.message);
    }
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


// NEW REPLACEMENT ROUTE FOR LECTURER CORRECTIONS
app.post('/lecturer/update-attendance/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Lecturer') {
        return res.redirect('/login');
    }

    try {
        const attendanceId = req.params.id;
        const updatedRecords = req.body.attendance; // From the lecturer.ejs form

        // Find the specific attendance document and update the records array
        await Attendance.findByIdAndUpdate(attendanceId, {
            records: updatedRecords.map(s => ({
                studentId: s.studentId,
                studentName: s.studentName,
                status: s.status
            })),
            lastModifiedBy: 'Lecturer',
            lastModifiedDate: new Date()
        });

        res.send("<script>alert('Attendance Updated Successfully!'); window.location.href='/lecturer';</script>");
    } catch (err) {
        console.error("Lecturer Update Error:", err);
        res.status(500).send("Error updating record: " + err.message);
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