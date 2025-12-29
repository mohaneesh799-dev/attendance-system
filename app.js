const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const path = require('path');
const bcrypt = require('bcrypt');
// 1. ADD THIS LINE HERE
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
    name: { type: String, default: "" },
    rollNo: { type: String, default: "" },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: false }, // Change to false for Google users
    googleId: { type: String }, // ADD THIS LINE
    role: { type: String, default: 'Student' },
    approved: { type: Boolean, default: false }
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

app.get('/auth/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account' // This helps if you have multiple Gmails logged in
  })
);

// Handle the callback after Google login
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    if (!req.user.approved) { // Master still controls access
        return res.send("<h1>Pending Master Approval</h1><a href='/logout'>Logout</a>");
    }
    req.session.user = req.user; // Set session for your existing dashboard logic
    
    // Redirect based on the role you assigned in Master Dashboard
    if (req.user.role === 'Master') return res.redirect('/master');
    if (req.user.role === 'Lecturer') return res.redirect('/lecturer');
    if (req.user.role === 'Leader') return res.redirect('/leader');
    res.redirect('/student');
  });

// --- UPDATE YOUR MASTER ROUTE STARTING AT LINE 54 ---
app.get('/master', async (req, res) => {
    try {
        // 1. Fetch the user data from MongoDB
        const users = await User.find({}); 
        
        // 2. Pass that data to your master.ejs file.jpg]
        res.render('master', { users: users }); 
    } catch (err) {
        console.error("❌ Error loading master dashboard:", err);
        res.status(500).send("Internal Server Error");
    }
});


app.post('/delete-user/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Master') {
        return res.status(403).send("Unauthorized");
    }
    await User.findByIdAndDelete(req.params.id); // Deletes from MongoDB
    res.redirect('/master');
});


app.get('/leader', async (req, res) => {
    try {
        // 1. Fetch all users who are Students for the attendance table
        const studentList = await User.find({ role: 'Student' });

        // 2. Fetch ALL users so the EJS can filter for approved Lecturers
        const allUsers = await User.find({});

        // 3. Pass BOTH variables to the page
        res.render('leader', { 
            students: studentList, 
            users: allUsers 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading Leader dashboard.");
    }
});

app.get('/lecturer', async (req, res) => {
    try {
        // 1. Check if the session and user exist first
        if (!req.session || !req.session.user) {
            return res.redirect('/login'); // Redirect to login if not authenticated
        }

       // Inside app.get('/lecturer', ...) in app.js
            const loggedInEmail = req.session.user.email.toLowerCase(); // Convert to lowercase
            const records = await Attendance.find({ 
            lecturerEmail: { $regex: new RegExp("^" + loggedInEmail + "$", "i") } // Case-insensitive search
        });

        // 3. Render using the exact name expected by your EJS
        res.render('lecturer', { 
            attendanceRecords: records, 
            user: req.session.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading dashboard");
    }
});

app.get('/student', async (req, res) => {
    try {
        const users = await User.find({});
        const studentList = users.filter(u => u.role === 'Student');

        res.render('student', { 
            users: users, 
            students: studentList, // ADD THIS LINE TO FIX THE ERROR
            user: { email: "student@example.com" } 
        });
    } catch (err) {
        res.status(500).send("Error loading Student dashboard");
    }
});


app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // 1. Find user by email
        const user = await User.findOne({ email: email });

        // If user doesn't exist, stop here
        if (!user) {
            console.log("❌ Login failed: Email not found");
            return res.status(400).send("Invalid email or password");
        }

        // 2. CHECK APPROVAL STATUS
        // If the user exists but is not approved, send a specific message
        if (user.approved === false) {
            console.log("⚠️ Login blocked: User not approved yet");
            return res.status(403).send("Your account is pending admin approval.");
        }

        // Inside app.post('/login'), replace lines 91-95 with:
const isMatch = await bcrypt.compare(password, user.password);

if (!isMatch) {
    console.log("❌ Login failed: Wrong password");
    // 'return' ensures the code stops here if the password is wrong
    return res.status(400).send("Invalid email or password"); 
}

// SUCCESS BLOCK (Keep only this one)
req.session.user = user; 
console.log("✅ Login successful for:", email);
// Redirect based on the user's role (Lecturer, Leader, etc.)
res.redirect(`/${user.role.toLowerCase()}`); 

} catch (err) {
        console.error("🔥 Server Error during login:", err);
        res.status(500).send("Internal Server Error");
    }
});


app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { 
            return next(err); 
        }
        req.session.destroy(() => {
            res.clearCookie('connect.sid'); // Clears the login cookie
            res.redirect('/'); // Sends you back to the login page
        });
    });
});

// --- UPDATE YOUR SETTINGS ROUTE IN app.js ---
app.get('/settings', async (req, res) => {
    try {
        // Find the user by their email (in a real app, use req.session.email)
        // For now, we search for the student role to get their profile
        const currentUser = await User.findOne({ role: 'Student' }); 

        if (!currentUser) {
            return res.send("User not found. Please log in again.");
        }

        // Pass the 'currentUser' as 'user' to the EJS template
        res.render('settings', { user: currentUser }); 
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading settings page.");
    }
});

app.post('/update-settings', async (req, res) => {
    try {
        const { name, rollNo, themeColor, email } = req.body; // Added email from form
        
        // Instead of a hardcoded email, use the one from the form
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



app.post('/approve-user/:id', async (req, res) => {
    try {
        // Ensure only Master can do this
        if (!req.session.user || req.session.user.role !== 'Master') {
            return res.status(403).send("Unauthorized");
        }

        // Get the role from the dropdown (named assignedRole_ID)
        const assignedRole = req.body[`assignedRole_${req.params.id}`];

        await User.findByIdAndUpdate(req.params.id, { 
            approved: true, 
            role: assignedRole || 'Student' // Default to student if something goes wrong
        });

        res.redirect('/master'); // Refresh dashboard
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating user");
    }
});


app.post('/lock-period', async (req, res) => {
    try {

        const { periodNumber, subject, lecturerEmail } = req.body;
const userEmail = req.session.user.email;

// Add these right after you get the data from req.body
console.log("DEBUG: Form lecturerEmail is:", lecturerEmail);
console.log("DEBUG: Logged in Leader is:", req.session.user.email);

        // Troubleshooting: Add this log to see what the server is actually getting
        console.log("Received Period:", periodNumber); 

        if (!periodNumber || !subject) {
            return res.status(400).send("Error: Period and Subject are required!");
        }

        const students = await User.find({ role: 'Student' });
        const studentData = students.map(s => ({
            studentId: s._id,
            status: req.body['status_' + s._id] || 'Present'
        }));

       // Inside your route that handles the 'Lock' button
const newAttendance = new Attendance({
    date: req.body.date,
    periodNumber: req.body.periodNumber,
    subject: req.body.subject,
    leaderEmail: req.session.user.email, // This is already working
    lecturerEmail: req.body.lecturerEmail, // YOU MUST ADD THIS LINE
    students: studentData
});
await newAttendance.save();
        res.send("<script>alert('Attendance Locked!'); window.location.href='/leader';</script>");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error: " + err.message);
    }
});

app.post('/approve-user/:id', async (req, res) => {
    try {
        // 1. Get the role from the dropdown menu
        // The name in req.body must match the name in your <select> tag
        const assignedRole = req.body[`assignedRole_${req.params.id}`];

        // 2. Update the user in MongoDB
        await User.findByIdAndUpdate(req.params.id, { 
            approved: true, 
            role: assignedRole 
        });

        // 3. Refresh the Master Dashboard
        res.redirect('/master');
    } catch (err) {
        console.error("Approval Error:", err);
        res.status(500).send("Failed to approve user.");
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




// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});