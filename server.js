const path = require('path');
const express = require('express');
const session = require('express-session');
const store = require('./accountsStore');

store.ensureDb();

const app = express();
const PORT = process.env.PORT || 4000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'hqsoft-dev-secret-change-me';

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
      // secure:true yeu cau HTTPS - bat len khi da co reverse proxy HTTPS
      secure: process.env.COOKIE_SECURE === '1',
      maxAge: 1000 * 60 * 60 * 12, // 12h
    },
  })
);

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Cần quyền admin' });
  }
  next();
}

/* ---------- auth ---------- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu' });
  const account = store.verifyLogin(username, password);
  if (!account) return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
  req.session.user = account;
  res.json({ ok: true, user: account });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({ user: req.session.user });
});

app.get('/api/modules', requireAuth, (req, res) => {
  res.json({ modules: store.MODULES });
});

/* ---------- admin: quan ly tai khoan ---------- */
app.get('/api/accounts', requireAdmin, (req, res) => {
  res.json({ accounts: store.listAccounts(), modules: store.MODULES });
});

app.post('/api/accounts', requireAdmin, (req, res) => {
  const { username, password, role, modules } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu' });
  if (role !== 'admin' && (!Array.isArray(modules) || modules.length === 0)) {
    return res.status(400).json({ error: 'Chọn ít nhất 1 chức năng, hoặc cấp quyền admin' });
  }
  try {
    const accounts = store.createAccount({ username, password, role, modules });
    res.json({ ok: true, accounts });
  } catch (e) {
    res.status(e.code === 'DUPLICATE' ? 409 : 400).json({ error: e.message });
  }
});

app.put('/api/accounts/:username', requireAdmin, (req, res) => {
  try {
    const accounts = store.updateAccountModules(req.params.username, req.body || {});
    res.json({ ok: true, accounts });
  } catch (e) {
    res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:username', requireAdmin, (req, res) => {
  try {
    const accounts = store.deleteAccount(req.params.username);
    res.json({ ok: true, accounts });
  } catch (e) {
    res.status(e.code === 'FORBIDDEN' ? 403 : 404).json({ error: e.message });
  }
});

/* ---------- static frontend ---------- */
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`HQSOFT Ops Console server đang chạy tại http://localhost:${PORT}`);
});
