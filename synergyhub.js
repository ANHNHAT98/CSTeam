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
  // Tasks (trang SynergyHub → Tasks): hàm thật lấy từ lời gọi API của trang. Có thể ghi đè bằng biến môi trường SYNERGYHUB_TASKS_METHOD.
  tasks: 'synergyhub.api.dynamic_permissions.get_filtered_tasks_with_context',
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
      for (const [k, v] of Object.entries(r)) {
        if (v == null || typeof v !== 'object') o[key(k)] = v;
        else if (Array.isArray(v) && v.length && isRowsArray(v)) {
          // dòng cha (vd 1 nhân viên) chứa danh sách con (các time log) → giữ lại để mở rộng
          o.__children = (o.__children || []).concat(v.map((c) => { const co = {}; for (const [ck, cv] of Object.entries(c)) if (cv == null || typeof cv !== 'object') co[key(ck)] = cv; return co; }));
        }
      }
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

const HOURS_LIKE = /(hour|hrs|so_gio|gio_lam|man_hour)/; const HOURS_NOT = /(rate|cost|price|per_|billing|amount|target|expected|capacity)/;
const DATE_RE = /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/;
function allKeys(objs) { return [...new Set(objs.flatMap((o) => Object.keys(o)))].filter((k) => k !== '__children'); }
function hoursKeyLike(objs) { return allKeys(objs).find((k) => HOURS_LIKE.test(k) && !HOURS_NOT.test(k) && objs.some((o) => !isEmpty(o[k]) && toHours(o[k]) > 0)) || null; }
function dateKeyByValue(objs) {
  for (const k of allKeys(objs)) {
    const vals = objs.map((o) => o[k]).filter((v) => !isEmpty(v));
    if (vals.length && vals.filter((v) => DATE_RE.test(String(v))).length >= vals.length * 0.5) return k;
  }
  return null;
}
const DESIGNATION = ['designation', 'employee_designation', 'position', 'job_title', 'job_position', 'chuc_danh', 'role', 'employee_level', 'level'];
const EMPLOYEE = ['employee_name', 'employee', 'full_name', 'member', 'member_name', 'user_name', 'user', 'nhan_vien', 'owner'];
const HOURS = ['hours', 'hour', 'total_hours', 'logged_hours', 'log_hours', 'spent_hours', 'working_hours', 'work_hours', 'time_logged', 'hrs', 'so_gio'];
const HOURS_WEAK = ['duration', 'time_spent', 'time'];
const DATE = ['log_date', 'work_date', 'logged_date', 'time_log_date', 'date', 'posting_date', 'start_date', 'started_at', 'created_at', 'creation', 'from_time', 'start_time']; // from_time/start_time thường chỉ là giờ trong ngày → để cuối

/** Giờ công → [{designation, employee, hours, monthKey}] + diagnostics. */
function normalizeTimeLogs(msg, range = {}) {
  const found = findRows(msg);
  const diagnostics = { shape: found ? found.shape : 'không tìm thấy mảng dữ liệu', sourceRows: 0, columns: [], detected: {}, sample: null, skipped: 0, designationMissing: false, topKeys: msg && typeof msg === 'object' ? Object.keys(msg).slice(0, 15) : [] };
  if (!found) return { rows: [], diagnostics };
  let objs = toObjects(found);
  diagnostics.parentRows = objs.length;
  // dòng cha chứa danh sách time log con → mở thành từng time log, thừa hưởng chức danh/nhân viên của cha (bỏ các cột tổng giờ của cha)
  diagnostics.expandedChildren = objs.some((o) => o.__children && o.__children.length);
  objs = objs.flatMap((o) => {
    if (!o.__children || !o.__children.length) return [o];
    const parent = {}; for (const [k, v] of Object.entries(o)) if (k !== '__children' && !/(hour|hrs|duration|total|gio)/.test(k)) parent[k] = v;
    return o.__children.map((c) => ({ ...parent, ...c }));
  });
  diagnostics.columns = allKeys(objs).slice(0, 60);
  diagnostics.sample = objs[0] || null;
  const dKey = firstKeyPresent(objs, DESIGNATION); const eKey = firstKeyPresent(objs, EMPLOYEE);
  const hKey = firstKeyPresent(objs, HOURS) || hoursKeyLike(objs) || firstKeyPresent(objs, HOURS_WEAK);
  // cột ngày: thử lần lượt từng ứng viên TRÊN TỪNG DÒNG, lấy cột đầu tiên cho ra ngày hợp lệ (tránh chọn nhầm cột chỉ có giờ như from_time = "08:30:00")
  const dateCands = [...new Set([...DATE.filter((n) => objs.some((o) => o[n] !== undefined && !isEmpty(o[n]))), dateKeyByValue(objs)].filter(Boolean))];
  const monthOfRow = (o) => { for (const k of dateCands) { const m = monthKeyOf(o[k]); if (m) return m; } return ''; };
  const tKey = dateCands.find((k) => objs.some((o) => monthKeyOf(o[k]))) || dateCands[0] || null;
  diagnostics.detected = { designation: dKey, employee: eKey, hours: hKey, date: tKey, hoursIsWeakGuess: Boolean(hKey && HOURS_WEAK.includes(hKey)) };
  diagnostics.missing = { designation: 0, hours: 0, date: 0 };
  // Báo cáo không có cột ngày (chỉ có tổng giờ): nếu khoảng ngày nằm trong 1 tháng thì gán cả vào tháng đó
  const fromM = monthKeyOf(range.from_date); const toM = monthKeyOf(range.to_date);
  const fallbackMonth = !tKey && fromM && fromM === toM ? fromM : '';
  diagnostics.dateFallbackMonth = fallbackMonth || null;
  diagnostics.designationMissing = !dKey;
  const rows = [];
  for (const o of objs) {
    const label = String(o[eKey] ?? o[dKey] ?? Object.values(o)[0] ?? '').trim().toLowerCase();
    if (label === 'total' || label === 'tổng' || label === 'tong') continue;
    diagnostics.sourceRows++;
    const hours = hKey ? toHours(o[hKey]) : 0;
    const monthKey = monthOfRow(o) || (tKey ? '' : fallbackMonth);
    const designation = String((dKey ? o[dKey] : null) ?? (eKey ? o[eKey] : '') ?? '').trim(); // thiếu chức danh → dùng tên nhân viên để người dùng map cấp bậc
    if (!designation) diagnostics.missing.designation++;
    if (!hours) diagnostics.missing.hours++;
    if (!monthKey) diagnostics.missing.date++;
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

/** Các trường vô hướng của phản hồi (success, total, page, page_size…) kể cả trong 1 cấp lồng nhau — để dò phân trang và hiển thị chẩn đoán. */
function pageMeta(msg) {
  const m = {};
  if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
    for (const [k, v] of Object.entries(msg)) {
      if (v == null || typeof v !== 'object') m[k] = v;
      else if (!Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (v2 == null || typeof v2 !== 'object') m[`${k}.${k2}`] = v2;
    }
  }
  return m;
}
const TOTAL_KEYS = /(^|\.)(total|total_count|total_records|total_rows|total_items|count|total_results)$/;
function reportedTotal(meta) {
  for (const [k, v] of Object.entries(meta)) if (TOTAL_KEYS.test(k) && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  return null;
}

/**
 * Lấy HẾT các trang của 1 hàm SynergyHub. Tên tham số phân trang chưa biết nên gửi nhiều tên (Frappe tự bỏ tham số hàm không khai báo):
 * page/page_number/page_no, page_size/limit/per_page/page_length, offset/start (= số dòng đã lấy).
 * Dừng khi: hết dữ liệu, đủ tổng (nếu phản hồi báo total), trang trả về y hệt trang trước (hàm bỏ qua tham số trang), hoặc quá maxPages.
 * call(params) → trả về `message` của phản hồi.
 */
async function fetchAllPages(call, base, { pageSize = 500, maxPages = 100 } = {}) {
  const all = []; const info = { pages: 0, pageSizeAsked: pageSize, reportedTotal: null, meta: null, stopped: '' };
  let prevSig = null; let columns = null;
  for (let page = 1; page <= maxPages; page++) {
    const msg = await call({ ...base, page, page_number: page, page_no: page, page_size: pageSize, limit: pageSize, per_page: pageSize, page_length: pageSize, offset: all.length, start: all.length });
    const found = findRows(msg); const rows = found ? found.rows : [];
    if (page === 1) { info.meta = pageMeta(msg); info.reportedTotal = reportedTotal(info.meta); columns = found ? found.columns : null; if (!found) info.stopped = 'không tìm thấy mảng dữ liệu'; }
    if (!rows.length) { info.stopped = info.stopped || 'hết dữ liệu'; break; }
    const sig = `${rows.length}|${JSON.stringify(rows[0])}|${JSON.stringify(rows[rows.length - 1])}`;
    if (sig === prevSig) { info.stopped = 'trang trùng trang trước (hàm không nhận tham số trang)'; break; }
    prevSig = sig; all.push(...rows); info.pages = page;
    if (info.reportedTotal && all.length >= info.reportedTotal) { info.stopped = 'đủ tổng số dòng'; break; }
    if (!info.reportedTotal && rows.length < 100) { info.stopped = 'trang cuối'; break; }
    if (page === maxPages) info.stopped = `dừng ở ${maxPages} trang — có thể còn dữ liệu`;
  }
  info.fetched = all.length;
  return { message: columns ? { columns, result: all } : { data: all }, info };
}

/* ---------- Tasks (CS25 cách 2): task của thành viên, hạn dự kiến, ngày hoàn thành ---------- */
const T_TITLE = ['task_name', 'title', 'subject', 'task_title', 'name_of_task', 'task', 'name'];
const T_ID = ['task_id', 'id', 'name', 'task_code', 'code'];
const T_PROJECT = ['project_name', 'project', 'project_title', 'project_id'];
const T_ASSIGNEE = ['assignees', 'assigned_to', 'assignee', 'assigned_users', 'assigned_user', 'assignee_email', 'assigned_to_email', 'assigned_to_name', 'responsible', 'team_member', 'owner'];
const T_PLANNED = ['due_date', 'end_date', 'expected_end_date', 'planned_end_date', 'planned_end', 'deadline', 'target_date', 'estimated_end_date', 'exp_end_date', 'finish_date', 'exp_end', 'due'];
const T_DONE = ['completed_on', 'completed_date', 'completion_date', 'completed_at', 'actual_end_date', 'actual_end', 'closed_on', 'done_date', 'finished_on', 'date_completed', 'resolved_on'];
const T_DONE_APPROX = ['modified', 'updated_at', 'last_updated', 'date_modified'];
const T_STATUS = ['status', 'task_status', 'state'];
const T_DONE_STATUS = /^(completed|complete|done|closed|finished|resolved|hoan thanh|da hoan thanh)$/i;

function flatKeyMap(o) { const m = {}; for (const [k, v] of Object.entries(o || {})) { const nk = key(k); if (m[nk] === undefined) m[nk] = v; } return m; }
function firstVal(m, names) { for (const n of names) if (m[n] !== undefined && m[n] !== null && String(m[n]) !== '' && !(Array.isArray(m[n]) && !m[n].length)) return { k: n, v: m[n] }; return null; }
function peopleOf(v) {
  const out = [];
  const add = (x) => { if (x == null) return; if (typeof x === 'string' || typeof x === 'number') { for (const part of String(x).split(/[,;]/)) { const t = part.trim().toLowerCase(); if (t) out.push(t); } } else if (Array.isArray(x)) x.forEach(add); else if (typeof x === 'object') add(x.email || x.user || x.user_id || x.name || x.full_name || x.employee || x.username); };
  add(v); return [...new Set(out)];
}
const isoDay = (v) => { if (v == null) return ''; const s0 = String(v); let m = s0.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = s0.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); return m ? `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : ''; };

/** Phản hồi danh sách task → [{id, name, project, assignees:[email…], planned, done, doneApprox, status}] + diagnostics (cột nhận được, mẫu). */
function normalizeTasks(msg) {
  const found = findRows(msg);
  const diagnostics = { shape: found ? found.shape : 'không tìm thấy mảng dữ liệu', rows: 0, detected: {}, sample: null, noPlanned: 0, noAssignee: 0, topKeys: msg && typeof msg === 'object' ? Object.keys(msg).slice(0, 15) : [] };
  if (!found) return { tasks: [], diagnostics };
  const maps = found.rows.map((r) => flatKeyMap(Array.isArray(r) && found.columns ? Object.fromEntries(found.columns.map((c, i) => [typeof c === 'string' ? c : (c.fieldname || c.label), r[i]])) : r));
  diagnostics.rows = maps.length; diagnostics.sample = found.rows[0] || null;
  const present = (names) => names.find((n) => maps.some((m) => firstVal(m, [n]))) || null;
  const keys = { title: present(T_TITLE), id: present(T_ID), project: present(T_PROJECT), assignee: present(T_ASSIGNEE), planned: present(T_PLANNED), done: present(T_DONE), status: present(T_STATUS), doneApprox: present(T_DONE_APPROX) };
  diagnostics.detected = keys;
  const tasks = maps.map((m) => {
    const status = keys.status ? String(m[keys.status] ?? '').trim() : '';
    let done = keys.done ? isoDay(m[keys.done]) : ''; let approx = false;
    if (!done && T_DONE_STATUS.test(key(status).replace(/_/g, ' '))) { done = keys.doneApprox ? isoDay(m[keys.doneApprox]) : ''; approx = Boolean(done); }
    const planned = keys.planned ? isoDay(m[keys.planned]) : '';
    const assignees = keys.assignee ? peopleOf(m[keys.assignee]) : [];
    if (!planned) diagnostics.noPlanned++; if (!assignees.length) diagnostics.noAssignee++;
    const pv = keys.project ? m[keys.project] : '';
    return { id: String(keys.id ? m[keys.id] ?? '' : ''), name: String(keys.title ? m[keys.title] ?? '' : ''), project: String(pv && typeof pv === 'object' ? (pv.project_name || pv.name || pv.title || '') : (pv ?? '')), assignees, planned, done, doneApprox: approx, status, completedByStatus: T_DONE_STATUS.test(key(status).replace(/_/g, ' ')) };
  });
  return { tasks, diagnostics };
}

module.exports = { normalizeTasks, fetchAllPages, METHODS, findRows, toObjects, normalizeTimeLogs, normalizeProjects, key };
