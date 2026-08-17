const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_DIR = path.join(__dirname, 'db');
const DB_FILE = path.join(DB_DIR, 'accounts.json');

const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASS || 'admin123@';

// Danh sach module co san trong he thong. Sua/them o day khi co chuc nang moi.
const MODULES = [
  { id: 'crs-pakd-baogia', label: 'Crs: PAKD và Báo Giá', ready: true },
  { id: 'module-02', label: 'Chưa có nội dung', ready: false },
  { id: 'module-03', label: 'Chưa có nội dung', ready: false },
];

function ensureDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const seed = {
      [DEFAULT_ADMIN_USER]: {
        passwordHash: bcrypt.hashSync(DEFAULT_ADMIN_PASS, 10),
        role: 'admin',
        modules: ['*'],
        createdAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), 'utf8');
    console.log(`[accountsStore] Đã tạo tài khoản admin mặc định: ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASS}`);
  }
}

function loadAll() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveAll(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function findAccount(username) {
  const all = loadAll();
  return all[username] || null;
}

function verifyLogin(username, password) {
  const acc = findAccount(username);
  if (!acc) return null;
  if (!bcrypt.compareSync(password, acc.passwordHash)) return null;
  return { username, role: acc.role, modules: acc.modules };
}

function listAccounts() {
  const all = loadAll();
  return Object.keys(all).map((username) => ({
    username,
    role: all[username].role,
    modules: all[username].modules,
    isDefault: username === DEFAULT_ADMIN_USER,
  }));
}

function createAccount({ username, password, role, modules }) {
  const all = loadAll();
  if (all[username]) {
    const err = new Error('Tài khoản đã tồn tại');
    err.code = 'DUPLICATE';
    throw err;
  }
  all[username] = {
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'member',
    modules: role === 'admin' ? ['*'] : (Array.isArray(modules) ? modules : []),
    createdAt: new Date().toISOString(),
  };
  saveAll(all);
  return listAccounts();
}

function deleteAccount(username) {
  if (username === DEFAULT_ADMIN_USER) {
    const err = new Error('Không thể xóa tài khoản admin mặc định');
    err.code = 'FORBIDDEN';
    throw err;
  }
  const all = loadAll();
  if (!all[username]) {
    const err = new Error('Không tìm thấy tài khoản');
    err.code = 'NOT_FOUND';
    throw err;
  }
  delete all[username];
  saveAll(all);
  return listAccounts();
}

function updateAccountModules(username, { role, modules, password }) {
  const all = loadAll();
  if (!all[username]) {
    const err = new Error('Không tìm thấy tài khoản');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (role) all[username].role = role === 'admin' ? 'admin' : 'member';
  if (all[username].role === 'admin') {
    all[username].modules = ['*'];
  } else if (Array.isArray(modules)) {
    all[username].modules = modules;
  }
  if (password) all[username].passwordHash = bcrypt.hashSync(password, 10);
  saveAll(all);
  return listAccounts();
}

function isModuleAllowed(account, moduleId) {
  if (!account) return false;
  return account.modules.includes('*') || account.modules.includes(moduleId);
}

module.exports = {
  MODULES,
  ensureDb,
  findAccount,
  verifyLogin,
  listAccounts,
  createAccount,
  deleteAccount,
  updateAccountModules,
  isModuleAllowed,
  DEFAULT_ADMIN_USER,
};
