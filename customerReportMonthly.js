'use strict';
/* Báo cáo tháng khách hàng theo dự án (trang /duan/bao-cao-thang-khach-hang).
   Cùng định nghĩa và cùng thông số với Báo cáo tuần khách hàng (customerReport.js), chỉ đổi kỳ báo cáo từ tuần sang THÁNG:
   - Tiếp nhận trong tháng = Opening On rơi vào tháng (ngày 1 → ngày cuối tháng).
   - Đã xử lý trong tháng  = Resolution Date (hoặc Modified nếu Closed mà không có Resolution Date) rơi vào tháng.
   - Tồn đọng              = đã mở tới ngày chốt và chưa xử lý xong tới ngày chốt (tháng hiện tại: theo trạng thái hiện tại).
   - SLA                   = cùng ngưỡng/giờ làm việc; tỷ lệ đạt = Đạt / (Đạt + Trượt), ticket còn trong ngưỡng là "Đang chờ".
   Trả về ĐẦY ĐỦ danh sách ticket sau mỗi con số để trang xuất được Excel đối chiếu từng con số trên slide. */

const weekly = require('./weeklyReport');
const base = require('./customerReport');
const { slaMinutes, addDays, BACKLOG_STATUSES } = weekly;
const { AGE_BUCKETS, STATUS_BOXES, PRIORITY_ORDER, normalize, slaOne, slaSummary, slaDueAt, thresholdOf, countBy, prioRank, fmtNaive, parseNaive, vnNow, isBacklogAt } = base;

const DAY_MS = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);
const round1 = (x) => Math.round(x * 10) / 10;

/** 'YYYY-MM' của một ngày ISO. */
const monthKeyOf = (iso) => String(iso || '').slice(0, 7);
/** Ngày đầu / ngày cuối của tháng 'YYYY-MM'. */
function monthStartOf(key) { return `${key}-01`; }
function monthEndOf(key) { const [y, m] = key.split('-').map(Number); return isoDay(new Date(Date.UTC(y, m, 0))); }
/** Cộng n tháng vào khoá 'YYYY-MM'. */
function addMonths(key, n) { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return isoDay(d).slice(0, 7); }
const isMonthKey = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

function buildMonthlyCustomerReport(rows, { project = '', month, months = 6, now = vnNow() } = {}) {
  const today = isoDay(now);
  const mk = isMonthKey(month) ? month : monthKeyOf(today);
  const ms = monthStartOf(mk); const me = monthEndOf(mk);
  const snapDay = me < today ? me : today;

  const seen = new Set(); const T = [];
  for (const r of rows || []) { if (!r || !r.name || seen.has(r.name)) continue; seen.add(r.name); T.push(normalize(r)); }
  const inRange = (day, s, e) => Boolean(day) && day >= s && day <= e;
  const snapEnd = snapDay >= today ? now : parseNaive(`${snapDay} 23:59:59`);
  const isOverdue = (t) => Boolean(t.openDt) && slaMinutes(t.priority, t.openDt, snapEnd) >= thresholdOf(t.priority);
  const ageDays = (t) => Math.max(0, Math.round((new Date(`${snapDay}T00:00:00Z`) - new Date(`${t.openDay}T00:00:00Z`)) / DAY_MS));

  const out = (t, extra = {}) => ({
    name: t.name, subject: t.subject, priority: t.priority, status: t.status, requestType: t.requestType, raisedBy: t.raisedBy,
    opening: t.opening, openMonth: monthKeyOf(t.openDay), firstResponded: t.firstResponded, resolvedAt: t.resolvedStr, assign: t.assign.join(', '), ...extra,
  });

  const opened = T.filter((t) => inRange(t.openDay, ms, me))
    .sort((a, b) => String(a.opening).localeCompare(String(b.opening)))
    .map((t) => out(t, { frt: slaOne(t, 'frt', now), res: slaOne(t, 'res', now) }));
  const resolved = T.filter((t) => inRange(t.resolvedDay, ms, me))
    .sort((a, b) => String(a.resolvedStr).localeCompare(String(b.resolvedStr)))
    .map((t) => out(t, { resolveMinutes: t.openDt && t.resolvedDt ? Math.round(slaMinutes(t.priority, t.openDt, t.resolvedDt)) : null }));
  const backlog = T.filter((t) => isBacklogAt(t, snapDay, today))
    .sort((a, b) => monthKeyOf(a.openDay).localeCompare(monthKeyOf(b.openDay)) || prioRank(a.priority) - prioRank(b.priority) || String(a.opening).localeCompare(String(b.opening)))
    .map((t) => out(t, { ageDays: ageDays(t), slaDue: fmtNaive(slaDueAt(t.priority, t.openDt)), overdue: isOverdue(t), fromPrevMonth: t.openDay < ms }));

  const backlogByOpenMonth = [];
  for (const t of backlog) {
    const last = backlogByOpenMonth[backlogByOpenMonth.length - 1];
    if (last && last.month === t.openMonth) last.count++;
    else backlogByOpenMonth.push({ month: t.openMonth, monthStart: monthStartOf(t.openMonth), monthEnd: monthEndOf(t.openMonth), count: 1 });
  }

  // xu hướng nhiều tháng
  const trend = [];
  for (let k = months - 1; k >= 0; k--) {
    const key = addMonths(mk, -k); const s = monthStartOf(key); const e = monthEndOf(key); const snap = e < today ? e : today;
    trend.push({
      month: key, monthStart: s, monthEnd: e,
      opened: T.filter((t) => inRange(t.openDay, s, e)).length,
      closed: T.filter((t) => inRange(t.resolvedDay, s, e)).length,
      backlog: s > today ? null : T.filter((t) => isBacklogAt(t, snap, today)).length,
    });
  }
  const cur = trend[trend.length - 1]; const prev = trend[trend.length - 2] || null;
  const warnings = [];
  if (!T.length) warnings.push('Không có ticket nào của dự án trong dữ liệu ERP trả về.');
  if (T.length && !T.some((t) => t.frtDt)) warnings.push('Không có ticket nào có First Responded On — SLA phản hồi sẽ chỉ tính các ticket quá hạn.');
  if (opened.length !== cur.opened || resolved.length !== cur.closed || backlog.length !== cur.backlog) {
    warnings.push('Số liệu chi tiết lệch với số liệu xu hướng — báo lại để kiểm tra.');
  }

  const frt = slaSummary(opened, 'frt'); const res = slaSummary(opened, 'res');
  const slaPass = frt.pass + res.pass; const slaDecided = frt.decided + res.decided;
  const known = new Set(STATUS_BOXES.flatMap(([, st]) => st));
  const openedByStatusBox = STATUS_BOXES.map(([label, st]) => ({ label, statuses: st, count: opened.filter((t) => st.includes(t.status)).length }));
  const openedOtherStatus = countBy(opened.filter((t) => !known.has(t.status)), (t) => t.status);
  const [y, m] = mk.split('-').map(Number);

  return {
    project,
    month: { key: mk, number: m, year: y, start: ms, end: me, today, isCurrent: ms <= today && today <= me, isFuture: ms > today, snapshotDay: snapDay },
    summary: {
      opened: opened.length, resolved: resolved.length, backlog: backlog.length,
      openedPrev: prev ? prev.opened : null, resolvedPrev: prev ? prev.closed : null, backlogPrev: prev ? prev.backlog : null,
      openedStillOpen: opened.filter((t) => BACKLOG_STATUSES.includes(t.status)).length,
      frt, res,
      sla: { pass: slaPass, decided: slaDecided, passRate: slaDecided ? round1((slaPass / slaDecided) * 100) : null },
      carriedOver: prev ? prev.backlog : null,
      carriedOverStillOpen: backlog.filter((t) => t.fromPrevMonth).length,
      overdue: backlog.filter((t) => t.overdue).length,
      openedByStatusBox, openedOtherStatus,
      openedByPriority: countBy(opened, (t) => t.priority, PRIORITY_ORDER),
      backlogByPriority: countBy(backlog, (t) => t.priority, PRIORITY_ORDER),
      openedByStatus: countBy(opened, (t) => t.status, [...BACKLOG_STATUSES, 'Closed']),
      openedByRequestType: countBy(opened, (t) => t.requestType),
      backlogByAge: AGE_BUCKETS.map(([a, b, label]) => ({ label, count: backlog.filter((t) => t.ageDays >= a && t.ageDays <= b).length })),
      backlogByOpenMonth,
    },
    trend,
    tickets: { opened, resolved, backlog },
    meta: { rows: T.length, generatedAt: new Date().toISOString(), warnings, months },
  };
}

module.exports = { buildMonthlyCustomerReport, monthKeyOf, monthStartOf, monthEndOf, addMonths, isMonthKey };
