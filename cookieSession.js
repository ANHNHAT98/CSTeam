'use strict';
/* Phiên đăng nhập lưu trong cookie có chữ ký HMAC (thay express-session MemoryStore).
   Server không giữ phiên trong RAM nữa → restart / deploy lại / Render ngủ dậy vẫn còn đăng nhập.
   Bắt buộc đặt SESSION_SECRET (chuỗi ngẫu nhiên dài) trên Render: ai biết secret mới tạo được cookie hợp lệ.
   Nếu chưa đặt, server dùng secret ngẫu nhiên mỗi lần khởi động (an toàn, nhưng restart vẫn bị đăng xuất như cũ). */
const crypto = require('crypto');

const DEFAULT_WEAK = 'hqsoft-dev-secret-change-me';

function cookieSession({ name, secret, maxAgeMs, secure }) {
  let key = String(secret || '');
  if (!key || key === DEFAULT_WEAK || key.length < 16) {
    key = crypto.randomBytes(32).toString('hex');
    console.warn('[session] SESSION_SECRET chưa đặt hoặc quá ngắn (<16 ký tự) → dùng secret tạm, restart server sẽ phải đăng nhập lại.');
  }
  const sign = (v) => crypto.createHmac('sha256', key).update(v).digest('base64url');
  const renewAfter = Math.min(maxAgeMs / 7, 24 * 3600 * 1000); // gia hạn cookie tối đa 1 lần/ngày

  function read(req) {
    const raw = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
    if (!raw) return null;
    const [body, sig] = decodeURIComponent(raw.slice(name.length + 1)).split('.');
    if (!body || !sig) return null;
    const want = sign(body);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    try {
      const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return d && d.exp > Date.now() ? d : null;
    } catch (_) { return null; }
  }

  function cookieStr(value, maxAge) {
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(maxAge / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  return function (req, res, next) {
    const d = read(req);
    const startUser = d ? d.u : undefined;
    let destroyed = false;
    req.session = {
      username: startUser,
      destroy(cb) { destroyed = true; this.username = undefined; if (cb) cb(); },
    };
    const origWriteHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!res.headersSent) {
        const u = req.session && req.session.username;
        let set = null;
        if (destroyed || (startUser && !u)) set = cookieStr('', 0);
        else if (u && (u !== startUser || !d || d.exp - Date.now() < maxAgeMs - renewAfter)) {
          const body = Buffer.from(JSON.stringify({ u, exp: Date.now() + maxAgeMs }), 'utf8').toString('base64url');
          set = cookieStr(body + '.' + sign(body), maxAgeMs);
        }
        if (set) {
          const prev = res.getHeader('Set-Cookie');
          res.setHeader('Set-Cookie', prev ? [].concat(prev, set) : set);
        }
      }
      return origWriteHead.apply(this, args);
    };
    next();
  };
}

module.exports = { cookieSession };
