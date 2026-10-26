const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const erp = require('./erpClient');
const BUILD = '2026-10-11.10'; // đối chiếu với trang Tạo Ticket để phát hiện deploy thiếu file
console.log(`[build] Ops Console ${BUILD}`);
const { applyTicketDefaults } = require('./ticketDefaults');
const weekly = require('./weeklyReport');
const { buildCustomerReport, slaDueAt, parseNaive, fmtNaive } = require('./customerReport');
const kpiSla = require('./kpiSla');
const kpiComplaint = require('./kpiComplaint');
const sqlEnv = require('./sqlEnv');
const screenTables = require('./screenTablesStore');
const kpiDefect = require('./kpiDefect');
const kpiCr = require('./kpiCr');
const kpiAi = require('./kpiAi');
const kpiCert = require('./kpiCert');
const kpiCrPlan = require('./kpiCrPlan');
const synergyhub = require('./synergyhub');
const { buildMonthlyCustomerReport, monthStartOf, monthEndOf, addMonths, isMonthKey } = require('./customerReportMonthly');
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

app.get('/api/build', requireAuth, (req, res) => res.json({ build: BUILD }));

app.get('/duan/support-tuan', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'duan-support-tuan.html'));
});

app.get('/duan/bao-cao-khach-hang', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'duan-bao-cao-khach-hang.html'));
});

app.get('/duan/bao-cao-thang-khach-hang', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'duan-bao-cao-thang-khach-hang.html'));
});

app.get('/tickets/tao-moi', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store'); // luôn lấy bản trang mới nhất, không để trình duyệt giữ bản cũ
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

app.get('/duan/table-man-hinh', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'duan-table-man-hinh.html'));
});

/* ---------- Dự án: Table màn hình (danh sách table của từng màn hình theo dự án — để nhân viên SELECT đúng table khi kiểm tra) ----------
   GET    /api/screen-tables                  → { items:[{id, project, code, name, module, note, tables:[{name, role, desc, where}], updatedAt, updatedBy}], modules, roles, githubBacked }
   POST   /api/screen-tables                  (có id = sửa, không id = thêm; (project, code) là duy nhất) → { screen, commitUrl }
   POST   /api/screen-tables/import           { project, rows:[{code,name,module,table,role,desc,where}] } → { added, updated, tables, commitUrl } (1 commit)
   DELETE /api/screen-tables/:id
   Lưu qua listStore (GitHub nếu đã cấu hình GITHUB_TOKEN/GITHUB_REPO — mỗi lần lưu là 1 commit — ngược lại ./data/screen-tables.json). */
app.get('/api/screen-tables', requireAuth, async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ items: await screenTables.list(), modules: screenTables.MODULES, roles: screenTables.ROLES, githubBacked: screenTables.store.isGithubBacked() }); }
  catch (e) { console.error('[screen-tables:get] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.post('/api/screen-tables/import', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await screenTables.importRows(b.project, b.rows, req.session.username)) }); }
  catch (e) { console.error('[screen-tables:import] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.post('/api/screen-tables', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await screenTables.upsert(req.body || {}, req.session.username)) }); }
  catch (e) { console.error('[screen-tables:post] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.delete('/api/screen-tables/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await screenTables.remove(req.params.id)) }); }
  catch (e) { console.error('[screen-tables:delete] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});

app.get('/hotfix/moi-truong', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'hotfix-moi-truong.html'));
});

/* ---------- Hotfix: Môi trường SQL Build (thông tin DB / BackOffice / SFA / API / Hangfire của từng server dự án) ----------
   GET    /api/sql-env        → { items:[{id, project, name, kind, note, rows:[{type,key,value,link}], updatedAt, updatedBy}], kinds, githubBacked }
   POST   /api/sql-env        (cùng dữ liệu, không có id)  → thêm
   PUT    /api/sql-env/:id    (cùng dữ liệu)               → sửa
   DELETE /api/sql-env/:id                                 → xoá
   Mỗi dòng: {type:'group'|'item', key (tiêu đề), value (nội dung), link (link/đính kèm)}; mật khẩu do từng thành viên tự quản lý nên không che/mã hoá (dữ liệu cũ dạng enc: vẫn đọc được — xem sqlEnv.js).
   Lưu qua listStore: có GITHUB_TOKEN/GITHUB_REPO thì mỗi lần thêm/sửa/xoá là 1 commit (trả về commitUrl), ngược lại ghi ./data/sql-environments.json. */
app.get('/api/sql-env', requireAuth, async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ items: await sqlEnv.list(), kinds: sqlEnv.KINDS, githubBacked: sqlEnv.store.isGithubBacked() }); }
  catch (e) { console.error('[sql-env:get] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
/* File đính kèm của dòng (APK, zip…): POST /api/sql-env/upload (multipart, field "file") → meta để gắn vào dòng rồi Lưu;
   GET /api/sql-env/:id/file/:fileId → tải về; DELETE /api/sql-env/upload/:assetId → bỏ file vừa tải lên nhưng chưa lưu. Lưu ở GitHub Releases (xem envFiles.js). */
const envFiles = require('./envFiles');
const envUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: envFiles.MAX_BYTES, files: 1 } }).single('file');
app.post('/api/sql-env/upload', requireAuth, (req, res) => {
  envUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File lớn hơn 100MB — hãy dán link (Drive/SharePoint…) vào cột Link / Đính kèm.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file.' });
    try {
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); // multer đọc tên theo latin1 → đổi lại UTF-8 để giữ tiếng Việt
      res.json({ ok: true, file: await envFiles.save(req.file.buffer, name, req.session.username) });
    } catch (e) { console.error('[sql-env:upload] lỗi:', e.message); res.status(400).json({ error: e.message }); }
  });
});
app.delete('/api/sql-env/upload/:assetId', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await sqlEnv.discardUpload(req.params.assetId)) }); }
  catch (e) { console.error('[sql-env:discard] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.get('/api/sql-env/:id/file/:fileId', requireAuth, async (req, res) => {
  try {
    const f = await sqlEnv.findFile(req.params.id, req.params.fileId);
    if (!f) return res.status(404).json({ error: 'Không tìm thấy file (có thể đã bị xoá).' });
    const { stream, size } = await envFiles.open(f.assetId);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(f.name));
    if (size) res.set('Content-Length', String(size));
    stream.on('error', (e) => { console.error('[sql-env:file] lỗi stream:', e.message); res.destroy(e); });
    stream.pipe(res);
  } catch (e) { console.error('[sql-env:file] lỗi:', e.message); if (!res.headersSent) res.status(502).json({ error: e.message }); }
});
app.post('/api/sql-env', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await sqlEnv.add(req.body || {}, req.session.username)) }); }
  catch (e) { console.error('[sql-env:post] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.put('/api/sql-env/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await sqlEnv.update(req.params.id, req.body || {}, req.session.username)) }); }
  catch (e) { console.error('[sql-env:put] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.delete('/api/sql-env/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await sqlEnv.remove(req.params.id)) }); }
  catch (e) { console.error('[sql-env:delete] lỗi:', e.message); res.status(400).json({ error: e.message }); }
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

app.get(['/kpiteam/sla-phan-hoi', '/kpiteam/sla-hoan-tat'], requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-sla-danh-gia.html')); // 1 trang dùng chung, tự nhận CS01/CS02 theo đường dẫn
});

app.get('/kpiteam/loi-lot-review', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-defect.html'));
});

app.get('/kpiteam/cr-phan-tich', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-cr.html'));
});

app.get('/kpiteam/ai-workflow', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-ai.html'));
});

app.get('/kpiteam/chung-nhan-san-pham', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-cert.html'));
});

app.get('/kpiteam/quan-ly-cr', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-crplan.html'));
});

app.get('/kpiteam/complaint', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-complaint.html'));
});

app.get('/bao-cao/tuan-erp', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'protected', 'kpiteam-bao-cao-tuan.html'));
});
app.get('/bao-cao/cs-am', requirePageAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'protected', 'baocao-cs-am.html'));
});
// URL cũ (trước khi chuyển sang chức năng "Báo Cáo") — giữ để các đường dẫn đã lưu vẫn dùng được
app.get('/kpiteam/bao-cao-tuan', requirePageAuth, (req, res) => res.redirect(301, '/bao-cao/tuan-erp'));

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
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL và ERP_API_KEY/ERP_API_SECRET hoặc ERP_USER/ERP_PASS).',
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

/* ---------- Bảng đơn giá nhân công master (rate-master.json) cho trang Lợi Nhuận Crs — dùng chung cho nguồn ERP, SynergyHub và upload file ---------- */
app.get('/api/crs/rate-master', requireAuth, (req, res) => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'rate-master.json'), 'utf8'));
    const rates = (Array.isArray(j.rates) ? j.rates : [])
      .map((r) => ({ designation: String(r.designation || '').trim(), perHour: Number(r.perHour), perDay: Number(r.perDay) || null, perMonth: Number(r.perMonth) || null }))
      .filter((r) => r.designation && Number.isFinite(r.perHour) && r.perHour > 0);
    if (!rates.length) return res.status(500).json({ error: 'rate-master.json không có dòng đơn giá hợp lệ (cần designation và perHour > 0).' });
    res.json({ rates });
  } catch (e) {
    console.error('[crs/rate-master] lỗi:', e.message);
    res.status(500).json({ error: 'Không đọc được rate-master.json: ' + e.message });
  }
});

/* ---------- SynergyHub: danh sách dự án + giờ công (cho trang Lợi nhuận Crs) ----------
   Cùng máy chủ ERP nên dùng tài khoản ERP đã cấu hình. Cấu trúc phản hồi được tự dò (synergyhub.js) và trả kèm `diagnostics`.
   GET /api/synergyhub/projects[?raw=1]
   GET /api/synergyhub/time-logs?project=<tên dự án>&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD[&approval_status=][&raw=1] */
function shError(res, what, e) {
  console.error(`[synergyhub/${what}] lỗi:`, e.message);
  res.status(502).json({ error: `SynergyHub (${what}): ${e.message}` });
}
app.get('/api/synergyhub/projects', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    // không gửi bộ lọc rỗng (có thể bị hiểu là "lọc theo chuỗi rỗng"); chỉ gửi tham số phân trang
    const call = async (params) => { const b = await erp.callMethod(synergyhub.METHODS.projects, params); return b.message !== undefined ? b.message : b; };
    const { message, info } = await synergyhub.fetchAllPages(call, {}, { pageSize: 1000 });
    const out = synergyhub.normalizeProjects(message);
    out.diagnostics.paging = info;
    const body = message;
    if (req.query.raw) out.raw = body;
    res.json(out);
  } catch (e) { shError(res, 'projects', e); }
});
app.get('/api/synergyhub/time-logs', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  const project = String(req.query.project || '').trim();
  const from_date = String(req.query.from_date || ''); const to_date = String(req.query.to_date || '');
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!project || project.length > 300 || !DATE_RE.test(from_date) || !DATE_RE.test(to_date)) {
    return res.status(400).json({ error: 'Thiếu hoặc sai tham số project / from_date / to_date (YYYY-MM-DD).' });
  }
  try {
    // đúng bộ tham số mà giao diện SynergyHub gửi (các ô để trống thì gửi chuỗi rỗng) + tham số phân trang; lấy HẾT các trang
    const base = { from_date, to_date, employee: '', department: '', project, activity_type: '', approval_status: String(req.query.approval_status || '') };
    const call = async (params) => { const b = await erp.callMethod(synergyhub.METHODS.timeLogs, params); return b.message !== undefined ? b.message : b; };
    const { message, info } = await synergyhub.fetchAllPages(call, base, { pageSize: 500 });
    const out = synergyhub.normalizeTimeLogs(message, { from_date, to_date });
    out.diagnostics.paging = info;
    const body = message;
    if (req.query.raw) out.raw = body;
    res.json(out);
  } catch (e) { shError(res, 'time-logs', e); }
});

/* ---------- SynergyHub Tasks (CS25 cách 2): task được giao cho thành viên, hạn dự kiến vs ngày hoàn thành ----------
   Hàm API Tasks: synergyhub.api.dynamic_permissions.get_filtered_tasks_with_context (ghi đè bằng biến SYNERGYHUB_TASKS_METHOD hoặc ?method=).
   GET /api/synergyhub/tasks[?method=&refresh=1]  → số task, cột nhận được, mẫu (chẩn đoán)
   GET /api/kpi/crplan-auto?member=<email>&level=&month=<YYYY-MM>[&projects=[tên dự án SynergyHub đã chọn]]  → Actual = task đúng hạn ÷ task được giao (hạn trong tháng) */
let synergyTasksCache = null;
/** Lấy HẾT task: gọi đúng bộ tham số mà trang Tasks gửi (filters rỗng, không lọc dự án, báo cáo toàn bộ), phân trang bằng limit_start / limit_page_length. */
async function loadSynergyTasks({ method, refresh } = {}) {
  const m = method && /^synergyhub\.api\.[a-z0-9_.]+$/i.test(method) ? method : (process.env.SYNERGYHUB_TASKS_METHOD || synergyhub.METHODS.tasks);
  if (!refresh && synergyTasksCache && synergyTasksCache.method === m && Date.now() - synergyTasksCache.at < 3 * 60 * 1000) return synergyTasksCache.data;
  const PAGE = 5000; const MAX = 100000; const all = []; let rowsRaw = []; let pages = 0; let firstMsg = null; let sig = null;
  try {
    for (let start = 0; start < MAX; start += PAGE) {
      const b = await erp.callMethod(m, { filters: '{}', project: '', limit_start: String(start), limit_page_length: String(PAGE), context: 'report_view', my_tasks_only: 'false' });
      const msg = b.message !== undefined ? b.message : b;
      if (firstMsg === null) firstMsg = msg;
      const found = synergyhub.findRows(msg); const rows = found ? found.rows : [];
      if (!rows.length) break;
      const s2 = `${rows.length}|${JSON.stringify(rows[0])}`; if (s2 === sig) break; sig = s2; // hàm bỏ qua limit_start → tránh lặp vô hạn
      all.push(...rows); pages++;
      if (rows.length < PAGE) break;
    }
  } catch (e) {
    const err = new Error(`Không gọi được hàm Tasks của SynergyHub (${m}): ${e.message}`); err.tried = [{ method: m, error: String(e.message).slice(0, 220) }]; throw err;
  }
  const out = synergyhub.normalizeTasks(all.length ? { data: all } : firstMsg);
  out.method = m; out.diagnostics.paging = { pages, fetched: all.length, pageSize: PAGE };
  synergyTasksCache = { at: Date.now(), method: m, data: out };
  return out;
}
app.get('/api/synergyhub/tasks', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const out = await loadSynergyTasks({ method: String(req.query.method || ''), refresh: Boolean(req.query.refresh) });
    res.json({ method: out.method, total: out.tasks.length, diagnostics: out.diagnostics, sample: out.tasks.slice(0, 5) });
  } catch (e) { res.status(502).json({ error: e.message, tried: e.tried || [] }); }
});
app.get('/api/kpi/crplan-auto', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const config = kpiSla.loadConfig(); const c = config.crplan;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const chosen = parseJsonArrayParam(req.query.projects).map((x) => String(x).trim().toLowerCase()).filter(Boolean); // dự án SynergyHub đã chọn trong danh sách (tên hoặc mã); rỗng = tất cả
    const data = await loadSynergyTasks({ refresh: Boolean(req.query.refresh) });
    const local = member.split('@')[0];
    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const mine = data.tasks.filter((t) => t.assignees.includes(member) || t.assignees.includes(local));
    const projectsOfMember = [...new Set(mine.map((t) => t.project).filter(Boolean))].sort();
    const inProj = mine.filter((t) => !chosen.length || chosen.includes(t.project.trim().toLowerCase()));
    const rows = inProj.filter((t) => t.planned && t.planned.slice(0, 7) === month).map((t) => {
      let status; let pass = false; let decided = true;
      if (t.done) { if (t.done <= t.planned) { status = 'Đạt (đúng hạn)'; pass = true; } else status = 'Trễ hạn'; }
      else if (t.completedByStatus) { status = 'Hoàn thành (không có ngày hoàn thành)'; pass = true; }
      else if (t.planned < today) status = 'Quá hạn chưa xong';
      else { status = 'Đang thực hiện'; decided = false; }
      return { ...t, resultStatus: status, pass, decided };
    }).sort((a, b) => a.planned.localeCompare(b.planned));
    const decided = rows.filter((r) => r.decided); const pass = decided.filter((r) => r.pass).length;
    const actual = decided.length ? (pass / decided.length) * 100 : null;
    const th = c.thresholds[level]; const weight = c.weights[level]; const applicable = Boolean(th) && weight != null;
    const p = applicable ? require('./kpiSla').progressOf(actual, th) : null;
    res.json({
      month, member, level, method: data.method, projects: chosen,
      kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
      result: { total: rows.length, decided: decided.length, pass, fail: decided.length - pass, pending: rows.length - decided.length, actual: actual == null ? null : Math.round(actual * 1e4) / 1e4,
        progress: p ? Math.round(p.progress * 1e4) / 1e4 : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? Math.round(p.progress * weight * 1e2) / 1e4 : null },
      tasks: rows, projectsOfMember,
      diagnostics: { ...data.diagnostics, tasksInSynergyHub: data.tasks.length, assignedToMember: mine.length, afterProjectFilter: inProj.length, noPlannedForMember: inProj.filter((t) => !t.planned).length },
    });
  } catch (e) { console.error('[kpi/crplan-auto] lỗi:', e.message); res.status(502).json({ error: e.message, tried: e.tried || [] }); }
});

/* ---------- Dashboard Support Tuần của từng dự án ----------
   GET /api/projects/weekly?project=<mã project ERP>&week=<YYYY-MM-DD bất kỳ trong tuần>&weeks=<số tuần xu hướng, mặc định 8>
   Lấy ticket của dự án từ ERP (mở trong cửa sổ xu hướng, có cập nhật trong cửa sổ, và toàn bộ ticket còn tồn), rồi tính bằng weeklyReport.js. */
const weeklyCache = new Map(); // key -> { at, data }
app.get('/api/projects/weekly', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  const project = String(req.query.project || '');
  const known = loadInstructionProjects().find((p) => p.code === project);
  if (!known) return res.status(400).json({ error: 'Dự án không hợp lệ.' });
  const weekParam = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week || '')) ? String(req.query.week) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const weeks = Math.min(26, Math.max(2, Number(req.query.weeks) || 8));
  const weekStart = weekly.mondayOf(weekParam);
  const key = `${project}|${weekStart}|${weeks}`;
  const hit = weeklyCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000 && !req.query.refresh) return res.json(hit.data);
  try {
    const trendStart = weekly.addDays(weekStart, -7 * (weeks - 1));
    const weekEnd = weekly.addDays(weekStart, 6);
    const limit = 5000;
    // 3 truy vấn tuần tự (dùng chung 1 phiên ERP): mở trong cửa sổ · có cập nhật trong cửa sổ (gồm ticket cũ mới đóng) · toàn bộ ticket còn tồn
    const a = await erp.fetchTickets({ projects: [project], openingFrom: trendStart, openingTo: weekEnd, limit });
    const b = await erp.fetchTickets({ projects: [project], modifiedFrom: trendStart, limit });
    const c = await erp.fetchTickets({ projects: [project], statuses: weekly.BACKLOG_STATUSES, limit });
    const rows = [...(a.data || a), ...(b.data || b), ...(c.data || c)];
    const data = weekly.buildWeeklyReport(rows, { project, weekStart, weeks });
    data.projectName = known.name;
    data.erpUrl = erp.getBaseUrl();
    if ([a, b, c].some((x) => (x.data || x).length >= limit)) data.meta.warnings.push(`Một truy vấn chạm giới hạn ${limit} ticket — số liệu có thể thiếu.`);
    weeklyCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('[projects/weekly] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- Báo cáo khách hàng theo dự án (slide tổng hợp + tồn đọng, xuất PNG/Excel/PPTX) ----------
   GET /api/projects/customer-report?project=<mã project ERP>&week=<YYYY-MM-DD>&weeks=<số tuần xu hướng, mặc định 8>
   Cùng nguồn dữ liệu và định nghĩa với /api/projects/weekly, nhưng trả đủ danh sách ticket sau từng con số (customerReport.js). */
const customerCache = new Map();
app.get('/api/projects/customer-report', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  const project = String(req.query.project || '');
  const known = loadInstructionProjects().find((p) => p.code === project);
  if (!known) return res.status(400).json({ error: 'Dự án không hợp lệ.' });
  const weekParam = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week || '')) ? String(req.query.week) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const weeks = Math.min(26, Math.max(2, Number(req.query.weeks) || 8));
  const weekStart = weekly.mondayOf(weekParam);
  const key = `${project}|${weekStart}|${weeks}`;
  const hit = customerCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000 && !req.query.refresh) return res.json(hit.data);
  try {
    const trendStart = weekly.addDays(weekStart, -7 * (weeks - 1));
    const weekEnd = weekly.addDays(weekStart, 6);
    const limit = 5000;
    const a = await erp.fetchTickets({ projects: [project], openingFrom: trendStart, openingTo: weekEnd, limit });
    const b = await erp.fetchTickets({ projects: [project], modifiedFrom: trendStart, limit });
    const c = await erp.fetchTickets({ projects: [project], statuses: weekly.BACKLOG_STATUSES, limit });
    const rows = [...(a.data || a), ...(b.data || b), ...(c.data || c)];
    const data = buildCustomerReport(rows, { project, weekStart, weeks });
    data.projectName = known.name;
    data.erpUrl = erp.getBaseUrl();
    if ([a, b, c].some((x) => (x.data || x).length >= limit)) data.meta.warnings.push(`Một truy vấn chạm giới hạn ${limit} ticket — số liệu có thể thiếu.`);
    customerCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('[projects/customer-report] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- Báo cáo THÁNG khách hàng theo dự án (cùng thông số với báo cáo tuần, kỳ = tháng; xuất PNG/Excel/PPTX) ----------
   GET /api/projects/customer-report-monthly?project=<mã project ERP>&month=<YYYY-MM>&months=<số tháng xu hướng, mặc định 6>
   Cùng nguồn dữ liệu và định nghĩa với /api/projects/customer-report, chỉ đổi kỳ từ tuần sang tháng (customerReportMonthly.js). */
const customerMonthlyCache = new Map();
app.get('/api/projects/customer-report-monthly', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  const project = String(req.query.project || '');
  const known = loadInstructionProjects().find((p) => p.code === project);
  if (!known) return res.status(400).json({ error: 'Dự án không hợp lệ.' });
  const month = isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const months = Math.min(24, Math.max(2, Number(req.query.months) || 6));
  const key = `${project}|${month}|${months}`;
  const hit = customerMonthlyCache.get(key);
  if (hit && Date.now() - hit.at < 3 * 60 * 1000 && !req.query.refresh) return res.json(hit.data);
  try {
    const trendStart = monthStartOf(addMonths(month, -(months - 1)));
    const monthEnd = monthEndOf(month);
    const limit = 5000;
    const a = await erp.fetchTickets({ projects: [project], openingFrom: trendStart, openingTo: monthEnd, limit });
    const b = await erp.fetchTickets({ projects: [project], modifiedFrom: trendStart, limit });
    const c = await erp.fetchTickets({ projects: [project], statuses: weekly.BACKLOG_STATUSES, limit });
    const rows = [...(a.data || a), ...(b.data || b), ...(c.data || c)];
    const data = buildMonthlyCustomerReport(rows, { project, month, months });
    data.projectName = known.name;
    data.erpUrl = erp.getBaseUrl();
    if ([a, b, c].some((x) => (x.data || x).length >= limit)) data.meta.warnings.push(`Một truy vấn chạm giới hạn ${limit} ticket — số liệu có thể thiếu.`);
    customerMonthlyCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('[projects/customer-report-monthly] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- KPI Team: CS01 "SLA Phản Hồi" / CS02 "SLA Hoàn Tất" — đánh giá THEO THÁNG cho 1 thành viên ----------
   GET /api/kpi/sla-member?kpi=firstResponse|resolution&member=<email>&level=<Fresher|Junior|Middle|Senior>&month=<YYYY-MM>
       &projects=["ANVY_eSale_Support","MerapLion_eSales"]&by=assign|owner
   Thành viên phải nằm trong danh sách người tạo ticket (ticket-creators.json). Tính ở kpiSla.js, ngưỡng/trọng số ở kpi-sla-config.json. */
const kpiSlaCache = new Map(); // dữ liệu ERP thô theo dự án+tháng, để đổi thành viên/level không phải gọi ERP lại
app.get('/api/kpi/sla-member', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  let config;
  try { config = kpiSla.loadConfig(); } catch (e) { return res.status(500).json({ error: 'Không đọc được kpi-sla-config.json: ' + e.message }); }
  const kpiKey = String(req.query.kpi || '');
  if (!config.kpis[kpiKey]) return res.status(400).json({ error: 'KPI không hợp lệ.' });
  const member = String(req.query.member || '').trim().toLowerCase();
  if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
  const level = String(req.query.level || '');
  if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
  const valid = new Set(loadInstructionProjects().map((p) => p.code));
  const requested = parseJsonArrayParam(req.query.projects);
  const projects = (requested.length ? requested : config.defaultProjects).filter((c) => valid.has(c));
  if (!projects.length) return res.status(400).json({ error: 'Chưa chọn dự án hợp lệ.' });
  const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const by = req.query.by === 'owner' ? 'owner' : 'assign';
  const key = `${[...projects].sort().join(',')}|${month}`;
  try {
    let hit = kpiSlaCache.get(key);
    if (!hit || Date.now() - hit.at > 3 * 60 * 1000 || req.query.refresh) {
      const limit = 5000;
      const r = await erp.fetchTickets({ projects, openingFrom: monthStartOf(month), openingTo: monthEndOf(month), limit });
      const rows = r.data || r;
      hit = { at: Date.now(), rows, truncated: rows.length >= limit, limit };
      kpiSlaCache.set(key, hit);
    }
    const data = kpiSla.evaluateMember(hit.rows, { month, projects, member, by, level, kpiKey, config });
    data.warnings = hit.truncated ? [`Truy vấn chạm giới hạn ${hit.limit} ticket — số liệu có thể thiếu.`] : [];
    data.config = { levels: config.levels, defaultProjects: config.defaultProjects, thresholds: config.kpis[kpiKey].thresholds, weights: config.kpis[kpiKey].weights, name: config.kpis[kpiKey].matrixName };
    res.json(data);
  } catch (e) {
    console.error('[kpi/sla-member] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ---------- KPI Team: CS03 Complaint khách hàng — ghi nhận tay theo tháng, chấm KPI theo thành viên + level + dự án ----------
   GET    /api/kpi/complaint-score?member=<email>&level=&month=<YYYY-MM>&projects=[...]  → Actual/Progress/KPI Completion + complaint của thành viên + tổng hợp cả team trong tháng
   POST   /api/kpi/complaints        {date, member, project, type: progress|repeat, issue, channel, note}   → thêm
   PUT    /api/kpi/complaints/:id    (cùng dữ liệu)                                                         → sửa
   DELETE /api/kpi/complaints/:id                                                                          → xoá
   Dữ liệu lưu qua listStore.js (GitHub nếu đã cấu hình, ngược lại ./data/kpi-complaints.json). Cách tính: kpiComplaint.js + kpi-sla-config.json ("complaint"). */
function complaintCtx() { return { config: kpiSla.loadConfig(), allowedMembers: loadProjectCreators().creators, allowedProjects: loadInstructionProjects().map((p) => p.code) }; }
app.get('/api/kpi/complaint-score', requireAuth, async (req, res) => {
  try {
    const config = kpiSla.loadConfig(); const c = config.complaint;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const requested = parseJsonArrayParam(req.query.projects);
    const allProjects = loadInstructionProjects().map((p) => p.code);
    const projects = (requested.length ? requested : allProjects).filter((p) => allProjects.includes(p));
    if (!projects.length) return res.status(400).json({ error: 'Chưa chọn dự án hợp lệ.' });
    const all = await kpiComplaint.store.readAll();
    const out = kpiComplaint.scoreMember(all, { month, member, level, projects, config });
    out.overview = kpiComplaint.overview(all, { month, projects, config });
    out.config = { levels: config.levels, projects: allProjects, channels: c.channels, types: kpiComplaint.TYPES, thresholds: c.thresholds, weights: c.weights, progressComplaintPenalty: c.progressComplaintPenalty, repeatPenaltyByCount: c.repeatPenaltyByCount, name: c.matrixName };
    out.githubBacked = kpiComplaint.store.isGithubBacked();
    res.json(out);
  } catch (e) { console.error('[kpi/complaint-score] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.post('/api/kpi/complaints', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiComplaint.add(req.body || {}, complaintCtx())) }); }
  catch (e) { console.error('[kpi/complaints:post] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.put('/api/kpi/complaints/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiComplaint.update(req.params.id, req.body || {}, complaintCtx())) }); }
  catch (e) { console.error('[kpi/complaints:put] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.delete('/api/kpi/complaints/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiComplaint.remove(req.params.id)) }); }
  catch (e) { console.error('[kpi/complaints:delete] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});

/* ---------- KPI Team: CS05 Functional defect escape sau review — dò từ ticket ERP của tháng (mở lại / ticket mới liên quan-lặp lại ticket cũ) ----------
   GET  /api/kpi/defect-escape?member=<email>&level=&month=<YYYY-MM>&projects=[...]   → ứng viên lỗi lọt của thành viên + Actual/Progress/KPI Completion (kpiDefect.js)
   POST /api/kpi/defect-decision {id, decision: include|exclude|clear, note}           → QA xác nhận tính / không tính 1 ứng viên (lưu qua listStore) */
const defectCache = new Map();
async function loadDefectData(projects, month, config, refresh) {
  const key = `${[...projects].sort().join(',')}|${month}`;
  const hit = defectCache.get(key);
  if (hit && !refresh && Date.now() - hit.at < 3 * 60 * 1000) return hit.data;
  const dc = config.defect;
  const from = monthStartOf(addMonths(month, -dc.lookbackMonths)); const to = monthEndOf(month);
  const limit = 5000;
  const r = await erp.fetchTickets({ projects, openingFrom: from, openingTo: to, limit });
  let rows = r.data || r;
  const warnings = rows.length >= limit ? [`Truy vấn chạm giới hạn ${limit} ticket — có thể thiếu ticket cũ để đối chiếu.`] : [];
  let linkFields = []; let metaError = '';
  try {
    const meta = await erp.getTicketMeta();
    linkFields = meta.fields.filter((f) => f.fieldtype === 'Link' && f.options === 'Ticket' && f.fieldname !== 'name').map((f) => f.fieldname);
  } catch (e) { metaError = e.message; }
  let versions = null; let versionsError = '';
  try { versions = await erp.fetchVersions({ from: monthStartOf(month), to }); } catch (e) { versionsError = e.message; }
  if (versions) { // ticket mở lại có thể mở từ trước khoảng lookback → lấy bổ sung theo mã
    const have = new Set(rows.map((x) => x.name));
    const need = kpiDefect.reopenEventsFromVersions(versions, dc.closedStatuses).map((e) => e.ticket).filter((n) => !have.has(n));
    if (need.length) { try { rows = rows.concat(await erp.fetchTicketsByNames(need)); } catch (e) { warnings.push('Không lấy được ticket mở lại ngoài khoảng đối chiếu: ' + e.message); } }
  }
  let built = kpiDefect.buildCandidates({ rows, versions, versionsError, linkFields, month, projects, config });
  if (built.needHandlers.length) { // ticket cũ đã đóng thường mất _assign → tra lịch sử giao việc (ToDo)
    const asked = built.needHandlers.length;
    try {
      const todo = await erp.fetchTodoAssignees(built.needHandlers);
      built = kpiDefect.buildCandidates({ rows, versions, versionsError, linkFields, todoAssignees: todo, month, projects, config });
      built.diagnostics.todoLookup = { askedTickets: asked, foundTickets: Object.keys(todo).length, stillUnattributed: built.diagnostics.unattributed };
    } catch (e) { built.diagnostics.todoError = e.message; }
  }
  if (metaError) built.diagnostics.metaError = metaError;
  built.warnings = warnings;
  defectCache.set(key, { at: Date.now(), data: built });
  return built;
}
app.get('/api/kpi/defect-escape', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const config = kpiSla.loadConfig(); const dc = config.defect;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const allProjects = loadInstructionProjects().map((p) => p.code);
    const requested = parseJsonArrayParam(req.query.projects);
    const projects = (requested.length ? requested : allProjects).filter((p) => allProjects.includes(p));
    if (!projects.length) return res.status(400).json({ error: 'Chưa chọn dự án hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const built = await loadDefectData(projects, month, config, Boolean(req.query.refresh));
    const decisions = await kpiDefect.store.readAll();
    const out = kpiDefect.scoreMember(built.candidates, decisions, { member, level, config });
    out.month = { key: month }; out.projects = projects; out.diagnostics = built.diagnostics; out.warnings = built.warnings;
    out.erpUrl = erp.getBaseUrl();
    out.teamUnattributed = built.candidates.filter((c) => !c.handlers.length);
    out.config = { levels: config.levels, thresholds: dc.thresholds, weights: dc.weights, lookbackMonths: dc.lookbackMonths, similarityThreshold: dc.similarityThreshold, name: dc.name };
    res.json(out);
  } catch (e) { console.error('[kpi/defect-escape] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.post('/api/kpi/defect-decision', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiDefect.setDecision({ id: b.id, decision: b.decision, note: b.note, by: req.session.username })) }); }
  catch (e) { console.error('[kpi/defect-decision] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});

/* ---------- Báo Cáo CS & AM: ticket của các dự án kèm HẠN SLA tính từ Opening On theo Priority (dự phòng khi ticket chưa có Estimated Deadline) ----------
   GET /api/bao-cao/cs-am/tickets?projects=[...]&statuses=[...]&limit=
   Mỗi ticket thêm trường _sla_due = Opening On + ngưỡng SLA xử lý theo Priority (Critical 1h, Urgent 4h liên tục; High 8h, Medium 72h, Low 120h giờ làm việc, trừ ngày lễ). */
app.get('/api/bao-cao/cs-am/tickets', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const projects = parseJsonArrayParam(req.query.projects);
    const statuses = parseJsonArrayParam(req.query.statuses);
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 2000));
    const r = await erp.fetchTickets({ projects, statuses, limit });
    const rows = (r.data || r).map((t) => {
      const opening = parseNaive(t.opening_date || t.creation);
      return { ...t, _sla_due: opening ? fmtNaive(slaDueAt(t.priority, opening)) : '' };
    });
    res.json({ data: rows });
  } catch (e) { console.error('[bao-cao/cs-am/tickets] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});

/* ---------- KPI Team: CS07 CR phân tích đúng hạn & đạt chất lượng — ghi nhận CR được giao phân tích theo tháng, chấm KPI theo thành viên + level + dự án ----------
   GET    /api/kpi/cr-score?member=<email>&level=&month=<YYYY-MM>&projects=[...]   → Actual/Progress/KPI Completion + CR của thành viên + tổng hợp cả team trong tháng
   POST   /api/kpi/cr-entries   {cr, member, project, assignedDate, dueDate, doneDate, returnCount, returnReason, note}
   PUT    /api/kpi/cr-entries/:id   ·   DELETE /api/kpi/cr-entries/:id
   Lưu qua listStore.js; cách tính: kpiCr.js + kpi-sla-config.json ("cr"). */
function crCtx() { return { allowedMembers: loadProjectCreators().creators, allowedProjects: loadInstructionProjects().map((p) => p.code) }; }
app.get('/api/kpi/cr-score', requireAuth, async (req, res) => {
  try {
    const config = kpiSla.loadConfig(); const c = config.cr;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const allProjects = loadInstructionProjects().map((p) => p.code);
    const requested = parseJsonArrayParam(req.query.projects);
    const projects = (requested.length ? requested : c.defaultProjects).filter((p) => allProjects.includes(p));
    if (!projects.length) return res.status(400).json({ error: 'Chưa chọn dự án hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const all = await kpiCr.store.readAll();
    const out = kpiCr.scoreMember(all, { month, member, level, projects, config });
    out.overview = kpiCr.overview(all, { month, projects });
    out.config = { levels: config.levels, thresholds: c.thresholds, weights: c.weights, defaultProjects: c.defaultProjects, name: c.name };
    out.githubBacked = kpiCr.store.isGithubBacked();
    res.json(out);
  } catch (e) { console.error('[kpi/cr-score] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.post('/api/kpi/cr-entries', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiCr.add(req.body || {}, crCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/kpi/cr-entries/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiCr.update(req.params.id, req.body || {}, crCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/kpi/cr-entries/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiCr.remove(req.params.id)) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- KPI Team: CS21 AI adoption cá nhân — ghi nhận bằng chứng AI workflow theo tháng, chấm KPI theo thành viên + level ----------
   GET    /api/kpi/ai-score?member=<email>&level=&month=<YYYY-MM>
   POST   /api/kpi/ai-submit {member, date, evidence, note, workflow:{…,rubric:[key…]}, time, reports:[…], violation:{has, description}}  (nhân viên ghi nhận + tự đánh giá cả 3 tiêu chí 1 lần)
   POST   /api/kpi/ai-entries {kind: time|workflow|report|violation, member, ...}   ·   POST /api/kpi/ai-grade {id, rubric:[key…], note, clear}  (người chấm tick checklist rubric cho 1 workflow)   ·   PUT /api/kpi/ai-entries/:id   ·   DELETE /api/kpi/ai-entries/:id
   POST   /api/kpi/ai-assess  {member, month, c1, c2, c3, note, clear}      → điểm điều chỉnh của L&D (tuỳ chọn) cho từng tiêu chí
   Lưu qua listStore.js (data/kpi-ai.json); cách tính: kpiAi.js + kpi-sla-config.json ("ai"). */
function aiCtx() { return { config: kpiSla.loadConfig(), allowedMembers: loadProjectCreators().creators }; }
app.get('/api/kpi/ai-score', requireAuth, async (req, res) => {
  try {
    const config = kpiSla.loadConfig(); const c = config.ai;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const all = await kpiAi.store.readAll();
    const out = kpiAi.scoreMember(all, { month, member, level, config });
    out.config = { levels: config.levels, thresholds: c.thresholds, weights: c.weights, criteria: c.criteria, rubric: c.rubric, reportKinds: c.reportKinds, timeKinds: c.timeKinds, name: c.name };
    out.githubBacked = kpiAi.store.isGithubBacked();
    res.json(out);
  } catch (e) { console.error('[kpi/ai-score] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.post('/api/kpi/ai-submit', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiAi.submit(req.body || {}, aiCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/ai-entries', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiAi.add(req.body || {}, aiCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/kpi/ai-entries/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiAi.update(req.params.id, req.body || {}, aiCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/kpi/ai-entries/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiAi.remove(req.params.id)) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/ai-grade', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiAi.gradeWorkflow({ id: b.id, rubric: b.rubric, note: b.note, clear: b.clear, by: req.session.username }, aiCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/ai-assess', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiAi.setAssess({ ...(req.body || {}), by: req.session.username }, aiCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- KPI Team: CS23 Hoàn thành chứng nhận sản phẩm — lộ trình module của kỳ (tháng), chấm theo thành viên + level ----------
   GET    /api/kpi/cert-score?member=<email>&level=&month=<YYYY-MM>
   POST   /api/kpi/cert-modules       {module, member, month, weight, dueDate, doneDate, evidence, note}
   GET    /api/kpi/cert-roadmaps?month=&member=    → các lộ trình đã lập theo tháng (mỗi nhân viên: module, trọng số %, % hoàn thành)
   POST   /api/kpi/cert-roadmap {members:[…], month, modules:[{module, weight%}]}   → QUẢN LÝ lập lộ trình (tổng trọng số = 100%)
   POST   /api/kpi/cert-submit  {member, month, items:[{id, completion%, evidence, note}]}   → NHÂN VIÊN gửi bằng chứng + % hoàn thành (1 commit)
   POST   /api/kpi/cert-modules/bulk  {member, month, items:[{module, weight?, dueDate?}]}   (cũ: thêm cả lộ trình 1 lần, 1 commit)
   PUT    /api/kpi/cert-modules/:id   ·   DELETE /api/kpi/cert-modules/:id
   Lưu qua listStore.js (data/kpi-cert.json); cách tính: kpiCert.js + kpi-sla-config.json ("cert"). */
function certCtx() { return { allowedMembers: loadProjectCreators().creators }; }
app.get('/api/kpi/cert-score', requireAuth, async (req, res) => {
  try {
    const config = kpiSla.loadConfig(); const c = config.cert;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const all = await kpiCert.store.readAll();
    const out = kpiCert.scoreMember(all, { month, member, level, config });
    out.config = { levels: config.levels, thresholds: c.thresholds, weights: c.weights, name: c.name };
    out.githubBacked = kpiCert.store.isGithubBacked();
    res.json(out);
  } catch (e) { console.error('[kpi/cert-score] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.get('/api/kpi/cert-roadmaps', requireAuth, async (req, res) => {
  try {
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const member = String(req.query.member || '').trim().toLowerCase();
    const all = await kpiCert.store.readAll();
    res.json({ month, member, roadmaps: kpiCert.roadmaps(all, { month, member }) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/kpi/cert-roadmap', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiCert.setRoadmap({ members: b.members, month: b.month, modules: b.modules }, certCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/cert-submit', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiCert.submit({ member: b.member, month: b.month, items: b.items }, certCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/cert-modules/bulk', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiCert.addMany({ member: b.member, month: b.month }, b.items, certCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/cert-modules', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiCert.add(req.body || {}, certCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/kpi/cert-modules/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiCert.update(req.params.id, req.body || {}, certCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/kpi/cert-modules/:id', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await kpiCert.remove(req.params.id)) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- KPI Team: CS25 Quản lý CR — giữ đúng plan CR đã cam kết với khách. Cách 1: quản lý lập lộ trình tháng (mục + trọng số % tổng 100% + hạn cam kết), nhân viên nhập ngày thực tế + bằng chứng.
   GET  /api/kpi/crplan-score?member=<email>&level=&month=<YYYY-MM>
   GET  /api/kpi/crplan-roadmaps?month=&member=
   POST /api/kpi/crplan-roadmap {members:[…], month, modules:[{module, weight%, plannedDate}]}      → QUẢN LÝ lập lộ trình (tổng trọng số = 100%)
   POST /api/kpi/crplan-submit  {member, month, items:[{id, actualDate, hasError, evidence, note}]}   → NHÂN VIÊN gửi ngày thực tế + bằng chứng (1 commit)
   Lưu qua listStore.js (data/kpi-crplan-roadmap.json); cách tính: kpiCrPlan.js + kpi-sla-config.json ("crplan"). Cách 2 (tự động từ SynergyHub) ở bên dưới. */
function crPlanCtx() { return { allowedMembers: loadProjectCreators().creators }; }
app.get('/api/kpi/crplan-score', requireAuth, async (req, res) => {
  try {
    const config = kpiSla.loadConfig(); const c = config.crplan;
    const member = String(req.query.member || '').trim().toLowerCase();
    if (!loadProjectCreators().creators.includes(member)) return res.status(400).json({ error: 'Thành viên không nằm trong danh sách người tạo ticket.' });
    const level = String(req.query.level || '');
    if (!config.levels.includes(level)) return res.status(400).json({ error: 'Level không hợp lệ.' });
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const all = await kpiCrPlan.store.readAll();
    const out = kpiCrPlan.scoreMember(all, { month, member, level, config });
    out.config = { levels: config.levels, thresholds: c.thresholds, weights: c.weights, criteria: c.criteria, name: c.name };
    res.json(out);
  } catch (e) { console.error('[kpi/crplan-score] lỗi:', e.message); res.status(502).json({ error: e.message }); }
});
app.get('/api/kpi/crplan-roadmaps', requireAuth, async (req, res) => {
  try {
    const month = kpiSla.isMonthKey(req.query.month) ? String(req.query.month) : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const member = String(req.query.member || '').trim().toLowerCase();
    res.json({ month, member, roadmaps: kpiCrPlan.roadmaps(await kpiCrPlan.store.readAll(), { month, member, config: kpiSla.loadConfig() }) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/kpi/crplan-roadmap', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiCrPlan.setRoadmap({ members: b.members, month: b.month, modules: b.modules }, crPlanCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/kpi/crplan-submit', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, ...(await kpiCrPlan.submit({ member: b.member, month: b.month, items: b.items }, crPlanCtx())) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- File hướng dẫn AI (.md) cho từng dự án: nhân viên tải về để tạo Project/Skill gen ticket ----------
   Nguồn: ticket-instructions/projects.json + Project-Instructions-<DỰ ÁN>.md (sinh bằng scripts/gen-ticket-instructions.js). */
const INSTR_DIR = path.join(__dirname, 'ticket-instructions');
function loadInstructionProjects() {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTR_DIR, 'projects.json'), 'utf8'));
  } catch (e) {
    console.error('[ticket-instructions] không đọc được projects.json:', e.message);
    return [];
  }
}

function buildMasterBlock(m) {
  const order = [['request_type', 'Request Type'], ['internal_request_type', 'Internal Request Type'], ['region', 'Region'], ['contact_role', 'Contact Role'], ['products', 'Products']];
  const parts = order.filter(([k]) => m[k] && m[k].length).map(([k, label]) => `- ${label}:\n${m[k].map((v) => `  - ${v}`).join('\n')}`);
  if (!parts.length) return '';
  const stamp = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  return `<!-- Danh sách lấy trực tiếp từ ERP lúc tải file (${stamp}) -->\n${parts.join('\n')}`;
}

app.get('/api/ticket-instructions', requireAuth, (req, res) => {
  res.json(loadInstructionProjects().map(({ code, label, name, file }) => ({ code, label, name, file })));
});

/** Nội dung file hướng dẫn của dự án, đã thay khối master bằng danh sách lấy trực tiếp từ ERP (nếu kết nối được). */
async function renderInstruction(p) {
  const full = path.join(INSTR_DIR, p.file);
  let text = fs.readFileSync(full, 'utf8');
  let source = 'static';
  if (erp.isConfigured()) {
    try {
      const m = await erp.getMasterLists();
      const block = buildMasterBlock(m);
      const a = text.indexOf('<!-- MASTER:BEGIN -->');
      const b = text.indexOf('<!-- MASTER:END -->');
      if (block && a >= 0 && b > a) {
        text = text.slice(0, a) + block + text.slice(b + '<!-- MASTER:END -->'.length);
        source = 'live';
      }
    } catch (e) { console.error('[ticket-instructions] không lấy được master từ ERP:', e.message); }
  }
  if (source === 'static') text = text.replace(/<!-- MASTER:(BEGIN|END) -->\n?/g, '');
  return { text, source };
}

function findInstructionProject(code) {
  const p = loadInstructionProjects().find((x) => x.code === code);
  if (!p || path.basename(p.file) !== p.file) return null;
  return fs.existsSync(path.join(INSTR_DIR, p.file)) ? p : null;
}

app.get('/api/ticket-instructions/:code', requireAuth, async (req, res) => {
  const p = findInstructionProject(req.params.code);
  if (!p) return res.status(404).json({ error: 'Không có file hướng dẫn cho dự án này (nếu chưa tạo: node scripts/gen-ticket-instructions.js).' });
  const { text, source } = await renderInstruction(p);
  res.setHeader('X-Masters', source);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${p.file}"`);
  res.send(text);
});

/* ---------- API: TẠO TICKET trên ERP (ghi dữ liệu thật) ----------
   - GET  /api/erp/ticket-meta              : cấu trúc trường của DocType Ticket (để dựng form đúng tên trường)
   - GET  /api/erp/link-search?doctype=&txt= : gợi ý giá trị cho trường Link (chỉ cho các DocType có trong form Ticket)
   - POST /api/erp/tickets {fields, dry_run} : dry_run=true chỉ kiểm tra, không gửi sang ERP */
const BLOCKED_WRITE_FIELDS = new Set(['name', 'owner', 'creation', 'modified', 'modified_by', 'docstatus', 'idx', 'doctype']);
const recentCreates = new Map(); // chống bấm tạo trùng: project|subject -> thời điểm
const createdTickets = new Map(); // mã ticket vừa tạo từ tool -> thời điểm (chỉ cho phép đính kèm vào các ticket này)

app.post('/api/erp/refresh-cache', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const m = await erp.refreshCache();
    res.json({ ok: true, fields: m.fields.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/erp/ticket-meta', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    res.json(await erp.getTicketMeta());
  } catch (e) {
    console.error('[erp/ticket-meta] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Người tạo ticket: CHỈ chọn trong danh sách email cấu hình (ticket-creators.json hoặc biến ERP_PROJECT_CREATORS cùng định dạng):
   {"serviceAccount":"nhatha@hqsoft.com.vn",
    "creators":["phuctm@hqsoft.com.vn", ...],
    "defaults":{"MerapLion_eSales":"phuctm@hqsoft.com.vn", ...}}
   - creators  : danh sách hiển thị ở MỌI dự án để chọn.
   - defaults  : email mặc định theo từng dự án.
   - serviceAccount: tài khoản đăng nhập ERP đã cấu hình trên Render (ERP_USER) — chọn email này thì tạo trực tiếp, không thay mặt.
   - assignees: nhóm NGƯỜI XỬ LÝ — chọn thêm người trong nhóm này (khác người tạo) thì ticket mới chuyển Status Assign.
   - Người xử lý mặc định là người tạo ticket; có thể chọn thêm email trong creators + assignees, nhưng chỉ người thuộc assignees mới làm đổi Status. */
function loadProjectCreators() {
  let raw = process.env.ERP_PROJECT_CREATORS;
  try {
    if (!raw) raw = fs.readFileSync(path.join(__dirname, 'ticket-creators.json'), 'utf8');
    const j = JSON.parse(raw) || {};
    const norm = (x) => String(x || '').trim().toLowerCase();
    const serviceAccount = norm(j.serviceAccount);
    const creators = [...new Set([...(Array.isArray(j.creators) ? j.creators : []).map(norm), serviceAccount].filter((x) => EMAIL_RE.test(x)))];
    // defaults: dự án → 1 email, hoặc MẢNG email. Phần tử đầu = người tạo mặc định ở trang Tạo Ticket;
    // cả mảng = các thành viên "phụ trách" dự án (dùng để tích sẵn dự án ở các trang KPI CS01/CS02/CS03).
    const defaults = {}; const defaultMembers = {};
    for (const [code, v] of Object.entries(j.defaults || {})) {
      const list = [...new Set((Array.isArray(v) ? v : [v]).map(norm).filter((e) => creators.includes(e)))];
      if (list.length) { defaults[code] = list[0]; defaultMembers[code] = list; }
    }
    const assignees = [...new Set((Array.isArray(j.assignees) ? j.assignees : []).map(norm).filter((x) => EMAIL_RE.test(x)))];
    const assignable = [...new Set([...assignees, ...creators])]; // danh sách được phép chọn làm người xử lý
    return { serviceAccount: EMAIL_RE.test(serviceAccount) ? serviceAccount : '', creators, defaults, defaultMembers, assignees, assignable };
  } catch (e) {
    console.error('[ticket-creators] không đọc được cấu hình:', e.message);
    return { serviceAccount: '', creators: [], defaults: {}, defaultMembers: {}, assignees: [], assignable: [] };
  }
}
{
  const c = loadProjectCreators();
  const u = String(erp.getUser() || '').trim().toLowerCase();
  console.log(`[ticket-creators] ${c.creators.length} email người tạo; tài khoản Render (ERP_USER) = ${u || 'chưa cấu hình'}`);
  if (c.serviceAccount && u && u !== c.serviceAccount) {
    console.warn(`[ticket-creators] CẢNH BÁO: ERP_USER (${u}) khác serviceAccount (${c.serviceAccount}) — chọn "${c.serviceAccount}" sẽ tạo bằng ${u}.`);
  }
}

app.get('/api/erp/ticket-creators', requireAuth, (req, res) => {
  res.json(loadProjectCreators());
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

function sanitizeTicketFields(input, meta) {
  const byName = new Map(meta.fields.map((f) => [f.fieldname, f]));
  const payload = {};
  const rejected = [];
  for (const [k, v] of Object.entries(input)) {
    const f = byName.get(k);
    if (!f || BLOCKED_WRITE_FIELDS.has(k) || f.read_only) { rejected.push(k); continue; }
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    payload[k] = v;
  }
  return { payload, rejected };
}

/* Xem trước các trường sẽ được tự điền (để form hiển thị trước khi tạo). Không ghi gì vào ERP. */
app.post('/api/erp/ticket-defaults', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const input = req.body && req.body.fields;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'Thiếu dữ liệu fields.' });
    const meta = await erp.getTicketMeta();
    const { payload } = sanitizeTicketFields(input, meta);
    res.json({ autofilled: await applyTicketDefaults(payload, meta, erp) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* Đính kèm ảnh/file vào ticket VỪA TẠO từ tool (tối đa 8 file, mỗi file 8 MB). Chỉ nhận mã ticket do tool tạo trong 2 giờ gần nhất. */
const ATTACH_OK = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|zip))$/i;
const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, ATTACH_OK.test(file.mimetype || '')),
});
app.post('/api/erp/attachments', requireAuth, (req, res) => {
  attachUpload.array('files', 8)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File quá lớn (tối đa 8 MB mỗi file).' : `Lỗi nhận file: ${err.message}` });
    if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
    const ticket = String((req.body && req.body.ticket) || '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(ticket)) return res.status(400).json({ error: 'Mã ticket không hợp lệ.' });
    const at = createdTickets.get(ticket);
    if (!at || Date.now() - at > 2 * 60 * 60 * 1000) return res.status(403).json({ error: 'Chỉ đính kèm được vào ticket vừa tạo từ tool (trong 2 giờ).' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Không có file hợp lệ (chỉ nhận ảnh, PDF, văn bản, Office, zip; tối đa 8 MB).' });
    const results = [];
    const imageUrls = [];
    for (const f of files) {
      // multer đọc tên file theo latin1 -> đổi lại UTF-8 để giữ tiếng Việt
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || 'file';
      try {
        const r = await erp.uploadAttachment(ticket, name, f.mimetype, f.buffer);
        results.push({ name, ok: true, url: r.file_url || null });
        if (r.file_url && /^image\//i.test(f.mimetype || '')) imageUrls.push(r.file_url);
      } catch (e) {
        console.error('[erp/attachments] lỗi:', e.message);
        results.push({ name, ok: false, error: e.message });
      }
    }
    // Tuỳ chọn: chèn ảnh vào mô tả ticket để hiện ngay trong nội dung (không chỉ ở mục Attachments)
    let embedded = 0, embedWarning = null;
    if (String((req.body && req.body.embed) || '') === '1' && imageUrls.length) {
      try { embedded = await erp.embedImagesInDescription(ticket, imageUrls); }
      catch (e) { console.error('[erp/attachments] không chèn được ảnh vào mô tả:', e.message); embedWarning = `Ảnh đã đính kèm nhưng chưa chèn được vào mô tả: ${e.message}`; }
    }
    console.log(`[erp/attachments] ${ticket}: ${results.filter((x) => x.ok).length}/${results.length} file, chèn mô tả ${embedded}`);
    res.json({ results, embedded, embed_warning: embedWarning });
  });
});

/* Gợi ý người liên hệ (Contact) theo email / tên lấy từ mục "Người liên hệ" của ticket. */
app.post('/api/erp/contact-suggest', requireAuth, async (req, res) => {
  if (!erp.isConfigured()) return res.status(501).json({ error: 'Server chưa cấu hình kết nối ERP.' });
  try {
    const meta = await erp.getTicketMeta();
    const cf = meta.fields.find((f) => f.fieldtype === 'Link' && f.label.trim().toLowerCase() === 'contact');
    if (!cf) return res.json([]);
    const email = String((req.body && req.body.email) || '').trim();
    const name = String((req.body && req.body.name) || '').trim();
    if (!email && !name) return res.json([]);
    res.json(await erp.suggestContacts({ doctype: cf.options, email, name }));
  } catch (e) {
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
    // Chỉ nhận trường có trong DocType Ticket, không phải trường hệ thống / chỉ-đọc.
    const { payload, rejected } = sanitizeTicketFields(input, meta);

    // Tự điền trường cố định (Customer theo Project, mặc định cấu hình, Deadline theo Priority) trước khi kiểm tra bắt buộc.
    let autofilled = [];
    try { autofilled = await applyTicketDefaults(payload, meta, erp); }
    catch (e) { console.error('[erp/tickets] tự điền lỗi (bỏ qua):', e.message); }

    const missing = meta.fields
      .filter((f) => f.reqd && !f.read_only && !f.hidden && payload[f.fieldname] === undefined && !f.default)
      .map((f) => f.label || f.fieldname);
    if (missing.length) {
      return res.status(400).json({ error: 'Thiếu trường bắt buộc: ' + missing.join(', '), missing });
    }

    // Người tạo: CHỈ nhận email nằm trong danh sách cấu hình (ticket-creators.json), không nhận cách nào khác.
    const cfg = loadProjectCreators();
    const creatorEmail = String((req.body && req.body.creator_email) || '').trim().toLowerCase();
    if (!creatorEmail) return res.status(400).json({ error: 'Chọn người tạo ticket.' });
    if (!cfg.creators.includes(creatorEmail)) return res.status(400).json({ error: 'Người tạo không nằm trong danh sách cho phép.' });
    const direct = creatorEmail === cfg.serviceAccount; // tài khoản đăng nhập Render: tạo trực tiếp
    if (!direct && !(await erp.userExists(creatorEmail))) {
      return res.status(400).json({ error: `"${creatorEmail}" không phải người dùng đang hoạt động trên ERP.` });
    }

    // Người xử lý (Assign): danh sách email (mặc định = người tạo), chỉ nhận email trong danh sách cho phép.
    const rawAssign = req.body && req.body.assign_to;
    const assignList = [...new Set((Array.isArray(rawAssign) ? rawAssign : String(rawAssign || '').split(/[,;\s]+/)).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
    if (assignList.length > 10) return res.status(400).json({ error: 'Tối đa 10 người xử lý.' });
    for (const e of assignList) {
      if (!cfg.assignable.includes(e)) return res.status(400).json({ error: `Người xử lý "${e}" không nằm trong danh sách cho phép.` });
      if (!(await erp.userExists(e))) return res.status(400).json({ error: `"${e}" không phải người dùng đang hoạt động trên ERP.` });
    }
    // Chỉ khi chọn thêm người thuộc NHÓM NGƯỜI XỬ LÝ (assignees, khác người tạo) thì chuyển Status sang Assign;
    // chỉ người tạo, hoặc người tạo khác (không thuộc nhóm), hoặc không giao ai thì giữ Open.
    const hasOtherAssignee = assignList.some((e) => e !== creatorEmail && cfg.assignees.includes(e));

    if (dryRun) return res.json({ dry_run: true, payload, rejected, autofilled, creator: creatorEmail, method: direct ? 'direct' : 'on-behalf', assign_to: assignList, will_set_status_assign: hasOtherAssignee });

    const key = `${creatorEmail}|${payload.project || ''}|${String(payload.subject || '').trim().toLowerCase()}`;
    const last = recentCreates.get(key);
    if (last && Date.now() - last < 2 * 60 * 1000 && !(req.body && req.body.force)) {
      return res.status(409).json({ error: 'Ticket cùng Project + Subject vừa được tạo cách đây dưới 2 phút (nghi tạo trùng).', duplicate: true });
    }

    let doc, method, warning = null;
    if (direct) {
      doc = await erp.createTicket(payload);
      method = 'direct';
    } else {
      ({ doc, method, warning } = await erp.createTicketOnBehalf(payload, creatorEmail));
    }
    recentCreates.set(key, Date.now());
    createdTickets.set(doc.name, Date.now());
    let assignInfo = null, assignWarning = null, statusSet = null;
    if (assignList.length) {
      try {
        assignInfo = await erp.assignTicket(doc.name, assignList, String(payload.subject || ''));
        if (hasOtherAssignee) statusSet = await erp.setAssignStatus(doc.name);
      } catch (e) {
        console.error('[erp/assign] lỗi:', e.message);
        assignWarning = `Ticket đã tạo nhưng chưa giao được cho ${assignList.join(', ')}: ${e.message}`;
      }
    }
    console.log(`[erp/tickets] ${req.session && req.session.username ? req.session.username : 'user'} đã tạo ${doc.name} (${payload.project}), người tạo ${creatorEmail} (${method})${assignList.length ? ', giao ' + assignList.join(', ') + (statusSet ? ' (Status ' + statusSet + ')' : '') : ''}`);
    res.json({ ok: true, name: doc.name, url: `${erp.getBaseUrl()}/app/ticket/${encodeURIComponent(doc.name)}`, doc, creator: creatorEmail, method, warning, autofilled, assigned_to: assignInfo ? assignList : [], status_set: statusSet, assign_warning: assignWarning });
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
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL và ERP_API_KEY/ERP_API_SECRET hoặc ERP_USER/ERP_PASS).',
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
      error: 'Server chưa cấu hình kết nối ERP (thiếu ERP_BASE_URL và ERP_API_KEY/ERP_API_SECRET hoặc ERP_USER/ERP_PASS).',
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

/* ---------- API: Case Hỗ Trợ (thư viện case thường gặp: mô tả sự cố, nguyên nhân, câu lệnh SQL / kiểm tra PROC, cách xử lý, hình ảnh) ----------
   GET    /api/support-cases                       → { cases:[{id, project, title, symptom, cause, solution, module (API|BO|APP|Manager), sql/tags (case cũ), images:[{id,name,size,assetId,...}], ...}], modules, githubBacked }
   POST   /api/support-cases                       (có id = sửa, không id = thêm) → { case, commitUrl }
   DELETE /api/support-cases/:id
   POST   /api/support-cases/upload                (multipart, field "file") → { file } để gắn vào case rồi Lưu; DELETE /api/support-cases/upload/:assetId → bỏ ảnh chưa lưu
   GET    /api/support-cases/:id/file/:fileId      → xem/tải ảnh (cần đăng nhập)
   Dữ liệu ghi qua listStore (GitHub nếu đã cấu hình GITHUB_TOKEN/GITHUB_REPO — mỗi lần lưu là 1 commit — ngược lại ./data/support-cases.json); ảnh lưu ở GitHub Releases (xem supportCasesStore.js / envFiles.js). */
app.get('/api/support-cases', requireAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const cases = await supportCases.readAll();
    res.json({ cases, modules: supportCases.MODULES, githubBacked: supportCases.isGithubBacked() });
  } catch (e) {
    console.error('[support-cases:get] lỗi:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/support-cases', requireAuth, async (req, res) => {
  try {
    const result = await supportCases.upsert(req.body || {}, req.session.username);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[support-cases:post] lỗi:', e.message);
    res.status(400).json({ error: e.message });
  }
});

const caseUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: supportCases.images.MAX_BYTES, files: 1 } }).single('file');
app.post('/api/support-cases/upload', requireAuth, (req, res) => {
  caseUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File lớn hơn 20MB — hãy giảm dung lượng ảnh.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file.' });
    try {
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); // multer đọc tên theo latin1 → đổi lại UTF-8
      res.json({ ok: true, file: await supportCases.images.save(req.file.buffer, name, req.session.username) });
    } catch (e) { console.error('[support-cases:upload] lỗi:', e.message); res.status(400).json({ error: e.message }); }
  });
});
app.delete('/api/support-cases/upload/:assetId', requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await supportCases.discardUpload(req.params.assetId)) }); }
  catch (e) { console.error('[support-cases:discard] lỗi:', e.message); res.status(400).json({ error: e.message }); }
});
app.get('/api/support-cases/:id/file/:fileId', requireAuth, async (req, res) => {
  try {
    const f = await supportCases.findImage(req.params.id, req.params.fileId);
    if (!f) return res.status(404).json({ error: 'Không tìm thấy file (có thể đã bị xoá).' });
    await require('./envFiles').sendFile(supportCases.images, res, f);
  } catch (e) { console.error('[support-cases:file] lỗi:', e.message); if (!res.headersSent) res.status(502).json({ error: e.message }); }
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
