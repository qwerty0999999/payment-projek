const express = require('express');
const multer = require('multer');
const fs = require('fs');
const session = require('express-session');
const ExcelJS = require('exceljs'); 
const app = express();
const PORT = 3000;

// --- SETUP ---
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));
app.use(session({ secret: 'rahasia', resave: false, saveUninitialized: true, cookie: { maxAge: 3600000 } }));

// --- DB HELPER ---
const getFile = (f) => { try { return JSON.parse(fs.readFileSync(f)); } catch { return []; } };
const saveFile = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

// --- FUNGSI PENCATAT LOG (FITUR BARU) ---
function logActivity(username, action, detail) {
    let logs = getFile('logs.json');
    logs.push({
        time: new Date(), // Waktu persis
        username: username,
        action: action, // Contoh: "Update Order"
        detail: detail  // Contoh: "Menerima pesanan INV-123"
    });
    // Batasi log biar gak kepenuhan (Simpan 100 terakhir aja)
    if (logs.length > 100) logs = logs.slice(-100);
    saveFile('logs.json', logs);
}

// --- MIDDLEWARE ---
const requireLogin = (req, res, next) => {
    if (req.path === '/admin.html' && !req.session.isLoggedIn) return res.redirect('/login.html');
    next();
};
const requireSuper = (req, res, next) => {
    if (!req.session.isLoggedIn || req.session.role !== 'superuser') return res.status(403).json({success:false});
    next();
};
app.use(requireLogin);

// ==========================================
// 1. AUTH SYSTEM
// ==========================================
app.post('/auth', (req, res) => {
    const { username, password } = req.body;
    let users = getFile('users.json');
    if (users.length === 0) {
        users = [{ username: "super", password: "123", role: "superuser", isOnline: false }, { username: "admin", password: "123", role: "admin", isOnline: false }];
        saveFile('users.json', users);
    }
    const idx = users.findIndex(u => u.username === username && u.password === password);
    if (idx !== -1) {
        req.session.isLoggedIn=true; req.session.username=users[idx].username; req.session.role=users[idx].role;
        users[idx].isOnline=true; saveFile('users.json', users);
        
        // CATAT LOG LOGIN
        logActivity(users[idx].username, "Login", "Masuk ke sistem");
        
        res.json({ success: true });
    } else res.json({ success: false });
});

app.get('/logout', (req, res) => {
    if (req.session.username) {
        let users = getFile('users.json');
        const idx = users.findIndex(u => u.username===req.session.username);
        if(idx!==-1) { users[idx].isOnline=false; saveFile('users.json', users); }
        
        // CATAT LOG LOGOUT
        logActivity(req.session.username, "Logout", "Keluar dari sistem");
    }
    req.session.destroy(); res.redirect('/login.html');
});

app.get('/api/me', (req, res) => { if(!req.session.isLoggedIn) return res.status(401).json({}); res.json({user:req.session.username, role:req.session.role}); });

// ==========================================
// 2. FITUR ADMIN (DENGAN PENCATAT LOG)
// ==========================================

// USER MANAGEMENT
app.get('/api/users', requireSuper, (req, res) => res.json(getFile('users.json')));
app.post('/api/users/add', requireSuper, (req, res) => {
    let users = getFile('users.json'); if(users.find(u=>u.username===req.body.newUser)) return res.json({success:false});
    users.push({username:req.body.newUser, password:req.body.newPass, role:req.body.newRole, isOnline:false}); saveFile('users.json', users); 
    
    logActivity(req.session.username, "Add User", `Menambah user baru: ${req.body.newUser}`);
    res.json({success:true});
});
app.post('/api/users/delete', requireSuper, (req, res) => {
    let users = getFile('users.json').filter(u=>u.username!==req.body.targetUser); saveFile('users.json', users); 
    
    logActivity(req.session.username, "Delete User", `Menghapus user: ${req.body.targetUser}`);
    res.json({success:true});
});

// LOGS VIEWER
app.get('/api/logs', requireSuper, (req, res) => res.json(getFile('logs.json')));

// PRODUCT MANAGEMENT
app.get('/api/products', (req, res) => {
    if (!fs.existsSync('products.json')) saveFile('products.json', [{id:1, name:"Paket A", price:150000, stock:50, icon:"📦"}]);
    res.json(getFile('products.json'));
});
app.post('/api/products/add', requireSuper, (req, res) => {
    let p = getFile('products.json'); const id = p.length>0?Math.max(...p.map(x=>x.id))+1:1;
    p.push({id:id, name:req.body.name, price:req.body.price, stock:req.body.stock, icon:"📦"}); saveFile('products.json', p);
    
    logActivity(req.session.username, "Add Product", `Menambah produk: ${req.body.name}`);
    res.json({success:true});
});
app.post('/api/products/update', requireSuper, (req, res) => {
    let p = getFile('products.json'); const i = p.findIndex(x=>x.id==req.body.id);
    if(i!==-1) { 
        p[i].name=req.body.name; p[i].price=req.body.price; p[i].stock=req.body.stock; saveFile('products.json', p);
        logActivity(req.session.username, "Update Product", `Update produk: ${req.body.name}`);
        res.json({success:true});
    } else res.json({success:false});
});
app.post('/api/products/delete', requireSuper, (req, res) => {
    let p = getFile('products.json').filter(x=>x.id!=req.body.id); saveFile('products.json', p);
    logActivity(req.session.username, "Delete Product", `Menghapus produk ID: ${req.body.id}`);
    res.json({success:true});
});

// TRANSAKSI
app.post('/bayar', upload.single('buktiTransfer'), (req, res) => {
    const trans = getFile('data.json');
    const inv = `INV-${Math.floor(Math.random()*90000)}`;
    trans.push({ id:Date.now(), invoiceId:inv, tanggal:new Date().toLocaleDateString('id-ID'), nama:req.body.nama, produk:req.body.produk, harga:req.body.harga, fileBukti:req.file.filename, status:'Pending' });
    saveFile('data.json', trans); 
    // Log otomatis oleh sistem (opsional, tapi bagus buat debug)
    // logActivity("SYSTEM", "New Order", `Pesanan baru: ${inv}`); 
    res.json({success:true, invoiceId: inv});
});
app.post('/api/track', (req, res) => res.json({success:true, data: getFile('data.json').find(t=>t.invoiceId===req.body.invoiceId)}));
app.get('/api/data', (req, res) => res.json(getFile('data.json')));

// UPDATE STATUS TRANSAKSI (PENTING!)
const updateTrx = (req, res, status, actionName) => {
    if(!req.session.isLoggedIn) return res.status(403).json({});
    let data = getFile('data.json');
    const idx = data.findIndex(t => t.id == req.body.id);
    if (idx !== -1) { 
        data[idx].status = status; saveFile('data.json', data); 
        
        // CATAT LOG AKSI ADMIN
        logActivity(req.session.username, actionName, `${actionName} pesanan ${data[idx].invoiceId}`);
        
        res.json({ success: true }); 
    } else res.json({ success: false });
};

app.post('/api/update', (req, res) => updateTrx(req, res, 'Lunas', 'Terima'));
app.post('/api/reject', (req, res) => updateTrx(req, res, 'Ditolak', 'Tolak'));

app.post('/api/delete', (req, res) => {
    let d = getFile('data.json');
    const target = d.find(t => t.id == req.body.id);
    if(target) {
        logActivity(req.session.username, "Hapus Data", `Menghapus data ${target.invoiceId}`);
        d = d.filter(t => t.id != req.body.id);
        saveFile('data.json', d); 
        res.json({success:true});
    } else res.json({success:false});
});

app.get('/api/export-excel', async (req, res) => {
    logActivity(req.session.username, "Export", "Download Laporan Excel");
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Laporan');
    ws.columns=[{header:'Inv', key:'i'}, {header:'Sts', key:'s'}]; getFile('data.json').forEach(x=>ws.addRow({i:x.invoiceId, s:x.status}));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); await wb.xlsx.write(res); res.end();
});

app.listen(PORT, () => console.log(`Server Logger Aktif: http://localhost:${PORT}`));