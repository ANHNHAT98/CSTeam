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
  ccAssignees: false,     // CC thêm người xử lý (người được giao, kể cả ngoài danh sách quản lý) của các ticket trễ trong mail
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
    ccAssignees: input.ccAssignees != null ? Boolean(input.ccAssignees) : Boolean(cur.ccAssignees),
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
  // Danh sách ticket qua API thường trả _assign rỗng → bổ sung người đang được giao từ ToDo (Assign To) đang mở, giống trang CS-AM / Effort
  if (overdue.length) {
    try {
      const todo = await erp.fetchTodoAssignees(overdue.map((t) => t.name), { activeOnly: true });
      overdue.forEach((t) => { t.assign = [...new Set([...t.assign, ...(todo[t.name] || [])])]; });
      // ticket vẫn chưa thấy ai (ToDo đã đóng khi chuyển trạng thái) → lấy lịch sử giao việc (ToDo chưa huỷ)
      const still = overdue.filter((t) => !t.assign.length).map((t) => t.name);
      if (still.length) {
        const hist = await erp.fetchTodoAssignees(still, { activeOnly: false });
        overdue.forEach((t) => { if (!t.assign.length && hist[t.name]) t.assign = hist[t.name]; });
      }
    } catch (e) { console.error('[sla-reminder] không đọc được ToDo:', e.message); }
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
let LABELS = null;
/** Tên ngắn dự án (Merap, ABI, AnVy…) lấy từ ticket-instructions/projects.json */
function labelOf(code) {
  if (!LABELS) {
    LABELS = {};
    try { JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'ticket-instructions', 'projects.json'), 'utf8')).forEach((x) => { if (x && x.code) LABELS[x.code] = x.name || x.label || x.code; }); } catch (e) { /* bỏ qua */ }
  }
  return LABELS[code] || code;
}
const labelsOf = (codes) => codes.map(labelOf).join(' · ');
const badge = (txt, bg, fg = '#fff') => `<span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${bg};color:${fg};font-size:11.5px;font-weight:600;white-space:nowrap">${esc(txt)}</span>`;
const dm = (s) => vnDate(s).slice(0, 5); // dd/mm

/** Bảng ticket của 1 dự án. owners = email người quản lý dự án → không lặp lại trong cột Người xử lý. */
function ticketTable(list, base, owners = []) {
  const own = new Set(owners);
  const link = (n) => (base ? `<a href="${esc(base)}/app/ticket/${encodeURIComponent(n)}" style="color:#1A56DB;font-weight:700;text-decoration:none;white-space:nowrap">${esc(n)}</a>` : `<b style="white-space:nowrap">${esc(n)}</b>`);
  const th = (h, w = '') => `<th align="left"${w ? ` width="${w}"` : ''} style="padding:9px 12px;background:#F4F6FA;color:#52606D;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #E3E8EF;${F};white-space:nowrap">${h}</th>`;
  const rows = list.map((t, n) => {
    const td = (extra = '') => `style="padding:11px 12px;border-bottom:1px solid #EDF0F5;vertical-align:top;background:${n % 2 ? '#FAFBFD' : '#FFFFFF'};${F};font-size:13px;color:#1F2933;${extra}"`;
    const people = (t.assign || []).filter((e) => !own.has(e));
    const who = !(t.assign || []).length ? '<span style="color:#B54708;font-weight:600">chưa giao</span>'
      : people.length ? people.map((e) => `<div style="white-space:nowrap">${esc(e)}</div>`).join('') : '<span style="color:#8792A2;white-space:nowrap">— (quản lý tự xử lý)</span>';
    return `<tr><td ${td('white-space:nowrap')}>${link(t.name)}<div style="margin-top:5px">${badge(t.priority, PRIO_COLOR[t.priority.toLowerCase()] || '#5F6B7A')}</div></td>`
      + `<td ${td()}><div style="font-weight:600;line-height:1.4">${esc(t.subject)}</div><div style="margin-top:4px;font-size:12px;color:#6B7685">${esc(t.status)}${t.noResponse ? ' · <span style="color:#B42318;font-weight:600">chưa phản hồi khách</span>' : ''}</div></td>`
      + `<td ${td('white-space:nowrap')}>${badge('Trễ ' + fmtDur(t.lateMin), '#FDECEC', '#B42318')}</td>`
      + `<td ${td('white-space:nowrap')}><b>${esc(vnDate(t.due))}</b><div style="font-size:12px;color:#8792A2;margin-top:3px">mở ${esc(vnDate(t.opening))}</div></td>`
      + `<td ${td('font-size:12.5px')}>${who}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E3E8EF;border-radius:8px">`
    + `<tr>${th('Ticket', '1%')}${th('Tiêu đề · Trạng thái')}${th('Trễ SLA', '1%')}${th('Hạn SLA', '1%')}${th('Người xử lý', '1%')}</tr>${rows}</table>`;
}
/** Khối 1 dự án: thanh tiêu đề có vạch màu bên trái */
const projectBlock = (code, list, owners, base) => `<tr><td style="padding:18px 28px 0">`
  + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-left:4px solid #B42318;padding:2px 0 2px 10px;${F}">`
  + `<span style="font-size:15px;font-weight:700;color:#1F2933">${esc(labelOf(code))}</span> <span style="font-size:12px;color:#8792A2">${esc(code)}</span></td>`
  + `<td align="right" style="${F};font-size:12.5px;color:#52606D;white-space:nowrap"><b style="color:#B42318">${list.length} ticket trễ</b>${owners.length ? ` · quản lý: <b>${esc(owners.map(nameOf).join(', '))}</b>` : ''}</td></tr></table>`
  + `<div style="height:8px;line-height:8px">&nbsp;</div>${ticketTable(list, base, owners)}</td></tr>`;
const statBox = (n, label, color, bg) => `<td width="25%" style="padding:0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${bg};border-radius:8px;padding:12px 14px;${F}"><div style="font-size:26px;font-weight:700;color:${color};line-height:1">${n}</div><div style="font-size:12px;color:#52606D;margin-top:4px">${label}</div></td></tr></table></td>`;
const stats = (items) => `<tr><td style="padding:14px 22px 2px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${items.map((x) => statBox(...x)).join('')}</tr></table></td></tr>`;
const p = (html) => `<tr><td style="padding:18px 28px 4px;${F};font-size:14.5px;color:#1F2933;line-height:1.6">${html}</td></tr>`;
/** Khung mail rộng 960px */
const wrap = (title, subtitle, rowsHtml, headColor = '#1F4E79') => `<div style="background:#F2F4F7;padding:24px 8px;${F}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:960px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E3E8EF">`
  + `<tr><td style="background:${headColor};padding:20px 28px;${F}"><div style="color:#fff;font-size:19px;font-weight:700">${title}</div><div style="color:#D6E4F0;font-size:13px;margin-top:6px;line-height:1.5">${subtitle}</div></td></tr>`
  + rowsHtml
  + `<tr><td style="padding:18px 28px 20px;${F};font-size:12px;color:#8792A2;border-top:1px solid #EEF2F7">SLA xử lý tính theo giờ làm việc T2–T6 (Critical/Urgent tính liên tục), trừ ngày lễ.</td></tr></table></div>`;
const statRow = (list) => stats([
  [list.length, 'ticket trễ SLA', '#B42318', '#FDECEC'],
  [list.filter((t) => !(t.assign || []).length).length, 'chưa giao ai', '#B54708', '#FFF4E5'],
  [list.filter((t) => t.noResponse).length, 'chưa phản hồi khách', '#1F4E79', '#EEF4FA'],
  [new Set(list.map((t) => t.project)).size, 'dự án có ticket trễ', '#2F7D4F', '#E9F5EE'],
]);

function buildMails(data, cfg, base) {
  const day = vnDate(data.at).slice(0, 10); const dd = day.slice(0, 5);
  const time = data.at.slice(11);
  const mails = [];
  const sendBy = cfg.sendBy || 'owner';
  const ownersOf = Object.fromEntries((data.byProject || []).map((r) => [r.project, r.owners || []]));
  const overdue = data.overdue || [];
  const blocks = (codes, list) => codes.map((c) => { const l = list.filter((t) => t.project === c); return l.length ? projectBlock(c, l, ownersOf[c] || [], base) : ''; }).join('');

  if (sendBy === 'all') {
    const to = [...new Set([...Object.keys(data.byOwner || {}), ...emails(cfg.summaryTo)])];
    if (to.length && (data.total || !cfg.skipEmpty)) {
      const rows = data.total
        ? p(`Chào cả team 👋,<br>Đầu tuần mình điểm qua chút nhé: các dự án đang có <b style="color:#B42318">${data.total} ticket đã trễ SLA xử lý</b> (tính đến ${esc(time)} ngày ${esc(day)}). Mọi người xem giúp ticket của dự án mình, ưu tiên xử lý hoặc cập nhật trạng thái / phản hồi khách để kéo SLA về lại nha. Cảm ơn cả nhà! 💪`)
          + statRow(overdue) + blocks(data.projects, overdue)
        : p('Chào cả team 👋,<br>Tuần này không có ticket nào trễ SLA. Cảm ơn mọi người, giữ vững phong độ nha! 🎉');
      const nProj = new Set(overdue.map((t) => t.project)).size;
      mails.push({ kind: 'all', to, cc: emails(cfg.cc).filter((x) => !to.includes(x)),
        subject: data.total ? `[Nhắc SLA ${dd}] ${data.total} ticket trễ · ${nProj} dự án` : `[Nhắc SLA ${dd}] Không có ticket trễ 🎉`,
        html: wrap('📧 Nhắc ticket trễ SLA đầu tuần', `Ngày ${esc(day)} · ${esc(labelsOf(data.projects))}`, rows, data.total ? '#1F4E79' : '#2F7D4F'), count: data.total });
    }
    return mails;
  }

  for (const [o, g] of Object.entries(data.byOwner || {})) {
    if (!g.tickets.length && cfg.skipEmpty) continue;
    const rows = g.tickets.length
      ? p(`Chào <b>${esc(nameOf(o))}</b> 👋,<br>Các dự án bạn đang quản lý có <b style="color:#B42318">${g.tickets.length} ticket đã trễ SLA xử lý</b> (tính đến ${esc(time)} ngày ${esc(day)}). Bạn xem giúp và nhắc anh em ưu tiên xử lý, hoặc cập nhật trạng thái / phản hồi khách giúp mình nhé. Cảm ơn bạn! 🙌`)
        + statRow(g.tickets) + blocks(g.projects, g.tickets)
      : p(`Chào <b>${esc(nameOf(o))}</b> 👋,<br>Tuần này các dự án bạn quản lý không có ticket nào trễ SLA. Giỏi quá, giữ phong độ nha! 🎉`);
    const withLate = g.projects.filter((c) => g.tickets.some((t) => t.project === c));
    const projTxt = withLate.length > 3 ? `${withLate.length} dự án` : labelsOf(withLate.length ? withLate : g.projects).replace(/ · /g, ', ');
    mails.push({ kind: 'owner', to: [o], cc: emails(cfg.cc).filter((x) => x !== o),
      subject: g.tickets.length ? `[Nhắc SLA ${dd}] ${g.tickets.length} ticket trễ · ${projTxt}` : `[Nhắc SLA ${dd}] Không có ticket trễ 🎉`,
      html: wrap('📧 Nhắc ticket trễ SLA đầu tuần', `Ngày ${esc(day)} · ${esc(labelsOf(g.projects))}`, rows, g.tickets.length ? '#1F4E79' : '#2F7D4F'), count: g.tickets.length });
  }

  const summaryTo = emails(cfg.summaryTo);
  if (summaryTo.length) {
    const th = (h, al = 'left') => `<th align="${al}" style="padding:9px 12px;background:#F4F6FA;color:#52606D;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #E3E8EF;${F}">${h}</th>`;
    const tdc = (v, n, al = 'left') => `<td align="${al}" style="padding:9px 12px;border-bottom:1px solid #EDF0F5;background:${n % 2 ? '#FAFBFD' : '#fff'};${F};font-size:13px">${v}</td>`;
    const projTable = `<tr><td style="padding:18px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E3E8EF"><tr>${th('Dự án')}${th('Người quản lý')}${th('Ticket trễ', 'right')}${th('Chưa giao', 'right')}</tr>`
      + (data.byProject || []).map((r, n) => { const l = overdue.filter((t) => t.project === r.project); return `<tr>${tdc(`<b>${esc(labelOf(r.project))}</b> <span style="color:#8792A2;font-size:12px">${esc(r.project)}</span>`, n)}${tdc(r.owners.length ? esc(r.owners.join(', ')) : '<span style="color:#B54708">chưa có người quản lý</span>', n)}${tdc(`<b style="color:${l.length ? '#B42318' : '#2F7D4F'}">${l.length}</b>`, n, 'right')}${tdc(l.filter((t) => !(t.assign || []).length).length, n, 'right')}</tr>`; }).join('')
      + '</table></td></tr>';
    let rows = statRow(overdue) + projTable;
    if (data.unassigned.length) rows += `<tr><td style="padding:18px 28px 0;${F};font-size:15px;font-weight:700;color:#B54708">Chưa giao cho ai (${data.unassigned.length})</td></tr><tr><td style="padding:8px 28px 0">${ticketTable(data.unassigned, base)}</td></tr>`;
    if (!data.total) rows += p('Không có ticket nào trễ SLA. 🎉');
    mails.push({ kind: 'summary', to: summaryTo, cc: [], subject: `[Nhắc SLA ${dd}] Tổng hợp ${data.total} ticket trễ`,
      html: wrap('📊 Tổng hợp ticket trễ SLA', `Ngày ${esc(day)} · ${esc(labelsOf(data.projects))}`, rows), count: data.total });
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
    const banner = `<div style="background:#FFF8E1;border:1px dashed #E0B252;color:#7A5300;padding:10px 14px;margin:0 auto 12px;max-width:960px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;border-radius:8px">🧪 <b>Mail thử</b> — bản thật sẽ gửi tới: ${esc(m.to.join(', '))}${m.cc.length ? ' · CC: ' + esc(m.cc.join(', ')) : ''}</div>`;
    const out = test ? { ...m, to: [test], cc: [], subject: `[THỬ] ${m.subject}`, html: banner + m.html } : m;
    try { await postWebhook(out); results.push({ to: m.to.join(', '), count: m.count, ok: true }); }
    catch (e) { results.push({ to: m.to.join(', '), count: m.count, ok: false, error: e.message }); }
  }
  const entry = { at: new Date().toISOString(), by, test: test || '', total: data.total, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  try { await runStore.mutate((all) => ({ list: [entry, ...(Array.isArray(all) ? all : [])].slice(0, MAX_RUNS), result: {} }), `sla-reminder: ${entry.sent} mail${entry.failed ? `, lỗi ${entry.failed}` : ''}${test ? ' (thử)' : ''}`); }
  catch (e) { console.error('[sla-reminder] không ghi được lịch sử:', e.message); }
  return { ok: entry.failed === 0, ...entry };
}

module.exports = { projectsOf, projectOptions, getConfig, saveConfig, compute, buildMails, run, readRuns, postWebhook, ALL_OPEN_STATUSES, webhookReady: () => mailOutbox.enabled() || Boolean(String(process.env.REMINDER_WEBHOOK_URL || '').trim()), mailMode: () => (mailOutbox.enabled() ? 'rss' : 'webhook'), isGithubBacked: () => configStore.isGithubBacked() };
