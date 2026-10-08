const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const erp = require('./erpClient');
const jira = require('./jiraClient');
const supportCases = require('./supportCasesStore');
const { hqEncrypt, hqDecrypt } = require('./hqPasswordCrypto');

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
    rolling: true, // mỗi request hợp lệ sẽ gia hạn lại phiên, đỡ bị hết hạn khi đang dùng dở
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1', // bật khi đã chạy sau HTTPS
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 ngày — giảm số lần phải đăng nhập lại
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
   vụ tĩnh không cần qua kiểm tra.
   Nếu phiên đã hết (ví dụ server Render "ngủ" rồi khởi động lại mất phiên),
   chuyển về trang đăng nhập KÈM đường dẫn đang xem (?next=...), để đăng
   nhập xong tự quay lại đúng chỗ thay vì phải bấm menu lại từ đầu. */
function requirePageAuth(req, res, next) {
  if (!req.session.username) {
    return res.redirect('/?next=' + encodeURIComponent(req.originalUrl));
  }
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

app.get('/anvy/uat-runbook', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'anvy-uat-runbook.html'));
});

app.get('/merap/uat-runbook', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'merap-uat-runbook.html'));
});

app.get('/tickets/tao-moi', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'tickets-tao-moi.html'));
});
app.get('/tickets/tra-cuu-erp', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'tickets-tra-cuu-erp.html'));
});

app.get('/tickets/sla-first-response', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'tickets-sla-first-response.html'));
});

app.get('/tickets/sla-resolution', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'tickets-sla-resolution.html'));
});

app.get('/tickets/sla-jira-abi', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'tickets-sla-jira-abi.html'));
});

app.get('/tickets/support-cases', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'support-cases.html'));
});

app.get('/hotfix/gop-sql', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'hotfix-gop-sql.html'));
});

app.get('/hotfix/gom-build', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'hotfix-gom-build.html'));
});

app.get('/hotfix/backup-build', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'hotfix-backup-build.html'));
});

app.get('/khac/ma-hoa-password-window', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'khac-ma-hoa-password.html'));
});

app.get('/khac/ma-hoa-password-macos', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'khac-ma-hoa-password-macos.html'));
});

app.get('/kpiteam/loi-nhuan-thang', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-loi-nhuan-thang.html'));
});

app.get('/kpiteam/bao-cao-tuan', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-bao-cao-tuan.html'));
});

/* ---------- API: mã hóa/giải mã password Windows (key hệ thống giữ ở server) ---------- */
app.post('/api/khac/mahoa-password', requireAuth, (req, res) => {
  try {
    const { mode, text } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Thiếu nội dung cần xử lý.' });
    }
    let result;
    if (mode === 'decrypt') {
      result = hqDecrypt(text);
    } else {
      result = hqEncrypt(text);
    }
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[khac/mahoa-password] lỗi:', e.message);
    res.status(400).json({ error: 'Không xử lý được — kiểm tra lại nội dung (đúng chuỗi Base64 nếu đang Giải mã).' });
  }
});

app.get('/crs/loi-nhuan-du-an', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'crs-loi-nhuan-du-an.html'));
});

app.get('/crs/pakd-bao-gia', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'crs-pakd-bao-gia.html'));
});

/* ---------- API: lấy ticket từ ERPNext (đăng nhập bằng email/mật khẩu) ----------
   projects / statuses: gửi dạng JSON array trong query string, ví dụ
   ?projects=["ABI_eSales_Support","Sabeco_PG"]&statuses=["Open","Working"] */
app.get('/api/erp/tickets', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) {
    return res.status(501).json({
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL / ERP_USER / ERP_PASS).',
    });
  }
  try {
    const projects = parseJsonArrayParam(req.query.projects);
    const statuses = parseJsonArrayParam(req.query.statuses);
    const openingFrom = req.query.opening_from || undefined;
    const openingTo = req.query.opening_to || undefined;
    const modifiedFrom = req.query.modified_from || undefined;
    const modifiedTo = req.query.modified_to || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const data = await erp.fetchTickets({ projects, statuses, openingFrom, openingTo, modifiedFrom, modifiedTo, limit });
    res.json(data);
  } catch (e) {
    console.error('[erp/tickets] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- API: TẠO TICKET trên ERP (ghi dữ liệu thật) ----------
   - GET  /api/erp/ticket-meta              : cấu trúc trường của DocType Ticket (để dựng form đúng tên trường)
   - GET  /api/erp/link-search?doctype=&txt= : gợi ý giá trị cho trường Link (chỉ cho các DocType có trong form Ticket)
   - POST /api/erp/tickets {fields, dry_run} : dry_run=true chỉ kiểm tra, không gửi sang ERP */
const BLOCKED_WRITE_FIELDS = new Set(['name', 'owner', 'creation', 'modified', 'modified_by', 'docstatus', 'idx', 'doctype']);
const recentCreates = new Map(); // chống bấm tạo trùng: project|subject -> thời điểm

app.get('/api/erp/ticket-meta', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    res.json(await erp.getTicketMeta());
  } catch (e) {
    console.error('[erp/ticket-meta] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/erp/creators', requireAuth, (req, res) => {
  res.json(erp.listCreators()); // chỉ trả key + nhãn, không có mật khẩu
});

app.get('/api/erp/link-search', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const doctype = String(req.query.doctype || '');
    const meta = await erp.getTicketMeta();
    const allowed = new Set();
    meta.fields.forEach((f) => { if (f.fieldtype === 'Link' && f.options) allowed.add(f.options); });
    Object.values(meta.children).forEach((fs) => fs.forEach((f) => { if (f.fieldtype === 'Link' && f.options) allowed.add(f.options); }));
    if (!allowed.has(doctype)) return res.status(400).json({ error: 'DocType không nằm trong form Ticket.' });
    res.json(await erp.searchLink(doctype, String(req.query.txt || '')));
  } catch (e) {
    console.error('[erp/link-search] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/erp/tickets', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const input = req.body && req.body.fields;
    const dryRun = Boolean(req.body && req.body.dry_run);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'Thiếu dữ liệu fields.' });
    }
    const meta = await erp.getTicketMeta();
    const byName = new Map(meta.fields.map((f) => [f.fieldname, f]));

    // Chỉ nhận trường có trong DocType Ticket, không phải trường hệ thống / chỉ-đọc.
    const payload = {};
    const rejected = [];
    for (const [k, v] of Object.entries(input)) {
      const f = byName.get(k);
      if (!f || BLOCKED_WRITE_FIELDS.has(k) || f.read_only) { rejected.push(k); continue; }
      if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
      payload[k] = v;
    }

    const missing = meta.fields
      .filter((f) => f.reqd && !f.read_only && !f.hidden && payload[f.fieldname] === undefined && !f.default)
      .map((f) => f.label || f.fieldname);
    if (missing.length) {
      return res.status(400).json({ error: 'Thiếu trường bắt buộc: ' + missing.join(', '), missing });
    }

    if (dryRun) return res.json({ dry_run: true, payload, rejected });

    const key = `${String((req.body && req.body.creator) || '')}|${payload.project || ''}|${String(payload.subject || '').trim().toLowerCase()}`;
    const last = recentCreates.get(key);
    if (last && Date.now() - last < 2 * 60 * 1000 && !(req.body && req.body.force)) {
      return res.status(409).json({ error: 'Ticket cùng Project + Subject vừa được tạo cách đây dưới 2 phút (nghi tạo trùng).', duplicate: true });
    }

    const creator = String((req.body && req.body.creator) || '');
    if (creator && !erp.listCreators().some((c) => c.key === creator)) {
      return res.status(400).json({ error: 'Người tạo không hợp lệ.' });
    }
    const doc = await erp.createTicket(payload, creator);
    recentCreates.set(key, Date.now());
    console.log(`[erp/tickets] ${req.session && req.session.username ? req.session.username : 'user'} đã tạo ${doc.name} (${payload.project}) bằng tài khoản ERP '${creator || 'chung'}'`);
    res.json({ ok: true, name: doc.name, url: `${erp.getBaseUrl()}/app/ticket/${encodeURIComponent(doc.name)}`, doc });
  } catch (e) {
    console.error('[erp/tickets POST] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- API: lấy danh sách dự án từ ERPNext (dùng cho combobox lọc) ----------
   ?project_type=Change Request  -> lọc theo loại dự án (vd dùng cho màn Crs) */
app.get('/api/erp/projects', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) {
    return res.status(501).json({
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL / ERP_USER / ERP_PASS).',
    });
  }
  try {
    const project_type = req.query.project_type || undefined;
    const project_owner = parseJsonArrayParam(req.query.project_owner);
    const data = await erp.fetchProjects({ project_type, project_owner });
    res.json(data);
  } catch (e) {
    console.error('[erp/projects] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- API: lấy Detail Timesheet Report trực tiếp từ ERPNext ----------
   ?project=...&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD (cả 3 đều bắt buộc) */
app.get('/api/erp/timesheet', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) {
    return res.status(501).json({
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL / ERP_USER / ERP_PASS).',
    });
  }
  const { from_date, to_date, project } = req.query;
  if (!from_date || !to_date || !project) {
    return res.status(400).json({ error: 'Thiếu tham số from_date / to_date / project.' });
  }
  try {
    const data = await erp.fetchTimesheetReport({ from_date, to_date, project });
    res.json(data);
  } catch (e) {
    console.error('[erp/timesheet] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- API: lấy issue từ Jira (Jira Cloud / Jira Service Management) ----------
   ?project=HQ&created_from=YYYY-MM-DD&created_to=YYYY-MM-DD (project mặc định "HQ") */
app.get('/api/jira/issues', requireAuth, async (req, res) => {
  if (!jira.isConfigured()) {
    return res.status(501).json({
      error: 'Server chưa cấu hình kết nối Jira (thiếu JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN).',
    });
  }
  try {
    const project = req.query.project || 'HQ';
    const createdFrom = req.query.created_from;
    const createdTo = req.query.created_to;
    const jqlParts = [`project = "${project}"`];
    if (createdFrom) jqlParts.push(`created >= "${createdFrom} 00:00"`);
    if (createdTo) jqlParts.push(`created <= "${createdTo} 23:59"`);
    const jql = jqlParts.join(' AND ') + ' ORDER BY created DESC';
    const { issues, ticketPriorityFieldId, hqTicketIdFieldId } = await jira.searchIssuesWithTicketPriority({ jql });
    res.json({ issues, jql, baseUrl: process.env.JIRA_BASE_URL || '', ticketPriorityFieldId, hqTicketIdFieldId });
  } catch (e) {
    console.error('[jira/issues] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- API: lấy dữ liệu SLA (Time to first response / Time to resolution...) cho
   nhiều issue Jira cùng lúc — body: { issueKeys: ["HQ-1","HQ-2",...] } ---------- */
app.post('/api/jira/sla-bulk', requireAuth, async (req, res) => {
  if (!jira.isConfigured()) {
    return res.status(501).json({
      error: 'Server chưa cấu hình kết nối Jira (thiếu JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN).',
    });
  }
  try {
    const issueKeys = Array.isArray(req.body && req.body.issueKeys) ? req.body.issueKeys : [];
    if (!issueKeys.length) return res.json({ results: {}, errors: {} });
    const { results, errors } = await jira.getIssuesSlaBulk(issueKeys);
    res.json({ results, errors });
  } catch (e) {
    console.error('[jira/sla-bulk] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- API: Case Hỗ Trợ (thư viện case thường gặp + cách xử lý) ----------
   Ghi qua GitHub Contents API nếu đã cấu hình GITHUB_TOKEN/GITHUB_REPO (tạo commit thật,
   Render auto-deploy sẽ tự nhận và deploy lại) — fallback lưu file local nếu chưa cấu hình. */
app.get('/api/support-cases', requireAuth, async (req, res) => {
  try {
    const cases = await supportCases.readAll();
    res.json({ cases, githubBacked: supportCases.isGithubBacked() });
  } catch (e) {
    console.error('[support-cases:get] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/support-cases', requireAuth, async (req, res) => {
  try {
    const result = await supportCases.upsert(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[support-cases:post] lỗi:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/support-cases/:id', requireAuth, async (req, res) => {
  try {
    const result = await supportCases.remove(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[support-cases:delete] lỗi:', e.message);
    res.status(400).json({ error: e.message });
  }
});

function parseJsonArrayParam(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/* ---------- API: build file "Lợi nhuận Crs" (2 sheet: PAKD + Chi tiết theo tháng) ----------
   Nhận file PAKD gốc (multipart) + payload JSON (tiersUsed/rateTable/monthRows đã tính ở
   trình duyệt từ Timesheet). Việc "ghi" file thật sự giao cho script Python (openpyxl) vì
   SheetJS ở trình duyệt không ghi lại được màu sắc/định dạng khi xuất file mới — chỉ
   openpyxl mới giữ nguyên style gốc của sheet PAKD. */
const exportUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.xlsx';
      cb(null, `crs-export-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post('/api/crs/loi-nhuan/export', requireAuth, exportUpload.single('pakdFile'), async (req, res) => {
  const uploadedPath = req.file && req.file.path;
  const cleanup = (...paths) => paths.forEach((p) => { if (p) fs.unlink(p, () => {}); });

  if (!uploadedPath) {
    return res.status(400).json({ error: 'Thiếu file PAKD (pakdFile).' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.payload || '{}');
  } catch (e) {
    cleanup(uploadedPath);
    return res.status(400).json({ error: 'payload không phải JSON hợp lệ: ' + e.message });
  }
  if (!Array.isArray(payload.tiersUsed) || !payload.rateTable || !Array.isArray(payload.monthRows)) {
    cleanup(uploadedPath);
    return res.status(400).json({ error: 'Thiếu tiersUsed / rateTable / monthRows trong payload.' });
  }

  const payloadPath = `${uploadedPath}.payload.json`;
  const outputPath = `${uploadedPath}.output.xlsx`;

  try {
    fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
  } catch (e) {
    cleanup(uploadedPath, payloadPath);
    return res.status(500).json({ error: 'Không ghi được payload tạm: ' + e.message });
  }

  const scriptPath = path.join(__dirname, 'scripts', 'build_loi_nhuan_report.py');
  const py = spawn('python3', [scriptPath, uploadedPath, payloadPath, outputPath]);

  let stdout = '';
  let stderr = '';
  py.stdout.on('data', (d) => { stdout += d.toString(); });
  py.stderr.on('data', (d) => { stderr += d.toString(); });

  py.on('error', (err) => {
    console.error('[export loi-nhuan] không chạy được python3:', err.message);
    cleanup(uploadedPath, payloadPath, outputPath);
    if (!res.headersSent) res.status(500).json({ error: 'Không chạy được python3 trên server: ' + err.message });
  });

  py.on('close', (code) => {
    if (res.headersSent) return;
    let result = null;
    try {
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      result = lastLine ? JSON.parse(lastLine) : null;
    } catch (e) {
      // giữ result = null, dùng thông báo lỗi mặc định bên dưới
    }

    if (code !== 0 || !result || result.ok !== true) {
      console.error('[export loi-nhuan] lỗi python:', stderr || stdout);
      cleanup(uploadedPath, payloadPath, outputPath);
      return res.status(500).json({ error: (result && result.error) || 'Lỗi khi build file (xem log server để biết chi tiết).' });
    }

    const rawName = (req.body.outName || 'LoiNhuan_Crs.xlsx').toString();
    const downloadName = rawName.replace(/[\\/:*?"<>|]+/g, '_');
    res.download(outputPath, downloadName, (err) => {
      if (err) console.error('[export loi-nhuan] lỗi gửi file:', err.message);
      cleanup(uploadedPath, payloadPath, outputPath);
    });
  });
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
