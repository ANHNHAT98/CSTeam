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
};

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emails = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (email) => String(email || '').split('@')[0];

async function getConfig() {
  const list = await configStore.readAll();
  const c = (Array.isArray(list) && list[0]) || {};
  return { ...DEFAULT_CONFIG, ...c };
}
async function saveConfig(input, user) {
  const cur = await getConfig();
  const members = emails(input.members != null ? input.members : cur.members);
  const cc = emails(input.cc != null ? input.cc : cur.cc);
  const summaryTo = emails(input.summaryTo != null ? input.summaryTo : cur.summaryTo);
  const bad = [...members, ...cc, ...summaryTo].filter((e) => !EMAIL_RE.test(e));
  if (bad.length) throw new Error(`Email không hợp lệ: ${bad.join(', ')}`);
  if (!members.length) throw new Error('Cần ít nhất 1 thành viên nhận nhắc.');
  const statuses = (Array.isArray(input.statuses) ? input.statuses : cur.statuses).filter((s) => ALL_OPEN_STATUSES.includes(s));
  if (!statuses.length) throw new Error('Chọn ít nhất 1 trạng thái.');
  const projects = [...new Set((Array.isArray(input.projects) ? input.projects : cur.projects).map((s) => String(s).trim()).filter(Boolean))].slice(0, 100);
  const next = {
    enabled: input.enabled != null ? Boolean(input.enabled) : cur.enabled,
    members, cc, summaryTo, projects, statuses,
    skipEmpty: input.skipEmpty != null ? Boolean(input.skipEmpty) : cur.skipEmpty,
    updatedAt: new Date().toISOString(), updatedBy: user || '',
  };
  await configStore.mutate(() => ({ list: [next], result: {} }), `sla-reminder: cập nhật cấu hình (${user || ''})`);
  return next;
}

async function projectsOf(cfg) {
  if (cfg.projects && cfg.projects.length) return cfg.projects;
  try { const w = await require('./weeklyErpReport').getConfig(); return w.projects || []; } catch (e) { return []; }
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
  if (!projects.length) throw new Error('Chưa có dự án nào (chọn ở tab Nhắc SLA hoặc lưu cấu hình Báo Cáo Tuần ERP tự động).');
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
  return { at: fmtNaive(now), projects, total: overdue.length, byMember, unassigned, others };
}

/* ---------- mail HTML (style inline cho Outlook) ---------- */
const TH = 'style="background:#1f3a5f;color:#fff;padding:6px 8px;border:1px solid #c9d3e0;text-align:left;font-size:13px"';
const TD = 'style="padding:6px 8px;border:1px solid #c9d3e0;font-size:13px;vertical-align:top"';
const PRIO_COLOR = { critical: '#b91c1c', urgent: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#4b5563' };
function ticketTable(list, base, { showAssign = false } = {}) {
  const link = (n) => (base ? `<a href="${esc(base)}/app/ticket/${encodeURIComponent(n)}">${esc(n)}</a>` : esc(n));
  const rows = list.map((t) => `<tr>
<td ${TD}>${link(t.name)}</td><td ${TD}>${esc(t.project)}</td><td style="padding:6px 8px;border:1px solid #c9d3e0;font-size:13px;vertical-align:top;min-width:220px">${esc(t.subject)}${t.noResponse ? ' <span style="color:#b91c1c">(chưa phản hồi)</span>' : ''}</td>
<td ${TD}><b style="color:${PRIO_COLOR[t.priority.toLowerCase()] || '#111'}">${esc(t.priority)}</b></td><td ${TD}>${esc(t.status)}</td>
<td ${TD}>${esc(vnDate(t.opening))}</td><td ${TD}>${esc(vnDate(t.due))}</td><td ${TD}><b style="color:#b91c1c">${esc(fmtDur(t.lateMin))}</b></td>${showAssign ? `<td ${TD}>${esc(t.assign.map(nameOf).join(', ') || '—')}</td>` : ''}</tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif"><thead><tr>
<th ${TH}>Ticket</th><th ${TH}>Dự án</th><th ${TH}>Tiêu đề</th><th ${TH}>Ưu tiên</th><th ${TH}>Trạng thái</th><th ${TH}>Mở lúc</th><th ${TH}>Hạn SLA</th><th ${TH}>Trễ</th>${showAssign ? `<th ${TH}>Người xử lý</th>` : ''}
</tr></thead><tbody>${rows}</tbody></table>`;
}
const wrap = (body) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111">${body}
<p style="color:#6b7280;font-size:12px;margin-top:16px">Mail tự động từ CS Tool — SLA tính theo giờ làm việc (Critical/Urgent tính liên tục), trừ ngày lễ.</p></div>`;

function buildMails(data, cfg, base) {
  const day = vnDate(data.at).slice(0, 10);
  const mails = [];
  for (const [m, list] of Object.entries(data.byMember)) {
    if (!list.length && cfg.skipEmpty) continue;
    const body = list.length
      ? `<p>Chào ${esc(nameOf(m))},</p><p>Hiện bạn có <b style="color:#b91c1c">${list.length} ticket đã trễ SLA</b> (tính đến ${esc(data.at.slice(11))} ngày ${esc(day)}). Bạn vui lòng ưu tiên xử lý hoặc cập nhật trạng thái/phản hồi khách giúp nhé.</p>${ticketTable(list, base)}`
      : `<p>Chào ${esc(nameOf(m))},</p><p>Bạn không có ticket nào trễ SLA. Cảm ơn bạn! 🎉</p>`;
    mails.push({ kind: 'member', to: [m], cc: emails(cfg.cc).filter((x) => x !== m), subject: list.length ? `[Nhắc SLA] Bạn có ${list.length} ticket trễ SLA – ${day}` : `[Nhắc SLA] Không có ticket trễ – ${day}`, html: wrap(body), count: list.length });
  }
  const summaryTo = emails(cfg.summaryTo);
  if (summaryTo.length) {
    const rows = Object.entries(data.byMember).map(([m, l]) => `<tr><td ${TD}>${esc(m)}</td><td ${TD} align="right"><b style="color:${l.length ? '#b91c1c' : '#15803d'}">${l.length}</b></td></tr>`).join('');
    let body = `<p>Tổng hợp ticket trễ SLA ngày ${esc(day)}: <b>${data.total}</b> ticket (dự án: ${esc(data.projects.join(', '))}).</p>
<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif"><thead><tr><th ${TH}>Thành viên</th><th ${TH}>Ticket trễ</th></tr></thead><tbody>${rows}</tbody></table>`;
    if (data.unassigned.length) body += `<h3 style="margin:18px 0 6px">Chưa giao cho ai (${data.unassigned.length})</h3>${ticketTable(data.unassigned, base)}`;
    if (data.others.length) body += `<h3 style="margin:18px 0 6px">Giao cho người ngoài danh sách (${data.others.length})</h3>${ticketTable(data.others, base, { showAssign: true })}`;
    mails.push({ kind: 'summary', to: summaryTo, cc: [], subject: `[Nhắc SLA] Tổng hợp ${data.total} ticket trễ SLA – ${day}`, html: wrap(body), count: data.total });
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

module.exports = { projectsOf, getConfig, saveConfig, compute, buildMails, run, readRuns, postWebhook, ALL_OPEN_STATUSES, webhookReady: () => mailOutbox.enabled() || Boolean(String(process.env.REMINDER_WEBHOOK_URL || '').trim()), mailMode: () => (mailOutbox.enabled() ? 'rss' : 'webhook'), isGithubBacked: () => configStore.isGithubBacked() };
