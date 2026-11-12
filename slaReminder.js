'use strict';
/* Nhắc ticket trễ SLA đầu tuần — gửi mail cho từng thành viên qua Power Automate (Render free chặn SMTP).
   - Lấy ticket chưa xong (trạng thái trong cấu hình) của các dự án đã chọn, tính trễ SLA xử lý theo đúng quy tắc
     của tool (weeklyReport.slaMinutes: Critical/Urgent tính liên tục, mức khác tính giờ làm việc, trừ ngày lễ).
   - Mỗi thành viên có ticket trễ (theo _assign) nhận 1 mail riêng. Người nhận tổng hợp nhận 1 mail gồm số trễ của từng
     người + ticket trễ chưa giao cho ai.
   - Gửi mail: POST JSON { to, cc, subject, html } tới URL webhook của flow Power Automate (env REMINDER_WEBHOOK_URL).
     Flow: "When a Teams webhook request is received" → Parse JSON → "Send an email (V2)".
   - Cấu hình: data/sla-reminder.json, lịch sử: data/sla-reminder-runs.json (qua listStore → GitHub nếu có).
   - Lịch: cron-job.org gọi POST /api/cron/sla-reminder?async=1 kèm header X-Cron-Key = CRON_SECRET. */

const erp = require('./erpClient');
const { createListStore } = require('./listStore');
const mailOutbox = require('./mailOutbox');
const { slaMinutes } = require('./weeklyReport');
const { slaDueAt, thresholdOf, parseNaive, fmtNaive, vnNow, prioRank } = require('./customerReport');

const configStore = createListStore({ repoFilePath: 'data/sla-reminder.json', localFile: 'data/sla-reminder.json' });
const runStore = createListStore({ repoFilePath: 'data/sla-reminder-runs.json', localFile: 'data/sla-reminder-runs.json' });
const MAX_RUNS = 200;

const ALL_OPEN_STATUSES = ['Open', 'Assign', 'Working', 'Reviewing', 'Waiting', 'Pending', 'Re-open'];
const DEFAULT_CONFIG = {
  enabled: true,
  members: ['lamlt1@hqsoft.com.vn', 'phuctm@hqsoft.com.vn', 'nhatha@hqsoft.com.vn', 'nhuttm@hqsoft.com.vn'],
  cc: [],                 // CC thêm vào mail của từng thành viên
  summaryTo: ['nhatha@hqsoft.com.vn'], // nhận mail tổng hợp (để trống = không gửi)
  projects: [],           // để trống = dùng danh sách dự án của Báo Cáo Tuần ERP tự động
  statuses: ['Open', 'Assign', 'Working', 'Reviewing', 'Re-open'], // Waiting/Pending = chờ khách → mặc định không nhắc
  skipEmpty: true,        // thành viên không có ticket trễ thì không gửi
  sendBy: 'owner',        // 'owner' = mỗi người quản lý 1 mail cho các dự án mình tích · 'all' = 1 mail chung tất cả dự án gửi cho mọi người quản lý
  owners: [],             // người quản lý dự án (khai báo tay): [{ email, projects: [mã dự án] }] — 1 dự án có thể nhiều người
};

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emails = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (email) => String(email || '').split('@')[0];

/** [{email, projects}] → chuẩn hoá, gộp email trùng. */
function parseOwners(v) {
  const map = new Map();
  for (const o of Array.isArray(v) ? v : []) {
    const e = String((o && o.email) || '').trim().toLowerCase();
    const ps = [...new Set((Array.isArray(o && o.projects) ? o.projects : []).map((x) => String(x).trim()).filter(Boolean))];
    if (!e && !ps.length) continue;
    if (!EMAIL_RE.test(e)) throw new Error(`Email người quản lý không hợp lệ: ${e || '(trống)'}`);
    const cur = map.get(e) || [];
    map.set(e, [...new Set([...cur, ...ps])]);
  }
  return [...map.entries()].map(([email, projects]) => ({ email, projects })).slice(0, 50);
}
const ownersProjects = (owners) => [...new Set((owners || []).flatMap((o) => o.projects || []))];

async function getConfig() {
  const list = await configStore.readAll();
  const c = (Array.isArray(list) && list[0]) || {};
  const out = { ...DEFAULT_CONFIG, ...c };
  if (!['owner', 'all'].includes(out.sendBy)) out.sendBy = 'owner';
  if (!Array.isArray(out.owners)) out.owners = [];
  return out;
}
async function saveConfig(input, user) {
  const cur = await getConfig();
  const members = emails(input.members != null ? input.members : cur.members);
  const cc = emails(input.cc != null ? input.cc : cur.cc);
  const summaryTo = emails(input.summaryTo != null ? input.summaryTo : cur.summaryTo);
  const bad = [...members, ...cc, ...summaryTo].filter((e) => !EMAIL_RE.test(e));
  if (bad.length) throw new Error(`Email không hợp lệ: ${bad.join(', ')}`);
  const sendBy = ['owner', 'all'].includes(input.sendBy) ? input.sendBy : (cur.sendBy || 'owner');
  const owners = parseOwners(input.owners != null ? input.owners : cur.owners);
  if (!owners.some((o) => o.projects.length)) throw new Error('Thêm ít nhất 1 người quản lý và tích dự án cho người đó.');
  const statuses = (Array.isArray(input.statuses) ? input.statuses : cur.statuses).filter((s) => ALL_OPEN_STATUSES.includes(s));
  if (!statuses.length) throw new Error('Chọn ít nhất 1 trạng thái.');
  const projects = ownersProjects(owners); // dự án cần nhắc = các dự án đã tích cho ít nhất 1 người quản lý
  const next = {
    enabled: input.enabled != null ? Boolean(input.enabled) : cur.enabled,
    members, cc, summaryTo, projects, statuses, sendBy, owners,
    skipEmpty: input.skipEmpty != null ? Boolean(input.skipEmpty) : cur.skipEmpty,
    updatedAt: new Date().toISOString(), updatedBy: user || '',
  };
  await configStore.mutate(() => ({ list: [next], result: {} }), `sla-reminder: cập nhật cấu hình (${user || ''})`);
  return next;
}

/** Dự án của Nhắc SLA — danh sách RIÊNG (cfg.projects). Cấu hình cũ chưa chọn riêng thì tạm dùng danh sách của Tự động gửi ERP. */
async function weeklyProjects() { try { const w = await require('./weeklyErpReport').getConfig(); return w.projects || []; } catch (e) { return []; } }
async function projectsOf(cfg) {
  const own = ownersProjects(cfg.owners);
  if (own.length) return own;
  if (cfg.projects && cfg.projects.length) return cfg.projects;
  return weeklyProjects();
}
/** Danh sách dự án để chọn: dự án trong ticket-instructions + dự án Tự động gửi ERP + dự án đã chọn. */
async function projectOptions(cfg) {
  const map = new Map();
  try {
    const list = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'ticket-instructions', 'projects.json'), 'utf8'));
    list.forEach((p) => p && p.code && map.set(p.code, p.name || p.label || p.code));
  } catch (e) { /* bỏ qua */ }
  (await weeklyProjects()).forEach((c) => { if (!map.has(c)) map.set(c, c); });
  (cfg.projects || []).forEach((c) => { if (!map.has(c)) map.set(c, c); });
  return [...map.entries()].map(([code, name]) => ({ code, name }));
}

function parseAssign(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : []; } catch (_) { return []; }
}
function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} phút`;
  const h = min / 60;
  if (h < 48) return `${Math.round(h * 10) / 10} giờ`;
  return `${Math.round((h / 24) * 10) / 10} ngày`;
}
const vnDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : ''; };

/** Tính danh sách ticket trễ SLA (xử lý) tại thời điểm now. */
async function compute({ cfg, now = vnNow() } = {}) {
  cfg = cfg || await getConfig();
  const projects = await projectsOf(cfg);
  if (!projects.length) throw new Error('Chưa chọn dự án nào cho Nhắc SLA (⚙ Cài đặt → 📧 Nhắc SLA đầu tuần).');
  const r = await erp.fetchTickets({ projects, statuses: cfg.statuses, limit: 5000 });
  const rows = r.data || r || [];
  const overdue = [];
  for (const t of rows) {
    const openStr = t.opening_date || t.creation;
    const openDt = parseNaive(openStr);
    if (!openDt) continue;
    const used = slaMinutes(t.priority, openDt, now);
    const th = thresholdOf(t.priority);
    if (used < th) continue;
    const due = slaDueAt(t.priority, openDt);
    overdue.push({
      name: t.name, subject: t.subject || '', project: t.project || '', priority: String(t.priority || '').trim() || '(không có)',
      status: t.status || '', opening: openStr, due: fmtNaive(due), lateMin: due ? (now - due) / 60000 : used - th,
      noResponse: !t.first_responded_on, assign: parseAssign(t._assign),
    });
  }
  overdue.sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || b.lateMin - a.lateMin);
  const members = emails(cfg.members);
  const byMember = Object.fromEntries(members.map((m) => [m, []]));
  const unassigned = []; const others = [];
  for (const t of overdue) {
    if (!t.assign.length) { unassigned.push(t); continue; }
    let hit = false;
    for (const a of t.assign) if (byMember[a]) { byMember[a].push(t); hit = true; }
    if (!hit) others.push(t);
  }
  // Người quản lý dự án (khai báo tay ở Cài đặt) → gom ticket trễ theo từng người; 1 dự án có thể nhiều người
  const ownersOf = {};
  (cfg.owners || []).forEach((o) => (o.projects || []).forEach((p) => { (ownersOf[p] = ownersOf[p] || []).push(o.email); }));
  const byOwner = {};
  (cfg.owners || []).forEach((o) => {
    const ps = (o.projects || []).filter((p) => projects.includes(p));
    if (ps.length) byOwner[o.email] = { projects: ps, tickets: overdue.filter((t) => ps.includes(t.project)) };
  });
  const noOwner = projects.filter((p) => !(ownersOf[p] || []).length);
  const byProject = projects.map((p) => ({ project: p, owners: ownersOf[p] || [], owner: (ownersOf[p] || []).join(', '), count: overdue.filter((t) => t.project === p).length }));
  return { at: fmtNaive(now), projects, total: overdue.length, byMember, unassigned, others, byOwner, noOwner, byProject, overdue };
}

/* ---------- mail HTML (style inline, dùng bảng để Outlook hiển thị đúng) ---------- */
const F = 'font-family:Segoe UI,Arial,Helvetica,sans-serif';
const PRIO_COLOR = { critical: '#C62828', urgent: '#E65100', high: '#B7791F', medium: '#2563EB', low: '#5F6B7A' };
const badge = (txt, bg, fg = '#fff') => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${fg};font-size:11.5px;font-weight:600;white-space:nowrap">${esc(txt)}</span>`;
function ticketTable(list, base, { showAssign = false } = {}) {
  const link = (n) => (base ? `<a href="${esc(base)}/app/ticket/${encodeURIComponent(n)}" style="color:#1A56DB;font-weight:700;text-decoration:none">${esc(n)}</a>` : `<b>${esc(n)}</b>`);
  const head = ['Ticket', 'Tiêu đề · Dự án · Trạng thái', 'Trễ SLA', 'Mở lúc / Hạn SLA', ...(showAssign ? ['Người xử lý'] : [])]
    .map((h) => `<th align="left" style="padding:8px 12px;background:#EEF2F7;color:#52606D;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #E3E8EF;${F}">${h}</th>`).join('');
  const rows = list.map((t, n) => {
    const td = `style="padding:10px 12px;border-bottom:1px solid #E3E8EF;vertical-align:top;background:${n % 2 ? '#F7F9FC' : '#FFFFFF'};${F};font-size:13px;color:#1F2933"`;
    return `<tr><td ${td}>${link(t.name)}<br>${badge(t.priority, PRIO_COLOR[t.priority.toLowerCase()] || '#5F6B7A')}</td>`
      + `<td ${td}><div style="font-weight:600">${esc(t.subject)}${t.noResponse ? ' <span style="color:#B42318;font-weight:600">· chưa phản hồi</span>' : ''}</div><div style="color:#6B7685;font-size:12px;margin-top:3px">${esc(t.project)} · ${esc(t.status)}</div></td>`
      + `<td ${td} nowrap>${badge('Trễ ' + fmtDur(t.lateMin), '#FDECEC', '#B42318')}</td>`
      + `<td ${td} nowrap><div style="color:#6B7685;font-size:12px">${esc(vnDate(t.opening))}</div><b>${esc(vnDate(t.due))}</b></td>`
      + (showAssign ? `<td ${td}>${esc(t.assign.map(nameOf).join(', ') || '—')}</td>` : '') + '</tr>';
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E3E8EF"><tr>${head}</tr>${rows}</table>`;
}
const section = (title, color, inner) => `<tr><td style="padding:16px 24px 6px;${F}"><div style="font-size:14px;font-weight:700;color:${color}">${title}</div></td></tr><tr><td style="padding:0 24px 8px">${inner}</td></tr>`;
const stat = (n, label, color) => `<td style="padding:0 22px 0 0;${F}"><div style="font-size:24px;font-weight:700;color:${color};line-height:1">${n}</div><div style="font-size:12px;color:#6B7685">${label}</div></td>`;
/** Khung mail: header + phần thân (các <tr>) + chân. */
const wrap = (title, subtitle, rowsHtml, headColor = '#1F4E79') => `<div style="background:#F2F4F7;padding:20px 0;${F}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:820px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #E3E8EF">`
  + `<tr><td style="background:${headColor};padding:16px 24px;${F}"><div style="color:#fff;font-size:17px;font-weight:700">${title}</div><div style="color:#D6E4F0;font-size:12.5px;margin-top:4px">${subtitle}</div></td></tr>`
  + rowsHtml
  + `<tr><td style="padding:12px 24px 18px;${F};font-size:11.5px;color:#8792A2;border-top:1px solid #EEF2F7">SLA xử lý tính theo giờ làm việc T2–T6 (Critical/Urgent tính liên tục), trừ ngày lễ — cùng quy tắc trang SLA của tool.<br>Mail tự động từ HQSOFT Ops Console.</td></tr></table></div>`;
const p = (html) => `<tr><td style="padding:16px 24px 4px;${F};font-size:14px;color:#1F2933;line-height:1.5">${html}</td></tr>`;

function buildMails(data, cfg, base) {
  const day = vnDate(data.at).slice(0, 10);
  const time = data.at.slice(11);
  const mails = [];
  const sendBy = cfg.sendBy || 'owner';
  if (sendBy === 'all') {
    // 1 mail chung: tất cả dự án, gửi cho mọi người quản lý + người nhận tổng hợp
    const to = [...new Set([...Object.keys(data.byOwner || {}), ...emails(cfg.summaryTo)])];
    if (to.length && (data.total || !cfg.skipEmpty)) {
      let rows = data.total
        ? p(`Chào anh/chị,<br>Các dự án hiện có <b style="color:#B42318">${data.total} ticket đã trễ SLA xử lý</b> (tính đến ${esc(time)} ngày ${esc(day)}). Nhờ người quản lý từng dự án nhắc người xử lý ưu tiên giải quyết hoặc cập nhật trạng thái / phản hồi khách.`)
          + `<tr><td style="padding:12px 24px 4px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${stat(data.total, 'ticket trễ SLA', '#B42318')}${stat(data.unassigned.length, 'chưa giao ai', '#B54708')}${stat((data.overdue || []).filter((t) => t.noResponse).length, 'chưa phản hồi khách', '#5F6B7A')}</tr></table></td></tr>`
        : p('Các dự án không có ticket nào trễ SLA. 🎉');
      for (const r of data.byProject || []) {
        const list = (data.overdue || []).filter((t) => t.project === r.project);
        if (list.length) rows += section(`${esc(r.project)} — ${list.length} ticket trễ${r.owners.length ? ` · quản lý: ${esc(r.owners.map(nameOf).join(', '))}` : ''}`, '#B42318', ticketTable(list, base, { showAssign: true }));
      }
      mails.push({ kind: 'all', to, cc: emails(cfg.cc).filter((x) => !to.includes(x)), subject: `[Nhắc SLA] ${data.total} ticket trễ SLA – tất cả dự án – ${day}`,
        html: wrap('📧 Nhắc ticket trễ SLA đầu tuần', `Ngày ${esc(day)} · ${esc(data.projects.join(', '))}`, rows, data.total ? '#1F4E79' : '#2F7D4F'), count: data.total });
    }
    return mails;
  }
  if (sendBy === 'owner') {
    for (const [o, g] of Object.entries(data.byOwner || {})) {
      if (!g.tickets.length && cfg.skipEmpty) continue;
      let rows = g.tickets.length
        ? p(`Chào <b>${esc(nameOf(o))}</b>,<br>Các dự án bạn quản lý hiện có <b style="color:#B42318">${g.tickets.length} ticket đã trễ SLA xử lý</b> (tính đến ${esc(time)} ngày ${esc(day)}). Bạn nhắc người xử lý ưu tiên giải quyết hoặc cập nhật trạng thái / phản hồi khách giúp nhé.`)
          + `<tr><td style="padding:12px 24px 4px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${stat(g.tickets.length, 'ticket trễ SLA', '#B42318')}${stat(g.tickets.filter((t) => !t.assign.length).length, 'chưa giao ai', '#B54708')}${stat(g.tickets.filter((t) => t.noResponse).length, 'chưa phản hồi khách', '#5F6B7A')}</tr></table></td></tr>`
        : p(`Chào <b>${esc(nameOf(o))}</b>,<br>Các dự án bạn quản lý không có ticket nào trễ SLA. 🎉`);
      for (const pj of g.projects) {
        const list = g.tickets.filter((t) => t.project === pj);
        if (list.length) rows += section(`${esc(pj)} — ${list.length} ticket trễ`, '#B42318', ticketTable(list, base, { showAssign: true }));
      }
      mails.push({ kind: 'owner', to: [o], cc: emails(cfg.cc).filter((x) => x !== o),
        subject: g.tickets.length ? `[Nhắc SLA] ${g.tickets.length} ticket trễ SLA – dự án ${g.projects.join(', ')} – ${day}` : `[Nhắc SLA] Không có ticket trễ – ${day}`,
        html: wrap('📧 Nhắc ticket trễ SLA đầu tuần', `Ngày ${esc(day)} · Dự án: ${esc(g.projects.join(', '))}`, rows, g.tickets.length ? '#1F4E79' : '#2F7D4F'), count: g.tickets.length });
    }
  }
  for (const [m, list] of (sendBy === 'owner' ? [] : Object.entries(data.byMember))) {
    if (!list.length && cfg.skipEmpty) continue;
    const rows = list.length
      ? p(`Chào <b>${esc(nameOf(m))}</b>,<br>Hiện bạn có <b style="color:#B42318">${list.length} ticket đã trễ SLA xử lý</b> (tính đến ${esc(time)} ngày ${esc(day)}). Bạn ưu tiên xử lý hoặc cập nhật trạng thái / phản hồi khách giúp nhé.`)
        + section('Ticket trễ SLA của bạn', '#B42318', ticketTable(list, base))
      : p(`Chào <b>${esc(nameOf(m))}</b>,<br>Bạn không có ticket nào trễ SLA. Cảm ơn bạn! 🎉`);
    mails.push({ kind: 'member', to: [m], cc: emails(cfg.cc).filter((x) => x !== m),
      subject: list.length ? `[Nhắc SLA] Bạn có ${list.length} ticket trễ SLA – ${day}` : `[Nhắc SLA] Không có ticket trễ – ${day}`,
      html: wrap('📧 Nhắc ticket trễ SLA đầu tuần', `Ngày ${esc(day)} · ${esc(data.projects.join(', '))}`, rows, list.length ? '#1F4E79' : '#2F7D4F'), count: list.length });
  }
  const summaryTo = emails(cfg.summaryTo);
  if (summaryTo.length) {
    const tr = Object.entries(data.byMember).map(([m, l], n) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #E3E8EF;background:${n % 2 ? '#F7F9FC' : '#fff'};${F};font-size:13px">${esc(m)}</td><td align="right" style="padding:8px 12px;border-bottom:1px solid #E3E8EF;background:${n % 2 ? '#F7F9FC' : '#fff'};${F};font-size:13px"><b style="color:${l.length ? '#B42318' : '#2F7D4F'}">${l.length}</b></td></tr>`).join('');
    const memberTable = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E3E8EF;min-width:360px"><tr><th align="left" style="padding:8px 12px;background:#EEF2F7;color:#52606D;font-size:11.5px;text-transform:uppercase;${F}">Thành viên</th><th align="right" style="padding:8px 12px;background:#EEF2F7;color:#52606D;font-size:11.5px;text-transform:uppercase;${F}">Ticket trễ</th></tr>${tr}</table>`;
    const assigned = Object.values(data.byMember).reduce((a, l) => a + l.length, 0);
    const th = (h, al = 'left') => `<th align="${al}" style="padding:8px 12px;background:#EEF2F7;color:#52606D;font-size:11.5px;text-transform:uppercase;${F}">${h}</th>`;
    const tdc = (v, n, al = 'left') => `<td align="${al}" style="padding:8px 12px;border-bottom:1px solid #E3E8EF;background:${n % 2 ? '#F7F9FC' : '#fff'};${F};font-size:13px">${v}</td>`;
    const projTable = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E3E8EF;min-width:480px"><tr>${th('Dự án')}${th('Người quản lý')}${th('Ticket trễ', 'right')}</tr>`
      + (data.byProject || []).map((r, n) => `<tr>${tdc(esc(r.project), n)}${tdc(r.owner ? esc(r.owner) : '<span style="color:#B54708">chưa có người quản lý</span>', n)}${tdc(`<b style="color:${r.count ? '#B42318' : '#2F7D4F'}">${r.count}</b>`, n, 'right')}</tr>`).join('') + '</table>';
    let rows = `<tr><td style="padding:16px 24px 4px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${stat(data.total, 'ticket trễ SLA', '#B42318')}${stat(data.unassigned.length, 'chưa giao ai', '#B54708')}${sendBy === 'owner' ? '' : stat(data.others.length, 'giao người ngoài DS', '#5F6B7A')}</tr></table></td></tr>`
      + section('Theo dự án', '#1F4E79', projTable)
      + (sendBy === 'owner' ? '' : section('Theo người được giao', '#1F4E79', memberTable));
    if (data.unassigned.length) rows += section(`Chưa giao cho ai (${data.unassigned.length})`, '#B54708', ticketTable(data.unassigned, base));
    if (data.others.length && sendBy !== 'owner') rows += section(`Giao cho người ngoài danh sách (${data.others.length})`, '#5F6B7A', ticketTable(data.others, base, { showAssign: true }));
    if (!data.total) rows += p('Không có ticket nào trễ SLA. 🎉');
    mails.push({ kind: 'summary', to: summaryTo, cc: [], subject: `[Nhắc SLA] Tổng hợp ${data.total} ticket trễ SLA – ${day}`,
      html: wrap('📊 Tổng hợp ticket trễ SLA', `Ngày ${esc(day)} · ${sendBy === 'owner' ? 'gửi theo người quản lý dự án' : assigned + ' ticket đã giao trong danh sách'} · ${esc(data.projects.join(', '))}`, rows), count: data.total });
  }
  return mails;
}

async function postWebhook(mail) {
  // Công ty chặn gọi webhook từ ngoài → có MAIL_FEED_KEY thì ghi vào hộp thư chờ, Power Automate đọc qua RSS (mailOutbox.js)
  if (mailOutbox.enabled()) { await mailOutbox.enqueue(mail); return; }
  const url = String(process.env.REMINDER_WEBHOOK_URL || '').trim();
  if (!url) throw new Error('Server chưa cấu hình REMINDER_WEBHOOK_URL (URL webhook của flow Power Automate).');
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: mail.to.join(';'), cc: mail.cc.join(';'), subject: mail.subject, html: mail.html }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Power Automate trả ${res.status}: ${t.slice(0, 200)}`); }
}

async function readRuns() { const r = await runStore.readAll(); return Array.isArray(r) ? r : []; }

/** dryRun: chỉ trả nội dung mail. testTo: gửi tất cả mail về 1 địa chỉ (không CC) để thử. */
async function run({ dryRun = false, testTo = '', by = 'lịch tự động' } = {}) {
  const cfg = await getConfig();
  if (!dryRun && !testTo && !cfg.enabled) return { skipped: true, reason: 'Nhắc SLA đang tắt.' };
  const data = await compute({ cfg });
  const mails = buildMails(data, cfg, erp.getBaseUrl());
  if (dryRun) return { ok: true, dryRun: true, total: data.total, at: data.at, projects: data.projects, mails };
  const test = emails(testTo)[0];
  if (testTo && !EMAIL_RE.test(test || '')) throw new Error('Email gửi thử không hợp lệ.');
  const results = [];
  for (const m of mails) {
    const out = test ? { ...m, to: [test], cc: [], subject: `[THỬ → ${m.to.join(', ')}] ${m.subject}` } : m;
    try { await postWebhook(out); results.push({ to: m.to.join(', '), count: m.count, ok: true }); }
    catch (e) { results.push({ to: m.to.join(', '), count: m.count, ok: false, error: e.message }); }
  }
  const entry = { at: new Date().toISOString(), by, test: test || '', total: data.total, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  try { await runStore.mutate((all) => ({ list: [entry, ...(Array.isArray(all) ? all : [])].slice(0, MAX_RUNS), result: {} }), `sla-reminder: ${entry.sent} mail${entry.failed ? `, lỗi ${entry.failed}` : ''}${test ? ' (thử)' : ''}`); }
  catch (e) { console.error('[sla-reminder] không ghi được lịch sử:', e.message); }
  return { ok: entry.failed === 0, ...entry };
}

module.exports = { projectsOf, projectOptions, getConfig, saveConfig, compute, buildMails, run, readRuns, postWebhook, ALL_OPEN_STATUSES, webhookReady: () => mailOutbox.enabled() || Boolean(String(process.env.REMINDER_WEBHOOK_URL || '').trim()), mailMode: () => (mailOutbox.enabled() ? 'rss' : 'webhook'), isGithubBacked: () => configStore.isGithubBacked() };
