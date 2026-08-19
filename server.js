const path = require('path');
const express = require('express');
const session = require('express-session');
const erp = require('./erpClient');

const app = express();
const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'hqsoft-dev-secret-change-me';

// Tài khoản dùng chung cho cả team — cấu hình qua biến môi trường.
// Không lưu trạng thái động nào ở đây, nên không có gì để "mất" khi server restart.
const TEAM_USER = process.env.ADMIN_USER || 'admin';
const TEAM_PASS = process.env.ADMIN_PASS || 'admin123@';

app.use(express.json());
app.use(
  session({
    name: 'hq_ops_sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1', // bật khi đã chạy sau HTTPS
      maxAge: 1000 * 60 * 60 * 12, // 12h
    },
  })
);

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu' });
  if (username !== TEAM_USER || password !== TEAM_PASS) {
    return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
  }
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({ username: req.session.username });
});

/* ---------- trang con cần đăng nhập (module theo dự án) ----------
   Đặt trong thư mục protected/ (không nằm trong public/), nên không ai
   truy cập trực tiếp được nếu chưa đăng nhập — khác với public/ vốn phục
   vụ tĩnh không cần qua kiểm tra. */
function requirePageAuth(req, res, next) {
  if (!req.session.username) return res.redirect('/');
  next();
}
function requireAuth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}

app.get('/abi/dashboard-ticket', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'abi-dashboard-ticket.html'));
});

app.get('/anvy/ticket-slide', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'anvy-ticket-slide.html'));
});

app.get('/abi/erp-tickets', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'abi-erp-tickets.html'));
});

/* ---------- API: lấy ticket từ ERPNext (đăng nhập bằng email/mật khẩu) ---------- */
app.get('/api/erp/tickets', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) {
    return res.status(501).json({
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL / ERP_USER / ERP_PASS).',
    });
  }
  try {
    const project = (req.query.project || '').toString().trim();
    const status = (req.query.status || '').toString().trim();
    const data = await erp.fetchTickets({ project, status });
    res.json(data);
  } catch (e) {
    console.error('[erp/tickets] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- static frontend ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`HQSOFT Ops Console server đang chạy tại http://localhost:${PORT}`);
  console.log(`Tài khoản dùng chung: ${TEAM_USER} / ${TEAM_PASS}`);
});
