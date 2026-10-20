'use strict';
/* KPI Team → CS01 "SLA Phản Hồi" (First Response) và CS02 "SLA Hoàn Tất" (Resolution Time), đánh giá THEO THÁNG cho 1 thành viên.
   - Thành viên: chọn trong danh sách người tạo ticket (ticket-creators.json → /api/erp/ticket-creators).
   - Ticket của thành viên: mặc định là ticket được GIAO cho người đó (_assign); có thể đổi sang ticket do người đó TẠO (owner).
   - Phạm vi: ticket có Opening On trong tháng, thuộc các dự án được chọn (mặc định AnVy + Merap).
   - Đúng/trượt SLA dùng đúng quy tắc của các trang SLA khác (customerReport.js → slaOne): ngưỡng theo Priority,
     Critical/Urgent tính giờ liên tục, mức khác tính giờ làm việc; ticket còn trong ngưỡng là "Đang chờ" và chưa tính vào mẫu số.
   - Actual = đúng SLA ÷ (đúng + trượt) × 100%. Progress nội suy theo Min/Target/Max của level; KPI Completion = Progress × trọng số.
   - Ngưỡng + trọng số theo level: kpi-sla-config.json (lấy từ file Master KPI). */

const fs = require('fs');
const path = require('path');
const { normalize, slaOne, vnNow } = require('./customerReport');
const { monthStartOf, monthEndOf, isMonthKey } = require('./customerReportMonthly');

const CONFIG_FILE = path.join(__dirname, 'kpi-sla-config.json');
function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }

/** % hoàn thành (Progress) của KPI "Cao tốt" theo 4 mức của file Master KPI. actual/min/target/max cùng đơn vị (%). */
function progressOf(actual, { min, target, max }) {
  if (actual == null || Number.isNaN(actual)) return null;
  if (actual < min) return { progress: 0, tier: 0, band: 'Chưa đạt Min' };
  if (max > target && actual >= max) return { progress: 150, tier: 3, band: 'Vượt Max' };
  if (actual >= target) return max > target
    ? { progress: 100 + (50 * (actual - target)) / (max - target), tier: 2, band: 'Từ Target đến Max' }
    : { progress: 100, tier: 2, band: 'Đạt Target' };
  return { progress: 50 + (50 * (actual - min)) / (target - min), tier: 1, band: 'Từ Min đến dưới Target' };
}

const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };

/**
 * rows: ticket ERP (có thể trùng, đã lọc theo dự án + tháng ở truy vấn; vẫn lọc lại ở đây cho chắc).
 * by: 'assign' (người xử lý) | 'owner' (người tạo).
 */
function evaluateMember(rows, { month, projects, member, by = 'assign', level, kpiKey, config, now = vnNow() }) {
  const kpi = config.kpis[kpiKey];
  const ms = monthStartOf(month); const me = monthEndOf(month);
  const who = lc(member); const seen = new Set(); const tickets = [];
  for (const r of rows || []) {
    if (!r || !r.name || seen.has(r.name)) continue;
    seen.add(r.name);
    if (!projects.includes(r.project)) continue;
    const t = normalize(r);
    if (!(t.openDay >= ms && t.openDay <= me)) continue;
    const mine = by === 'owner' ? lc(r.owner) === who : t.assign.some((a) => lc(a) === who);
    if (!mine) continue;
    const sla = slaOne(t, kpiKey === 'firstResponse' ? 'frt' : 'res', now);
    tickets.push({
      name: t.name, project: r.project, subject: t.subject, priority: t.priority, status: t.status,
      opening: t.opening, firstResponded: t.firstResponded, resolvedAt: t.resolvedStr, owner: r.owner || '', assign: t.assign.join(', '),
      result: sla ? sla.result : '', minutes: sla ? sla.minutes : null, threshold: sla ? sla.threshold : null,
    });
  }
  tickets.sort((a, b) => String(a.opening).localeCompare(String(b.opening)));

  const pass = tickets.filter((t) => t.result === 'Đạt').length;
  const fail = tickets.filter((t) => t.result === 'Trượt').length;
  const pending = tickets.filter((t) => t.result === 'Đang chờ').length;
  const decided = pass + fail;
  const th = kpi.thresholds[level]; const weight = kpi.weights[level];
  const applicable = Boolean(th) && weight != null;
  const actual = decided ? round((pass / decided) * 100, 4) : null;
  const p = applicable ? progressOf(actual, th) : null;

  const byProject = {};
  for (const t of tickets) {
    const o = byProject[t.project] || (byProject[t.project] = { total: 0, pass: 0, fail: 0, pending: 0 });
    o.total++; if (t.result === 'Đạt') o.pass++; else if (t.result === 'Trượt') o.fail++; else o.pending++;
  }
  return {
    month: { key: month, start: ms, end: me },
    member, by, level, projects,
    kpi: { key: kpiKey, code: kpi.code, weight: applicable ? weight : null, thresholds: th || null, applicable },
    result: {
      total: tickets.length, pass, fail, pending, decided,
      actual, progress: p ? round(p.progress, 4) : null, tier: p ? p.tier : null, band: p ? p.band : '',
      points: p && applicable ? round((p.progress * weight) / 100, 4) : null,
    },
    byProject, tickets,
    meta: { rows: seen.size, generatedAt: new Date().toISOString() },
  };
}

module.exports = { loadConfig, progressOf, evaluateMember, isMonthKey };
