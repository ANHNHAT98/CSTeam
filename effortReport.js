'use strict';
/* Báo Cáo Effort: effort của từng thành viên = SỐ LƯỢNG ticket (ERP) và task (SynergyHub) được assign cho người đó trong khoảng ngày.
   Hàm thuần (không gọi ERP) để dễ kiểm tra; server.js lấy dữ liệu rồi gọi build().
   Thành viên được gộp theo phần tên trước "@" (không phân biệt hoa/thường) vì ERP dùng email còn SynergyHub có thể chỉ trả tên. */

const { slaMinutes } = require('./weeklyReport');
const DAY_MS = 86400000;
// Đánh giá theo % xử lý chung (ticket Closed + task xong) trên tổng được assign
const GRADES = [[80, 'Tốt'], [60, 'Khá'], [40, 'Trung bình'], [0, 'Cần cải thiện']];
const gradeOf = (rate) => (rate == null ? '—' : GRADES.find(([min]) => rate >= min)[1]);
const pct1 = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const parseNaive = (s) => { if (!s) return null; const d = new Date(`${String(s).trim().replace(' ', 'T').replace(/\.\d+$/, '')}Z`); return Number.isNaN(d.getTime()) ? null : d; };
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const mondayOf = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return isoDay(d); };
const keyOf = (s) => { const x = String(s || '').trim().toLowerCase(); return x.includes('@') ? x.split('@')[0] : x; };
const prioGroup = (p) => { const x = String(p || '').trim().toLowerCase(); return (x === 'critical' || x === 'urgent') ? 'p1' : x === 'high' ? 'high' : x === 'medium' ? 'medium' : 'low'; };
const emptyWeekly = (weeks) => Object.fromEntries(weeks.map((w) => [w, { tickets: 0, tasks: 0 }]));

/**
 * ticketPairs: [{ name, subject, project, status, priority, assignee, date, openedAt, resolvedAt }]  (mỗi cặp ticket–người được assign 1 lần; date = ngày được giao hoặc ngày mở; openedAt/resolvedAt để tính thời gian xử lý)
 * taskPairs:   [{ id, name, project, status, done, planned, assignee }]       (mỗi cặp task–người được assign 1 lần; planned = hạn dự kiến)
 */
function build({ ticketPairs = [], taskPairs = [], from, to, itemCap = 300 }) {
  const weeks = []; for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weeks.push(w);
  const members = new Map();
  const get = (assignee) => {
    const k = keyOf(assignee); if (!k) return null;
    let m = members.get(k);
    if (!m) { m = { key: k, name: k, email: String(assignee).includes('@') ? String(assignee).trim().toLowerCase() : '', tickets: { total: 0, closed: 0, open: 0, p1: 0, high: 0, medium: 0, low: 0 }, handling: { n: 0, minutes: 0 }, tasks: { total: 0, done: 0 }, total: 0, weekly: emptyWeekly(weeks), byProject: {}, items: [] }; members.set(k, m); }
    else if (!m.email && String(assignee).includes('@')) m.email = String(assignee).trim().toLowerCase();
    return m;
  };
  const bucket = (day) => { const w = mondayOf(day); return weeks.includes(w) ? w : null; };
  const seenT = new Set(); const seenK = new Set();

  for (const t of ticketPairs) {
    const m = get(t.assignee); if (!m) continue;
    const dedupe = `${m.key}|${t.name}`; if (seenT.has(dedupe)) continue; seenT.add(dedupe);
    const closed = String(t.status || '').trim() === 'Closed';
    m.tickets.total++; m.tickets[closed ? 'closed' : 'open']++; m.tickets[prioGroup(t.priority)]++;
    if (closed) { const o = parseNaive(t.openedAt); const r = parseNaive(t.resolvedAt); if (o && r && r >= o) { m.handling.n++; m.handling.minutes += slaMinutes(t.priority, o, r); } }
    const b = t.date ? bucket(t.date) : null; if (b) m.weekly[b].tickets++;
    const pj = t.project || '(không có)'; m.byProject[pj] = (m.byProject[pj] || 0) + 1;
    if (m.items.length < itemCap) m.items.push({ kind: 'ticket', id: t.name, title: t.subject || '', project: t.project || '', status: t.status || '', priority: t.priority || '', date: t.date || '' });
  }
  for (const t of taskPairs) {
    const m = get(t.assignee); if (!m) continue;
    const dedupe = `${m.key}|${t.id || t.name}`; if (seenK.has(dedupe)) continue; seenK.add(dedupe);
    const done = Boolean(t.done) || Boolean(t.completedByStatus);
    m.tasks.total++; if (done) m.tasks.done++;
    const b = t.planned ? bucket(t.planned) : null; if (b) m.weekly[b].tasks++;
    if (m.items.length < itemCap * 2) m.items.push({ kind: 'task', id: t.id || '', title: t.name || '', project: t.project || '', status: t.status || '', priority: '', date: t.planned || '' });
  }
  const list = [...members.values()].map((m) => {
    const total = m.tickets.total + m.tasks.total; const processed = m.tickets.closed + m.tasks.done; const rate = pct1(processed, total);
    return { ...m, total, processed, pending: total - processed, rate, ticketRate: pct1(m.tickets.closed, m.tickets.total), taskRate: pct1(m.tasks.done, m.tasks.total),
      avgHours: m.handling.n ? Math.round(m.handling.minutes / m.handling.n / 6) / 10 : null, grade: gradeOf(rate) };
  }).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const weekly = weeks.map((w) => ({ weekStart: w, weekEnd: addDays(w, 6), tickets: list.reduce((s, m) => s + m.weekly[w].tickets, 0), tasks: list.reduce((s, m) => s + m.weekly[w].tasks, 0) }));
  const distinctTickets = new Set(ticketPairs.map((t) => t.name)).size; const distinctTasks = new Set(taskPairs.map((t) => t.id || t.name)).size;
  return {
    members: list, weekly, weeks,
    totals: { processed: list.reduce((s, m) => s + m.processed, 0), assigned: list.reduce((s, m) => s + m.total, 0), rate: pct1(list.reduce((s, m) => s + m.processed, 0), list.reduce((s, m) => s + m.total, 0)), members: list.length, ticketAssigns: list.reduce((s, m) => s + m.tickets.total, 0), taskAssigns: list.reduce((s, m) => s + m.tasks.total, 0), distinctTickets, distinctTasks },
  };
}

module.exports = { build, keyOf, prioGroup, mondayOf, addDays, gradeOf, GRADES };
