
/* =========================================================================
   COLUMN NORMALIZATION — mirrors generate_dashboard.py's load_data()
   ========================================================================= */
function normalizeRows(rawRows) {
  if (!rawRows.length) return { rows: [], cols: new Set() };
  const cols = new Set(Object.keys(rawRows[0]));
  const hasTinhTrang = cols.has('Tình Trạng');
  const hasTrangThai = cols.has('Trạng Thái') || cols.has('Trạng thái');
  const trangThaiKey = cols.has('Trạng Thái') ? 'Trạng Thái' : 'Trạng thái';

  const hasDaysOpen = cols.has('DaysOpen');
  const hasDueDay = cols.has('DueDay');

  const hasDeadline = cols.has('Deadline');
  const hasDeadlineHienTai = cols.has('Deadline hiện tại');
  const hasFirst = cols.has('Deadline lần đầu');
  const hasUpdated = cols.has('Deadline cập nhật');

  const rows = rawRows.map(r => {
    const row = Object.assign({}, r);
    if (!hasTinhTrang && hasTrangThai) row['Tình Trạng'] = r[trangThaiKey];
    if (!hasDaysOpen && hasDueDay) row['DaysOpen'] = r['DueDay'];

    if (!hasDeadline) {
      if (hasFirst && hasUpdated) {
        const upd = r['Deadline cập nhật'];
        row['Deadline'] = (upd !== null && upd !== undefined && upd !== '') ? upd : r['Deadline lần đầu'];
      } else if (hasUpdated) {
        row['Deadline'] = r['Deadline cập nhật'];
      } else if (hasFirst) {
        row['Deadline'] = r['Deadline lần đầu'];
      } else if (hasDeadlineHienTai) {
        row['Deadline'] = r['Deadline hiện tại'];
      }
    }
    if (row['TicketPriority'] === 'Medim') row['TicketPriority'] = 'Medium';
    if (row['TicketPriority'] === 'Hight') row['TicketPriority'] = 'High';
    if (typeof row['Assign'] === 'string') row['Assign'] = row['Assign'].trim();
    if (typeof row['Priority'] === 'string') row['Priority'] = row['Priority'].trim();
    return row;
  });
  return { rows, cols };
}

/* =========================================================================
   DEADLINE PARSING — mirrors parse_deadline_date() / format_deadline_display()
   ========================================================================= */
function toMidnight(y, m, d) { return new Date(y, m, d, 0, 0, 0, 0); }
function isValidYMD(y, m, d) {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
}

function excelSerialToDate(n) {
  // Excel serial date (days since 1899-12-30)
  const utcDays = Math.floor(n - 25569);
  const utcMs = utcDays * 86400 * 1000;
  const d = new Date(utcMs);
  return toMidnight(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function parseDeadlineDate(raw, refDate) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return toMidnight(raw.getFullYear(), raw.getMonth(), raw.getDate());
  if (typeof raw === 'number') return excelSerialToDate(raw);

  const s = String(raw).trim();

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (isValidYMD(y, mo, d)) return toMidnight(y, mo, d);
  }

  m = s.match(/^(\d{1,2})[\/\-](\d{2})(\d{4})\b/);
  if (m) {
    const d = +m[1], mo = +m[2] - 1, y = +m[3];
    if (d >= 1 && d <= 31 && mo >= 0 && mo <= 11 && isValidYMD(y, mo, d)) return toMidnight(y, mo, d);
  }

  m = s.match(/(\d{1,2})[\/\-](\d{1,2})(?!\d)/);
  if (m) {
    const day = +m[1], month = +m[2] - 1;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      let d = toMidnight(refDate.getFullYear(), month, day);
      if (!isValidYMD(refDate.getFullYear(), month, day)) return null;
      if ((refDate - d) / 86400000 > 183) d = toMidnight(refDate.getFullYear() + 1, month, day);
      return d;
    }
  }
  return null;
}

function formatDeadlineDisplay(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw instanceof Date) return fmtDMY(raw);
  if (typeof raw === 'number') return fmtDMY(excelSerialToDate(raw));
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(\s+00:00:00)?$/);
  if (m) return `${pad(+m[3])}/${pad(+m[2])}/${m[1]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{2})(\d{4})\s+00:00$/);
  if (m) return `${pad(+m[1])}/${pad(+m[2])}/${m[3]}`;
  return s;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDMY(d) { return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function isWeekend(d) { const wd = d.getDay(); return wd === 0 || wd === 6; }

/* ---------- Created date parsing (mixed Date/string formats) + weekly bucket ---------- */
function parseCreatedDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return toMidnight(raw.getFullYear(), raw.getMonth(), raw.getDate());
  if (typeof raw === 'number') return excelSerialToDate(raw);
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (isValidYMD(y, mo, d)) return toMidnight(y, mo, d);
  }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = +m[1], mo = +m[2] - 1, y = +m[3];
    if (isValidYMD(y, mo, d)) return toMidnight(y, mo, d);
  }
  return null;
}
function mondayOf(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() + diff);
  return m;
}

function businessDaysSigned(start, end) {
  if (!end) return null;
  if (sameDay(start, end)) return 0;
  const step = end > start ? 1 : -1;
  let n = 0;
  let d = new Date(start);
  while (!sameDay(d, end)) {
    d.setDate(d.getDate() + step);
    if (d.getDay() !== 0 && d.getDay() !== 6) n += step;
  }
  return n;
}

/* =========================================================================
   TICKET CODE — mirrors ticket_code()
   ========================================================================= */
function ticketCode(row) {
  const hq = row['HQTicketID'];
  if (hq !== null && hq !== undefined && String(hq).trim() !== '') {
    return String(hq).trim().replace(/\.+$/, '');
  }
  const key = row['Key'] !== undefined && row['Key'] !== null ? String(row['Key']) : '';
  return key.replace(/^SS-/, 'TKT-');
}

/* =========================================================================
   SMALL CHART HELPERS — mirrors donut_chart()/hbar_chart() in Python
   ========================================================================= */
const PALETTE = {
  Working: '#2E6F95', Review: '#E3A857', Close: '#5FA778', Open: '#B5533C',
  Urgent: '#8B2E2E', Critical: '#B5533C', High: '#E3A857', Medium: '#2E6F95', Low: '#8FA6B3',
  CS: '#2E6F95', Dev: '#5B4B8A', ABI: '#5FA778', HQ: '#2E6F95', SOLAR: '#5FA778',
  Pending: '#2E6F95', 'Waiting for customer': '#E3A857',
  'Trễ SLA': '#B5533C', 'Cảnh báo SLA': '#E3A857', 'Trong SLA': '#5FA778',
};
const DEFAULT_COLORS = ['#2E6F95', '#E3A857', '#5FA778', '#B5533C', '#5B4B8A', '#8FA6B3'];
function colorFor(label, idx) { return PALETTE[label] || DEFAULT_COLORS[idx % DEFAULT_COLORS.length]; }

function dispLabel(l) { return l === 'Close' ? 'Closed' : l; }

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function donutChart(counts, size = 170, stroke = 26) {
  const entries = Object.entries(counts);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  let segs = '';
  entries.forEach(([label, val], i) => {
    if (!val) return;
    const frac = val / total;
    const dash = frac * circumference;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorFor(label, i)}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
  });
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${segs}` +
    `<circle cx="${cx}" cy="${cy}" r="${r - stroke / 2 - 4}" fill="#FFFFFF"/>` +
    `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="22" font-weight="700" fill="#233240" font-family="Arial">${total}</text>` +
    `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10.5" fill="#7A8A96" font-family="Arial">tickets</text></svg>`;
}

function legendHtml(counts) {
  const entries = Object.entries(counts);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  return entries.map(([label, val], i) => {
    const pct = Math.round(val / total * 100);
    return `<div class="legend-row"><span class="dot" style="background:${colorFor(label, i)}"></span>` +
      `<span class="legend-label">${esc(dispLabel(label))}</span>` +
      `<span class="legend-val">${val} <span class="legend-pct">(${pct}%)</span></span></div>`;
  }).join('');
}

function hbarChart(counts) {
  const entries = Object.entries(counts);
  const maxVal = Math.max(...entries.map(([, v]) => v), 1);
  return entries.map(([label, val], i) => {
    const pct = (val / maxVal * 100);
    return `<div class="hbar-row"><div class="hbar-label">${esc(dispLabel(label))}</div>` +
      `<div class="hbar-track"><div class="hbar-fill" style="width:${pct.toFixed(1)}%; background:${colorFor(label, i)}"></div></div>` +
      `<div class="hbar-val">${val}</div></div>`;
  }).join('');
}

function vbarChart(counts, opts = {}) {
  const height = opts.height || 130;
  const suffix = opts.suffix || '';
  const entries = Object.entries(counts);
  const maxVal = opts.maxOverride || Math.max(...entries.map(([, v]) => v), 1);
  const colorFn = opts.colorFn || ((label, val, i) => colorFor(label, i));
  const cols = entries.map(([label, val], i) => {
    const pct = Math.max((val / maxVal * 100), val > 0 ? 4 : 0);
    return `<div class="vbar-col">` +
      `<div class="vbar-val">${val}${suffix}</div>` +
      `<div class="vbar-bar" style="height:${pct.toFixed(1)}%; background:${colorFn(label, val, i)}"></div>` +
      `<div class="vbar-label">${esc(dispLabel(label))}</div>` +
      `</div>`;
  }).join('');
  return `<div class="vbar-wrap" style="height:${height}px">${cols}</div>`;
}

function slaStackedBar(dat, tre) {
  const total = dat + tre || 1;
  const datPct = (dat / total * 100).toFixed(1);
  const trePct = (tre / total * 100).toFixed(1);
  return `<div class="hbar-track" style="display:flex;">` +
    (dat ? `<div style="width:${datPct}%; background:#5FA778; height:12px;"></div>` : '') +
    (tre ? `<div style="width:${trePct}%; background:#B5533C; height:12px;"></div>` : '') +
    `</div>`;
}

function assignAgingChart(assignAgingRows, buckets, height = 210) {
  const maxTotal = Math.max(...assignAgingRows.map(r => r.total), 1);
  const cols = assignAgingRows.map(r => {
    const totalPct = Math.max((r.total / maxTotal * 100), r.total > 0 ? 4 : 0);
    const segmentsHtml = r.segments.filter(s => s.count).map(s => {
      const segPct = r.total ? (s.count / r.total * 100) : 0;
      return `<div style="height:${segPct.toFixed(1)}%; background:${s.color};" title="${esc(s.label)}: ${s.count}"></div>`;
    }).join('');
    return `<div class="vbar-col">` +
      `<div class="vbar-val">${r.total}</div>` +
      `<div class="vbar-bar" style="height:${totalPct.toFixed(1)}%; display:flex; flex-direction:column-reverse; overflow:hidden;">${segmentsHtml}</div>` +
      `<div class="vbar-label">${esc(r.label)}</div>` +
      `</div>`;
  }).join('');
  const legend = `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11.5px;color:var(--sub)">` +
    buckets.map(b => `<span style="display:flex;align-items:center;gap:5px"><span class="dot" style="background:${b.color}"></span>${esc(b.label)}</span>`).join('') +
    `</div>`;
  return `<div class="vbar-wrap" style="height:${height}px">${cols}</div>` + legend;
}

function valueCounts(rows, field) {
  const counts = {};
  rows.forEach(r => {
    const v = r[field];
    if (v === null || v === undefined || v === '') return;
    counts[v] = (counts[v] || 0) + 1;
  });
  // sort descending by count, like pandas value_counts()
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}
function orderedCounts(rows, field, order) {
  const raw = valueCounts(rows, field);
  const out = {};
  order.forEach(k => { if (raw[k]) out[k] = raw[k]; });
  return Object.keys(out).length ? out : raw;
}

/* =========================================================================
   MAIN BUILD
   ========================================================================= */
function buildDashboard(rawRows, reportDateStr) {
  const { rows } = normalizeRows(rawRows);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  rows.forEach(r => {
    r._parsedDeadline = parseDeadlineDate(r['Deadline'], today);
    r._deltaDays = r._parsedDeadline ? Math.round((r._parsedDeadline - today) / 86400000) : null;
    r._bizDelta = r._parsedDeadline ? businessDaysSigned(today, r._parsedDeadline) : null;
    r._isWeekendDeadline = r._parsedDeadline ? isWeekend(r._parsedDeadline) : false;
    r._daysOpen = Number(r['DaysOpen']) || 0;
  });

  const total = rows.length;
  const nClose = rows.filter(r => r['Tình Trạng'] === 'Close').length;
  const nOpen = total - nClose;
  const nAging20 = rows.filter(r => r._daysOpen >= 20 && r['Tình Trạng'] !== 'Close').length;
  const nCriticalUrgent = rows.filter(r => ['Critical', 'Urgent'].includes(r['TicketPriority'])).length;
  const nHigh = rows.filter(r => r['TicketPriority'] === 'High').length;

  const todayList = rows.filter(r =>
    r['Tình Trạng'] === 'Working' &&
    !['Critical', 'Urgent'].includes(r['TicketPriority']) &&
    r._parsedDeadline && r._parsedDeadline <= today
  ).sort((a, b) => a._bizDelta - b._bizDelta);

  const upcoming = rows.filter(r =>
    ['Open', 'Working'].includes(r['Tình Trạng']) &&
    r._deltaDays !== null && r._deltaDays > 0 && !r._isWeekendDeadline
  ).sort((a, b) => a._deltaDays - b._deltaDays).slice(0, 10);

  const criticalUrgentList = rows.filter(r => ['Critical', 'Urgent'].includes(r['TicketPriority']))
    .sort((a, b) => {
      const aOpen = a['Tình Trạng'] !== 'Close' ? 1 : 0;
      const bOpen = b['Tình Trạng'] !== 'Close' ? 1 : 0;
      if (bOpen !== aOpen) return bOpen - aOpen;
      return b._daysOpen - a._daysOpen;
    });

  const tinhTrangCounts = orderedCounts(rows, 'Tình Trạng', ['Working', 'Review', 'Open', 'Close']);
  const openRows = rows.filter(r => r['Tình Trạng'] !== 'Close');
  const priorityCounts = orderedCounts(openRows, 'TicketPriority', ['Urgent', 'Critical', 'High', 'Medium', 'Low']);
  const jiraPriorityCounts = orderedCounts(openRows, 'Priority', ['P1', 'S1', 'P2', 'S2', 'P3', 'S3', 'P4', 'S4']);
  const currentMonthRows = rows.filter(r => {
    const cd = parseCreatedDate(r['Created']);
    return cd && cd.getFullYear() === today.getFullYear() && cd.getMonth() === today.getMonth();
  });
  const currentMonthOpenRows = currentMonthRows.filter(r => r['Tình Trạng'] !== 'Close');
  const nSlaTre = currentMonthOpenRows.filter(r => r['Tình trạng SLA'] === 'Trễ SLA').length;
  const monthLabel = `Tháng ${pad(today.getMonth() + 1)}/${today.getFullYear()}`;

  const slaPriorityOrder = ['P1', 'S1', 'P2', 'S2', 'P3', 'S3', 'P4', 'S4'];
  const monthPriorityValues = Array.from(new Set(currentMonthRows.map(r => r['Priority']).filter(v => v !== null && v !== undefined && v !== '')));
  const slaPriorityList = slaPriorityOrder.filter(p => monthPriorityValues.includes(p))
    .concat(monthPriorityValues.filter(p => !slaPriorityOrder.includes(p)));
  const slaByPriority = slaPriorityList.map(p => {
    const list = currentMonthRows.filter(r => r['Priority'] === p);
    const tre = list.filter(r => r['Tình trạng SLA'] === 'Trễ SLA').length;
    const total = list.length;
    const dat = total - tre;
    return { p, total, dat, tre, trePct: total ? Math.round(tre / total * 100) : 0 };
  });

  const weekCounts = {};
  const weekTreCounts = {};
  rows.forEach(r => {
    const cd = parseCreatedDate(r['Created']);
    if (!cd) return;
    const wk = mondayOf(cd).getTime();
    weekCounts[wk] = (weekCounts[wk] || 0) + 1;
    if (r['Tình trạng SLA'] === 'Trễ SLA') weekTreCounts[wk] = (weekTreCounts[wk] || 0) + 1;
  });
  const weekKeys = Object.keys(weekCounts).map(Number).sort((a, b) => a - b);
  const weeklyCounts = {};
  const weeklyOnTimeRate = {};
  weekKeys.forEach(k => {
    const start = new Date(k);
    const end = new Date(k); end.setDate(end.getDate() + 6);
    const label = `${pad(start.getDate())}/${pad(start.getMonth() + 1)}–${pad(end.getDate())}/${pad(end.getMonth() + 1)}`;
    weeklyCounts[label] = weekCounts[k];
    const tre = weekTreCounts[k] || 0;
    weeklyOnTimeRate[label] = Math.round((weekCounts[k] - tre) / weekCounts[k] * 100);
  });

  const assignCounts = valueCounts(openRows, 'Assign');
  const agingBuckets = [
    { label: '0–5 ngày', min: 0, max: 5, color: '#5FA778' },
    { label: '6–10 ngày', min: 6, max: 10, color: '#2E6F95' },
    { label: '11–20 ngày', min: 11, max: 20, color: '#E3A857' },
    { label: '> 20 ngày', min: 21, max: Infinity, color: '#B5533C' },
  ];
  const agingCounts = {};
  agingBuckets.forEach(b => {
    agingCounts[b.label] = openRows.filter(r => r._daysOpen >= b.min && r._daysOpen <= b.max).length;
  });
  const assignAgingRows = Object.keys(assignCounts).map(a => {
    const list = openRows.filter(r => r['Assign'] === a);
    const segments = agingBuckets.map(b => ({
      label: b.label, color: b.color,
      count: list.filter(r => r._daysOpen >= b.min && r._daysOpen <= b.max).length,
    }));
    return { label: a, total: list.length, segments };
  });

  const avgDays = rows.length ? (rows.reduce((a, r) => a + r._daysOpen, 0) / rows.length) : 0;
  const maxDays = rows.length ? Math.max(...rows.map(r => r._daysOpen)) : 0;

  function deadlineTag(delta) {
    if (delta === null || delta === undefined) return '';
    delta = Math.round(delta);
    if (delta < 0) return `<span class="days-hot">Quá hạn ${Math.abs(delta)} ngày làm việc</span>`;
    if (delta === 0) return `<span class="days-hot">Hôm nay</span>`;
    if (delta <= 3) return `<span class="days-warm">Còn ${delta} ngày làm việc</span>`;
    return `<span class="days-cool">Còn ${delta} ngày làm việc</span>`;
  }

  const prioClsMap = { Urgent: 'chip-urgent', Critical: 'chip-critical', High: 'chip-high', Medium: 'chip-medium', Low: 'chip-low' };

  function rowsHtml(list, showDelta) {
    if (!list.length) return null;
    return list.map(r => {
      const days = r._daysOpen;
      const daysCls = days >= 20 ? 'days-hot' : (days >= 7 ? 'days-warm' : 'days-cool');
      const prio = r['TicketPriority'] || '';
      const prioCls = prioClsMap[prio] || 'chip-medium';
      const tt = esc(dispLabel(r['Tình Trạng'] || ''));
      const lastCol = showDelta ? deadlineTag(r._bizDelta) : String(days);
      return '<tr>' +
        `<td class="cell-key">${esc(ticketCode(r))}</td>` +
        `<td class="cell-summary">${esc(r['Summary'])}</td>` +
        `<td><span class="chip ${prioCls}">${esc(prio)}</span></td>` +
        `<td>${esc(r['Assign'])}</td>` +
        `<td>${tt}</td>` +
        `<td class="${showDelta ? '' : daysCls}">${lastCol}</td>` +
        `<td class="cell-deadline">${esc(formatDeadlineDisplay(r['Deadline']))}</td>` +
        '</tr>';
    }).join('');
  }

  const todayRowsHtml = rowsHtml(todayList, true) || '<tr><td colspan="7" style="color:#6B7C88">Không có ticket Working nào đến hạn hoặc quá hạn hôm nay.</td></tr>';
  const upcomingRowsHtml = rowsHtml(upcoming, true) || '<tr><td colspan="7" style="color:#6B7C88">Không xác định được ngày deadline cụ thể từ cột Deadline.</td></tr>';
  const criticalRowsHtml = rowsHtml(criticalUrgentList, false) || '<tr><td colspan="7" style="color:#6B7C88">Không có ticket Critical/Urgent nào.</td></tr>';

  const html = `
  <div class="page">
    <div class="header">
      <div>
        <h1>Dashboard Tổng Hợp Ticket — Dự Án ABI</h1>
        <div class="sub">Nguồn: file chi tiết Jira Ticket Pending &nbsp;·&nbsp; Cập nhật cuối ngày ${reportDateStr}</div>
      </div>
      <div class="badge">${total} tickets đang theo dõi</div>
    </div>

    <div class="kpi-row">
      <div class="kpi"><div class="num">${total}</div><div class="label">TỔNG SỐ TICKET</div></div>
      <div class="kpi warn"><div class="num">${nOpen}</div><div class="label">ĐANG XỬ LÝ (chưa Closed)</div></div>
      <div class="kpi ok"><div class="num">${nClose}</div><div class="label">ĐÃ CLOSED</div></div>
      <div class="kpi warn"><div class="num">${nAging20}</div><div class="label">TỒN &ge; 20 NGÀY</div></div>
      <div class="kpi danger"><div class="num">${nCriticalUrgent}</div><div class="label">CRITICAL / URGENT</div></div>
      <div class="kpi info"><div class="num">${nHigh}</div><div class="label">HIGH</div></div>
      <div class="kpi info"><div class="num">${todayList.length}</div><div class="label">CẦN XỬ LÝ / RLS HÔM NAY</div></div>
      <div class="kpi warn"><div class="num">${nSlaTre}</div><div class="label">TRỄ SLA (tháng này, chưa Closed)</div></div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Tình trạng xử lý</h3>
        <div class="donut-wrap">${donutChart(tinhTrangCounts)}<div style="flex:1">${legendHtml(tinhTrangCounts)}</div></div>
      </div>
      <div class="card">
        <h3>Mức độ ưu tiên (chưa Closed)</h3>
        ${hbarChart(priorityCounts)}
        <h3 style="margin-top:16px">Priority Jira (P1–S3, chưa Closed) — ${openRows.length} ticket</h3>
        ${hbarChart(jiraPriorityCounts)}
      </div>
      <div class="card">
        <h3>SLA theo Priority (${monthLabel})</h3>
        <table>
          <thead><tr><th>Priority</th><th>Tổng</th><th>Đạt / Trễ</th><th>Đạt SLA</th><th>Trễ SLA</th><th>% Trễ</th></tr></thead>
          <tbody>${slaByPriority.map(x => `<tr>` +
            `<td><span class="chip ${x.p.startsWith('P1') || x.p.startsWith('S1') ? 'chip-urgent' : (x.p.startsWith('P2') || x.p.startsWith('S2')) ? 'chip-critical' : (x.p.startsWith('P4') || x.p.startsWith('S4')) ? 'chip-low' : 'chip-medium'}">${x.p}</span></td>` +
            `<td>${x.total}</td>` +
            `<td style="min-width:90px">${slaStackedBar(x.dat, x.tre)}</td>` +
            `<td style="color:#5FA778;font-weight:700">${x.dat}</td>` +
            `<td style="color:#B5533C;font-weight:700">${x.tre}</td>` +
            `<td>${x.total ? x.trePct + '%' : '—'}</td>` +
            `</tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Đội xử lý & số ngày tồn (chưa Closed)</h3>
        ${assignAgingChart(assignAgingRows, agingBuckets)}
      </div>
      <div class="card">
        <h3>Ticket tạo mới theo tuần</h3>
        ${vbarChart(weeklyCounts)}
      </div>
      <div class="card">
        <h3>Tỷ lệ đúng hạn theo tuần</h3>
        ${vbarChart(weeklyOnTimeRate, { suffix: '%', maxOverride: 100, colorFn: (l, v) => v >= 90 ? '#5FA778' : v >= 70 ? '#E3A857' : '#B5533C' })}
      </div>
    </div>

    <div class="section-title">🔴 Cần xử lý / release hôm nay hoặc đã quá hạn (${reportDateStr}) <span class="tag">${todayList.length} ticket</span></div>
    <table>
      <thead><tr><th>Ticket</th><th>Mô tả</th><th>Priority</th><th>Assign</th><th>Tình trạng</th><th>Hạn deadline</th><th>Deadline / Ghi chú</th></tr></thead>
      <tbody>${todayRowsHtml}</tbody>
    </table>

    <div class="section-title">🗓️ Sắp tới hạn deadline gần nhất (Open / Working, sau hôm nay, bỏ Thứ 7 &amp; Chủ Nhật)</div>
    <table>
      <thead><tr><th>Ticket</th><th>Mô tả</th><th>Priority</th><th>Assign</th><th>Tình trạng</th><th>Hạn deadline</th><th>Deadline / Ghi chú</th></tr></thead>
      <tbody>${upcomingRowsHtml}</tbody>
    </table>

    <div class="section-title">🚨 Critical / Urgent — Tình trạng hiện tại <span class="tag">${nCriticalUrgent} ticket</span></div>
    <table>
      <thead><tr><th>Ticket</th><th>Mô tả</th><th>Priority</th><th>Assign</th><th>Tình trạng</th><th>Số ngày mở</th><th>Deadline / Ghi chú</th></tr></thead>
      <tbody>${criticalRowsHtml}</tbody>
    </table>

    <div class="footer">Số ngày mở trung bình: ${avgDays.toFixed(1)} ngày &nbsp;·&nbsp; Lâu nhất: ${Math.round(maxDays)} ngày &nbsp;·&nbsp; Dashboard tự động tổng hợp từ file Ticket ABI.</div>
  </div>`;

  return html;
}

module.exports = { buildDashboard, normalizeRows };
