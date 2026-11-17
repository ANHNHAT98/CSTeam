'use strict';
/* KPI CS01 / CS02 — dự án ABI: dữ liệu vẫn lấy từ ERP, nhưng NGƯỠNG + khung giờ tính theo bảng cam kết SLA trên Jira
   (trang /tickets/sla-jira-abi): P1/P2/S1 tính 24/7; P3/P4/S2/S3 chỉ tính T2–T6 08:00–17:30.
   Cấu hình ở kpi-sla-config.json → "abiJira". ERP không có mã P1–S3 nên: tag [P1..P4]/[S1..S3] trong tiêu đề (nếu có) → ngược lại quy đổi
   Priority ERP (Critical/Urgent/High/Medium/Low) qua abiJira.priorityMap. */

const { HOLIDAYS } = require('./ticketDefaults');

const TAG_RE = /\[(P[1-4]|S[1-3])\]/i;
const isoDay = (d) => d.toISOString().slice(0, 10);

function abiCfg(config) { return (config && config.abiJira) || null; }
function isAbi(config, project) { const c = abiCfg(config); return Boolean(c) && c.project === project; }

/** Mã Jira (P1..S3) của ticket ABI, '' nếu không xác định được. */
function codeOf(config, { subject, priority }) {
  const c = abiCfg(config); if (!c) return '';
  const m = String(subject || '').match(TAG_RE);
  if (m) return m[1].toUpperCase();
  const key = Object.keys(c.priorityMap || {}).find((k) => k.toLowerCase() === String(priority || '').trim().toLowerCase());
  return key ? String(c.priorityMap[key]).toUpperCase() : '';
}

function thresholdOf(config, kind, code) {
  const c = abiCfg(config); const table = (kind === 'frt' ? c.frt : c.res) || {};
  const v = table[code];
  return typeof v === 'number' ? v : 7200; // mã lạ: 7200 phút như trang Jira (không fail oan)
}

/** Số phút SLA giữa 2 mốc (Date dạng "giờ VN trong getter UTC", cùng quy ước customerReport.js). */
function minutesBetween(config, code, start, end) {
  const c = abiCfg(config);
  if (!(end > start)) return 0;
  if ((c.calendar247 || []).includes(code)) return (end - start) / 60000;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  let total = 0;
  while (day.getTime() <= last) {
    const dow = day.getUTCDay();
    if (dow >= 1 && dow <= 5 && !(c.excludeHolidays && HOLIDAYS.has(isoDay(day)))) {
      const ws = new Date(day.getTime() + c.workStartMin * 60000); const we = new Date(day.getTime() + c.workEndMin * 60000);
      const a = ws > start ? ws : start; const b = we < end ? we : end;
      if (b > a) total += (b - a) / 60000;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return total;
}

/** Cùng dạng kết quả với customerReport.slaOne: { minutes, threshold, result:'Đạt'|'Trượt'|'Đang chờ', done } (+ code). */
function slaAbi(config, t, kind, now) {
  if (!t.openDt) return null;
  const code = codeOf(config, t);
  const threshold = thresholdOf(config, kind, code);
  const target = kind === 'frt' ? t.frtDt : t.resolvedDt;
  if (target) { const m = minutesBetween(config, code, t.openDt, target); return { minutes: Math.round(m), threshold, result: m < threshold ? 'Đạt' : 'Trượt', done: true, code }; }
  const m = minutesBetween(config, code, t.openDt, now);
  return { minutes: Math.round(m), threshold, result: m >= threshold ? 'Trượt' : 'Đang chờ', done: false, code };
}

/** Dòng ghi chú hiện ở đầu trang khi có chọn dự án ABI. */
function note(projects, config, kpiKey) {
  const c = abiCfg(config); if (!c || !projects.includes(c.project)) return '';
  const table = kpiKey === 'firstResponse' ? c.frt : c.res;
  const fmtMin = (m) => (m % 60 === 0 ? `${m / 60}h` : `${m}p`);
  const map = Object.entries(c.priorityMap || {}).map(([k, v]) => `${k}→${v}`).join(', ');
  const th = Object.entries(table || {}).map(([k, v]) => `${k} ${fmtMin(v)}`).join(' · ');
  return `Dự án ABI: dữ liệu lấy từ ERP, nhưng ngưỡng theo bảng SLA Jira (${th}). P1/P2/S1 tính 24/7; P3/P4/S2/S3 tính T2–T6 08:00–17:30. Quy đổi Priority ERP → Jira: ${map} (tiêu đề có tag [P*]/[S*] thì ưu tiên tag).`;
}

module.exports = { isAbi, codeOf, slaAbi, minutesBetween, thresholdOf, note };
