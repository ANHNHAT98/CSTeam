'use strict';
/* Báo cáo khách hàng theo dự án (trang /duan/bao-cao-khach-hang).
   Dùng đúng định nghĩa của Dashboard Support Tuần (weeklyReport.js) để số liệu 2 trang luôn khớp:
   - Tiếp nhận trong tuần = Opening On rơi vào tuần (T2 → CN).
   - Đã xử lý trong tuần  = Resolution Date (hoặc Modified nếu Closed mà không có Resolution Date) rơi vào tuần.
   - Tồn đọng            = đã mở tới ngày chốt và chưa xử lý xong tới ngày chốt (tuần hiện tại: theo trạng thái hiện tại).
   - SLA                 = cùng ngưỡng/giờ làm việc; tỷ lệ đạt = Đạt / (Đạt + Trượt), ticket còn trong ngưỡng là "Đang chờ".
   Khác với weeklyReport.js: trả về ĐẦY ĐỦ danh sách ticket sau mỗi con số (không cắt top 30/50),
   để trang xuất được file Excel chi tiết đối chiếu đúng từng con số trên slide. */

const weekly = require('./weeklyReport');
const { slaMinutes, mondayOf, addDays, isoWeekNumber, BACKLOG_STATUSES } = weekly;

const PRIORITY_ORDER = ['Critical', 'Urgent', 'High', 'Medium', 'Low'];
// GIỮ ĐỒNG BỘ với SLA_THRESHOLD trong weeklyReport.js / public/index.html
const SLA_THRESHOLD = { critical: 60, urgent: 240, high: 480, medium: 4320 };
const SLA_DEFAULT_THRESHOLD = 7200;
const AGE_BUCKETS = [[0, 3, '0–3 ngày'], [4, 7, '4–7 ngày'], [8, 14, '8–14 ngày'], [15, 30, '15–30 ngày'], [31, Infinity, 'Trên 30 ngày']];
const DAY_MS = 86400000;
// Ô trạng thái trên slide 1 (ticket tiếp nhận trong tuần, theo trạng thái hiện tại). Assign và Re-open gộp vào Open.
const STATUS_BOXES = [['Open', ['Open', 'Assign', 'Re-open']], ['Working', ['Working']], ['Reviewing', ['Reviewing']], ['Waiting', ['Waiting']], ['Pending', ['Pending']], ['Closed', ['Closed']]];

const isoDay = (d) => d.toISOString().slice(0, 10);
const dayOf = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : '');
function parseNaive(s) {
  if (!s) return null;
  const d = new Date(`${String(s).trim().replace(' ', 'T').replace(/\.\d+$/, '')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function vnNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
function thresholdOf(p) { const k = String(p || '').trim().toLowerCase(); return k in SLA_THRESHOLD ? SLA_THRESHOLD[k] : SLA_DEFAULT_THRESHOLD; }
function parseAssign(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter(Boolean) : []; } catch (_) { return []; }
}
const prioRank = (p) => { const i = PRIORITY_ORDER.findIndex((x) => x.toLowerCase() === String(p).toLowerCase()); return i < 0 ? 99 : i; };
const round1 = (x) => Math.round(x * 10) / 10;

function normalize(r) {
  const status = String(r.status || '').trim();
  const resolvedStr = r.resolution_date || (status === 'Closed' ? r.modified : '') || '';
  const opening = r.opening_date || r.creation || '';
  const openDay = dayOf(opening);
  return {
    name: r.name, subject: r.subject || '', status, priority: String(r.priority || '').trim() || '(không có)',
    requestType: r.request_type || '', raisedBy: r.raised_by || '',
    opening, openDay, openDt: parseNaive(opening), openWeekStart: openDay ? mondayOf(openDay) : '',
    firstResponded: r.first_responded_on || '', frtDt: parseNaive(r.first_responded_on),
    resolvedStr, resolvedDay: dayOf(resolvedStr), resolvedDt: parseNaive(resolvedStr),
    assign: parseAssign(r._assign),
  };
}

function isBacklogAt(t, D, today) {
  if (!t.openDay || t.openDay > D) return false;
  if (D >= today) return BACKLOG_STATUSES.includes(t.status);
  return !t.resolvedDay || t.resolvedDay > D;
}

/** Kết quả SLA 1 ticket — cùng quy tắc slaFor() trong weeklyReport.js. */
function slaOne(t, kind, now) {
  const target = kind === 'frt' ? t.frtDt : t.resolvedDt;
  const threshold = thresholdOf(t.priority);
  if (!t.openDt) return null;
  if (target) { const m = slaMinutes(t.priority, t.openDt, target); return { minutes: Math.round(m), threshold, result: m < threshold ? 'Đạt' : 'Trượt', done: true }; }
  const m = slaMinutes(t.priority, t.openDt, now);
  return { minutes: Math.round(m), threshold, result: m >= threshold ? 'Trượt' : 'Đang chờ', done: false };
}
function slaSummary(rows, kind) {
  const r = rows.map((t) => t[kind]).filter(Boolean);
  const pass = r.filter((x) => x.result === 'Đạt').length; const fail = r.filter((x) => x.result === 'Trượt').length;
  return { total: r.length, pass, fail, pending: r.length - pass - fail, decided: pass + fail, passRate: pass + fail ? round1((pass / (pass + fail)) * 100) : null };
}

function countBy(list, keyFn, order) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x) || '(không có)'; m.set(k, (m.get(k) || 0) + 1); }
  const keys = [...m.keys()];
  if (order) keys.sort((a, b) => { const ia = order.indexOf(a); const ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || m.get(b) - m.get(a); });
  else keys.sort((a, b) => m.get(b) - m.get(a));
  return keys.map((k) => ({ label: k, count: m.get(k) }));
}

function buildCustomerReport(rows, { project = '', weekStart, weeks = 8, now = vnNow() } = {}) {
  const today = isoDay(now);
  const ws = mondayOf(weekStart || today); const we = addDays(ws, 6);
  const snapDay = we < today ? we : today;
  const base = weekly.buildWeeklyReport(rows, { project, weekStart: ws, weeks, now });

  const seen = new Set(); const T = [];
  for (const r of rows || []) { if (!r || !r.name || seen.has(r.name)) continue; seen.add(r.name); T.push(normalize(r)); }
  const inWeek = (day) => day && day >= ws && day <= we;
  // Mốc tính quá hạn cho ticket tồn đọng: cuối ngày chốt (tuần đã qua) hoặc hiện tại (tuần này).
  const snapEnd = snapDay >= today ? now : parseNaive(`${snapDay} 23:59:59`);
  const isOverdue = (t) => Boolean(t.openDt) && slaMinutes(t.priority, t.openDt, snapEnd) >= thresholdOf(t.priority);
  const ageDays = (t) => Math.max(0, Math.round((new Date(`${snapDay}T00:00:00Z`) - new Date(`${t.openDay}T00:00:00Z`)) / DAY_MS));

  const out = (t, extra = {}) => ({
    name: t.name, subject: t.subject, priority: t.priority, status: t.status, requestType: t.requestType, raisedBy: t.raisedBy,
    opening: t.opening, openWeek: t.openWeekStart ? isoWeekNumber(t.openWeekStart) : null, openWeekStart: t.openWeekStart,
    firstResponded: t.firstResponded, resolvedAt: t.resolvedStr, assign: t.assign.join(', '), ...extra,
  });

  const opened = T.filter((t) => inWeek(t.openDay))
    .sort((a, b) => String(a.opening).localeCompare(String(b.opening)))
    .map((t) => out(t, { frt: slaOne(t, 'frt', now), res: slaOne(t, 'res', now) }));
  const resolved = T.filter((t) => inWeek(t.resolvedDay))
    .sort((a, b) => String(a.resolvedStr).localeCompare(String(b.resolvedStr)))
    .map((t) => out(t, { resolveMinutes: t.openDt && t.resolvedDt ? Math.round(slaMinutes(t.priority, t.openDt, t.resolvedDt)) : null }));
  const backlog = T.filter((t) => isBacklogAt(t, snapDay, today))
    .sort((a, b) => String(a.openWeekStart).localeCompare(String(b.openWeekStart)) || prioRank(a.priority) - prioRank(b.priority) || String(a.opening).localeCompare(String(b.opening)))
    .map((t) => out(t, { ageDays: ageDays(t), overdue: isOverdue(t), fromPrevWeek: t.openDay < ws }));

  const backlogByOpenWeek = [];
  for (const t of backlog) {
    const last = backlogByOpenWeek[backlogByOpenWeek.length - 1];
    if (last && last.weekStart === t.openWeekStart) last.count++;
    else backlogByOpenWeek.push({ weekStart: t.openWeekStart, weekEnd: addDays(t.openWeekStart, 6), week: t.openWeek, count: 1 });
  }

  const cur = base.trend[base.trend.length - 1]; const prev = base.trend[base.trend.length - 2] || null;
  const warnings = [...base.meta.warnings];
  if (opened.length !== cur.opened || resolved.length !== cur.closed || backlog.length !== cur.backlog) {
    warnings.push('Số liệu chi tiết lệch với Dashboard Support Tuần — báo lại để kiểm tra.');
  }

  const frt = slaSummary(opened, 'frt'); const res = slaSummary(opened, 'res');
  const slaPass = frt.pass + res.pass; const slaDecided = frt.decided + res.decided;
  const known = new Set(STATUS_BOXES.flatMap(([, st]) => st));
  const openedByStatusBox = STATUS_BOXES.map(([label, st]) => ({ label, statuses: st, count: opened.filter((t) => st.includes(t.status)).length }));
  const openedOtherStatus = countBy(opened.filter((t) => !known.has(t.status)), (t) => t.status);

  return {
    project,
    week: { ...base.week },
    summary: {
      opened: opened.length, resolved: resolved.length, backlog: backlog.length,
      openedPrev: prev ? prev.opened : null, resolvedPrev: prev ? prev.closed : null, backlogPrev: prev ? prev.backlog : null,
      openedStillOpen: opened.filter((t) => BACKLOG_STATUSES.includes(t.status)).length,
      frt, res,
      sla: { pass: slaPass, decided: slaDecided, passRate: slaDecided ? round1((slaPass / slaDecided) * 100) : null },
      carriedOver: prev ? prev.backlog : null,
      carriedOverStillOpen: backlog.filter((t) => t.fromPrevWeek).length,
      overdue: backlog.filter((t) => t.overdue).length,
      openedByStatusBox, openedOtherStatus,
      openedByPriority: countBy(opened, (t) => t.priority, PRIORITY_ORDER),
      backlogByPriority: countBy(backlog, (t) => t.priority, PRIORITY_ORDER),
      openedByStatus: countBy(opened, (t) => t.status, [...BACKLOG_STATUSES, 'Closed']),
      openedByRequestType: countBy(opened, (t) => t.requestType),
      backlogByAge: AGE_BUCKETS.map(([a, b, label]) => ({ label, count: backlog.filter((t) => t.ageDays >= a && t.ageDays <= b).length })),
      backlogByOpenWeek,
    },
    trend: base.trend,
    tickets: { opened, resolved, backlog },
    meta: { rows: T.length, generatedAt: new Date().toISOString(), warnings, weeks },
  };
}

module.exports = { buildCustomerReport, AGE_BUCKETS, STATUS_BOXES };
