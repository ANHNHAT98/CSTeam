'use strict';
/* Báo Cáo Tuần ERP — chạy tự động trên server (không cần mở trang).
   - Tính số liệu GIỐNG HỆT trang /bao-cao/tuan-erp (protected/kpiteam-bao-cao-tuan.html): ticket mở trong tuần, tồn đọng,
     so sánh tuần trước, giờ timesheet, "Thực hiện trong tuần", "Xử lý tuần sau". Sửa công thức ở trang thì sửa cả ở đây.
   - Vẽ biểu đồ (SVG → PNG bằng @resvg/resvg-js + font DejaVu trong assets/fonts), tạo 1 bản ghi trong DocType báo cáo
     của ERP (cấu hình trên trang: DocType + trường nào là Dự án / Từ ngày / Đến ngày / Nội dung / Tiêu đề), đính kèm ảnh
     biểu đồ, chèn ảnh vào nội dung rồi Submit (nếu DocType cho Submit và cấu hình bật "Gửi luôn").
   - Cấu hình lưu ở data/weekly-erp-auto.json, lịch sử chạy ở data/weekly-erp-runs.json (qua listStore → GitHub nếu có).
   - Lịch chạy: bên ngoài (GitHub Actions / GitLab schedule / cron-job.org) gọi POST /api/cron/weekly-erp kèm header
     X-Cron-Key = CRON_SECRET, mỗi sáng thứ 2. Mỗi dự án + tuần chỉ tạo 1 lần (gọi lại sẽ bỏ qua). */

const fs = require('fs');
const path = require('path');
const erp = require('./erpClient');
const { createListStore } = require('./listStore');

const configStore = createListStore({ repoFilePath: 'data/weekly-erp-auto.json', localFile: 'data/weekly-erp-auto.json' });
const runStore = createListStore({ repoFilePath: 'data/weekly-erp-runs.json', localFile: 'data/weekly-erp-runs.json' });
const MAX_RUNS = 300;

// Dự án trong menu (public/index.html) — mặc định chạy cho tất cả
const DEFAULT_PROJECTS = ['ABI_eSales_Support', 'MerapLion_eSales', 'ANVY_eSale_Support', 'Sabeco_PG', 'Sabeco_B2B_Support',
  'FES_eSales', 'ANKO_eSales_Support', 'HaiHa_eSales_Support', 'Jotun_VN_eSales'];
const DEFAULT_CONFIG = {
  enabled: true,
  // mode "note": thêm 1 Note vào bảng con của bản ghi có sẵn của dự án (Project Progress Update/<dự án> → tab Progress → New Note)
  // mode "new-doc": mỗi tuần tạo 1 bản ghi mới trong DocType
  mode: 'note',
  weekEnd: 0,            // ngày cuối kỳ báo cáo: 0 = Chủ nhật (T2→CN), 4 = Thứ 5 (T6→T5)…
  docname: '{project}',  // tên bản ghi của dự án (mode note)
  noteTable: '',         // trường Table chứa các Note (mode note) — để trống thì tự dò
  noteField: '',         // trường nội dung trong dòng Note (mode note) — để trống thì tự dò
  doctype: 'Project Progress Update',
  fields: { project: '', from: '', to: '', content: '', title: '' },
  titleTemplate: 'Báo cáo tuần {project} {week}',
  submit: true,
  projects: DEFAULT_PROJECTS,
  extra: {}, // giá trị cố định cho các trường bắt buộc khác: { fieldname: value }
};

/* ---------- cấu hình trạng thái (GIỮ ĐỒNG BỘ với trang) ---------- */
const BACKLOG_STATUSES = ['Open', 'Assign', 'Working', 'Reviewing', 'Waiting', 'Pending', 'Re-open'];
const NEXT_WEEK_STATUSES = ['Open', 'Assign', 'Working', 'Reviewing'];
const CLOSED_STATUS = 'Closed';

/* ---------- ngày (chuỗi YYYY-MM-DD, tính theo giờ Việt Nam) ---------- */
const isoOf = (d) => d.toISOString().slice(0, 10);
function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); }
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
/** Kỳ 7 ngày gần nhất đã kết thúc TRƯỚC hôm nay (giờ VN). weekEnd = thứ của ngày cuối kỳ: 0 = Chủ nhật (kỳ T2→CN), 4 = Thứ 5 (kỳ T6→T5)… */
function lastWeekVN(now = Date.now(), weekEnd = 0) {
  const vn = new Date(now + 7 * 3600 * 1000);
  const today = isoOf(vn);
  const back = ((vn.getUTCDay() - Number(weekEnd || 0)) + 7) % 7 || 7;
  const to = addDays(today, -back);
  return { from: addDays(to, -6), to };
}
const dayOfRow = (r) => { const s = String(r.opening_date || r.creation || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };
const inRange = (d, from, to) => Boolean(d) && d >= from && d <= to;
const parts = (iso) => iso.split('-').map(Number); // [y, m, d]
function rangeLabel(from, to) {
  const [, fm, fd] = parts(from); const [, tm, td] = parts(to);
  return fm === tm ? `(${fd} → ${td} tháng ${tm})` : `(${fd}/${fm} → ${td} tháng ${tm})`;
}
const fmtDM = (iso) => { const [, m, d] = parts(iso); return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`; };
const fmtDMY = (iso) => iso.split('-').reverse().join('/');

/* ---------- giờ timesheet (giống extractTotalHours trên trang) ---------- */
function extractTotalHours(reportJson) {
  const payload = reportJson && reportJson.message ? reportJson.message : reportJson;
  if (!payload) return null;
  const result = payload.result;
  if (!Array.isArray(result) || !result.length) return 0;
  if (!Array.isArray(result[0])) {
    const keys = Object.keys(result[0]);
    const hourKey = keys.find((k) => k.toLowerCase() === 'hours') || keys.find((k) => /hour/i.test(k)) || keys.find((k) => /time/i.test(k));
    if (!hourKey) return null;
    return result.reduce((sum, r) => {
      const hasOther = keys.some((k) => k !== hourKey && r[k] !== null && r[k] !== undefined && r[k] !== '');
      return hasOther ? sum + (parseFloat(r[hourKey]) || 0) : sum;
    }, 0);
  }
  const cols = Array.isArray(payload.columns) ? payload.columns : [];
  let idx = cols.findIndex((c) => (c.fieldname || '').toLowerCase() === 'hours');
  if (idx === -1) idx = cols.findIndex((c) => /hour/i.test(c.fieldname || c.label || ''));
  if (idx === -1) idx = cols.findIndex((c) => /time/i.test(c.fieldname || c.label || ''));
  if (idx === -1) return null;
  return result.reduce((sum, r) => {
    const hasOther = r.some((v, i) => i !== idx && v !== null && v !== undefined && v !== '');
    return hasOther ? sum + (parseFloat(r[idx]) || 0) : sum;
  }, 0);
}

/** Tính báo cáo 1 dự án cho khoảng ngày (mặc định tuần trước). */
async function compute({ project, from, to }) {
  const rowsOf = (r) => (Array.isArray(r && r.data) ? r.data : []);
  const weekRows = rowsOf(await erp.fetchTickets({ projects: [project], openingFrom: from, openingTo: to }))
    .filter((r) => inRange(dayOfRow(r), from, to));
  const backlogAllRows = rowsOf(await erp.fetchTickets({ projects: [project], statuses: BACKLOG_STATUSES }));
  const backlogRows = backlogAllRows.filter((r) => { const d = dayOfRow(r); return d && d <= to; });

  const periodDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const prevTo = addDays(from, -1); const prevFrom = addDays(prevTo, -periodDays + 1);
  const prevWeekRows = rowsOf(await erp.fetchTickets({ projects: [project], openingFrom: prevFrom, openingTo: prevTo }))
    .filter((r) => inRange(dayOfRow(r), prevFrom, prevTo));

  const st = (r) => String(r.status || '').trim();
  const weekByStatus = {}; BACKLOG_STATUSES.forEach((s) => { weekByStatus[s] = 0; });
  let received = 0; let closed = 0;
  weekRows.forEach((r) => {
    if (!dayOfRow(r)) return;
    if (BACKLOG_STATUSES.includes(st(r))) weekByStatus[st(r)]++;
    received++;
    if (st(r) === CLOSED_STATUS) closed++;
  });
  const backlogByStatus = {}; BACKLOG_STATUSES.forEach((s) => { backlogByStatus[s] = 0; });
  backlogRows.forEach((r) => { if (BACKLOG_STATUSES.includes(st(r))) backlogByStatus[st(r)]++; });
  const backlogNow = backlogRows.length;
  const backlogPrev = backlogRows.filter((r) => { const d = dayOfRow(r); return d && d < from; }).length;

  // Nhận xét tự động (giống trang)
  const unit = periodDays >= 28 ? 'tháng' : 'tuần';
  const prio = (r) => { const p = String(r.priority || '').trim().toLowerCase(); return (p === 'critical' || p === 'urgent') ? 'Critical/Urgent' : (p === 'high' ? 'High' : 'Medium/Low'); };
  const countPrio = (rows) => { const m = { 'Critical/Urgent': 0, High: 0, 'Medium/Low': 0 }; rows.forEach((r) => { m[prio(r)]++; }); return m; };
  const trend = (diff) => (diff > 0 ? `tăng ${diff}` : (diff < 0 ? `giảm ${Math.abs(diff)}` : 'không đổi'));
  const pctTxt = (cur, prev) => (prev > 0 ? ` (${cur >= prev ? '+' : '−'}${Math.abs(Math.round((cur - prev) / prev * 100))}%)` : '');
  const prevReceived = prevWeekRows.length;
  const curP = countPrio(weekRows); const prevP = countPrio(prevWeekRows);
  const prioLine = Object.keys(curP).map((k) => `${k} ${curP[k]} (${unit} trước ${prevP[k]}, ${trend(curP[k] - prevP[k])})`).join(' · ');
  const closedPct = received ? Math.round(closed / received * 100) : 0;
  const changePct = prevReceived > 0 ? (received - prevReceived) / prevReceived * 100 : null;
  let verdict;
  if (prevReceived === 0 && received === 0) verdict = `Không phát sinh ticket mới ở cả hai ${unit}.`;
  else if (changePct === null) verdict = `${unit[0].toUpperCase() + unit.slice(1)} trước không có ticket mở nên chưa so sánh được xu hướng.`;
  else if (changePct > 20) verdict = `Lượng ticket mở tăng đáng kể so với ${unit} trước.`;
  else if (changePct < -20) verdict = `Lượng ticket mở giảm rõ rệt so với ${unit} trước.`;
  else verdict = `Lượng ticket mở tương đối ổn định so với ${unit} trước.`;
  const urgentUp = curP['Critical/Urgent'] > prevP['Critical/Urgent'];
  const nhanxet =
    `Ticket mở (Opening On ${fmtDM(from)} → ${fmtDM(to)}): ${received} ticket (${unit} trước ${fmtDM(prevFrom)} → ${fmtDM(prevTo)}: ${prevReceived}) — ${trend(received - prevReceived)} ticket${pctTxt(received, prevReceived)} so với ${unit} trước.\n` +
    `Theo mức độ ưu tiên: ${prioLine}.\n` +
    `Đã xử lý (Closed) ${closed}/${received} ticket mở trong ${unit}${received ? ` (${closedPct}%)` : ''}; còn ${received - closed} ticket chưa Closed.\n` +
    `Tồn đọng: ${backlogPrev} ticket chưa Closed từ trước ${fmtDM(from)}; tổng ticket tồn đọng còn lại ${backlogNow}.\n` +
    `Đánh giá: ${verdict}${urgentUp ? ` Ticket Critical/Urgent tăng ${curP['Critical/Urgent'] - prevP['Critical/Urgent']} so với ${unit} trước, cần lưu ý.` : ''}`;

  const subj = (r) => String(r.subject || '').trim() || String(r.name || '').trim() || '(không có subject)';
  const order = (s) => { const i = NEXT_WEEK_STATUSES.indexOf(s); return i === -1 ? NEXT_WEEK_STATUSES.length + BACKLOG_STATUSES.indexOf(s) : i; };
  const tuansau = backlogRows.slice().sort((x, y) => order(st(x)) - order(st(y))).map(subj);
  const thuchien = weekRows.filter((r) => st(r) === CLOSED_STATUS).map(subj);

  let hours = '0H'; const notes = [];
  try {
    const h = extractTotalHours(await erp.fetchTimesheetReport({ from_date: from, to_date: to, project }));
    if (h === null) notes.push('không tìm được cột giờ trong Detail Timesheet Report'); else hours = h.toFixed(2) + 'H';
  } catch (e) { notes.push('lỗi lấy timesheet: ' + e.message); }

  const nextFrom = addDays(to, 1); const nextTo = addDays(to, 7);
  return {
    project, from, to,
    weekLabel: rangeLabel(from, to), doneRange: rangeLabel(from, to), nextRange: rangeLabel(nextFrom, nextTo),
    m: {
      closed, open: weekByStatus.Open, assign: weekByStatus.Assign, working: weekByStatus.Working, reviewing: weekByStatus.Reviewing,
      waiting: weekByStatus.Waiting, pending: weekByStatus.Pending, reopen: weekByStatus['Re-open'],
      hours, received, backlogPrev, processed: closed, backlogNow,
    },
    backlogByStatus, nhanxet, thuchien, tuansau, crs: 'không có', khac: 'không có', notes,
  };
}

/* ---------- biểu đồ PNG (cùng màu/bố cục với trang) ---------- */
const CHART_PALETTE = {
  Closed: '#5FA778', Open: '#B5533C', Assign: '#E3A857', Working: '#2E6F95', Reviewing: '#5B4B8A', Waiting: '#8FA6B3', Pending: '#C9821F', 'Re-open': '#8B2E2E',
  'Tồn đọng tuần trước': '#8FA6B3', 'Nhận': '#2E6F95', 'Xử lý': '#5FA778', 'Tồn đọng còn lại': '#B5533C',
};
const DEFAULT_COLORS = ['#2E6F95', '#E3A857', '#5FA778', '#B5533C', '#5B4B8A', '#8FA6B3'];
const color = (label, i) => CHART_PALETTE[label] || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function chartSeries(rep) {
  const m = rep.m;
  return {
    backlog: rep.backlogByStatus,
    week: { Closed: m.closed, Open: m.open, Assign: m.assign, Working: m.working, Reviewing: m.reviewing, Waiting: m.waiting, Pending: m.pending, 'Re-open': m.reopen },
    flow: { 'Tồn đọng tuần trước': m.backlogPrev, 'Nhận': m.received, 'Xử lý': m.processed, 'Tồn đọng còn lại': m.backlogNow },
  };
}

function donutPanel(x, y, title, counts) {
  const size = 150; const stroke = 24; const r = (size - stroke) / 2; const cx = x + 20 + size / 2; const cy = y + 46 + size / 2;
  const C = 2 * Math.PI * r; const entries = Object.entries(counts); const total = entries.reduce((a, [, v]) => a + v, 0);
  let off = 0; let out = `<text x="${x + 20}" y="${y + 26}" font-size="14" font-weight="bold" fill="#12233D">${xml(title)}</text>`;
  out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EEF2F6" stroke-width="${stroke}"/>`;
  entries.filter(([, v]) => v > 0).forEach(([label, v]) => {
    const dash = v / (total || 1) * C; const i = entries.findIndex(([l]) => l === label);
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color(label, i)}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += dash;
  });
  out += `<text x="${cx}" y="${cy + 2}" text-anchor="middle" font-size="22" font-weight="bold" fill="#12233D">${total}</text>`;
  out += `<text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="11" fill="#5B7089">ticket</text>`;
  entries.forEach(([label, v], i) => {
    const ly = y + 60 + i * 21; const lx = x + 200; const pct = Math.round(v / (total || 1) * 100);
    out += `<rect x="${lx}" y="${ly - 10}" width="11" height="11" rx="2" fill="${color(label, i)}"/>`;
    out += `<text x="${lx + 18}" y="${ly}" font-size="12.5" fill="#12233D">${xml(label)}</text>`;
    out += `<text x="${lx + 205}" y="${ly}" text-anchor="end" font-size="12.5" font-weight="bold" fill="#12233D">${v} <tspan font-weight="normal" fill="#5B7089">(${pct}%)</tspan></text>`;
  });
  return out;
}

function barPanel(x, y, w, title, counts, note) {
  const entries = Object.entries(counts); const max = Math.max(1, ...entries.map(([, v]) => v));
  const top = y + 64; const h = 150; const colW = w / entries.length;
  let out = `<text x="${x + 20}" y="${y + 26}" font-size="14" font-weight="bold" fill="#12233D">${xml(title)}</text>`;
  out += `<line x1="${x + 20}" y1="${top + h}" x2="${x + w - 20}" y2="${top + h}" stroke="#D8DEE6"/>`;
  entries.forEach(([label, v], i) => {
    const bh = Math.max(v / max * h, v > 0 ? 4 : 0); const bx = x + i * colW + colW / 2 - 34;
    out += `<rect x="${bx}" y="${top + h - bh}" width="68" height="${bh}" rx="3" fill="${color(label, i)}"/>`;
    out += `<text x="${bx + 34}" y="${top + h - bh - 7}" text-anchor="middle" font-size="14" font-weight="bold" fill="#12233D">${v}</text>`;
    out += `<text x="${bx + 34}" y="${top + h + 20}" text-anchor="middle" font-size="12" fill="#5B7089">${xml(label)}</text>`;
  });
  if (note) out += `<text x="${x + 20}" y="${top + h + 46}" font-size="11.5" fill="${note.ok ? '#5B7089' : '#B23A48'}">${xml(note.text)}</text>`;
  return out;
}

function chartSvg(rep) {
  const s = chartSeries(rep); const W = 900; const H = 560;
  const calc = s.flow['Tồn đọng tuần trước'] + s.flow['Nhận'] - s.flow['Xử lý'];
  const ok = calc === s.flow['Tồn đọng còn lại'];
  const note = { ok, text: `Tồn đọng tuần trước ${s.flow['Tồn đọng tuần trước']} + Nhận ${s.flow['Nhận']} − Xử lý ${s.flow['Xử lý']} = ${calc}${ok ? ' (khớp Tồn đọng còn lại)' : ` — lệch so với Tồn đọng còn lại ${s.flow['Tồn đọng còn lại']}`}` };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">` +
    `<rect width="${W}" height="${H}" fill="#FFFFFF"/>` +
    `<rect x="8" y="8" width="434" height="236" rx="8" fill="none" stroke="#D8DEE6"/>` +
    `<rect x="458" y="8" width="434" height="236" rx="8" fill="none" stroke="#D8DEE6"/>` +
    `<rect x="8" y="260" width="884" height="292" rx="8" fill="none" stroke="#D8DEE6"/>` +
    donutPanel(8, 8, `Tồn đọng còn lại (đến hết ${fmtDMY(rep.to)})`, s.backlog) +
    donutPanel(458, 8, `Ticket mở ${fmtDMY(rep.from)} → ${fmtDMY(rep.to)}`, s.week) +
    barPanel(8, 260, 884, `Tồn đọng / Nhận / Xử lý (${fmtDMY(rep.from)} → ${fmtDMY(rep.to)})`, s.flow, note) +
    '</svg>';
}

let resvg = null; let resvgErr = null;
try { resvg = require('@resvg/resvg-js'); } catch (e) { resvgErr = e.message; }
const FONT_DIR = path.join(__dirname, 'assets', 'fonts');
/** PNG của biểu đồ (Buffer) hoặc null nếu server thiếu thư viện vẽ. */
function chartPng(rep) {
  if (!resvg) { console.error('[weekly-erp] không vẽ được biểu đồ (thiếu @resvg/resvg-js):', resvgErr); return null; }
  const fontFiles = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map((f) => path.join(FONT_DIR, f)).filter((f) => fs.existsSync(f));
  const r = new resvg.Resvg(chartSvg(rep), { fitTo: { mode: 'zoom', value: 2 }, font: { fontFiles, loadSystemFonts: !fontFiles.length, defaultFontFamily: 'DejaVu Sans' } });
  return Buffer.from(r.render().asPng());
}

/* ---------- nội dung HTML (giống nút "Sao chép dạng bảng" trên trang) ---------- */
function buildHtml(rep, { chartUrl } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const BRAND = '#1F4E79'; const BORDER = '#D8DEE6'; const ZEBRA = '#F5F8FB'; const FONT = 'font-family:Arial,Helvetica,sans-serif;';
  const sectionHead = `${FONT}background:${BRAND};color:#fff;font-weight:700;font-size:13.5px;padding:8px 12px;margin:0;border-radius:5px 5px 0 0;`;
  const box = `border:1px solid ${BORDER};border-top:none;border-radius:0 0 5px 5px;padding:12px 14px;margin:0;`;
  const gap = '<div style="height:18px;line-height:18px;font-size:1px;">&nbsp;</div>';
  const th = `${FONT}text-align:left;background:${BRAND};color:#fff;font-size:12px;padding:7px 10px;border:1px solid ${BRAND};`;
  const td = `${FONT}font-size:12.5px;padding:6px 10px;border:1px solid ${BORDER};`;
  const table = 'border-collapse:collapse;width:100%;margin:0;';
  const list = (items) => (items.length
    ? `<ol style="${FONT}font-size:12.5px;line-height:1.65;margin:6px 0 0;padding-left:20px;">${items.map((s) => `<li style="margin-bottom:3px;">${esc(s)}</li>`).join('')}</ol>`
    : `<p style="${FONT}font-size:12.5px;color:#777;margin:4px 0;">(không có)</p>`);
  const rows = (pairs) => pairs.map(([k, v], i) => `<tr${i % 2 ? ` style="background:${ZEBRA};"` : ''}><td style="${td}">${esc(k)}</td><td style="${td}text-align:right;font-weight:700;">${esc(v)}</td></tr>`).join('');
  const m = rep.m;
  // biểu đồ đặt TRÊN CÙNG — giống nút "Sao chép bảng + hình ảnh" khi nhân viên dán tay vào Note
  const chart = chartUrl
    ? `<div style="${sectionHead}">Biểu đồ tuần</div><div style="${box}margin:0 0 4px;"><p style="margin:0;"><img src="${esc(chartUrl)}" alt="Biểu đồ tuần" style="max-width:680px;width:100%;"></p></div>`
    : '';
  return `
${chart}
<p style="${FONT}font-size:14px;margin:0 0 14px;"><b>Tuần báo cáo:</b> ${esc(rep.weekLabel)}</p>
<div style="${sectionHead}">1. Báo cáo số lượng ticket trong tuần</div>
<div style="${box}">
<table style="${table}"><tr><th style="${th}">Trạng thái</th><th style="${th}text-align:right;">Số lượng</th></tr>
${rows([['Closed', m.closed], ['Open', m.open], ['Assign', m.assign], ['Working', m.working], ['Reviewing', m.reviewing], ['Waiting', m.waiting], ['Pending', m.pending], ['Re-open', m.reopen]])}</table>
<div style="height:16px;line-height:16px;font-size:1px;">&nbsp;</div>
<table style="${table}"><tr><th style="${th}">Chỉ số</th><th style="${th}text-align:right;">Giá trị</th></tr>
${rows([['Time hỗ trợ', m.hours], ['Ticket nhận trong tuần/tháng', m.received], ['Ticket tồn động tuần/tháng trước', m.backlogPrev], ['Ticket xử lý trong tuần/tháng', m.processed], ['Tổng ticket tồn đọng còn lại', m.backlogNow]])}</table>
</div>
${gap}
<div style="${sectionHead}">2. Nhận xét / Vấn đề</div>
<div style="${box}">
<p style="${FONT}font-size:12.5px;margin:0 0 10px;"><i>Nhận xét chung về tình hình support tuần/tháng báo cáo so với tuần trước:</i><br>${esc(rep.nhanxet).replace(/\n/g, '<br>')}</p>
<p style="${FONT}font-size:12.5px;font-weight:700;margin:10px 0 0;">Thực hiện trong tuần: <span style="font-weight:400;color:#5B7089;">${esc(rep.doneRange)}</span></p>
${list(rep.thuchien)}
<p style="${FONT}font-size:12.5px;font-weight:700;margin:14px 0 0;">Xử lý tuần sau: <span style="font-weight:400;color:#5B7089;">${esc(rep.nextRange)}</span></p>
${list(rep.tuansau)}
</div>
${gap}
<div style="${sectionHead}">3. Báo cáo tình hình thực hiện CRs</div>
<div style="${box}"><p style="${FONT}font-size:12.5px;margin:0;">${esc(rep.crs || '(không có)')}</p></div>
${gap}
<div style="${sectionHead}">4. Báo cáo thông tin khác</div>
<div style="${box}"><p style="${FONT}font-size:12.5px;margin:0;">${esc(rep.khac || '(không có)')}</p></div>`.trim();
}

/* ---------- cấu hình ---------- */
async function getConfig() {
  const list = await configStore.readAll();
  const c = (Array.isArray(list) && list[0]) || {};
  return { ...DEFAULT_CONFIG, ...c, fields: { ...DEFAULT_CONFIG.fields, ...(c.fields || {}) }, extra: { ...(c.extra || {}) } };
}
const fieldName = (s) => String(s || '').trim().replace(/[^\w]/g, '').slice(0, 80);
async function saveConfig(input, user) {
  const cur = await getConfig();
  const f = input.fields || {};
  const extra = {};
  Object.entries(input.extra && typeof input.extra === 'object' ? input.extra : {}).forEach(([k, v]) => {
    const key = fieldName(k); if (key && v !== undefined && v !== null && String(v) !== '') extra[key] = typeof v === 'number' ? v : String(v).slice(0, 500);
  });
  const mode = input.mode === 'new-doc' ? 'new-doc' : (input.mode === 'note' ? 'note' : cur.mode);
  const next = {
    enabled: input.enabled === undefined ? cur.enabled : Boolean(input.enabled),
    mode,
    weekEnd: Number.isInteger(Number(input.weekEnd)) && Number(input.weekEnd) >= 0 && Number(input.weekEnd) <= 6 ? Number(input.weekEnd) : (cur.weekEnd || 0),
    docname: String(input.docname === undefined ? cur.docname : input.docname).trim().slice(0, 140) || '{project}',
    noteTable: fieldName(input.noteTable === undefined ? cur.noteTable : input.noteTable),
    noteField: fieldName(input.noteField === undefined ? cur.noteField : input.noteField),
    doctype: String(input.doctype === undefined ? cur.doctype : input.doctype).trim().slice(0, 140),
    fields: { project: fieldName(f.project), from: fieldName(f.from), to: fieldName(f.to), content: fieldName(f.content), title: fieldName(f.title) },
    titleTemplate: String(input.titleTemplate === undefined ? cur.titleTemplate : input.titleTemplate).slice(0, 200),
    submit: input.submit === undefined ? cur.submit : Boolean(input.submit),
    owners: (Array.isArray(input.owners) ? input.owners : (cur.owners || [])).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+$/.test(x)).slice(0, 30),
    projects: (Array.isArray(input.projects) ? input.projects : cur.projects).map((p) => String(p).trim()).filter(Boolean).slice(0, 50),
    extra,
    updatedAt: new Date().toISOString(), updatedBy: user || '',
  };
  if (!next.doctype) throw new Error('Chưa nhập DocType báo cáo trong ERP.');
  if (mode === 'new-doc' && !next.fields.content) throw new Error('Chưa chọn trường Nội dung (nơi ghi báo cáo).');
  if (mode === 'note' && (!next.noteTable || !next.noteField)) throw new Error('Chưa chọn bảng Note / trường nội dung Note.');
  await configStore.mutate(() => ({ list: [next], result: {} }), `weekly-erp: cấu hình tự động (${next.doctype})`);
  return next;
}

/** Các trường của DocType báo cáo + gợi ý ghép trường. */
async function doctypeInfo(doctype) {
  const meta = await erp.getDoctypeMeta(doctype);
  const f = meta.fields;
  const pick = (pred) => (f.find(pred) || {}).fieldname || '';
  const lab = (x) => `${x.label} ${x.fieldname}`.toLowerCase();
  const suggest = {
    project: pick((x) => x.fieldtype === 'Link' && x.options === 'Project'),
    from: pick((x) => /^date/i.test(x.fieldtype) && /(from|start|bắt đầu|từ)/.test(lab(x))) || pick((x) => /^date/i.test(x.fieldtype)),
    to: pick((x) => /^date/i.test(x.fieldtype) && /(to_|_to|\bto\b|end|kết thúc|đến)/.test(lab(x))),
    content: pick((x) => ['Text Editor', 'HTML Editor'].includes(x.fieldtype)) || pick((x) => ['Long Text', 'Text', 'Small Text'].includes(x.fieldtype)),
    title: meta.title_field || pick((x) => x.fieldtype === 'Data' && /(title|subject|tiêu đề)/.test(lab(x))),
  };
  // bảng Note: trường Table có DocType con chứa ô soạn thảo (Text Editor) — ưu tiên tên có "note"
  const noteTables = f.filter((x) => x.fieldtype === 'Table' && (meta.children[x.options] || []).some((c) => ['Text Editor', 'HTML Editor', 'Long Text', 'Text'].includes(c.fieldtype)));
  const nt = noteTables.find((x) => /note|progress|update/i.test(`${x.fieldname} ${x.label}`)) || noteTables[0];
  if (nt) {
    const cf = meta.children[nt.options];
    suggest.noteTable = nt.fieldname;
    suggest.noteField = (cf.find((c) => c.fieldtype === 'Text Editor' && /note/i.test(c.fieldname)) || cf.find((c) => ['Text Editor', 'HTML Editor'].includes(c.fieldtype)) || cf.find((c) => ['Long Text', 'Text'].includes(c.fieldtype))).fieldname;
  }
  return { doctype, fields: f, children: meta.children, is_submittable: meta.is_submittable, title_field: meta.title_field, suggest };
}

/* ---------- ghi vào ERP ---------- */
function titleOf(tpl, rep) {
  return String(tpl || DEFAULT_CONFIG.titleTemplate)
    .replace(/\{project\}/g, rep.project).replace(/\{week\}/g, rep.weekLabel)
    .replace(/\{from\}/g, fmtDMY(rep.from)).replace(/\{to\}/g, fmtDMY(rep.to)).slice(0, 140);
}

const slug = (dt) => encodeURIComponent(dt.toLowerCase().replace(/ /g, '-'));
const vnStamp = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const plainOf = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
/** Note đã có báo cáo của tuần này chưa (kể cả note nhân viên dán tay, dạng "Tuần báo cáo: (23 -> 29 tháng 10)"). */
function hasWeekNote(rows, field, rep) {
  const [, fm, fd] = parts(rep.from); const [, tm, td] = parts(rep.to);
  const re = new RegExp(`Tuần báo cáo:?\\s*\\(?\\s*${fd}(\\s*/\\s*${fm})?\\s*(->|→|-|–|đến)\\s*${td}\\s*(/\\s*${tm}|tháng\\s*${tm})`, 'i');
  return (rows || []).find((r) => re.test(plainOf(r[field])));
}

/** Mode "note": thêm báo cáo thành 1 Note mới trong bản ghi của dự án (giống bấm New Note → Add). */
async function pushNote(cfg, rep, { html: givenHtml, png: givenPng, force } = {}) {
  const dt = cfg.doctype; const name = String(cfg.docname || '{project}').replace(/\{project\}/g, rep.project);
  let parent;
  try { parent = await erp.getDoc(dt, name); }
  catch (e) { if (e.status === 404) throw new Error(`ERP chưa có bản ghi ${dt} "${name}" cho dự án này.`); throw e; }
  const meta = await erp.getDoctypeMeta(dt);
  const tf = meta.fields.find((f) => f.fieldname === cfg.noteTable && f.fieldtype === 'Table');
  if (!tf) throw new Error(`${dt} không có bảng "${cfg.noteTable}" — mở lại cấu hình, bấm Tải trường.`);
  const childFields = meta.children[tf.options] || [];
  const url = `${erp.getBaseUrl()}/app/${slug(dt)}/${encodeURIComponent(name)}`;
  if (!force) {
    const dup = hasWeekNote(parent[cfg.noteTable], cfg.noteField, rep);
    if (dup) return { skipped: true, doc: name, url, note: `trong ${name} đã có note báo cáo tuần ${rep.weekLabel}` };
  }
  const warnings = [];
  let chartUrl = '';
  try {
    const png = givenPng || chartPng(rep);
    if (png) chartUrl = ((await erp.uploadFileTo(dt, name, `bieu-do-tuan-${rep.project}-${rep.from}.png`, 'image/png', png)) || {}).file_url || '';
    else warnings.push('không vẽ được biểu đồ');
  } catch (e) { warnings.push('lỗi đính kèm biểu đồ: ' + e.message); }
  const html = givenHtml ? (chartUrl ? insertChart(givenHtml, chartUrl) : givenHtml) : buildHtml(rep, { chartUrl });
  const row = { doctype: tf.options, [cfg.noteField]: html };
  if (childFields.some((c) => c.fieldname === 'added_by')) row.added_by = await erp.getLoggedUser();
  if (childFields.some((c) => c.fieldname === 'added_on')) row.added_on = vnStamp();
  await erp.addChildRow(dt, name, cfg.noteTable, row);
  return { doc: name, url, submitted: false, added: 'note', warnings };
}

async function pushToErp(cfg, rep, opts = {}) {
  if (cfg.mode !== 'new-doc') return pushNote(cfg, rep, opts);
  const { html: givenHtml, png: givenPng } = opts;
  if (!cfg.doctype || !cfg.fields.content) throw new Error('Chưa cấu hình DocType / trường Nội dung cho báo cáo tự động.');
  const dt = cfg.doctype; const F = cfg.fields;
  const doc = { ...cfg.extra };
  if (F.project) doc[F.project] = rep.project;
  if (F.from) doc[F.from] = rep.from;
  if (F.to) doc[F.to] = rep.to;
  if (F.title) doc[F.title] = titleOf(cfg.titleTemplate, rep);
  doc[F.content] = givenHtml || buildHtml(rep);
  const created = await erp.createDoc(dt, doc);
  const name = created.name;
  const warnings = [];
  try {
    const png = givenPng || chartPng(rep);
    if (png) {
      const file = await erp.uploadFileTo(dt, name, `bieu-do-tuan-${rep.project}-${rep.from}.png`, 'image/png', png);
      const url = file && file.file_url;
      if (url) {
        const html = givenHtml ? insertChart(givenHtml, url) : buildHtml(rep, { chartUrl: url });
        await erp.updateDoc(dt, name, { [F.content]: html });
      }
    } else warnings.push('không vẽ được biểu đồ');
  } catch (e) { warnings.push('lỗi đính kèm biểu đồ: ' + e.message); }
  let submitted = false;
  if (cfg.submit) {
    try { submitted = await erp.submitDoc(dt, name); } catch (e) { warnings.push('đã tạo nhưng chưa Submit được: ' + e.message); }
  }
  return { doc: name, url: `${erp.getBaseUrl()}/app/${encodeURIComponent(dt.toLowerCase().replace(/ /g, '-'))}/${encodeURIComponent(name)}`, submitted, warnings };
}
// báo cáo đã sửa tay trên trang: chèn ảnh biểu đồ lên ĐẦU (giống "Sao chép bảng + hình ảnh")
function insertChart(html, url) {
  const u = String(url).replace(/"/g, '&quot;');
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#1F4E79;color:#fff;font-weight:700;font-size:13.5px;padding:8px 12px;margin:0;border-radius:5px 5px 0 0;">Biểu đồ tuần</div>` +
    `<div style="border:1px solid #D8DEE6;border-top:none;border-radius:0 0 5px 5px;padding:12px 14px;margin:0 0 4px;"><p style="margin:0;"><img src="${u}" alt="Biểu đồ tuần" style="max-width:680px;width:100%;"></p></div>` + html;
}

/* ---------- chạy ---------- */
const runKey = (project, from) => `${project}|${from}`;
async function readRuns() { const r = await runStore.readAll(); return Array.isArray(r) ? r : []; }
async function appendRuns(entries) {
  if (!entries.length) return;
  await runStore.mutate((all) => ({ list: [...entries, ...(Array.isArray(all) ? all : [])].slice(0, MAX_RUNS), result: {} }),
    `weekly-erp: ${entries.map((e) => `${e.project} ${e.from} ${e.ok ? (e.skipped ? 'bỏ qua' : 'ok') : 'lỗi'}`).join(', ')}`.slice(0, 200));
}

/** Chạy 1 dự án. dryRun: chỉ tính + trả HTML/PNG xem thử, không ghi ERP. html/png: báo cáo đã sửa tay trên trang. */
async function runOne({ project, from, to, by = '', force = false, dryRun = false, html, png, cfg, runs, log = true }) {
  let week = isIso(from) && isIso(to) ? { from, to } : null;
  try { cfg = cfg || await getConfig(); } catch (e) { cfg = null; }
  week = week || lastWeekVN(Date.now(), cfg ? cfg.weekEnd : 0);
  const base = { project, from: week.from, to: week.to, by, at: new Date().toISOString() };
  try {
    if (!cfg) cfg = await getConfig();
    if (!dryRun && !force) {
      const done = (runs || await readRuns()).find((r) => r.key === runKey(project, week.from) && r.ok && !r.skipped && r.doc);
      if (done) { const e = { ...base, key: runKey(project, week.from), ok: true, skipped: true, doc: done.doc, url: done.url, note: 'đã có báo cáo tuần này' }; if (log && !html) await appendRuns([e]); return e; } // gửi tay từ trang: hỏi lại người dùng, không ghi lịch sử
    }
    const rep = await compute({ project, from: week.from, to: week.to });
    if (dryRun) {
      const pngBuf = chartPng(rep);
      return { ...base, ok: true, dryRun: true, report: rep, html: buildHtml(rep, { chartUrl: pngBuf ? 'data:image/png;base64,' + pngBuf.toString('base64') : '' }) };
    }
    const r = await pushToErp(cfg, rep, { html, png, force });
    if (r.skipped) { const e = { ...base, key: runKey(project, week.from), ok: true, skipped: true, doc: r.doc, url: r.url, note: r.note }; if (log && !html) await appendRuns([e]); return e; }
    const e = { ...base, key: runKey(project, week.from), ok: true, doc: r.doc, url: r.url, submitted: r.submitted, added: r.added, note: [...rep.notes, ...r.warnings].join('; ') };
    if (log) await appendRuns([e]);
    return e;
  } catch (err) {
    const e = { ...base, key: runKey(project, week.from), ok: false, error: err.message };
    if (log && !dryRun) await appendRuns([e]).catch((x) => console.error('[weekly-erp] không ghi được lịch sử:', x.message));
    return e;
  }
}

/** Chạy tất cả dự án trong cấu hình (dùng cho lịch sáng thứ 2). */
async function runAll({ from, to, by = 'lịch tự động', force = false } = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { skipped: true, reason: 'Tự động đang tắt trong cấu hình.', results: [] };
  if (!cfg.doctype || (cfg.mode === 'new-doc' ? !cfg.fields.content : !(cfg.noteTable && cfg.noteField))) return { skipped: true, reason: 'Chưa cấu hình DocType / bảng Note (bấm Tải trường rồi Lưu trên trang).', results: [] };
  const runs = await readRuns();
  const results = [];
  for (const project of cfg.projects) results.push(await runOne({ project, from, to, by, force, cfg, runs, log: false }));
  await appendRuns(results).catch((x) => console.error('[weekly-erp] không ghi được lịch sử:', x.message));
  return { results };
}

module.exports = { getConfig, saveConfig, doctypeInfo, runOne, runAll, readRuns, lastWeekVN, compute, buildHtml, chartSvg, chartPng, DEFAULT_PROJECTS, isGithubBacked: () => configStore.isGithubBacked() };
