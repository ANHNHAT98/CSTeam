'use strict';
/* Tính số liệu "Dashboard Support Tuần" của một dự án từ danh sách ticket ERP.
   - Tuần = Thứ 2 đến Chủ nhật (giờ Việt Nam). Ngày giờ ERP là chuỗi "YYYY-MM-DD HH:mm:ss" giờ VN, được đọc như
     "giờ không múi giờ" (UTC getter) nên kết quả không phụ thuộc múi giờ máy chủ.
   - SLA dùng cùng quy tắc với Dashboard Tổng Quan: Critical/Urgent tính 24h liên tục, các mức còn lại chỉ tính giờ làm
     việc T2–T6 08:00–12:00 và 13:30–17:30, trừ ngày lễ; ngưỡng (phút) và trọng số 70/30 giữ nguyên như dashboard. */

const { HOLIDAYS } = require('./ticketDefaults');

const BACKLOG_STATUSES = ['Open', 'Assign', 'Working', 'Reviewing', 'Waiting', 'Pending', 'Re-open'];
const STATUS_ORDER = [...BACKLOG_STATUSES, 'Closed'];
const PRIORITY_ORDER = ['Critical', 'Urgent', 'High', 'Medium', 'Low'];
// GIỮ ĐỒNG BỘ với SLA_THRESHOLD / SLA_DEFAULT_THRESHOLD trong public/index.html
const SLA_THRESHOLD = { critical: 60, urgent: 240, high: 480, medium: 4320 };
const SLA_DEFAULT_THRESHOLD = 7200;
const WORK_WINDOWS = [[8 * 60, 12 * 60], [13 * 60 + 30, 17 * 60 + 30]];
const DAY_MS = 86400000;

/* ---------- ngày giờ ---------- */
const isoDay = (d) => d.toISOString().slice(0, 10);
function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); }
function mondayOf(iso) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return isoDay(d); }
function parseNaive(s) {
  if (!s) return null;
  const d = new Date(`${String(s).trim().replace(' ', 'T').replace(/\.\d+$/, '')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const dayOf = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : '');
function vnNow() { return new Date(Date.now() + 7 * 3600 * 1000); } // các getter UTC của đối tượng này = giờ VN
function isoWeekNumber(iso) {
  const d = new Date(`${iso}T00:00:00Z`); const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - first) / DAY_MS - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}

/* ---------- SLA ---------- */
function businessMinutes(start, end) {
  if (!(end > start)) return 0;
  let total = 0;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (day.getTime() <= last) {
    const dow = day.getUTCDay();
    if (dow >= 1 && dow <= 5 && !HOLIDAYS.has(isoDay(day))) {
      for (const [s, e] of WORK_WINDOWS) {
        const ws = new Date(day.getTime() + s * 60000); const we = new Date(day.getTime() + e * 60000);
        const a = ws > start ? ws : start; const b = we < end ? we : end;
        if (b > a) total += (b - a) / 60000;
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return total;
}
const isP1 = (p) => ['critical', 'urgent'].includes(String(p || '').trim().toLowerCase());
function slaMinutes(priority, start, end) { return isP1(priority) ? Math.max(0, (end - start) / 60000) : businessMinutes(start, end); }
function thresholdOf(priority) { const k = String(priority || '').trim().toLowerCase(); return k in SLA_THRESHOLD ? SLA_THRESHOLD[k] : SLA_DEFAULT_THRESHOLD; }

/* ---------- chuẩn hoá ticket ---------- */
function parseAssign(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(Boolean) : []; } catch (_) { return []; }
}
function normalize(r) {
  const status = String(r.status || '').trim();
  const resolvedStr = r.resolution_date || (status === 'Closed' ? r.modified : '') || '';
  const opening = r.opening_date || r.creation || '';
  return {
    name: r.name, subject: r.subject || '', status, priority: String(r.priority || '').trim() || '(không có)',
    requestType: r.request_type || '', opening, openDay: dayOf(opening), openDt: parseNaive(opening),
    frtDt: parseNaive(r.first_responded_on), resolvedStr, resolvedDay: dayOf(resolvedStr), resolvedDt: parseNaive(resolvedStr),
    assign: parseAssign(r._assign),
  };
}
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const round1 = (x) => Math.round(x * 10) / 10;
const prioRank = (p) => { const i = PRIORITY_ORDER.findIndex((x) => x.toLowerCase() === String(p).toLowerCase()); return i < 0 ? 99 : i; };

/** Tồn đọng tại cuối ngày D: đã mở tới D và chưa xử lý xong tới D. Nếu D là hôm nay/tương lai thì dùng trạng thái hiện tại. */
function isBacklogAt(t, D, today) {
  if (!t.openDay || t.openDay > D) return false;
  if (D >= today) return BACKLOG_STATUSES.includes(t.status);
  return !t.resolvedDay || t.resolvedDay > D;
}

/** SLA của các ticket mở trong tuần. kind = 'frt' (First Responded On) hoặc 'res' (Resolution Date). */
function slaFor(items, kind, now) {
  const rows = [];
  for (const t of items) {
    const target = kind === 'frt' ? t.frtDt : t.resolvedDt;
    const th = thresholdOf(t.priority);
    if (!t.openDt) continue;
    let minutes; let result;
    if (target) { minutes = slaMinutes(t.priority, t.openDt, target); result = minutes < th ? 'Pass' : 'Fail'; }
    else { minutes = slaMinutes(t.priority, t.openDt, now); result = minutes >= th ? 'Fail' : 'Pending'; } // chưa có mốc: quá hạn = Fail, còn trong hạn = đang chờ
    rows.push({ t, minutes, result, th, done: Boolean(target) });
  }
  const decided = rows.filter((x) => x.result !== 'Pending');
  const g1 = decided.filter((x) => isP1(x.t.priority)); const g2 = decided.filter((x) => !isP1(x.t.priority));
  const rate = (g) => (g.length ? pct(g.filter((x) => x.result === 'Pass').length, g.length) : 100);
  const doneRows = rows.filter((x) => x.done);
  return {
    total: decided.length, pass: decided.filter((x) => x.result === 'Pass').length, fail: decided.filter((x) => x.result === 'Fail').length,
    pending: rows.length - decided.length,
    passRate: decided.length ? round1(pct(decided.filter((x) => x.result === 'Pass').length, decided.length)) : null,
    weighted: decided.length ? round1(rate(g1) * 0.7 + rate(g2) * 0.3) : null,
    p1: { total: g1.length, pass: g1.filter((x) => x.result === 'Pass').length }, p2: { total: g2.length, pass: g2.filter((x) => x.result === 'Pass').length },
    avgMinutes: doneRows.length ? Math.round(doneRows.reduce((s, x) => s + x.minutes, 0) / doneRows.length) : null,
    failList: rows.filter((x) => x.result === 'Fail').sort((a, b) => prioRank(a.t.priority) - prioRank(b.t.priority) || b.minutes - a.minutes).slice(0, 10)
      .map((x) => ({ name: x.t.name, subject: x.t.subject, priority: x.t.priority, minutes: Math.round(x.minutes), threshold: x.th, done: x.done })),
  };
}

function countBy(list, keyFn, order) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x) || '(không có)'; m.set(k, (m.get(k) || 0) + 1); }
  const keys = [...m.keys()];
  if (order) keys.sort((a, b) => { const ia = order.indexOf(a); const ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || m.get(b) - m.get(a); });
  else keys.sort((a, b) => m.get(b) - m.get(a));
  return keys.map((k) => ({ label: k, count: m.get(k) }));
}

/**
 * rows: danh sách ticket ERP (có thể trùng, sẽ khử trùng theo name).
 * Trả về toàn bộ số liệu cho tuần chứa `weekStart` + xu hướng `weeks` tuần gần nhất.
 */
function buildWeeklyReport(rows, { project = '', weekStart, weeks = 8, now = vnNow() } = {}) {
  const today = isoDay(now);
  const ws = mondayOf(weekStart || today); const we = addDays(ws, 6);
  const snapDay = we < today ? we : today; // ngày chốt số tồn đọng của tuần đang xem
  const seen = new Set(); const T = [];
  for (const r of rows || []) { if (!r || !r.name || seen.has(r.name)) continue; seen.add(r.name); T.push(normalize(r)); }

  const inWeek = (day, s, e) => day && day >= s && day <= e;
  const opened = T.filter((t) => inWeek(t.openDay, ws, we));
  const resolved = T.filter((t) => inWeek(t.resolvedDay, ws, we));

  // xu hướng nhiều tuần
  const trendStart = addDays(ws, -7 * (weeks - 1)); const trend = [];
  for (let k = 0; k < weeks; k++) {
    const s = addDays(trendStart, 7 * k); const e = addDays(s, 6); const snap = e < today ? e : today;
    trend.push({
      weekStart: s, weekEnd: e, week: isoWeekNumber(s),
      opened: T.filter((t) => inWeek(t.openDay, s, e)).length,
      closed: T.filter((t) => inWeek(t.resolvedDay, s, e)).length,
      backlog: s > today ? null : T.filter((t) => isBacklogAt(t, snap, today)).length,
    });
  }
  const cur = trend[trend.length - 1]; const prev = trend[trend.length - 2] || null;

  const frt = slaFor(opened, 'frt', now); const res = slaFor(opened, 'res', now);
  const resolutionMinutes = resolved.filter((t) => t.openDt && t.resolvedDt).map((t) => slaMinutes(t.priority, t.openDt, t.resolvedDt));
  const backlogRows = T.filter((t) => isBacklogAt(t, snapDay, today));

  const byDay = [];
  for (let d = 0; d < 7; d++) {
    const day = addDays(ws, d);
    byDay.push({ date: day, opened: T.filter((t) => t.openDay === day).length, resolved: T.filter((t) => t.resolvedDay === day).length });
  }

  // tải công việc theo người xử lý (tồn đọng hiện tại)
  const load = new Map();
  for (const t of T.filter((x) => BACKLOG_STATUSES.includes(x.status))) {
    for (const a of (t.assign.length ? t.assign : ['(chưa giao)'])) {
      const o = load.get(a) || { assignee: a, total: 0, p1: 0, high: 0, other: 0 };
      o.total++; if (isP1(t.priority)) o.p1++; else if (String(t.priority).toLowerCase() === 'high') o.high++; else o.other++;
      load.set(a, o);
    }
  }

  const reqTop = countBy(opened, (t) => t.requestType);
  const requestTypes = reqTop.length > 8 ? [...reqTop.slice(0, 8), { label: 'Khác', count: reqTop.slice(8).reduce((s, x) => s + x.count, 0) }] : reqTop;
  const ageDays = (t) => Math.max(0, Math.round((new Date(`${snapDay}T00:00:00Z`) - new Date(`${t.openDay}T00:00:00Z`)) / DAY_MS));
  const warnings = [];
  if (!T.length) warnings.push('Không có ticket nào của dự án trong dữ liệu ERP trả về.');
  if (T.length && !T.some((t) => t.frtDt)) warnings.push('Không có ticket nào có First Responded On — SLA phản hồi sẽ chỉ tính các ticket quá hạn.');

  return {
    project,
    week: { start: ws, end: we, number: isoWeekNumber(ws), today, isCurrent: ws <= today && today <= we, isFuture: ws > today, snapshotDay: snapDay },
    kpi: {
      opened: cur.opened, closed: cur.closed, backlog: cur.backlog,
      openedPrev: prev ? prev.opened : null, closedPrev: prev ? prev.closed : null, backlogPrev: prev ? prev.backlog : null,
      closeRate: opened.length ? round1(pct(opened.filter((t) => t.status === 'Closed').length, opened.length)) : null,
      openedStillOpen: opened.filter((t) => BACKLOG_STATUSES.includes(t.status)).length,
      avgResolutionMinutes: resolutionMinutes.length ? Math.round(resolutionMinutes.reduce((a, b) => a + b, 0) / resolutionMinutes.length) : null,
      p1Opened: opened.filter((t) => isP1(t.priority)).length,
    },
    sla: { frt, res },
    trend,
    breakdown: {
      status: countBy(opened, (t) => t.status, STATUS_ORDER), priority: countBy(opened, (t) => t.priority, PRIORITY_ORDER),
      requestType: requestTypes, byDay,
    },
    workload: [...load.values()].sort((a, b) => b.total - a.total).slice(0, 15),
    lists: {
      backlog: backlogRows.sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || ageDays(b) - ageDays(a)).slice(0, 30)
        .map((t) => ({ name: t.name, subject: t.subject, priority: t.priority, status: t.status, opening: t.opening, ageDays: ageDays(t), assign: t.assign })),
      opened: [...opened].sort((a, b) => String(b.opening).localeCompare(String(a.opening))).slice(0, 50)
        .map((t) => ({ name: t.name, subject: t.subject, priority: t.priority, status: t.status, opening: t.opening, frtMinutes: t.frtDt && t.openDt ? Math.round(slaMinutes(t.priority, t.openDt, t.frtDt)) : null })),
      resolved: [...resolved].sort((a, b) => String(b.resolvedStr).localeCompare(String(a.resolvedStr))).slice(0, 50)
        .map((t) => ({ name: t.name, subject: t.subject, priority: t.priority, resolvedAt: t.resolvedStr, minutes: t.openDt && t.resolvedDt ? Math.round(slaMinutes(t.priority, t.openDt, t.resolvedDt)) : null })),
    },
    meta: { rows: T.length, generatedAt: new Date().toISOString(), warnings, weeks },
  };
}

module.exports = { buildWeeklyReport, businessMinutes, slaMinutes, mondayOf, addDays, isoWeekNumber, BACKLOG_STATUSES };
