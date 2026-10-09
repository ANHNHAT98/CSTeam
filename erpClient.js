// Client goi ERPNext (Frappe) bang phien dang nhap email/mat khau,
// KHONG can API Key / API Secret (khong can quyen System Manager).

const ERP_BASE_URL = (process.env.ERP_BASE_URL || '').replace(/\/+$/, '');
const ERP_USER = process.env.ERP_USER || '';
const ERP_PASS = process.env.ERP_PASS || '';

let cachedCookie = null;
let loginPromise = null;

function assertConfigured() {
  if (!ERP_BASE_URL || !ERP_USER || !ERP_PASS) {
    const err = new Error(
      'Chưa cấu hình ERP_BASE_URL / ERP_USER / ERP_PASS trên server (xem docker-compose.yml).'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
}

/** Đăng nhập ERP bằng 1 cặp tài khoản bất kỳ, trả về chuỗi cookie phiên. */
async function loginRequest(usr, pwd) {
  assertConfigured();
  const res = await fetch(`${ERP_BASE_URL}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usr, pwd }).toString(),
  });

  if (!res.ok) {
    const err = new Error(`Đăng nhập ERP thất bại cho "${usr}" (HTTP ${res.status}) — kiểm tra lại tài khoản/mật khẩu.`);
    err.code = 'LOGIN_FAILED';
    throw err;
  }

  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  if (!cookies.length) {
    const err = new Error('Đăng nhập ERP không trả về cookie phiên — kiểm tra lại địa chỉ ERP_BASE_URL.');
    err.code = 'NO_COOKIE';
    throw err;
  }
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function erpLogin() {
  cachedCookie = await loginRequest(ERP_USER, ERP_PASS);
  return cachedCookie;
}

function ensureLoggedIn() {
  if (cachedCookie) return Promise.resolve(cachedCookie);
  if (!loginPromise) {
    loginPromise = erpLogin().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

async function erpFetch(pathWithQuery, { retry = true } = {}) {
  assertConfigured();
  await ensureLoggedIn();

  const res = await fetch(`${ERP_BASE_URL}${pathWithQuery}`, {
    headers: { Cookie: cachedCookie, Accept: 'application/json' },
  });

  if ((res.status === 401 || res.status === 403) && retry) {
    cachedCookie = null;
    await ensureLoggedIn();
    return erpFetch(pathWithQuery, { retry: false });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ERP API lỗi HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.code = 'ERP_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Lay danh sach ticket theo doctype "Ticket".
 * projects: string | string[] -> loc theo project (operator "=" neu 1 gia tri, "in" neu nhieu)
 * statuses: string | (string|null)[] -> loc theo status, ho tro ca gia tri null (chua co status)
 * openingFrom/openingTo: 'YYYY-MM-DD' -> loc theo opening_date ngay tren ERP (tranh bi cat bot
 *   du lieu khi project co qua limit_page_length ticket va API khong sap xep theo ngay).
 * modifiedFrom/modifiedTo: 'YYYY-MM-DD' -> loc theo modified (lan cap nhat gan nhat), dung de
 *   lay danh sach ticket co thao tac/cap nhat trong 1 khoang ngay (vd de gen "Thuc hien trong tuan").
 */
async function fetchTickets({ projects, statuses, limit = 2000, openingFrom, openingTo, modifiedFrom, modifiedTo } = {}) {
  const filters = [];

  const projList = normalizeList(projects);
  if (projList.length === 1) filters.push(['project', '=', projList[0]]);
  else if (projList.length > 1) filters.push(['project', 'in', projList]);

  const statusList = normalizeList(statuses, { keepNull: true });
  if (statusList.length === 1 && statusList[0] !== null) filters.push(['status', '=', statusList[0]]);
  else if (statusList.length > 1) filters.push(['status', 'in', statusList]);

  if (openingFrom) filters.push(['opening_date', '>=', `${openingFrom} 00:00:00`]);
  if (openingTo) filters.push(['opening_date', '<=', `${openingTo} 23:59:59`]);
  if (modifiedFrom) filters.push(['modified', '>=', `${modifiedFrom} 00:00:00`]);
  if (modifiedTo) filters.push(['modified', '<=', `${modifiedTo} 23:59:59`]);

  const qs = new URLSearchParams();
  qs.set('filters', JSON.stringify(filters));
  qs.set('fields', JSON.stringify(['*']));
  qs.set('limit_page_length', String(limit));
  qs.set('order_by', modifiedFrom || modifiedTo ? 'modified desc' : 'opening_date desc');

  return erpFetch(`/api/resource/Ticket?${qs.toString()}`);
}

function normalizeList(value, { keepNull = false } = {}) {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (v === 'null' || v === null ? (keepNull ? null : undefined) : v))
    .filter((v) => v !== undefined && v !== '');
}

/**
 * Lay danh sach du an (doctype "Project"), loc theo project_type neu co.
 * Dung cho combobox chon du an o cac man hinh loc theo project (vd Timesheet).
 */
async function fetchProjects({ project_type, project_owner, limit = 500 } = {}) {
  const filters = [];
  if (project_type) filters.push(['project_type', '=', project_type]);

  const ownerList = normalizeList(project_owner);
  if (ownerList.length === 1) filters.push(['project_owner', '=', ownerList[0]]);
  else if (ownerList.length > 1) filters.push(['project_owner', 'in', ownerList]);

  const qs = new URLSearchParams();
  qs.set('filters', JSON.stringify(filters));
  qs.set('fields', JSON.stringify(['name', 'project_name', 'status', 'project_type', 'project_owner']));
  qs.set('limit_page_length', String(limit));
  qs.set('order_by', 'project_name asc');

  return erpFetch(`/api/resource/Project?${qs.toString()}`);
}

/**
 * Chay Query Report "Detail Timesheet Report" truc tiep tren ERP (khong can
 * export file .xlsx thu cong). Query Report khac doctype thuong nen phai goi
 * qua endpoint frappe.desk.query_report.run, khong phai /api/resource.
 */
async function fetchTimesheetReport({ from_date, to_date, project } = {}) {
  const filters = {};
  if (from_date) filters.from_date = from_date;
  if (to_date) filters.to_date = to_date;
  if (project) filters.project = project;

  const qs = new URLSearchParams();
  qs.set('report_name', 'Detail Timesheet Report');
  qs.set('filters', JSON.stringify(filters));
  qs.set('ignore_prepared_report', '1');

  return erpFetch(`/api/method/frappe.desk.query_report.run?${qs.toString()}`);
}

/* ===================== GHI DỮ LIỆU (tạo ticket) ===================== */
let cachedCsrf = null;

/* ERP_USERS: JSON mảng các thành viên có tài khoản ERP riêng để tạo ticket đúng tên người tạo, ví dụ
   [{"key":"an","label":"Nguyễn An","user":"an@hqsoft.vn","pass":"***"}]
   Mật khẩu chỉ nằm ở biến môi trường của server, không bao giờ gửi xuống trình duyệt. */
function parseErpUsers(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('phải là mảng');
    return arr
      .filter((u) => u && u.key && u.user && u.pass)
      .map((u) => ({ key: String(u.key), label: String(u.label || u.user), user: String(u.user), pass: String(u.pass) }));
  } catch (e) {
    console.error('[erp] ERP_USERS không hợp lệ, bỏ qua:', e.message);
    return [];
  }
}
const ERP_USERS = parseErpUsers(process.env.ERP_USERS);
// ERP_ALLOW_CUSTOM_LOGIN=0 -> ẩn/chặn tuỳ chọn "nhập tài khoản ERP khác", chỉ cho chọn tài khoản khai báo trong ERP_USERS.
const ALLOW_CUSTOM_LOGIN = !/^(0|false|no|off)$/i.test(String(process.env.ERP_ALLOW_CUSTOM_LOGIN || '1').trim());
console.log(`[erp] Người tạo ticket đã nạp từ ERP_USERS: ${ERP_USERS.length} tài khoản${ERP_USERS.length ? ' (' + ERP_USERS.map((u) => u.key).join(', ') + ')' : ''}; nhập tài khoản khác: ${ALLOW_CUSTOM_LOGIN ? 'cho phép' : 'tắt'}`);

/** Danh sách người tạo hiển thị trên form (KHÔNG chứa mật khẩu). key '' = tài khoản mặc định ERP_USER. */
function listCreators() {
  return [
    { key: '', label: `Tài khoản chung (${ERP_USER || 'chưa cấu hình'})` },
    ...ERP_USERS.map((u) => ({ key: u.key, label: `${u.label} (${u.user})` })),
  ];
}

const userCtxs = new Map(); // key -> ngữ cảnh phiên riêng của từng thành viên
const defaultCtx = {
  label: ERP_USER,
  async cookie() { await ensureLoggedIn(); return cachedCookie; },
  get csrf() { return cachedCsrf; },
  set csrf(v) { cachedCsrf = v; },
  reset() { cachedCookie = null; cachedCsrf = null; },
};

function getCtx(creatorKey) {
  if (!creatorKey) return defaultCtx;
  const u = ERP_USERS.find((x) => x.key === creatorKey);
  if (!u) {
    const err = new Error(`Không có người tạo "${creatorKey}" trong danh sách ERP_USERS.`);
    err.code = 'UNKNOWN_CREATOR';
    throw err;
  }
  if (!userCtxs.has(u.key)) {
    const st = { cookie: null, csrf: null, p: null };
    userCtxs.set(u.key, {
      label: u.user,
      async cookie() {
        if (st.cookie) return st.cookie;
        if (!st.p) st.p = loginRequest(u.user, u.pass).then((c) => { st.cookie = c; return c; }).finally(() => { st.p = null; });
        return st.p;
      },
      get csrf() { return st.csrf; },
      set csrf(v) { st.csrf = v; },
      reset() { st.cookie = null; st.csrf = null; },
    });
  }
  return userCtxs.get(u.key);
}

/** Ngữ cảnh cho tài khoản do người dùng tự đăng nhập trên trang: chỉ giữ cookie phiên, KHÔNG giữ mật khẩu. */
function makeCookieCtx(user, cookie) {
  const st = { cookie, csrf: null, expired: false };
  return {
    label: user,
    async cookie() {
      if (st.expired) {
        const err = new Error(`Phiên ERP của "${user}" đã hết hạn — hãy đăng nhập lại tài khoản ERP.`);
        err.code = 'SESSION_EXPIRED';
        throw err;
      }
      return st.cookie;
    },
    get csrf() { return st.csrf; },
    set csrf(v) { st.csrf = v; },
    reset() { st.expired = true; st.cookie = null; st.csrf = null; },
  };
}

async function fetchCsrfToken(ctx) {
  // Frappe nhúng csrf_token trong trang /app khi dùng phiên đăng nhập bằng cookie.
  const res = await fetch(`${ERP_BASE_URL}/app`, { headers: { Cookie: await ctx.cookie(), Accept: 'text/html' } });
  const html = await res.text();
  const m = html.match(/csrf_token\s*[=:]\s*["']([^"']+)["']/);
  ctx.csrf = m ? m[1] : null;
  return ctx.csrf;
}

async function erpPost(pathname, body, { ctx = defaultCtx, retry = true, csrfTried = false, method = 'POST' } = {}) {
  assertConfigured();
  const headers = { Cookie: await ctx.cookie(), Accept: 'application/json', 'Content-Type': 'application/json' };
  if (ctx.csrf) headers['X-Frappe-CSRF-Token'] = ctx.csrf;

  const res = await fetch(`${ERP_BASE_URL}${pathname}`, { method, headers, body: JSON.stringify(body) });

  if (res.status === 401 && retry) {
    ctx.reset();
    return erpPost(pathname, body, { ctx, retry: false, csrfTried, method });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (!csrfTried && /csrf/i.test(text)) {
      await fetchCsrfToken(ctx);
      return erpPost(pathname, body, { ctx, retry, csrfTried: true, method });
    }
    const err = new Error(`ERP API lỗi HTTP ${res.status} (người tạo: ${ctx.label}): ${extractFrappeError(text)}`);
    err.code = 'ERP_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Frappe trả lỗi trong _server_messages (chuỗi JSON lồng nhau) hoặc exception.
function extractFrappeError(text) {
  try {
    const j = JSON.parse(text);
    if (j._server_messages) {
      const msgs = JSON.parse(j._server_messages).map((m) => {
        try { return JSON.parse(m).message; } catch (_) { return m; }
      });
      return msgs.join(' | ').replace(/<[^>]+>/g, '').slice(0, 400);
    }
    if (j.exception) return String(j.exception).slice(0, 400);
  } catch (_) { /* không phải JSON */ }
  return String(text).slice(0, 300);
}

const LAYOUT_TYPES = new Set(['Section Break', 'Column Break', 'Tab Break', 'HTML', 'Button', 'Heading', 'Fold']);
let metaCache = { at: 0, data: null };

/** Lấy cấu trúc DocType Ticket (tên trường thật, kiểu, bắt buộc, options) — cache 10 phút. */
async function getTicketMeta() {
  if (metaCache.data && Date.now() - metaCache.at < 10 * 60 * 1000) return metaCache.data;
  const raw = await erpFetch('/api/method/frappe.desk.form.load.getdoctype?doctype=Ticket&with_parent=1');
  const docs = raw.docs || [];
  const simplify = (d) => (d.fields || [])
    .filter((f) => !LAYOUT_TYPES.has(f.fieldtype))
    .map((f) => ({
      fieldname: f.fieldname, label: f.label || '', fieldtype: f.fieldtype, options: f.options || '',
      reqd: f.reqd ? 1 : 0, read_only: f.read_only ? 1 : 0, hidden: f.hidden ? 1 : 0, default: f.default || '', fetch_from: f.fetch_from || '',
    }));
  const main = docs.find((d) => d.name === 'Ticket');
  if (!main) throw new Error('Không đọc được cấu trúc DocType Ticket từ ERP (kiểm tra quyền của ERP_USER).');
  const children = {};
  docs.filter((d) => d.name !== 'Ticket').forEach((d) => { children[d.name] = simplify(d); });
  // Một số bản ERP không trả kèm DocType con -> tự lấy riêng (cần cho Products: Table MultiSelect).
  const mainFields = simplify(main);
  for (const f of mainFields) {
    if ((f.fieldtype === 'Table MultiSelect' || f.fieldtype === 'Table') && f.options && !children[f.options]) {
      try {
        const sub = await erpFetch(`/api/method/frappe.desk.form.load.getdoctype?doctype=${encodeURIComponent(f.options)}`);
        const d = (sub.docs || []).find((x) => x.name === f.options);
        if (d) children[f.options] = simplify(d);
      } catch (e) {
        console.error(`[erp/meta] không lấy được DocType con ${f.options}:`, e.message);
      }
    }
  }
  metaCache = { at: Date.now(), data: { fields: mainFields, children } };
  return metaCache.data;
}

const linkedCache = new Map(); // "DocType|name|field" -> {at, v}
/** Đọc 1 trường của bản ghi liên kết (vd Project.customer). Cache 5 phút. */
async function getLinkedValue(doctype, name, field) {
  const key = `${doctype}|${name}|${field}`;
  const hit = linkedCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.v;
  const r = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  const v = (r.data || r)[field] || '';
  linkedCache.set(key, { at: Date.now(), v });
  return v;
}

/** Gợi ý người liên hệ (Contact): khớp chính xác theo email, hoặc tìm theo tên. Trả [{value, description, match}]. */
async function suggestContacts({ doctype = 'Contact', email = '', name = '' } = {}) {
  const out = new Map();
  if (email) {
    try {
      const qs = new URLSearchParams({
        fields: JSON.stringify(['name', 'email_id', 'mobile_no']),
        filters: JSON.stringify([['email_id', '=', email]]),
        limit_page_length: '5',
      });
      const r = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}?${qs.toString()}`);
      (r.data || []).forEach((c) => out.set(c.name, { value: c.name, description: [c.email_id, c.mobile_no].filter(Boolean).join(' · '), match: 'email' }));
    } catch (e) { console.error('[erp/contact] tìm theo email lỗi:', e.message); }
  }
  if (name) {
    try {
      (await searchLink(doctype, name, 5)).forEach((x) => { if (!out.has(x.value)) out.set(x.value, { ...x, match: 'tên' }); });
    } catch (e) { console.error('[erp/contact] tìm theo tên lỗi:', e.message); }
  }
  return [...out.values()];
}

/** Gợi ý giá trị cho trường Link (cùng cơ chế ô tìm kiếm trên form ERP). */
async function searchLink(doctype, txt = '', pageLength = 20) {
  const qs = new URLSearchParams({ doctype, txt, page_length: String(pageLength) });
  const r = await erpFetch(`/api/method/frappe.desk.search.search_link?${qs.toString()}`);
  const list = r.message || r.results || [];
  return list.map((x) => ({ value: x.value, description: x.description || '' }));
}

/** Tạo 1 Ticket mới. fields: object {fieldname: value}. Trả về document vừa tạo. */
async function createTicket(fields, creatorKey = '', ctxOverride = null) {
  const r = await erpPost('/api/resource/Ticket', fields, { ctx: ctxOverride || getCtx(creatorKey) });
  return r.data || r;
}

/* ===================== GHI NHẬN THAY NGƯỜI KHÁC (không cần mật khẩu) =====================
   Tài khoản ERP_USER (Render) là "người thực hiện". Người dùng chỉ chọn email trên giao diện; ticket được gắn
   người tạo (owner) là email đó. Hai cách, thử theo thứ tự (ERP_ONBEHALF_MODE = auto | impersonate | set-owner):
   1) impersonate : dùng chức năng "Impersonate" của Frappe để tạo ticket trong phiên của người đó (cần ERP bản hỗ trợ
                    và ERP_USER là System Manager). ERP tự ghi owner = người đó và lưu vết "impersonated by".
   2) set-owner   : tạo bằng ERP_USER rồi cập nhật trường owner của ticket sang email đó (PUT), đọc lại để xác nhận. */
const ONBEHALF_MODE = String(process.env.ERP_ONBEHALF_MODE || 'auto').trim().toLowerCase();

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Kiểm tra email có là user đang hoạt động trên ERP không (chống gõ sai / gửi giá trị bậy). */
async function userExists(email) {
  try {
    const r = await erpFetch(`/api/resource/User/${encodeURIComponent(email)}`);
    const d = r.data || r;
    return Boolean(d && d.name && Number(d.enabled) !== 0);
  } catch (_) {
    return false;
  }
}

/** Mở phiên ERP của `email` bằng impersonate (qua phiên ERP_USER). Trả về cookie phiên mới. */
async function impersonateCookie(email) {
  const ctx = defaultCtx;
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Cookie: await ctx.cookie(), Accept: 'application/json', 'Content-Type': 'application/json' };
    if (ctx.csrf) headers['X-Frappe-CSRF-Token'] = ctx.csrf;
    const res = await fetch(`${ERP_BASE_URL}/api/method/frappe.core.doctype.user.user.impersonate`, {
      method: 'POST', headers,
      body: JSON.stringify({ user: email, reason: 'Ops Console: tạo ticket thay người dùng' }),
    });
    if (res.ok) {
      const cookies = getSetCookies(res).map((c) => c.split(';')[0]);
      if (!cookies.length) throw codedError('IMPERSONATE_NO_COOKIE', 'Impersonate không trả về phiên đăng nhập mới.');
      const cookie = cookies.join('; ');
      const who = await fetch(`${ERP_BASE_URL}/api/method/frappe.auth.get_logged_user`, { headers: { Cookie: cookie, Accept: 'application/json' } })
        .then((r) => r.json()).then((j) => j.message).catch(() => null);
      if (who !== email) throw codedError('IMPERSONATE_MISMATCH', `Impersonate không chuyển được sang "${email}" (đang là "${who}").`);
      return cookie;
    }
    const text = await res.text().catch(() => '');
    if (attempt === 0 && /csrf/i.test(text)) { await fetchCsrfToken(ctx); continue; }
    if (attempt === 0 && res.status === 401) { ctx.reset(); continue; }
    throw codedError('IMPERSONATE_FAILED', `Impersonate bị ERP từ chối (HTTP ${res.status}): ${extractFrappeError(text)}`);
  }
  throw codedError('IMPERSONATE_FAILED', 'Impersonate thất bại.');
}

async function logoutCookie(cookie) {
  try { await fetch(`${ERP_BASE_URL}/api/method/logout`, { method: 'POST', headers: { Cookie: cookie } }); } catch (_) { /* bỏ qua */ }
}

/** Tạo ticket rồi đổi owner sang email (cách 2). Trả {doc, applied}. */
async function createThenSetOwner(fields, email) {
  const doc = await createTicket(fields);
  let applied = false;
  try {
    await erpPost(`/api/resource/Ticket/${encodeURIComponent(doc.name)}`, { owner: email }, { method: 'PUT' });
    const back = await erpFetch(`/api/resource/Ticket/${encodeURIComponent(doc.name)}`);
    applied = ((back.data || back).owner || '') === email;
    if (applied) doc.owner = email; // phản ánh đúng owner sau khi đổi
  } catch (e) {
    console.error('[erp/set-owner] không đổi được owner:', e.message);
  }
  return { doc, applied };
}

/** Tạo ticket với người tạo = email. Trả {doc, method, warning}. */
async function createTicketOnBehalf(fields, email) {
  if (ONBEHALF_MODE === 'auto' || ONBEHALF_MODE === 'impersonate') {
    let cookie = null;
    try {
      cookie = await impersonateCookie(email);
    } catch (e) {
      if (ONBEHALF_MODE === 'impersonate') throw e;
      console.warn('[erp/on-behalf] impersonate không dùng được, chuyển sang đổi owner:', e.message);
    }
    if (cookie) {
      try {
        const doc = await createTicket(fields, '', makeCookieCtx(email, cookie));
        return { doc, method: 'impersonate', warning: null };
      } catch (e) {
        // Lỗi ở bước tạo (thiếu quyền Create của người đó, dữ liệu sai...) -> báo thẳng, KHÔNG tạo lại bằng tài khoản khác.
        e.message = `Tạo ticket thay "${email}" thất bại: ${e.message}`;
        throw e;
      } finally {
        logoutCookie(cookie);
      }
    }
  }
  const { doc, applied } = await createThenSetOwner(fields, email);
  return {
    doc, method: 'set-owner',
    warning: applied ? null : `Ticket đã tạo bằng tài khoản chung (${ERP_USER}); ERP không cho đổi người tạo sang "${email}". Hãy ghi người báo ở trường Raised By (Email).`,
  };
}

module.exports = {
  fetchTickets,
  fetchProjects,
  fetchTimesheetReport,
  getTicketMeta,
  searchLink,
  createTicket,
  listCreators,
  loginRequest,
  getLinkedValue,
  suggestContacts,
  userExists,
  createTicketOnBehalf,
  isCustomLoginAllowed: () => ALLOW_CUSTOM_LOGIN,
  makeCookieCtx,
  getBaseUrl: () => ERP_BASE_URL,
  isConfigured: () => Boolean(ERP_BASE_URL && ERP_USER && ERP_PASS),
};
