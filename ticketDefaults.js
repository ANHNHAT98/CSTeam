/* Tự điền các trường "cố định" khi tạo ticket, để file md/AI chỉ cần điền phần phụ thuộc nội dung.
   Thứ tự (chỉ điền khi trường đang trống):
   1) fetch_from của ERP  — vd Customer lấy từ Project (đọc từ cấu trúc DocType Ticket, không hard-code)
   2) ERP_TICKET_DEFAULTS — mặc định do bạn đặt trên Render, theo dự án, vd Contact Role
   3) Estimated Deadline  — tính theo Priority, chỉ đếm ngày làm việc (bỏ T7/CN và ngày lễ), 17:30
   Tắt tự tính deadline: ERP_AUTO_DEADLINE=0. */

// Ngày nghỉ lễ rơi vào T2–T6 (YYYY-MM-DD). Giữ đồng bộ với HOLIDAYS trong các trang SLA khi cập nhật lịch mới.
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-04-07', '2025-04-30', '2025-05-01', '2025-09-01', '2025-09-02',
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-04-27', '2026-04-30', '2026-05-01', '2026-09-01', '2026-09-02', '2026-11-24',
  '2027-01-01', '2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-04-16', '2027-04-30', '2027-05-03', '2027-09-02', '2027-09-03', '2027-11-24',
]);

// Số ngày làm việc cộng thêm theo Priority (Critical = trong ngày, nếu hôm nay không phải ngày làm việc thì ngày làm việc kế tiếp)
const DEADLINE_OFFSET = { critical: 0, urgent: 1, high: 2, medium: 3, low: 5 };

// Khoá JSON gọn -> nhãn trên form ERP (dùng cho ERP_TICKET_DEFAULTS)
const KEY_TO_LABEL = {
  customer: 'Customer', contact_role: 'Contact Role', contact: 'Contact', contact_temp: 'Contact (Temp)',
  raised_by: 'Raised By (Email)', region: 'Region', internal_request_type: 'Internal Request Type',
  request_type: 'Request Type', priority: 'Priority', status: 'Status', series: 'Series',
};

function vnToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function isWorkday(d) {
  const g = d.getUTCDay();
  return g !== 0 && g !== 6 && !HOLIDAYS.has(d.toISOString().slice(0, 10));
}

function addWorkingDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (n === 0) {
    while (!isWorkday(d)) d.setUTCDate(d.getUTCDate() + 1);
  } else {
    let c = 0;
    while (c < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (isWorkday(d)) c++;
    }
  }
  return d.toISOString().slice(0, 10);
}

function deadlineFor(priority, today = vnToday()) {
  const k = String(priority || '').trim().toLowerCase();
  if (!(k in DEADLINE_OFFSET)) return null;
  return `${addWorkingDays(today, DEADLINE_OFFSET[k])} 17:30:00`;
}

function parseDefaults() {
  const raw = process.env.ERP_TICKET_DEFAULTS;
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('phải là object');
    return j;
  } catch (e) {
    console.error('[erp] ERP_TICKET_DEFAULTS không hợp lệ, bỏ qua:', e.message);
    return {};
  }
}
const ENV_DEFAULTS = parseDefaults();
const AUTO_DEADLINE = !/^(0|false|no|off)$/i.test(String(process.env.ERP_AUTO_DEADLINE || '1').trim());

function findField(meta, keyOrLabel) {
  const k = String(keyOrLabel).trim().toLowerCase();
  const label = (KEY_TO_LABEL[k] || keyOrLabel).trim().toLowerCase();
  return meta.fields.find((f) => f.label.trim().toLowerCase() === label) || meta.fields.find((f) => f.fieldname === k) || null;
}

/** Điền các trường đang trống vào `payload` (sửa trực tiếp). Trả về [{fieldname,label,value,source}]. */
async function applyTicketDefaults(payload, meta, erp, today) {
  const filled = [];
  const set = (f, value, source) => { payload[f.fieldname] = value; filled.push({ fieldname: f.fieldname, label: f.label, value, source }); };
  const empty = (f) => payload[f.fieldname] === undefined;

  // 1) fetch_from (vd Customer <- Project)
  for (const f of meta.fields) {
    if (!f.fetch_from || f.read_only || !empty(f)) continue;
    const [linkName, target] = f.fetch_from.split('.');
    const linkField = meta.fields.find((x) => x.fieldname === linkName && x.fieldtype === 'Link');
    const linkVal = payload[linkName];
    if (!linkField || !linkVal || !target) continue;
    try {
      const v = await erp.getLinkedValue(linkField.options, linkVal, target);
      if (v) set(f, v, `lấy từ ${linkField.label || linkName}`);
    } catch (e) { console.error('[erp/defaults] fetch_from lỗi:', e.message); }
  }

  // 1b) Customer lấy từ Project nếu ERP không khai báo fetch_from
  const projectField = findField(meta, 'Project');
  const customerField = findField(meta, 'Customer');
  if (customerField && projectField && empty(customerField) && !customerField.read_only && payload[projectField.fieldname] && projectField.options) {
    try {
      const v = await erp.getLinkedValue(projectField.options, payload[projectField.fieldname], 'customer');
      if (v) set(customerField, v, 'lấy từ Project');
    } catch (e) { /* Project không có trường customer: bỏ qua */ }
  }

  // 1c) Contact: nếu có email người báo và ERP có đúng 1 Contact trùng email thì tự chọn
  const contactField = findField(meta, 'Contact');
  const raisedField = findField(meta, 'Raised By (Email)');
  if (contactField && raisedField && !contactField.read_only && empty(contactField) && payload[raisedField.fieldname] && contactField.options) {
    try {
      const list = (await erp.suggestContacts({ doctype: contactField.options, email: String(payload[raisedField.fieldname]).trim() })).filter((x) => x.match === 'email');
      if (list.length === 1) set(contactField, list[0].value, 'khớp email người liên hệ');
    } catch (e) { console.error('[erp/defaults] khớp Contact lỗi:', e.message); }
  }

  // 2) ERP_TICKET_DEFAULTS: {"*":{...},"ABI_eSales_Support":{"contact_role":"HO"}}
  const proj = projectField ? payload[projectField.fieldname] : '';
  const merged = { ...(ENV_DEFAULTS['*'] || {}), ...((proj && ENV_DEFAULTS[proj]) || {}) };
  for (const [k, v] of Object.entries(merged)) {
    const f = findField(meta, k);
    if (f && !f.read_only && empty(f) && v !== '' && v != null) set(f, v, 'mặc định cấu hình');
  }

  // 3) Estimated Deadline theo Priority
  const dl = findField(meta, 'Estimated Deadline');
  if (AUTO_DEADLINE && dl && !dl.read_only && empty(dl)) {
    const prioField = findField(meta, 'Priority');
    const prio = payload[prioField && prioField.fieldname] || (prioField && prioField.default) || '';
    const d = deadlineFor(prio, today);
    if (d) set(dl, d, `tính theo Priority ${prio} (ngày làm việc, trừ lễ)`);
  }
  return filled;
}

module.exports = { applyTicketDefaults, deadlineFor, addWorkingDays, HOLIDAYS };
