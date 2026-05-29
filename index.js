const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const PORT = 3030;

// Path Setup
const DATA_FILE = path.join(__dirname, 'data.add.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const BOTS_DIR = path.join(__dirname, 'bots');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const BACKGROUNDS_DIR = path.join(__dirname, 'backgrounds');
const VIDEOS_DIR = path.join(__dirname, 'videos');

// Pastikan folder ada
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKGROUNDS_DIR)) fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// Inisialisasi file users.json dengan user default
function initUsersFile() {
    if (!fs.existsSync(USERS_FILE)) {
        const defaultUsers = [
            { username: 'admin', password: bcrypt.hashSync('admin123', 10) }
        ];
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
        console.log('✅ File users.json dibuat dengan user default: admin / admin123');
    }
}
initUsersFile();

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/backgrounds', express.static(BACKGROUNDS_DIR));
app.use('/videos', express.static(VIDEOS_DIR));

// Session Configuration
app.use(session({
    secret: 'inori_panel_secret_key_change_this',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 1000 * 60 * 60 * 24 // 24 jam
    }
}));

// Middleware untuk proteksi route API
function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// Middleware untuk halaman web (redirect ke login)
function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login');
}

// Konfigurasi Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (file.fieldname === 'botFile') {
            cb(null, UPLOAD_DIR);
        } else if (file.fieldname === 'backgroundImage') {
            cb(null, BACKGROUNDS_DIR);
        } else if (file.fieldname === 'backgroundVideo') {
            cb(null, VIDEOS_DIR);
        }
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }
});

// Inisialisasi Data File
function initDataFile() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ 
            bots: [], 
            settings: {
                background: { type: 'color', value: '#0f172a' }
            }
        }, null, 2));
        console.log('✅ File data.add.json dibuat.');
    }
}
initDataFile();

// Helper: Download file dari URL
async function downloadFile(url, filename, directory) {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
        });
        const filePath = path.join(directory, filename);
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(filename));
            writer.on('error', reject);
        });
    } catch (error) {
        throw new Error(`Gagal download file: ${error.message}`);
    }
}

// Helper: Simpan base64 image
function saveBase64Image(base64Data, filename) {
    try {
        const matches = base64Data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches) throw new Error('Format base64 tidak valid');
        const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const dataBuffer = Buffer.from(matches[2], 'base64');
        const filePath = path.join(BACKGROUNDS_DIR, `${filename}.${extension}`);
        fs.writeFileSync(filePath, dataBuffer);
        return `${filename}.${extension}`;
    } catch (error) {
        throw new Error(`Gagal simpan base64 image: ${error.message}`);
    }
}

// Helper: Simpan base64 video
function saveBase64Video(base64Data, filename) {
    try {
        const videoMatch = base64Data.match(/^data:video\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!videoMatch) throw new Error('Format base64 video tidak valid');
        const extension = videoMatch[1];
        const dataBuffer = Buffer.from(videoMatch[2], 'base64');
        const filePath = path.join(VIDEOS_DIR, `${filename}.${extension}`);
        fs.writeFileSync(filePath, dataBuffer);
        return `${filename}.${extension}`;
    } catch (error) {
        throw new Error(`Gagal simpan base64 video: ${error.message}`);
    }
}

// Helper: Generate video thumbnail
function generateVideoThumbnail(videoPath, thumbnailPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: ['00:00:01'],
                filename: path.basename(thumbnailPath),
                folder: path.dirname(thumbnailPath),
                size: '320x180'
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });
}

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
        if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });
        if (password.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
        
        const users = JSON.parse(fs.readFileSync(USERS_FILE));
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ error: 'Username sudah terdaftar' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        users.push({ username, password: hashedPassword });
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        res.json({ success: true, message: 'Registrasi berhasil, silakan login' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Terjadi kesalahan server' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
        const users = JSON.parse(fs.readFileSync(USERS_FILE));
        const user = users.find(u => u.username === username);
        if (!user) return res.status(401).json({ error: 'Username atau password salah' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Username atau password salah' });
        req.session.user = { username: user.username };
        res.json({ success: true, message: 'Login berhasil', username: user.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Terjadi kesalahan server' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Gagal logout' });
        res.json({ success: true, message: 'Logout berhasil' });
    });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session.user) {
        res.json({ authenticated: true, username: req.session.user.username });
    } else {
        res.json({ authenticated: false });
    }
});

// ==================== API ROUTES (dilindungi) ====================
app.get('/api/data', isAuthenticated, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Gagal baca data" });
    }
});

app.get('/api/bots', isAuthenticated, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        res.json(data.bots || []);
    } catch (err) {
        res.status(500).json({ error: "Gagal baca data bot" });
    }
});

app.get('/api/background', isAuthenticated, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        res.json(data.settings?.background || { type: 'color', value: '#0f172a' });
    } catch (err) {
        res.status(500).json({ error: "Gagal baca background settings" });
    }
});

app.post('/api/background', isAuthenticated, upload.fields([
    { name: 'backgroundImage', maxCount: 1 },
    { name: 'backgroundVideo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { type, value, videoOptions } = req.body;
        let backgroundValue = value;
        let fileName = null;
        let thumbnailName = null;

        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.settings) data.settings = {};

        // Hapus background lama
        if (data.settings.background) {
            const oldBg = data.settings.background;
            if (oldBg.type === 'image' && oldBg.value && oldBg.value.startsWith('bg_')) {
                const oldPath = path.join(BACKGROUNDS_DIR, oldBg.value);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            if (oldBg.type === 'video' && oldBg.value) {
                const oldVideoPath = path.join(VIDEOS_DIR, oldBg.value);
                if (fs.existsSync(oldVideoPath)) fs.unlinkSync(oldVideoPath);
                if (oldBg.thumbnail) {
                    const oldThumbPath = path.join(BACKGROUNDS_DIR, oldBg.thumbnail);
                    if (fs.existsSync(oldThumbPath)) fs.unlinkSync(oldThumbPath);
                }
            }
        }

        let parsedVideoOptions = {};
        try { parsedVideoOptions = videoOptions ? JSON.parse(videoOptions) : {}; } catch(e) {}

        switch (type) {
            case 'url':
                if (!value || !value.startsWith('http')) return res.status(400).json({ error: "URL tidak valid" });
                const isVideoUrl = value.match(/\.(mp4|webm|ogg|mov|avi|mkv)$/i);
                if (isVideoUrl) {
                    fileName = `video_${Date.now()}${path.extname(value) || '.mp4'}`;
                    await downloadFile(value, fileName, VIDEOS_DIR);
                    thumbnailName = `thumb_${Date.now()}.jpg`;
                    const videoPath = path.join(VIDEOS_DIR, fileName);
                    const thumbPath = path.join(BACKGROUNDS_DIR, thumbnailName);
                    try { await generateVideoThumbnail(videoPath, thumbPath); } catch(e) { thumbnailName = null; }
                    backgroundValue = fileName;
                } else {
                    fileName = `bg_${Date.now()}.jpg`;
                    await downloadFile(value, fileName, BACKGROUNDS_DIR);
                    backgroundValue = fileName;
                }
                break;
            case 'file':
                if (!req.files?.backgroundImage?.[0] && !req.files?.backgroundVideo?.[0]) {
                    return res.status(400).json({ error: "File diperlukan" });
                }
                if (req.files.backgroundVideo?.[0]) {
                    const videoFile = req.files.backgroundVideo[0];
                    backgroundValue = videoFile.filename;
                    thumbnailName = `thumb_${Date.now()}.jpg`;
                    const videoPath = path.join(VIDEOS_DIR, videoFile.filename);
                    const thumbPath = path.join(BACKGROUNDS_DIR, thumbnailName);
                    try { await generateVideoThumbnail(videoPath, thumbPath); } catch(e) { thumbnailName = null; }
                } else {
                    backgroundValue = req.files.backgroundImage[0].filename;
                }
                break;
            case 'video':
                if (!value || !value.startsWith('http')) return res.status(400).json({ error: "URL video tidak valid" });
                fileName = `video_${Date.now()}${path.extname(value) || '.mp4'}`;
                await downloadFile(value, fileName, VIDEOS_DIR);
                thumbnailName = `thumb_${Date.now()}.jpg`;
                const videoPath = path.join(VIDEOS_DIR, fileName);
                const thumbPath = path.join(BACKGROUNDS_DIR, thumbnailName);
                try { await generateVideoThumbnail(videoPath, thumbPath); } catch(e) { thumbnailName = null; }
                backgroundValue = fileName;
                break;
            case 'color':
                const colorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
                if (!colorRegex.test(value)) return res.status(400).json({ error: "Format warna tidak valid" });
                break;
            case 'base64':
                if (!value || !value.includes('base64')) return res.status(400).json({ error: "Data base64 tidak valid" });
                if (value.includes('data:video/')) {
                    fileName = `video_${Date.now()}`;
                    backgroundValue = saveBase64Video(value, fileName);
                    thumbnailName = `thumb_${Date.now()}.jpg`;
                    const videoPath = path.join(VIDEOS_DIR, backgroundValue);
                    const thumbPath = path.join(BACKGROUNDS_DIR, thumbnailName);
                    try { await generateVideoThumbnail(videoPath, thumbPath); } catch(e) { thumbnailName = null; }
                } else {
                    fileName = `bg_${Date.now()}`;
                    backgroundValue = saveBase64Image(value, fileName);
                }
                break;
            default:
                return res.status(400).json({ error: "Tipe background tidak valid" });
        }

        data.settings.background = {
            type: type,
            value: backgroundValue,
            thumbnail: thumbnailName,
            videoOptions: parsedVideoOptions,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Background berhasil diupdate", background: data.settings.background });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || "Terjadi kesalahan server" });
    }
});

app.post('/api/background/reset', isAuthenticated, (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (data.settings.background) {
            const oldBg = data.settings.background;
            if (oldBg.type === 'image' && oldBg.value && oldBg.value.startsWith('bg_')) {
                const oldPath = path.join(BACKGROUNDS_DIR, oldBg.value);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            if (oldBg.type === 'video' && oldBg.value) {
                const oldVideoPath = path.join(VIDEOS_DIR, oldBg.value);
                if (fs.existsSync(oldVideoPath)) fs.unlinkSync(oldVideoPath);
                if (oldBg.thumbnail) {
                    const oldThumbPath = path.join(BACKGROUNDS_DIR, oldBg.thumbnail);
                    if (fs.existsSync(oldThumbPath)) fs.unlinkSync(oldThumbPath);
                }
            }
        }
        data.settings.background = { type: 'color', value: '#0f172a', updatedAt: new Date().toISOString() };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Background berhasil direset ke default", background: data.settings.background });
    } catch (err) {
        res.status(500).json({ error: "Gagal reset background" });
    }
});

app.get('/api/backgrounds/list', isAuthenticated, (req, res) => {
    try {
        const imageFiles = fs.readdirSync(BACKGROUNDS_DIR)
            .filter(file => file.startsWith('bg_') || file.startsWith('thumb_'))
            .map(file => ({
                name: file, type: 'image', path: `/backgrounds/${file}`,
                size: fs.statSync(path.join(BACKGROUNDS_DIR, file)).size,
                created: fs.statSync(path.join(BACKGROUNDS_DIR, file)).birthtime
            }));
        const videoFiles = fs.readdirSync(VIDEOS_DIR)
            .filter(file => file.startsWith('video_'))
            .map(file => {
                const thumbFile = `thumb_${path.parse(file).name}.jpg`;
                const hasThumb = fs.existsSync(path.join(BACKGROUNDS_DIR, thumbFile));
                return {
                    name: file, type: 'video', path: `/videos/${file}`,
                    thumbnail: hasThumb ? `/backgrounds/${thumbFile}` : null,
                    size: fs.statSync(path.join(VIDEOS_DIR, file)).size,
                    created: fs.statSync(path.join(VIDEOS_DIR, file)).birthtime
                };
            });
        res.json([...imageFiles, ...videoFiles]);
    } catch (err) {
        res.status(500).json({ error: "Gagal membaca daftar background" });
    }
});

app.get('/api/video/:filename', isAuthenticated, (req, res) => {
    try {
        const filename = req.params.filename;
        const videoPath = path.join(VIDEOS_DIR, filename);
        if (!fs.existsSync(videoPath)) return res.status(404).json({ error: "Video tidak ditemukan" });
        const stats = fs.statSync(videoPath);
        const thumbFile = `thumb_${path.parse(filename).name}.jpg`;
        const thumbPath = path.join(BACKGROUNDS_DIR, thumbFile);
        const hasThumb = fs.existsSync(thumbPath);
        res.json({
            name: filename, path: `/videos/${filename}`, size: stats.size,
            created: stats.birthtime, thumbnail: hasThumb ? `/backgrounds/${thumbFile}` : null
        });
    } catch (err) {
        res.status(500).json({ error: "Gagal membaca info video" });
    }
});

app.post('/api/bots', isAuthenticated, upload.single('botFile'), (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            if(req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: "Nama Bot wajib diisi!" });
        }
        if (!req.file) return res.status(400).json({ error: "File ZIP wajib diupload!" });

        const botId = Date.now().toString();
        const botPath = path.join(BOTS_DIR, botId);
        fs.mkdirSync(botPath, { recursive: true });

        try {
            const zip = new AdmZip(req.file.path);
            zip.extractAllTo(botPath, true);
            fs.unlinkSync(req.file.path);

            const items = fs.readdirSync(botPath);
            const dirs = items.filter(item => fs.statSync(path.join(botPath, item)).isDirectory());
            if (dirs.length === 1) {
                const folderName = dirs[0];
                const innerPath = path.join(botPath, folderName);
                const innerItems = fs.readdirSync(innerPath);
                innerItems.forEach(innerItem => {
                    const oldPath = path.join(innerPath, innerItem);
                    const newPath = path.join(botPath, innerItem);
                    fs.renameSync(oldPath, newPath);
                });
                fs.rmdirSync(innerPath);
            }
        } catch (err) {
            console.error("Gagal unzip:", err);
            return res.status(500).json({ error: "Gagal mengekstrak file ZIP." });
        }

        const newBot = {
            id: botId, name: name, path: botPath, status: 'stopped', pid: null,
            createdAt: new Date().toLocaleString()
        };
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.bots) data.bots = [];
        data.bots.push(newBot);
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ message: "Bot berhasil ditambahkan", bot: newBot });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Terjadi kesalahan server." });
    }
});

app.delete('/api/bots/:id', isAuthenticated, (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.bots) return res.status(404).json({ error: "Tidak ada data bot" });
        const botIndex = data.bots.findIndex(b => b.id === id);
        if (botIndex === -1) return res.status(404).json({ error: "Bot tidak ditemukan" });
        const bot = data.bots[botIndex];
        if (bot.pid) { try { process.kill(bot.pid); } catch(e) {} }
        if (fs.existsSync(bot.path)) fs.rmSync(bot.path, { recursive: true, force: true });
        data.bots.splice(botIndex, 1);
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Bot berhasil dihapus", deletedId: id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal menghapus bot: " + err.message });
    }
});

app.post('/api/bots/:id/start', isAuthenticated, (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.bots) return res.status(404).json({ error: "Tidak ada data bot" });
        const botIndex = data.bots.findIndex(b => b.id === id);
        if (botIndex === -1) return res.status(404).json({ error: "Bot tidak ditemukan" });
        if (data.bots[botIndex].status === 'running') return res.status(400).json({ error: "Bot sudah berjalan!" });
        const bot = data.bots[botIndex];
        const child = spawn('node', ['index.js'], { cwd: bot.path, detached: true, stdio: 'ignore' });
        child.unref();
        bot.pid = child.pid;
        bot.status = 'running';
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Bot berhasil dijalankan", pid: child.pid });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal menjalankan bot" });
    }
});

app.post('/api/bots/:id/stop', isAuthenticated, (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.bots) return res.status(404).json({ error: "Tidak ada data bot" });
        const botIndex = data.bots.findIndex(b => b.id === id);
        if (botIndex === -1) return res.status(404).json({ error: "Bot tidak ditemukan" });
        const bot = data.bots[botIndex];
        if (!bot.pid) return res.status(400).json({ error: "Bot tidak sedang berjalan." });
        try { process.kill(bot.pid); } catch(e) {}
        bot.pid = null;
        bot.status = 'stopped';
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Bot berhasil dihentikan" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal menghentikan bot" });
    }
});

app.post('/api/bots/:id/restart', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.bots) return res.status(404).json({ error: "Tidak ada data bot" });
        const botIndex = data.bots.findIndex(b => b.id === id);
        if (botIndex === -1) return res.status(404).json({ error: "Bot tidak ditemukan" });
        const bot = data.bots[botIndex];
        if (bot.pid) { try { process.kill(bot.pid); } catch(e) {} }
        const child = spawn('node', ['index.js'], { cwd: bot.path, detached: true, stdio: 'ignore' });
        child.unref();
        bot.pid = child.pid;
        bot.status = 'running';
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true, message: "Bot berhasil direstart", pid: child.pid });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal restart bot" });
    }
});

app.post('/api/terminal', isAuthenticated, (req, res) => {
    try {
        const { id, command } = req.body;
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        if (!data.bots) return res.status(404).json({ output: "Tidak ada data bot" });
        const bot = data.bots.find(b => b.id === id);
        if (!bot) return res.status(404).json({ output: "Bot tidak ditemukan" });
        exec(command, { cwd: bot.path }, (error, stdout, stderr) => {
            let output = "";
            if (stdout) output += stdout;
            if (stderr) output += `\n[ERROR]:\n${stderr}`;
            if (error) output += `\n[SYSTEM ERROR]: ${error.message}`;
            res.json({ success: true, output: output || "Command executed (no output)." });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ output: "Gagal menjalankan command" });
    }
});

// ==================== HALAMAN WEB ====================
// Helper untuk membaca background settings dari file (publik)
function getPublicBackgroundSettings() {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE));
        return data.settings?.background || { type: 'color', value: '#0f172a' };
    } catch (err) {
        return { type: 'color', value: '#0f172a' };
    }
}

// Halaman Login (dengan background kustom)
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    const background = getPublicBackgroundSettings();
    const bgJson = JSON.stringify(background);
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - Panel Inori 🦀</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; background-size: cover; background-position: center; background-attachment: fixed; transition: background 0.3s ease; position: relative; }
        .video-background-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -2; overflow: hidden; display: none; }
        .video-background { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 100%; min-height: 100%; width: auto; height: auto; object-fit: cover; }
        .video-controls { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); padding: 10px 15px; border-radius: 20px; display: flex; gap: 10px; align-items: center; z-index: 1000; backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); display: none; }
        .video-control-btn { background: transparent; border: none; color: white; cursor: pointer; font-size: 1.2rem; padding: 5px; border-radius: 50%; width: 35px; height: 35px; display: flex; align-items: center; justify-content: center; transition: background 0.3s; }
        .video-control-btn:hover { background: rgba(255,255,255,0.1); }
        .volume-slider { width: 80px; cursor: pointer; }
        .content-overlay { background: rgba(15, 23, 42, 0.85); position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; transition: background 0.3s ease; }
        .login-container { background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(10px); border-radius: 20px; padding: 40px; width: 100%; max-width: 420px; border: 1px solid #334155; box-shadow: 0 20px 40px rgba(0,0,0,0.4); position: relative; z-index: 1; }
        .crab-icon { font-size: 4rem; text-align: center; margin-bottom: 10px; animation: crabWalk 3s infinite; }
        @keyframes crabWalk { 0%,100% { transform: translateX(0) rotate(0deg); } 25% { transform: translateX(5px) rotate(-10deg); } 50% { transform: translateX(0) rotate(0deg); } 75% { transform: translateX(-5px) rotate(10deg); } }
        h1 { text-align: center; color: #f8fafc; margin-bottom: 30px; font-size: 1.8rem; }
        .form-group { margin-bottom: 20px; }
        label { display: block; color: #94a3b8; margin-bottom: 8px; font-size: 0.9rem; }
        input { width: 100%; padding: 12px 15px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; color: white; font-size: 1rem; transition: border-color 0.3s; }
        input:focus { outline: none; border-color: #3b82f6; }
        button { width: 100%; padding: 12px; background: #3b82f6; border: none; border-radius: 10px; color: white; font-size: 1rem; font-weight: bold; cursor: pointer; transition: opacity 0.3s; margin-top: 10px; }
        button:hover { opacity: 0.9; }
        .toggle-link { text-align: center; margin-top: 20px; color: #94a3b8; cursor: pointer; }
        .toggle-link span { color: #3b82f6; text-decoration: underline; }
        .message { margin-top: 15px; padding: 10px; border-radius: 8px; text-align: center; font-size: 0.85rem; display: none; }
        .message.error { background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid #ef4444; }
        .message.success { background: rgba(16,185,129,0.2); color: #10b981; border: 1px solid #10b981; }
        .footer { text-align: center; margin-top: 30px; color: #64748b; font-size: 0.75rem; }
    </style>
</head>
<body>
    <div class="video-background-container" id="videoBackgroundContainer"><video class="video-background" id="backgroundVideo" loop muted playsinline></video></div>
    <div class="video-controls" id="videoControls">
        <button class="video-control-btn" onclick="toggleVideoPlayback()" id="playPauseBtn">⏸️</button>
        <button class="video-control-btn" onclick="toggleVideoMute()" id="muteBtn">🔇</button>
        <input type="range" min="0" max="1" step="0.1" value="0.5" class="volume-slider" id="volumeSlider" oninput="changeVideoVolume(this.value)">
        <button class="video-control-btn" onclick="restartVideo()">↺</button>
    </div>
    <div class="content-overlay" id="contentOverlay"></div>
    <div class="login-container">
        <div class="crab-icon">🦀</div>
        <h1>Panel Inori</h1>
        <div id="loginForm">
            <div class="form-group"><label>Username</label><input type="text" id="loginUsername" placeholder="Masukkan username"></div>
            <div class="form-group"><label>Password</label><input type="password" id="loginPassword" placeholder="Masukkan password"></div>
            <button onclick="login()">🔐 Login</button>
            <div class="toggle-link" onclick="showRegister()">Belum punya akun? <span>Daftar sekarang</span></div>
        </div>
        <div id="registerForm" style="display: none;">
            <div class="form-group"><label>Username (min. 3 karakter)</label><input type="text" id="regUsername" placeholder="Masukkan username"></div>
            <div class="form-group"><label>Password (min. 4 karakter)</label><input type="password" id="regPassword" placeholder="Masukkan password"></div>
            <button onclick="register()">📝 Daftar</button>
            <div class="toggle-link" onclick="showLogin()">Sudah punya akun? <span>Login disini</span></div>
        </div>
        <div id="message" class="message"></div>
        <div class="footer">Panel Inori 🦀 - Bot Manager</div>
    </div>
    <script>
        // Background settings dari server
        const initialBackground = ${bgJson};
        let videoElement = null;
        let videoControlsVisible = false;

        function applyBackgroundToPage() {
            const body = document.body;
            const overlay = document.getElementById('contentOverlay');
            const videoContainer = document.getElementById('videoBackgroundContainer');
            const videoControls = document.getElementById('videoControls');
            body.style.backgroundImage = '';
            body.style.backgroundColor = '';
            videoContainer.style.display = 'none';
            videoControls.style.display = 'none';
            if(videoElement){ videoElement.pause(); videoElement.src = ''; }
            if(initialBackground.type === 'color'){
                body.style.backgroundColor = initialBackground.value;
                overlay.style.background = 'rgba(15, 23, 42, 0.85)';
            } else {
                let sourceUrl = initialBackground.value;
                const isVideo = initialBackground.type === 'video' || (initialBackground.type === 'url' && sourceUrl.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i)) || (initialBackground.type === 'file' && sourceUrl.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i));
                if(isVideo){
                    videoContainer.style.display = 'block';
                    if(!videoElement) videoElement = document.getElementById('backgroundVideo');
                    if(initialBackground.type === 'video' || initialBackground.type === 'file') sourceUrl = '/videos/' + sourceUrl;
                    videoElement.src = sourceUrl;
                    const opts = initialBackground.videoOptions || {};
                    videoElement.autoplay = opts.autoplay !== false;
                    videoElement.loop = opts.loop !== false;
                    videoElement.muted = opts.muted !== false;
                    videoElement.volume = opts.volume || 0.5;
                    videoElement.playbackRate = opts.playbackRate || 1;
                    videoElement.onloadeddata = () => videoElement.play().catch(e=>console.log);
                    if(!videoElement.muted){ videoControls.style.display = 'flex'; videoControlsVisible = true; }
                    overlay.style.background = 'rgba(15, 23, 42, 0.7)';
                } else {
                    if(initialBackground.type === 'image' || initialBackground.type === 'file') sourceUrl = '/backgrounds/' + sourceUrl;
                    body.style.backgroundImage = \`url("\${sourceUrl}")\`;
                    body.style.backgroundSize = 'cover';
                    body.style.backgroundPosition = 'center';
                    body.style.backgroundAttachment = 'fixed';
                    overlay.style.background = 'rgba(15, 23, 42, 0.85)';
                }
            }
        }

        function toggleVideoPlayback() { if(videoElement){ if(videoElement.paused){ videoElement.play(); document.getElementById('playPauseBtn').textContent='⏸️'; } else { videoElement.pause(); document.getElementById('playPauseBtn').textContent='▶️'; } } }
        function toggleVideoMute() { if(videoElement){ videoElement.muted = !videoElement.muted; document.getElementById('muteBtn').textContent = videoElement.muted ? '🔇' : '🔊'; const vc = document.getElementById('videoControls'); if(videoElement.muted){ vc.style.display='none'; videoControlsVisible=false; } else { vc.style.display='flex'; videoControlsVisible=true; } } }
        function changeVideoVolume(v) { if(videoElement){ videoElement.volume = parseFloat(v); document.getElementById('volumeSlider').value = v; if(videoElement.volume===0){ videoElement.muted=true; document.getElementById('muteBtn').textContent='🔇'; } else if(videoElement.muted){ videoElement.muted=false; document.getElementById('muteBtn').textContent='🔊'; } } }
        function restartVideo() { if(videoElement){ videoElement.currentTime=0; videoElement.play(); document.getElementById('playPauseBtn').textContent='⏸️'; } }

        document.addEventListener('mousemove', (e)=>{ if(videoElement && videoControlsVisible){ const vc = document.getElementById('videoControls'); const near = e.clientY > window.innerHeight-100; if(near){ vc.style.opacity='1'; vc.style.pointerEvents='auto'; } else { vc.style.opacity='0'; vc.style.pointerEvents='none'; } } });

        function showMessage(msg, type) { const d=document.getElementById('message'); d.textContent=msg; d.className='message '+type; d.style.display='block'; setTimeout(()=>d.style.display='none',3000); }
        async function login() { const u=document.getElementById('loginUsername').value.trim(), p=document.getElementById('loginPassword').value; if(!u||!p) return showMessage('Username dan password wajib diisi','error'); try{ const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}); const data=await res.json(); if(data.success){ showMessage('Login berhasil! Mengalihkan...','success'); setTimeout(()=>window.location.href='/dashboard',1000); } else showMessage(data.error||'Login gagal','error'); }catch(e){ showMessage('Terjadi kesalahan server','error'); } }
        async function register() { const u=document.getElementById('regUsername').value.trim(), p=document.getElementById('regPassword').value; if(!u||!p) return showMessage('Username dan password wajib diisi','error'); if(u.length<3) return showMessage('Username minimal 3 karakter','error'); if(p.length<4) return showMessage('Password minimal 4 karakter','error'); try{ const res=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}); const data=await res.json(); if(data.success){ showMessage('Registrasi berhasil! Silakan login.','success'); showLogin(); document.getElementById('loginUsername').value=u; document.getElementById('loginPassword').value=''; } else showMessage(data.error||'Registrasi gagal','error'); }catch(e){ showMessage('Terjadi kesalahan server','error'); } }
        function showRegister() { document.getElementById('loginForm').style.display='none'; document.getElementById('registerForm').style.display='block'; document.getElementById('message').style.display='none'; }
        function showLogin() { document.getElementById('registerForm').style.display='none'; document.getElementById('loginForm').style.display='block'; document.getElementById('message').style.display='none'; }
        async function checkAuth(){ try{ const res=await fetch('/api/auth/check'); const data=await res.json(); if(data.authenticated) window.location.href='/dashboard'; }catch(e){} }
        checkAuth();
        document.getElementById('loginPassword').addEventListener('keypress',e=>{if(e.key==='Enter')login();});
        document.getElementById('regPassword').addEventListener('keypress',e=>{if(e.key==='Enter')register();});

        applyBackgroundToPage();
    </script>
</body>
</html>`);
});

// Halaman Dashboard (dengan tombol close di sidebar)
app.get('/dashboard', ensureAuthenticated, (req, res) => {
    const username = req.session.user.username;
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta property="og:title" content="Panel Inori 🦀 - Bot Manager">
    <meta property="og:description" content="Dashboard untuk mengelola bot WhatsApp dengan fitur custom background">
    <meta property="og:image" content="https://files.catbox.moe/4kpvbt.jpeg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:url" content="https://your-domain.com">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Panel Inori 🦀 - Bot Manager">
    <meta name="twitter:description" content="Dashboard untuk mengelola bot WhatsApp dengan fitur custom background">
    <meta name="twitter:image" content="https://files.catbox.moe/4kpvbt.jpeg">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Panel Inori 🦀 - Bot Manager</title>
    <style>
        :root {
            --bg-body: #0f172a;
            --bg-panel: #1e293b;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --primary: #3b82f6;
            --danger: #ef4444;
            --success: #10b981;
            --warning: #f59e0b;
            --terminal-bg: #000000;
            --terminal-text: #00ff00;
            --border: #334155;
            --crab-color: #ff6b6b;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: var(--bg-body); color: var(--text-main); display: flex; min-height: 100vh; overflow-x: hidden; background-size: cover; background-position: center; background-attachment: fixed; background-repeat: no-repeat; transition: background 0.3s ease; }
        .content-overlay { background: rgba(15, 23, 42, 0.85); position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; transition: background 0.3s ease; }
        .video-background-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -2; overflow: hidden; display: none; }
        .video-background { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 100%; min-height: 100%; width: auto; height: auto; object-fit: cover; }
        .video-controls { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); padding: 10px 15px; border-radius: 20px; display: flex; gap: 10px; align-items: center; z-index: 1000; backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); display: none; }
        .video-control-btn { background: transparent; border: none; color: white; cursor: pointer; font-size: 1.2rem; padding: 5px; border-radius: 50%; width: 35px; height: 35px; display: flex; align-items: center; justify-content: center; transition: background 0.3s; }
        .video-control-btn:hover { background: rgba(255,255,255,0.1); }
        .volume-slider { width: 80px; cursor: pointer; }
        .sidebar { width: 260px; background: rgba(30, 41, 59, 0.95); border-right: 1px solid var(--border); padding: 20px; position: fixed; height: 100%; z-index: 20; transition: transform 0.3s ease; backdrop-filter: blur(10px); display: flex; flex-direction: column; }
        .sidebar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
        .sidebar-header-left { display: flex; align-items: center; gap: 10px; }
        .close-sidebar { background: transparent; border: none; color: var(--text-muted); font-size: 1.4rem; cursor: pointer; padding: 5px; line-height: 1; border-radius: 5px; transition: all 0.2s; }
        .close-sidebar:hover { background: rgba(255,255,255,0.1); color: white; }
        .crab-icon { font-size: 1.8rem; animation: crabWalk 3s infinite; }
        @keyframes crabWalk { 0%,100% { transform: translateX(0) rotate(0deg); } 25% { transform: translateX(5px) rotate(-10deg); } 50% { transform: translateX(0) rotate(0deg); } 75% { transform: translateX(-5px) rotate(10deg); } }
        .main-content { margin-left: 260px; flex: 1; padding: 30px; width: calc(100% - 260px); transition: margin-left 0.3s ease, width 0.3s ease; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; background: rgba(30, 41, 59, 0.9); padding: 15px 20px; border-radius: 10px; backdrop-filter: blur(10px); border: 1px solid var(--border); }
        .header h1 { font-size: 1.8rem; display: flex; align-items: center; gap: 10px; }
        .menu-btn { display: none; font-size: 1.5rem; background: rgba(59,130,246,0.2); border: none; color: white; cursor: pointer; padding: 8px 12px; border-radius: 5px; }
        .bg-btn { background: var(--primary); color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 0.9rem; margin-left: 10px; display: flex; align-items: center; gap: 5px; }
        .bg-btn:hover { opacity: 0.9; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
        .card { background: rgba(30, 41, 59, 0.95); border: 1px solid var(--border); border-radius: 8px; padding: 20px; position: relative; backdrop-filter: blur(10px); transition: transform 0.2s, box-shadow 0.2s; }
        .card:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .bot-name { font-weight: bold; font-size: 1.2rem; }
        .status { padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; text-transform: uppercase; }
        .status.stopped { background: rgba(239,68,68,0.2); color: var(--danger); }
        .status.running { background: rgba(16,185,129,0.2); color: var(--success); }
        .info-row { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 6px; }
        .actions-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 15px; }
        .actions-secondary { display: flex; gap: 8px; margin-top: 10px; }
        .btn { padding: 8px; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85rem; color: white; font-weight: 500; transition: opacity 0.2s; }
        .btn:hover { opacity: 0.9; }
        .btn-start { background: var(--success); }
        .btn-stop { background: var(--danger); }
        .btn-restart { background: var(--warning); }
        .btn-terminal { background: #4b5563; flex: 1; }
        .btn-delete { background: rgba(239,68,68,0.2); color: var(--danger); border: 1px solid var(--danger); flex: 1; }
        .btn-delete:hover { background: var(--danger); color: white; }
        .btn-add { background: var(--primary); color: white; width: 100%; margin-top: 10px; }
        .add-card { border: 2px dashed var(--border); display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 180px; cursor: pointer; background: rgba(30, 41, 59, 0.5); transition: border-color 0.3s; }
        .add-card:hover { border-color: var(--primary); background: rgba(59,130,246,0.1); }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 100; display: none; align-items: center; justify-content: center; backdrop-filter: blur(5px); }
        .modal-overlay.active { display: flex; }
        .modal { background: var(--bg-panel); width: 90%; max-width: 600px; padding: 25px; border-radius: 10px; border: 1px solid var(--border); max-height: 90vh; overflow-y: auto; }
        .tab-buttons { display: flex; gap: 5px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px; flex-wrap: wrap; }
        .tab-btn { padding: 10px; background: transparent; border: none; color: var(--text-muted); cursor: pointer; border-radius: 5px; transition: all 0.3s; font-size: 0.85rem; display: flex; align-items: center; gap: 5px; }
        .tab-btn.active { background: var(--primary); color: white; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .color-picker-container { display: flex; align-items: center; gap: 15px; margin-bottom: 20px; }
        .color-preview { width: 50px; height: 50px; border-radius: 5px; border: 2px solid var(--border); }
        .color-input { flex: 1; padding: 10px; background: #0f172a; border: 1px solid var(--border); border-radius: 5px; color: white; }
        .video-options { background: rgba(15,23,42,0.5); padding: 15px; border-radius: 8px; margin-top: 15px; border: 1px solid var(--border); }
        .option-group { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
        .option-label { width: 150px; font-size: 0.9rem; color: var(--text-muted); }
        .option-input { flex: 1; padding: 8px; background: #0f172a; border: 1px solid var(--border); border-radius: 5px; color: white; min-width: 200px; }
        .option-checkbox { width: 20px; height: 20px; }
        .preview-section { margin-top: 20px; padding: 20px; background: rgba(15,23,42,0.5); border-radius: 8px; border: 1px solid var(--border); }
        .preview-title { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        .preview-area { width: 100%; height: 200px; border-radius: 5px; border: 2px dashed var(--border); display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: var(--text-muted); overflow: hidden; background-size: cover; background-position: center; position: relative; }
        .video-preview { width: 100%; height: 100%; object-fit: cover; }
        .background-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; margin-top: 15px; }
        .bg-item { aspect-ratio: 16/9; border-radius: 5px; overflow: hidden; cursor: pointer; border: 2px solid transparent; transition: border-color 0.3s; position: relative; }
        .bg-item:hover { border-color: var(--primary); }
        .bg-item.active { border-color: var(--success); }
        .bg-thumbnail { width: 100%; height: 100%; object-fit: cover; }
        .bg-type-badge { position: absolute; top: 5px; right: 5px; background: rgba(0,0,0,0.7); color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 3px; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; color: var(--text-muted); font-size: 0.9rem; }
        .form-input, .form-file, .form-textarea { width: 100%; padding: 10px; background: #0f172a; border: 1px solid var(--border); color: white; border-radius: 5px; }
        .form-file::file-selector-button { background: var(--primary); border: none; color: white; padding: 5px 10px; border-radius: 4px; cursor: pointer; margin-right: 10px; }
        .form-textarea { min-height: 120px; resize: vertical; font-family: monospace; }
        .file-upload-area { border: 2px dashed var(--border); border-radius: 5px; padding: 30px; text-align: center; cursor: pointer; margin-bottom: 15px; transition: border-color 0.3s; }
        .file-upload-area:hover { border-color: var(--primary); }
        .file-upload-area.dragover { background: rgba(59,130,246,0.1); border-color: var(--primary); }
        .terminal-box { background: var(--terminal-bg); color: var(--terminal-text); padding: 15px; border-radius: 5px; height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.85rem; margin-bottom: 10px; white-space: pre-wrap; border: 1px solid #333; }
        .cmd-input-group { display: flex; gap: 10px; }
        .cmd-input { flex: 1; background: #111; border: 1px solid #333; color: white; padding: 10px; font-family: monospace; }
        .close-btn { float: right; cursor: pointer; font-size: 1.5rem; }
        .button-group { display: flex; gap: 10px; margin-top: 20px; }
        .btn-secondary { background: #4b5563; }
        .btn-secondary:hover { background: #6b7280; }
        @media (max-width: 768px) {
            .sidebar { transform: translateX(-100%); width: 280px; }
            .sidebar.active { transform: translateX(0); }
            .main-content { margin-left: 0; width: 100%; padding: 15px; }
            .menu-btn, .bg-btn { display: flex; }
            .header h1 { font-size: 1.4rem; }
            .grid { grid-template-columns: 1fr; }
            .actions-grid { grid-template-columns: 1fr; }
            .actions-secondary { flex-direction: column; }
            .card { padding: 15px; }
            .modal { width: 95%; padding: 20px; }
            .background-grid { grid-template-columns: repeat(2,1fr); }
            .color-picker-container { flex-direction: column; align-items: stretch; }
            .color-preview { width: 100%; height: 40px; }
            .tab-buttons { justify-content: center; }
            .tab-btn { font-size: 0.8rem; padding: 8px; }
            .video-controls { bottom: 10px; padding: 8px 12px; }
            /* tampilkan tombol close hanya di mobile */
            .close-sidebar { display: block; }
        }
        @media (min-width: 769px) {
            .close-sidebar { display: none; }
        }
        @media (max-width: 480px) {
            .header { flex-direction: column; gap: 10px; align-items: stretch; }
            .header-buttons { display: flex; gap: 10px; }
            .bg-btn { margin-left: 0; flex: 1; justify-content: center; }
            .tab-buttons { gap: 3px; }
            .tab-btn { font-size: 0.75rem; padding: 6px 8px; }
            .video-controls { transform: translateX(-50%) scale(0.9); bottom: 5px; }
        }
    </style>
</head>
<body>
    <div class="video-background-container" id="videoBackgroundContainer"><video class="video-background" id="backgroundVideo" loop muted playsinline></video></div>
    <div class="video-controls" id="videoControls">
        <button class="video-control-btn" onclick="toggleVideoPlayback()" id="playPauseBtn">⏸️</button>
        <button class="video-control-btn" onclick="toggleVideoMute()" id="muteBtn">🔇</button>
        <input type="range" min="0" max="1" step="0.1" value="0.5" class="volume-slider" id="volumeSlider" oninput="changeVideoVolume(this.value)">
        <button class="video-control-btn" onclick="restartVideo()">↺</button>
    </div>
    <div class="content-overlay" id="contentOverlay"></div>
    <div class="sidebar" id="sidebar">
        <div class="sidebar-header">
            <div class="sidebar-header-left">
                <div class="crab-icon">🦀</div>
                <h2 style="color: var(--crab-color);">Panel Inori 🦀</h2>
            </div>
            <button class="close-sidebar" onclick="closeSidebar()">✕</button>
        </div>
        <p style="font-size:0.8rem; color: #666; margin-bottom: 20px;">v4.0 dengan Video Background</p>
        <div style="font-size: 0.9rem; color: #999; margin-bottom: 20px;">
            <p>Status: <span id="serverStatus">🟢 Online</span></p>
            <p>Bots: <span id="botCount">0</span> aktif</p>
        </div>
        <div style="margin-top: 30px;"><button class="btn btn-add" onclick="openBackgroundModal()">🎬 Custom Background</button></div>
        <div style="margin-top: 15px;"><button class="btn btn-secondary" style="width:100%;" onclick="resetBackground()">🔄 Reset Background</button></div>
        <!-- Bagian user info dan logout -->
        <div style="margin-top: auto; padding-top: 20px; border-top: 1px solid var(--border);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                <span>👤 <span id="usernameDisplay">${username}</span></span>
                <button class="btn btn-secondary" onclick="logout()" style="padding: 5px 10px;">🚪 Logout</button>
            </div>
            <p style="font-size: 0.75rem; color: #666; text-align: center;">Panel Inori 🦀 © 2025-2026</p>
        </div>
    </div>
    <div class="main-content">
        <div class="header">
            <h1><span class="crab-icon">🦀</span> Dashboard Panel Inori</h1>
            <div style="display: flex; gap: 10px; align-items: center;">
                <button class="menu-btn" onclick="toggleSidebar()">☰</button>
                <button class="bg-btn" onclick="openBackgroundModal()">🎬 Background</button>
            </div>
        </div>
        <div class="grid" id="botGrid">
            <div class="card add-card" onclick="openAddModal()"><div style="font-size: 3rem; margin-bottom: 10px;">+</div><div>➕ Tambah Bot Baru</div></div>
        </div>
    </div>
    <!-- Modal Add Bot -->
    <div class="modal-overlay" id="addModal"><div class="modal"><span class="close-btn" onclick="closeAddModal()">&times;</span><h2 style="margin-bottom:20px;">⚙️ Setup Bot Baru</h2><form id="addForm" enctype="multipart/form-data"><div class="form-group"><label>Nama Bot (Label)</label><input type="text" id="name" class="form-input" placeholder="Contoh: Bot Grup WA" required></div><div class="form-group"><label>Upload Script (.ZIP)</label><div class="file-upload-area" onclick="document.getElementById('botFile').click()" id="fileUploadArea" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleFileDrop(event)"><p style="font-size:3rem;">📁</p><p>Klik atau drop file ZIP di sini</p><p style="font-size:0.8rem; color:#666; margin-top:10px;">Maksimal 50MB</p></div><input type="file" id="botFile" class="form-file" accept=".zip" hidden required><div id="fileName" style="margin-top:10px; color:var(--primary);"></div></div><button type="submit" class="btn btn-add">💾 Simpan & Upload</button></form></div></div>
    <!-- Modal Terminal -->
    <div class="modal-overlay" id="terminalModal"><div class="modal" style="width:90%; max-width:700px;"><span class="close-btn" onclick="closeTerminal()">&times;</span><h2 id="termTitle" style="margin-bottom:15px;">💻 Terminal</h2><div id="terminalOutput" class="terminal-box">Ready...<br></div><form id="cmdForm" class="cmd-input-group"><span style="padding:10px; color:#00ff00;">$</span><input type="text" id="cmdInput" class="cmd-input" placeholder="npm install atau ls" autocomplete="off" required><button type="submit" class="btn" style="background:var(--primary);">🚀 RUN</button></form><div style="margin-top:10px; font-size:0.8rem; color:#666;">ℹ️ Catatan: Gunakan Start/Stop untuk menjalankan bot. Terminal untuk install/log.</div></div></div>
    <!-- Modal Background Settings -->
    <div class="modal-overlay" id="backgroundModal"><div class="modal" style="max-width:700px;"><span class="close-btn" onclick="closeBackgroundModal()">&times;</span><h2 style="margin-bottom:20px;">🎬 Custom Background</h2><div class="tab-buttons"><button class="tab-btn active" onclick="switchTab('color')">🎨 Warna</button><button class="tab-btn" onclick="switchTab('url')">🔗 URL</button><button class="tab-btn" onclick="switchTab('file')">📁 File</button><button class="tab-btn" onclick="switchTab('video')">🎬 Video</button><button class="tab-btn" onclick="switchTab('base64')">📸 Base64</button></div><div id="colorTab" class="tab-content active"><div class="form-group"><label>Pilih Warna Background</label><div class="color-picker-container"><div class="color-preview" id="colorPreview" style="background:#0f172a;"></div><input type="text" id="colorInput" class="color-input" value="#0f172a" placeholder="#RRGGBB atau nama warna"></div></div></div><div id="urlTab" class="tab-content"><div class="form-group"><label>URL Gambar/Video</label><input type="url" id="urlInput" class="form-input" placeholder="https://example.com/image.jpg atau video.mp4"><small style="color:#666;">Masukkan URL gambar (JPG, PNG, GIF) atau video (MP4, WebM)</small></div></div><div id="fileTab" class="tab-content"><div class="form-group"><label>Upload Gambar/Video</label><div class="file-upload-area" onclick="document.getElementById('fileInput').click()" id="imageUploadArea"><p style="font-size:3rem;">📁</p><p>Klik untuk upload gambar atau video</p><p style="font-size:0.8rem; color:#666;">Gambar: JPG, PNG, GIF | Video: MP4, WebM, MOV (Maks. 100MB)</p></div><input type="file" id="fileInput" accept="image/*,video/*" hidden><div id="imageFileName" style="margin-top:10px; color:var(--primary);"></div></div><div class="preview-section"><div class="preview-title">Background yang Tersimpan:</div><div class="background-grid" id="backgroundGrid"></div></div></div><div id="videoTab" class="tab-content"><div class="form-group"><label>URL Video</label><input type="url" id="videoUrlInput" class="form-input" placeholder="https://example.com/video.mp4"><small style="color:#666;">Masukkan URL video (MP4, WebM, OGG, MOV, AVI, MKV)</small></div><div class="video-options"><h4 style="margin-bottom:15px; color:var(--text-muted);">🎬 Video Options</h4><div class="option-group"><div class="option-label">Auto Play:</div><input type="checkbox" id="autoPlayOption" class="option-checkbox" checked></div><div class="option-group"><div class="option-label">Loop:</div><input type="checkbox" id="loopOption" class="option-checkbox" checked></div><div class="option-group"><div class="option-label">Muted:</div><input type="checkbox" id="mutedOption" class="option-checkbox" checked></div><div class="option-group"><div class="option-label">Volume:</div><input type="range" min="0" max="1" step="0.1" value="0.5" id="volumeOption" class="option-input" style="flex:none; width:200px;"><span id="volumeValue">50%</span></div><div class="option-group"><div class="option-label">Playback Rate:</div><select id="playbackRateOption" class="option-input" style="flex:none; width:200px;"><option value="0.5">0.5x (Slow)</option><option value="0.75">0.75x</option><option value="1" selected>1x (Normal)</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x (Fast)</option></select></div></div></div><div id="base64Tab" class="tab-content"><div class="form-group"><label>Base64 Image/Video Data</label><textarea id="base64Input" class="form-textarea" placeholder="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."></textarea><small style="color:#666;">Tempel data base64 gambar atau video lengkap dengan prefix</small></div><button class="btn btn-secondary" onclick="captureScreenshot()" style="width:100%; margin-top:10px;">📸 Capture & Convert to Base64</button></div><div class="video-options" id="videoOptionsSection" style="display:none;"><h4 style="margin-bottom:15px; color:var(--text-muted);">🎬 Video Options</h4><div class="option-group"><div class="option-label">Auto Play:</div><input type="checkbox" id="autoPlayOptionGlobal" class="option-checkbox" checked></div><div class="option-group"><div class="option-label">Loop:</div><input type="checkbox" id="loopOptionGlobal" class="option-checkbox" checked></div><div class="option-group"><div class="option-label">Muted:</div><input type="checkbox" id="mutedOptionGlobal" class="option-checkbox" checked></div></div><div class="preview-section"><div class="preview-title"><span>Preview:</span><button class="btn btn-secondary" onclick="updateBackgroundPreview()" style="padding:5px 10px; font-size:0.8rem;">🔄 Refresh Preview</button></div><div class="preview-area" id="backgroundPreview">Preview akan muncul di sini</div></div><div class="button-group"><button class="btn btn-secondary" onclick="closeBackgroundModal()" style="flex:1;">❌ Batal</button><button class="btn" onclick="applyBackground()" style="flex:2; background:var(--primary);">💾 Terapkan Background</button></div></div></div>
    <script>
        let currentBotId = null;
        let currentBackground = { type: 'color', value: '#0f172a' };
        let uploadedBackgrounds = [];
        let videoElement = null;
        let videoControlsVisible = false;
        function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
        function escapeQuotes(text) { return text.replace(/'/g, "\\\\'").replace(/"/g, '\\\\"'); }
        async function loadData() {
            try { const res = await fetch('/api/data'); const data = await res.json(); loadBots(data.bots); updateBotCount(data.bots); if (data.settings?.background) { currentBackground = data.settings.background; applyBackgroundToPage(); } } catch(e) { console.error(e); }
        }
        async function loadBots(botsData) {
            try { const bots = botsData || await (await fetch('/api/bots')).json(); const grid = document.getElementById('botGrid'); grid.innerHTML = '<div class="card add-card" onclick="openAddModal()"><div style="font-size: 3rem; margin-bottom: 10px;">+</div><div>➕ Tambah Bot Baru</div></div>';
                bots.forEach(bot => { const isRunning = bot.status === 'running'; const card = document.createElement('div'); card.className = 'card'; card.setAttribute('data-bot-id', bot.id); const safeName = escapeHtml(bot.name);
                card.innerHTML = \`<div class="card-header"><span class="bot-name">🤖 \${safeName}</span><span class="status \${bot.status}">\${bot.status === 'running' ? '▶️' : '⏸️'} \${bot.status}</span></div><div class="info-row"><span>📁 Path:</span> <span style="font-family:monospace; font-size:0.8rem">bots/\${bot.id}</span></div><div class="info-row"><span>📅 Created:</span> <span>\${bot.createdAt}</span></div><div class="actions-grid"><button class="btn btn-start" data-action="start" data-botid="\${bot.id}" \${isRunning ? 'disabled style="opacity:0.5; cursor:not-allowed"' : ''}>▶️ START</button><button class="btn btn-stop" data-action="stop" data-botid="\${bot.id}" \${!isRunning ? 'disabled style="opacity:0.5; cursor:not-allowed"' : ''}>⏸️ STOP</button><button class="btn btn-restart" data-action="restart" data-botid="\${bot.id}">🔄 RESTART</button></div><div class="actions-secondary"><button class="btn btn-terminal" data-action="terminal" data-botid="\${bot.id}" data-botname="\${escapeQuotes(safeName)}">💻 Terminal</button><button class="btn btn-delete" data-action="delete" data-botid="\${bot.id}">🗑️ Hapus</button></div>\`; grid.appendChild(card); });
                updateBotCount(bots);
            } catch(e) { console.error(e); document.getElementById('botGrid').innerHTML = '<div class="card add-card" onclick="openAddModal()"><div style="font-size: 3rem; margin-bottom: 10px;">+</div><div>➕ Tambah Bot Baru</div></div><div class="card"><div style="color: var(--danger); text-align: center;">Gagal memuat data bot</div></div>'; }
        }
        function updateBotCount(bots) { const running = bots ? bots.filter(b=>b.status==='running').length : 0; const total = bots ? bots.length : 0; document.getElementById('botCount').innerText = \`\${running}/\${total}\`; }
        document.addEventListener('click', function(e) { const btn = e.target.closest('[data-action]'); if(btn){ const action = btn.getAttribute('data-action'); const botId = btn.getAttribute('data-botid'); const botName = btn.getAttribute('data-botname'); if(!botId) return; if(action==='start') startBot(botId); else if(action==='stop') stopBot(botId); else if(action==='restart') restartBot(botId); else if(action==='terminal') openTerminal(botId, botName||''); else if(action==='delete') deleteBot(botId); } });
        function toggleSidebar() { document.getElementById('sidebar').classList.toggle('active'); }
        function closeSidebar() { document.getElementById('sidebar').classList.remove('active'); }
        function applyBackgroundToPage() {
            const body = document.body; const overlay = document.getElementById('contentOverlay'); const videoContainer = document.getElementById('videoBackgroundContainer'); const videoControls = document.getElementById('videoControls');
            body.style.backgroundImage = ''; body.style.backgroundColor = ''; videoContainer.style.display = 'none'; videoControls.style.display = 'none';
            if(videoElement){ videoElement.pause(); videoElement.src = ''; }
            if(currentBackground.type === 'color'){ body.style.backgroundColor = currentBackground.value; overlay.style.background = 'rgba(15, 23, 42, 0.85)'; }
            else {
                let sourceUrl = currentBackground.value;
                const isVideo = currentBackground.type === 'video' || (currentBackground.type === 'url' && sourceUrl.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i)) || (currentBackground.type === 'file' && sourceUrl.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i));
                if(isVideo){
                    videoContainer.style.display = 'block';
                    if(!videoElement) videoElement = document.getElementById('backgroundVideo');
                    if(currentBackground.type === 'video' || currentBackground.type === 'file') sourceUrl = '/videos/' + sourceUrl;
                    videoElement.src = sourceUrl;
                    const opts = currentBackground.videoOptions || {};
                    videoElement.autoplay = opts.autoplay !== false; videoElement.loop = opts.loop !== false; videoElement.muted = opts.muted !== false; videoElement.volume = opts.volume || 0.5; videoElement.playbackRate = opts.playbackRate || 1;
                    videoElement.onloadeddata = () => videoElement.play().catch(e=>console.log);
                    if(!videoElement.muted){ videoControls.style.display = 'flex'; videoControlsVisible = true; }
                    overlay.style.background = 'rgba(15, 23, 42, 0.7)';
                } else {
                    if(currentBackground.type === 'image' || currentBackground.type === 'file') sourceUrl = '/backgrounds/' + sourceUrl;
                    body.style.backgroundImage = \`url("\${sourceUrl}")\`; body.style.backgroundSize = 'cover'; body.style.backgroundPosition = 'center'; body.style.backgroundAttachment = 'fixed'; overlay.style.background = 'rgba(15, 23, 42, 0.85)';
                }
            }
        }
        function toggleVideoPlayback() { if(videoElement){ if(videoElement.paused){ videoElement.play(); document.getElementById('playPauseBtn').textContent='⏸️'; } else { videoElement.pause(); document.getElementById('playPauseBtn').textContent='▶️'; } } }
        function toggleVideoMute() { if(videoElement){ videoElement.muted = !videoElement.muted; document.getElementById('muteBtn').textContent = videoElement.muted ? '🔇' : '🔊'; const vc = document.getElementById('videoControls'); if(videoElement.muted){ vc.style.display='none'; videoControlsVisible=false; } else { vc.style.display='flex'; videoControlsVisible=true; } } }
        function changeVideoVolume(v) { if(videoElement){ videoElement.volume = parseFloat(v); document.getElementById('volumeSlider').value = v; if(videoElement.volume===0){ videoElement.muted=true; document.getElementById('muteBtn').textContent='🔇'; } else if(videoElement.muted){ videoElement.muted=false; document.getElementById('muteBtn').textContent='🔊'; } } }
        function restartVideo() { if(videoElement){ videoElement.currentTime=0; videoElement.play(); document.getElementById('playPauseBtn').textContent='⏸️'; } }
        document.addEventListener('mousemove', (e)=>{ if(videoElement && videoControlsVisible){ const vc = document.getElementById('videoControls'); const near = e.clientY > window.innerHeight-100; if(near){ vc.style.opacity='1'; vc.style.pointerEvents='auto'; } else { vc.style.opacity='0'; vc.style.pointerEvents='none'; } } });
        async function openBackgroundModal() { await loadUploadedBackgrounds(); if(currentBackground.type==='color'){ document.getElementById('colorInput').value=currentBackground.value; document.getElementById('colorPreview').style.background=currentBackground.value; } else if(currentBackground.type==='url') document.getElementById('urlInput').value=currentBackground.value; else if(currentBackground.type==='video'){ document.getElementById('videoUrlInput').value=currentBackground.value; const opts=currentBackground.videoOptions||{}; document.getElementById('autoPlayOption').checked=opts.autoplay!==false; document.getElementById('loopOption').checked=opts.loop!==false; document.getElementById('mutedOption').checked=opts.muted!==false; document.getElementById('volumeOption').value=opts.volume||0.5; document.getElementById('volumeValue').innerText=\`\${(opts.volume||0.5)*100}%\`; document.getElementById('playbackRateOption').value=opts.playbackRate||1; } else if(currentBackground.type==='base64') document.getElementById('base64Input').value=currentBackground.value||''; switchTab(currentBackground.type); updateBackgroundPreview(); document.getElementById('backgroundModal').classList.add('active'); }
        function closeBackgroundModal() { document.getElementById('backgroundModal').classList.remove('active'); }
        function switchTab(tabName){ document.querySelectorAll('.tab-btn').forEach(btn=>btn.classList.remove('active')); document.querySelectorAll('.tab-content').forEach(tab=>tab.classList.remove('active')); document.getElementById(tabName+'Tab').classList.add('active'); document.querySelectorAll('.tab-btn').forEach(btn=>{ if(btn.textContent.includes(tabName==='color'?'Warna':tabName==='url'?'URL':tabName==='file'?'File':tabName==='video'?'Video':'Base64')) btn.classList.add('active'); }); const vos = document.getElementById('videoOptionsSection'); if(tabName==='url'||tabName==='file'||tabName==='base64') vos.style.display='block'; else vos.style.display='none'; updateBackgroundPreview(); }
        async function loadUploadedBackgrounds(){ try{ const res=await fetch('/api/backgrounds/list'); uploadedBackgrounds=await res.json(); const grid=document.getElementById('backgroundGrid'); grid.innerHTML=''; uploadedBackgrounds.forEach(bg=>{ const isActive=currentBackground.value===bg.name; const isVideo=bg.type==='video'; const thumb=bg.thumbnail||bg.path; const item=document.createElement('div'); item.className=\`bg-item \${isActive?'active':''}\`; item.innerHTML=\`<img src="\${thumb}" class="bg-thumbnail" onclick="selectBackgroundFile('\${bg.name}','\${bg.type}')"><div class="bg-type-badge">\${isVideo?'🎬':'🖼️'}</div>\`; grid.appendChild(item); }); }catch(e){ console.error(e); } }
        function selectBackgroundFile(filename,type){ document.querySelectorAll('.bg-item').forEach(i=>i.classList.remove('active')); event.target.closest('.bg-item').classList.add('active'); currentBackground={type:type, value:filename}; updateBackgroundPreview(); }
        function updateBackgroundPreview(){ const preview=document.getElementById('backgroundPreview'); const activeTab=document.querySelector('.tab-content.active').id; preview.innerHTML=''; if(activeTab==='colorTab'){ const col=document.getElementById('colorInput').value; preview.style.background=col; preview.style.backgroundImage='none'; preview.innerHTML='<div>Warna: '+col+'</div>'; } else if(activeTab==='urlTab'){ const url=document.getElementById('urlInput').value; if(url){ const isVid=url.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i); if(isVid){ const vid=document.createElement('video'); vid.src=url; vid.className='video-preview'; vid.muted=true; vid.loop=true; vid.autoplay=true; preview.appendChild(vid); preview.style.backgroundImage='none'; } else { preview.style.backgroundImage=\`url("\${url}")\`; preview.style.backgroundSize='cover'; preview.innerHTML='<div>URL Gambar</div>'; } } else { preview.style.background='#1e293b'; preview.style.backgroundImage='none'; preview.innerHTML='<div>Masukkan URL gambar/video</div>'; } } else if(activeTab==='fileTab'){ if(currentBackground.type && currentBackground.value){ const isVid=currentBackground.value.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i); if(isVid){ const vid=document.createElement('video'); vid.src='/videos/'+currentBackground.value; vid.className='video-preview'; vid.muted=true; vid.loop=true; vid.autoplay=true; preview.appendChild(vid); preview.style.backgroundImage='none'; } else { preview.style.backgroundImage=\`url("/backgrounds/\${currentBackground.value}")\`; preview.style.backgroundSize='cover'; preview.innerHTML='<div>Gambar Terpilih</div>'; } } else { preview.style.background='#1e293b'; preview.style.backgroundImage='none'; preview.innerHTML='<div>Pilih file</div>'; } } else if(activeTab==='videoTab'){ const vurl=document.getElementById('videoUrlInput').value; if(vurl){ const vid=document.createElement('video'); vid.src=vurl; vid.className='video-preview'; vid.muted=true; vid.loop=true; vid.autoplay=true; preview.appendChild(vid); preview.style.backgroundImage='none'; } else { preview.style.background='#1e293b'; preview.innerHTML='<div>Masukkan URL video</div>'; } } else if(activeTab==='base64Tab'){ const b64=document.getElementById('base64Input').value; if(b64 && b64.includes('base64')){ const isVid=b64.includes('data:video/'); if(isVid){ const vid=document.createElement('video'); vid.src=b64; vid.className='video-preview'; vid.muted=true; vid.loop=true; vid.autoplay=true; preview.appendChild(vid); preview.style.backgroundImage='none'; } else { preview.style.backgroundImage=\`url("\${b64}")\`; preview.style.backgroundSize='cover'; preview.innerHTML='<div>Base64 Image</div>'; } } else { preview.style.background='#1e293b'; preview.innerHTML='<div>Masukkan data base64</div>'; } } }
        document.getElementById('colorInput').addEventListener('input',function(){ document.getElementById('colorPreview').style.background=this.value; updateBackgroundPreview(); });
        document.getElementById('urlInput').addEventListener('input',updateBackgroundPreview);
        document.getElementById('videoUrlInput').addEventListener('input',updateBackgroundPreview);
        document.getElementById('fileInput').addEventListener('change',function(e){ if(e.target.files[0]){ document.getElementById('imageFileName').textContent='File: '+e.target.files[0].name; const isVid=e.target.files[0].type.startsWith('video/'); currentBackground={type:'file', value:e.target.files[0].name}; updateBackgroundPreview(); } });
        document.getElementById('base64Input').addEventListener('input',updateBackgroundPreview);
        document.getElementById('volumeOption').addEventListener('input',function(e){ document.getElementById('volumeValue').innerText=Math.round(e.target.value*100)+'%'; });
        async function applyBackground(){
            const formData=new FormData(); let type,value; let videoOptions={}; const activeTab=document.querySelector('.tab-content.active').id;
            if(activeTab==='colorTab'){ type='color'; value=document.getElementById('colorInput').value; }
            else if(activeTab==='urlTab'){ const uv=document.getElementById('urlInput').value; if(!uv){ alert('Masukkan URL gambar/video'); return; } const isVid=uv.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i); type=isVid?'video':'url'; value=uv; if(isVid){ videoOptions={autoplay:document.getElementById('autoPlayOptionGlobal').checked, loop:document.getElementById('loopOptionGlobal').checked, muted:document.getElementById('mutedOptionGlobal').checked}; } }
            else if(activeTab==='fileTab'){ const fi=document.getElementById('fileInput'); if(fi.files.length>0){ type='file'; const file=fi.files[0]; const isVid=file.type.startsWith('video/'); if(isVid){ formData.append('backgroundVideo',file); videoOptions={autoplay:document.getElementById('autoPlayOptionGlobal').checked, loop:document.getElementById('loopOptionGlobal').checked, muted:document.getElementById('mutedOptionGlobal').checked}; } else { formData.append('backgroundImage',file); } value=''; } else if(currentBackground.type==='file' || currentBackground.type==='image'){ type=currentBackground.type; value=currentBackground.value; if(currentBackground.value.match(/\\.(mp4|webm|ogg|mov|avi|mkv)$/i)){ videoOptions={autoplay:document.getElementById('autoPlayOptionGlobal').checked, loop:document.getElementById('loopOptionGlobal').checked, muted:document.getElementById('mutedOptionGlobal').checked}; } } else { alert('Pilih file gambar/video terlebih dahulu'); return; } }
            else if(activeTab==='videoTab'){ type='video'; value=document.getElementById('videoUrlInput').value; if(!value){ alert('Masukkan URL video'); return; } videoOptions={autoplay:document.getElementById('autoPlayOption').checked, loop:document.getElementById('loopOption').checked, muted:document.getElementById('mutedOption').checked, volume:parseFloat(document.getElementById('volumeOption').value), playbackRate:parseFloat(document.getElementById('playbackRateOption').value)}; }
            else if(activeTab==='base64Tab'){ type='base64'; value=document.getElementById('base64Input').value; if(!value||!value.includes('base64')){ alert('Masukkan data base64 yang valid'); return; } if(value.includes('data:video/')){ videoOptions={autoplay:document.getElementById('autoPlayOptionGlobal').checked, loop:document.getElementById('loopOptionGlobal').checked, muted:document.getElementById('mutedOptionGlobal').checked}; } }
            formData.append('type',type); formData.append('value',value); formData.append('videoOptions',JSON.stringify(videoOptions));
            try{ const res=await fetch('/api/background',{method:'POST',body:formData}); const data=await res.json(); if(data.success){ currentBackground=data.background; applyBackgroundToPage(); closeBackgroundModal(); alert('✅ Background berhasil diupdate!'); } else alert('❌ Error: '+data.error); }catch(e){ alert('❌ Gagal mengupdate background'); console.error(e); }
        }
        async function resetBackground(){ if(!confirm('Reset background ke default?')) return; try{ const res=await fetch('/api/background/reset',{method:'POST'}); const data=await res.json(); if(data.success){ currentBackground=data.background; applyBackgroundToPage(); alert('✅ Background berhasil direset'); } }catch(e){ alert('❌ Gagal reset background'); } }
        function captureScreenshot(){ alert('Fitur screenshot: Gunakan Print Screen atau screenshot tool lain, lalu paste ke Base64 tab'); }
        function handleDragOver(e){ e.preventDefault(); e.stopPropagation(); document.getElementById('fileUploadArea').classList.add('dragover'); }
        function handleDragLeave(e){ e.preventDefault(); e.stopPropagation(); document.getElementById('fileUploadArea').classList.remove('dragover'); }
        function handleFileDrop(e){ e.preventDefault(); e.stopPropagation(); document.getElementById('fileUploadArea').classList.remove('dragover'); const files=e.dataTransfer.files; if(files.length>0){ document.getElementById('botFile').files=files; document.getElementById('fileName').innerText='File: '+files[0].name; } }
        function openAddModal(){ document.getElementById('addModal').classList.add('active'); }
        function closeAddModal(){ document.getElementById('addModal').classList.remove('active'); document.getElementById('addForm').reset(); document.getElementById('fileName').innerText=''; }
        document.getElementById('botFile').addEventListener('change',function(e){ if(e.target.files.length>0) document.getElementById('fileName').innerText='File: '+e.target.files[0].name; });
        document.getElementById('addForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const fd=new FormData(); fd.append('name',document.getElementById('name').value); fd.append('botFile',document.getElementById('botFile').files[0]); try{ const res=await fetch('/api/bots',{method:'POST',body:fd}); if(res.ok){ alert('✅ Bot Berhasil Ditambahkan!'); closeAddModal(); await loadData(); } else { const err=await res.json(); alert('❌ Error: '+(err.error||'Gagal menambah bot')); } }catch(err){ alert('❌ Gagal menambah bot: '+err.message); } });
        async function startBot(id){ try{ const res=await fetch('/api/bots/'+id+'/start',{method:'POST'}); const data=await res.json(); if(res.ok && data.success){ alert('✅ '+data.message); await loadData(); } else alert('❌ Error: '+(data.error||'Gagal menjalankan bot')); }catch(e){ alert('❌ Gagal menjalankan bot: '+e.message); } }
        async function stopBot(id){ try{ const res=await fetch('/api/bots/'+id+'/stop',{method:'POST'}); const data=await res.json(); if(res.ok && data.success){ alert('✅ '+data.message); await loadData(); } else alert('❌ Error: '+(data.error||'Gagal menghentikan bot')); }catch(e){ alert('❌ Gagal menghentikan bot: '+e.message); } }
        async function restartBot(id){ try{ const res=await fetch('/api/bots/'+id+'/restart',{method:'POST'}); const data=await res.json(); if(res.ok && data.success){ alert('✅ '+data.message); await loadData(); } else alert('❌ Error: '+(data.error||'Gagal restart bot')); }catch(e){ alert('❌ Gagal restart bot: '+e.message); } }
        async function deleteBot(id){ if(!confirm('⚠️ Yakin ingin menghapus bot ini?\\nSemua file bot akan dihapus permanen!')) return; try{ const res=await fetch('/api/bots/'+id,{method:'DELETE'}); const data=await res.json(); if(res.ok && data.success){ alert('✅ '+ (data.message||'Bot berhasil dihapus')); await loadData(); } else alert('❌ Error: '+(data.error||'Gagal menghapus bot')); }catch(e){ alert('❌ Gagal menghapus bot: '+e.message); } }
        const termModal=document.getElementById('terminalModal'); const termOutput=document.getElementById('terminalOutput');
        function openTerminal(id,name){ currentBotId=id; document.getElementById('termTitle').innerHTML='💻 Terminal: '+(name||'Bot'); termOutput.innerHTML='Connected to bots/'+id+'...<br>Ready.<br>'; termModal.classList.add('active'); document.getElementById('cmdInput').focus(); }
        function closeTerminal(){ termModal.classList.remove('active'); currentBotId=null; }
        document.getElementById('cmdForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const cmd=document.getElementById('cmdInput').value; termOutput.innerHTML+='<span style="color:white">root@server:$</span> '+cmd+'<br>'; termOutput.scrollTop=termOutput.scrollHeight; try{ const res=await fetch('/api/terminal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:currentBotId,command:cmd})}); const data=await res.json(); termOutput.innerHTML+=(data.output||'No output').replace(/\\n/g,'<br>')+'<br>'; termOutput.scrollTop=termOutput.scrollHeight; document.getElementById('cmdInput').value=''; }catch(err){ termOutput.innerHTML+='Error executing command<br>'; console.error(err); } });
        async function logout(){ if(confirm('Yakin ingin logout?')){ await fetch('/api/auth/logout',{method:'POST'}); window.location.href='/login'; } }
        loadData(); setInterval(loadData,30000);
    </script>
</body>
</html>`);
});

// Redirect root ke login
app.get('/', (req, res) => {
    res.redirect('/login');
});

app.listen(PORT, () => {
    console.log(`🦀 Panel Inori berjalan di http://localhost:${PORT}`);
    console.log(`🔐 Login dengan default: admin / admin123`);
    console.log(`🎬 Background video feature aktif (termasuk di halaman login)`);
    console.log(`✨ Tombol close (X) di sidebar untuk mode mobile`);
});