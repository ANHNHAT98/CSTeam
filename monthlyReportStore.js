const fs = require('fs');
const path = require('path');

/**
 * Luu tru "Bao cao SLA hang thang" — day la du lieu KHACH HANG tong hop va gui vao cuoi
 * thang (file Jira_Monthly_Report_*.xlsx, sheet "Dashboard"), KHONG lay realtime tu Jira
 * API duoc (khach chi gui 1 lan/thang). Vi vay can luu lai thu cong (nhap tay hoac import
 * file) de tool co the theo doi xu huong qua cac thang.
 *
 * File luu tai DATA_DIR (mac dinh ./data — nen mount volume ngoai container de khong mat
 * du liệu khi container bi xoa/deploy lai, xem docker-compose.yml).
 */
const DATA_DIR = process.env.MONTHLY_REPORT_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'monthly-report.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function readAll() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[monthlyReportStore] Không đọc được file dữ liệu, trả về mảng rỗng:', e.message);
    return [];
  }
}

function writeAll(rows) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), 'utf8');
}

/** month dạng "YYYY-MM", project là mã dự án (vd "HQ"). Key duy nhất = month + project.
 *  Field nào KHÔNG có trong record (undefined) sẽ giữ nguyên giá trị cũ (nếu đang update) —
 *  tránh trường hợp sửa 1 ô rồi lỡ ghi đè trắng các ô còn lại thành null. */
function upsert(record) {
  const month = String(record.month || '').trim();
  const project = String(record.project || '').trim();
  if (!month || !project) throw new Error('Thiếu month hoặc project.');

  const rows = readAll();
  const idx = rows.findIndex((r) => r.month === month && r.project === project);
  const existing = idx >= 0 ? rows[idx] : null;

  const numField = (key) => (record[key] !== undefined ? numOrNull(record[key]) : (existing ? existing[key] : null));

  const clean = {
    month, project,
    totalReceived: numField('totalReceived'),
    totalDone: numField('totalDone'),
    stillOpen: numField('stillOpen'),
    avgFirstResponseH: numField('avgFirstResponseH'),
    firstResponseSlaMetPct: numField('firstResponseSlaMetPct'),
    avgResolutionH: numField('avgResolutionH'),
    resolutionSlaMetPct: numField('resolutionSlaMetPct'),
    note: record.note !== undefined ? String(record.note).slice(0, 500) : (existing ? existing.note : ''),
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) rows[idx] = clean;
  else rows.push(clean);

  rows.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : a.project.localeCompare(b.project)));
  writeAll(rows);
  return clean;
}

function remove(month, project) {
  const rows = readAll().filter((r) => !(r.month === month && r.project === project));
  writeAll(rows);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { readAll, upsert, remove };
