const fs = require('fs'); 
const PDFDocument = require('pdfkit');
const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const csv = require('csv-parser');
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

app.use(helmet());



// --- UPDATED SESSION FOR VERSION 6.0.0 ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'attendance_system_secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
         mongoUrl: process.env.MONGO_URI,
         collectionName: 'sessions'
    }),
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        httpOnly: true,
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
    name: { type: String, required: true },
    // Update these two lines specifically:
    email: { type: String, required: true, unique: true, index: true }, 
    rollNo: { type: String, index: true }, 
    
    password: { type: String, required: true },
    role: { type: String, default: 'Student' }, // Student, Master, SuperAdmin
    section: { type: String, default: '' },
    isApproved: { type: Boolean, default: false },
    isPreRegistered: { type: Boolean, default: false }
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


// 1. Configure Email Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
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
        // Replace your existing lines with these:
        const users = await User.find({ section: req.session.user.section }); //
        const subjects = await Subject.find({ section: req.session.user.section }); //

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
        // Fetch only students and pre-registered users to exclude Master/Lecturer from the list
     // Replace your existing studentsOnly query with this:
const studentsOnly = await User.find({
    section: req.session.user.section, // Filter by the Leader's section
    $or: [
        { role: 'Student' },
        { role: 'Leader' }, // Ensure the Leader is included in the list
        { isPreRegistered: true }
    ]
}).sort({ rollNo: 1 });

// Modify your subject query as well:
const masterSubjects = await Subject.find({ section: req.session.user.section });
        res.render('leader', { 
            user: req.session.user, 
            allUsers: studentsOnly, // Only contains students now
            masterSubjects: masterSubjects 
        });
    } catch (err) {
        console.error("Leader Route Error:", err);
        res.status(500).send("Error loading dashboard.");
    }
});

app.get('/lecturer', async (req, res) => {
    try {
        // 1. Get Today's Date in YYYY-MM-DD format to match your DB strings
        const today = new Date().toISOString().split('T')[0];

       // Replace your existing todayRecords query with this:
    const todayRecords = await Attendance.find({
    section: req.session.user.section, // Added: Only show records for the lecturer's section
    lecturerEmail: req.session.user.email,
    date: today
});

        // 3. Render the page (Crucial: pass todayRecords so it's not undefined)
        res.render('lecturer', { 
            user: req.session.user, 
            todayRecords: todayRecords 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Internal Server Error: Could not load Lecturer Dashboard");
    }
});


app.get('/student', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Student') return res.redirect('/login');

    try {
        const userRoll = req.session.user.rollNo;

       // Add the section filter to ensure data isolation
        const records = await Attendance.find({
        section: req.session.user.section, // NEW: Filter by student's current section
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



app.get('/super-admin', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'SuperAdmin') return res.redirect('/login');

    try {
        const allUsers = await User.find({}).sort({ section: 1, role: 1 });
        const allSubjects = await Subject.find({});
        
        res.render('super-admin', { 
            user: req.session.user, 
            allUsers, 
            allSubjects 
        });
    } catch (err) {
        res.status(500).send("Error loading Super Admin dashboard");
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
            name: user.name,
            section: user.section, // NEW: Crucial for multi-section filtering
            rollNo: user.rollNo    // NEW: Needed for student dashboard stats
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


app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.log("Logout error:", err);
            return res.redirect('/dashboard');
        }
        res.clearCookie('connect.sid'); // Clears the browser cookie
        res.redirect('/login');
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






app.post('/upload-users', upload.single('csvFile'), async (req, res) => {
    if (!req.file) return res.status(400).send("No file uploaded.");
    
    const targetSection = req.body.section; // From hidden input in master.ejs
    const users = [];

    try {
        const workbook = new ExcelJS.Workbook();
        const filePath = req.file.path;

        // Load file based on extension
        if (req.file.originalname.endsWith('.csv')) {
            await workbook.csv.readFile(filePath);
        } else {
            await workbook.xlsx.readFile(filePath);
        }

        const worksheet = workbook.getWorksheet(1); // Get the first sheet

        // Loop through rows (starting from row 2 to skip headers)
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                // Mapping columns: 1=RollNo, 2=Name, 3=Email
                // You can adjust these indices if your Excel structure is different
                const rollNo = row.getCell(1).value;
                const name = row.getCell(2).value;
                const email = row.getCell(3).value;

                if (email) {
                    users.push({
                        rollNo: rollNo ? rollNo.toString().trim() : '',
                        name: name ? name.toString().trim() : 'New User',
                        email: email.toString().toLowerCase().trim(),
                        role: 'Student',
                        section: targetSection, // Link to Master's section
                        isApproved: true,
                        isPreRegistered: true
                    });
                }
            }
        });

        // Save to Database
        if (users.length > 0) {
            // ordered: false ensures one duplicate email doesn't stop the whole upload
            await User.insertMany(users, { ordered: false });
        }

        // Clean up: delete file after processing
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
        res.send("<script>alert('Upload Successful!'); window.location.href='/master';</script>");

    } catch (err) {
        console.error("Upload Error:", err);
        // Clean up even if it fails
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send("Failed to process file. Check column order: RollNo, Name, Email.");
    }
});



app.post('/lock-attendance', async (req, res) => {
    try {
        const { section, lecturerEmail, manualTime, subject, date, students } = req.body;
        const newAttendance = new Attendance({
            section: section, // NEW: Save the section tag
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


app.post('/bulk-approve', async (req, res) => {
    try {
        const { userIds, targetRole } = req.body;
        if (!userIds || userIds.length === 0) return res.redirect('/master');

        // Update all selected users at once
        await User.updateMany(
            { _id: { $in: userIds } },
            { 
                role: targetRole, 
                isApproved: true 
            }
        );
        res.redirect('/master');
    } catch (err) {
        res.status(500).send("Error in bulk approval");
    }
});


// UPDATED PDF GENERATION ROUTE
app.get('/generate-day-pdf/:date', async (req, res) => {
    try {
        // 1. Security check: Ensure user is logged in
        if (!req.session.user) return res.redirect('/login');

        const { date } = req.params;
        const { filter } = req.query;
        const userSection = req.session.user.section; // NEW: Get user's section

        // 2. Fetch records ONLY for this section on this date
        const records = await Attendance.find({ 
            date: date, 
            section: userSection // CRUCIAL: Add this filter
        }).sort({ manualTime: 1 });

        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument({ margin: 30 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=Attendance_Report_${date}_${userSection}.pdf`);

        doc.pipe(res);

        // 3. Update Title to include Section
        doc.fontSize(20).text(`Attendance Report: ${date}`, { align: 'center' });
        doc.fontSize(16).text(`Section: ${userSection}`, { align: 'center' }); // NEW
        
        if (filter) doc.fontSize(12).text(`Filter Applied: ${filter}`, { align: 'center' });
        doc.moveDown();

        if (records.length === 0) {
            doc.fontSize(14).text("No records found for this section on this date.", { align: 'center' });
        } else {
            records.forEach(rec => {
                doc.fontSize(14).text(`Slot: ${rec.manualTime} | Subject: ${rec.subject}`, { underline: true });
                doc.moveDown(0.5);

                rec.students.forEach(s => {
                    if (!filter || s.status === filter) {
                        doc.fontSize(10).text(`${s.name || s.studentName} (${s.studentId}): ${s.status}`);
                    }
                });
                doc.moveDown();
            });
        }

        doc.end();
    } catch (err) {
        console.error("PDF Error:", err);
        res.status(500).send("Error generating PDF.");
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


app.post('/update-attendance-status', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Lecturer') {
        return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const { attendanceId, studentId, newStatus } = req.body;

    try {
        const result = await Attendance.updateOne(
            { 
                _id: attendanceId, 
                "students.studentId": studentId,
                section: req.session.user.section // Section security
            },
            {
                $set: {
                    "students.$.status": newStatus,
                    lastModifiedBy: req.session.user.email, // Better tracking
                    lastModifiedDate: new Date()
                }
            }
        );

        if (result.modifiedCount > 0) {
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, message: "Record not found or no change made." });
        }
    } catch (err) {
        console.error("Update Error:", err);
        res.status(500).json({ success: false });
    }
});


app.post('/add-subject', async (req, res) => {
    try {
        // 1. Capture both the Name and the Section from the request body
        const { subjectName, section } = req.body;

        // 2. Validation: Ensure both fields are provided
        if (!subjectName || subjectName.trim() === "" || !section) {
            return res.status(400).send("Subject name and section are required.");
        }

        // 3. Save the new subject with the section tag
        const newSubject = new Subject({
            name: subjectName.trim(),
            section: section // NEW: Crucial for filtering on Leader Dashboard
        });

        await newSubject.save();
        res.redirect('/master');
    } catch (err) {
        console.error("Subject Add Error:", err);
        res.status(500).send("Error adding subject.");
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
    if (!req.session.user) return res.redirect('/login');

    try {
        const { startDate, endDate } = req.query;
        const user = req.session.user;
        let query = {};

        // Date filtering logic
        if (startDate && endDate) {
            query.date = { $gte: startDate, $lte: endDate };
        }

        // Updated Role-based data scoping
if (user.role === 'Student') {
    query["students.studentId"] = user.rollNo;
} else if (user.role === 'Lecturer') {
    query.lecturerEmail = user.email;
} else if (user.role === 'Leader') {
    // NEW: Ensure Leaders are restricted to their own section
    query.section = user.section; 
}
// Masters continue to see all records by default if no section is added to their query
        const history = await Attendance.find(query).sort({ date: -1 });
        
        res.render('history', { 
            user: user, 
            records: history,
            startDate,
            endDate
        });
    } catch (err) {
        res.status(500).send("Error fetching history");
    }
});


app.post('/submit-super-admin-request', async (req, res) => {
    // 1. Safety Check: Ensure a user is logged in
    if (!req.session.user) return res.status(401).send("Please login first.");

    // 2. Dynamic Variables from Session & Form
    const requesterEmail = req.session.user.email; // Who is logged in
    const requesterName = req.session.user.name;   // Their name
    const myDeveloperEmail = process.env.DEVELOPER_EMAIL;
    const secretKey = process.env.ADMIN_APPROVAL_SECRET;
    const appUrl = "https://attendance-system-g6f8.onrender.com";

    try {
        const approvalLink = `${appUrl}/approve-super-admin?email=${requesterEmail}&secret=${secretKey}`;

        const mailOptions = {
            // "from" stays your auth email (Gmail requirement)
            // but "replyTo" lets you hit 'Reply' to talk to the requester
            from: `"System Alert" <${process.env.EMAIL_USER}>`, 
            to: myDeveloperEmail,
            replyTo: requesterEmail, 
            subject: `🚨 Super Admin Request from ${requesterName}`,
            html: `
                <div style="font-family: Arial; border: 2px solid #007bff; padding: 20px; border-radius: 10px;">
                    <h2 style="color: #007bff;">Access Elevation Request</h2>
                    <p><strong>User:</strong> ${requesterName}</p>
                    <p><strong>Email:</strong> ${requesterEmail}</p>
                    <p>This user is requesting <b>Super Admin</b> privileges for the system.</p>
                    <div style="margin-top: 25px;">
                        <a href="${approvalLink}" 
                           style="background: #28a745; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                           Confirm & Approve
                        </a>
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.send("<script>alert('Your request has been sent to the Developer.'); window.location.href='/dashboard';</script>");
    } catch (err) {
        console.error("Email Error:", err);
        res.status(500).send("System failed to send the request email.");
    }
});


app.get('/approve-super-admin', async (req, res) => {
    const { email, secret } = req.query;

    // Security check
    if (secret !== process.env.ADMIN_APPROVAL_SECRET) return res.status(403).send("Unauthorized.");

    try {
        const user = await User.findOneAndUpdate(
            { email: email.toLowerCase().trim() },
            { 
                role: 'SuperAdmin', 
                isApproved: true,
                section: 'Global' // Super Admins handle all sections
            },
            { new: true }
        );

        if (user) {
            res.send(`<h3>Success!</h3><p>${email} has been promoted to Super Admin.</p>`);
        } else {
            res.status(404).send("User not found. Ensure they have registered an account first.");
        }
    } catch (err) {
        res.status(500).send("Database error.");
    }
});



// Add this after all your routes
app.use((err, req, res, next) => {
    console.error(err.stack); // Log the error for you to see
    res.status(500).render('error', { 
        message: "Something went wrong! Our team has been notified.",
        user: req.session.user || null 
    });
});


// --- Server Startup ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});