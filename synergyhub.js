'use strict';
/* SynergyHub (erp.hqsoft.vn/synergyhub) — lấy danh sách dự án + giờ công để tính "Lợi nhuận Crs".
   SynergyHub chạy trên cùng máy chủ Frappe/ERP nên gọi được bằng tài khoản ERP đã cấu hình (erpClient.callMethod):
   - synergyhub.api.projects.get_filtered_projects            → danh sách dự án
   - synergyhub.api.reports.get_detail_time_log_report        → giờ công (from_date, to_date, project, employee, department, activity_type, approval_status)
   Chưa có tài liệu cấu trúc phản hồi nên module này TỰ DÒ: tìm mảng dòng dữ liệu (dạng Frappe report {columns,result} hoặc mảng object)
   và tìm cột theo tên (Designation / Employee / Hours / ngày). Luôn trả kèm `diagnostics` để nhìn ra cột nào được nhận, cột nào không. */

const METHODS = {
  projects: 'synergyhub.api.projects.get_filtered_projects',
  timeLogs: 'synergyhub.api.reports.get_detail_time_log_report',
};

/** Chuẩn hoá tên cột/khoá: bỏ dấu tiếng Việt, chữ thường, ký tự lạ → "_". */
const key = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const ARRAY_KEYS = ['result', 'data', 'rows', 'items', 'projects', 'time_logs', 'timelogs', 'logs', 'records', 'message'];
function isRowsArray(a) { return Array.isArray(a) && a.every((r) => r && typeof r === 'object'); }

/** Tìm mảng dòng dữ liệu (+ danh sách cột nếu có) trong phản hồi bất kỳ. */
function findRows(msg, depth = 0) {
  if (msg == null || depth > 4) return null;
  if (Array.isArray(msg)) return isRowsArray(msg) ? { columns: null, rows: msg, shape: 'array' } : null;
  if (typeof msg !== 'object') return null;
  const cols = Array.isArray(msg.columns) ? msg.columns : null;
  for (const k of ARRAY_KEYS) {
    if (Array.isArray(msg[k]) && isRowsArray(msg[k])) return { columns: cols, rows: msg[k], shape: `object.${k}${cols ? '+columns' : ''}` };
  }
  for (const k of [...ARRAY_KEYS, ...Object.keys(msg)]) {
    if (msg[k] && typeof msg[k] === 'object' && !Array.isArray(msg[k])) {
      const r = findRows(msg[k], depth + 1);
      if (r) return { ...r, shape: `${k}.${r.shape}` };
    }
  }
  return null;
}

/** Dòng dạng mảng (khớp thứ tự columns) hoặc object → object với khoá đã chuẩn hoá. */
function toObjects({ columns, rows }) {
  return rows.map((r) => {
    const o = {};
    if (Array.isArray(r)) {
      (columns || []).forEach((c, i) => {
        const fn = typeof c === 'string' ? c : (c.fieldname || c.label || '');
        const lb = typeof c === 'string' ? c : (c.label || c.fieldname || '');
        if (o[key(fn)] === undefined) o[key(fn)] = r[i];
        if (o[key(lb)] === undefined) o[key(lb)] = r[i];
      });
    } else {
      for (const [k, v] of Object.entries(r)) if (v == null || typeof v !== 'object') o[key(k)] = v;
    }
    return o;
  });
}

const isEmpty = (v) => v == null || String(v).trim() === '';
function pick(o, names) { for (const n of names) if (o[n] !== undefined && !isEmpty(o[n])) return { name: n, value: o[n] }; return null; }
function firstKeyPresent(objs, names) { for (const n of names) if (objs.some((o) => o[n] !== undefined && !isEmpty(o[n]))) return n; return null; }

function toHours(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const hm = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60 + Number(hm[3] || 0) / 3600;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function monthKeyOf(v) {
  if (v == null) return '';
  if (typeof v === 'number') { const d = new Date(v > 1e12 ? v : v * 1000); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 7); }
  const s = String(v);
  let m = s.match(/(\d{4})-(\d{2})-\d{2}/); if (m) return `${m[1]}-${m[2]}`;
  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}`;
  return '';
}

const DESIGNATION = ['designation', 'employee_designation', 'position', 'job_title', 'job_position', 'chuc_danh', 'role', 'employee_level', 'level'];
const EMPLOYEE = ['employee_name', 'employee', 'full_name', 'member', 'member_name', 'user_name', 'user', 'nhan_vien', 'owner'];
const HOURS = ['hours', 'hour', 'total_hours', 'logged_hours', 'log_hours', 'spent_hours', 'working_hours', 'work_hours', 'time_logged', 'hrs', 'so_gio'];
const HOURS_WEAK = ['duration', 'time_spent', 'time'];
const DATE = ['from_time', 'start_time', 'log_date', 'work_date', 'logged_date', 'date', 'posting_date', 'start_date', 'time_log_date', 'started_at', 'created_at', 'creation'];

/** Giờ công → [{designation, employee, hours, monthKey}] + diagnostics. */
function normalizeTimeLogs(msg) {
  const found = findRows(msg);
  const diagnostics = { shape: found ? found.shape : 'không tìm thấy mảng dữ liệu', sourceRows: 0, columns: [], detected: {}, sample: null, skipped: 0, designationMissing: false, topKeys: msg && typeof msg === 'object' ? Object.keys(msg).slice(0, 15) : [] };
  if (!found) return { rows: [], diagnostics };
  const objs = toObjects(found);
  diagnostics.columns = [...new Set(objs.flatMap((o) => Object.keys(o)))].slice(0, 60);
  diagnostics.sample = objs[0] || null;
  const dKey = firstKeyPresent(objs, DESIGNATION); const eKey = firstKeyPresent(objs, EMPLOYEE);
  const hKey = firstKeyPresent(objs, HOURS) || firstKeyPresent(objs, HOURS_WEAK); const tKey = firstKeyPresent(objs, DATE);
  diagnostics.detected = { designation: dKey, employee: eKey, hours: hKey, date: tKey, hoursIsWeakGuess: Boolean(hKey && HOURS_WEAK.includes(hKey)) };
  diagnostics.designationMissing = !dKey;
  const rows = [];
  for (const o of objs) {
    const label = String(o[eKey] ?? o[dKey] ?? Object.values(o)[0] ?? '').trim().toLowerCase();
    if (label === 'total' || label === 'tổng' || label === 'tong') continue;
    diagnostics.sourceRows++;
    const hours = hKey ? toHours(o[hKey]) : 0;
    const monthKey = tKey ? monthKeyOf(o[tKey]) : '';
    const designation = String((dKey ? o[dKey] : null) ?? (eKey ? o[eKey] : '') ?? '').trim(); // thiếu chức danh → dùng tên nhân viên để người dùng map cấp bậc
    if (!designation || !hours || !monthKey) { diagnostics.skipped++; continue; }
    rows.push({ designation, employee: eKey ? String(o[eKey] ?? '') : '', hours, monthKey });
  }
  return { rows, diagnostics };
}

/** Danh sách dự án → [{value, id, label, type, status}] + diagnostics. `value` là giá trị gửi vào tham số `project` của báo cáo. */
function normalizeProjects(msg) {
  const found = findRows(msg);
  const diagnostics = { shape: found ? found.shape : 'không tìm thấy mảng dữ liệu', total: 0, keys: [], sample: null, topKeys: msg && typeof msg === 'object' ? Object.keys(msg).slice(0, 15) : [] };
  if (!found) return { projects: [], diagnostics };
  const objs = toObjects(found);
  diagnostics.total = objs.length; diagnostics.keys = Object.keys(objs[0] || {}).slice(0, 60); diagnostics.sample = objs[0] || null;
  const seen = new Set(); const projects = [];
  for (const o of objs) {
    const label = pick(o, ['project_name', 'title', 'name', 'project']); const id = pick(o, ['name', 'project_id', 'id', 'project']);
    if (!label) continue;
    const value = String(label.value).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const type = pick(o, ['project_type', 'type']); const status = pick(o, ['status', 'project_status']);
    projects.push({ value, id: id ? String(id.value) : value, label: value, type: type ? String(type.value) : '', status: status ? String(status.value) : '' });
  }
  projects.sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  return { projects, diagnostics };
}

module.exports = { METHODS, findRows, toObjects, normalizeTimeLogs, normalizeProjects, key };
