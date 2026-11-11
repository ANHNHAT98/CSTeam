'use strict';
/* Cảnh báo ticket Jira ABI SẮP TRỄ First Response — gửi mail trước N phút (mặc định 30) qua Power Automate.
   - Lấy issue đang mở theo JQL cấu hình (mặc định project HQ = Jira ABI của khách), đọc SLA "Time to first response"
     của Jira Service Management. Chỉ xét chu kỳ ĐANG CHẠY (chưa phản hồi), không tạm dừng; dùng đúng số phút còn lại
     Jira tự tính (remainingTime) nên khớp lịch làm việc/ngày nghỉ cấu hình trên Jira.
   - Còn ≤ N phút → đưa vào mail cảnh báo. Tuỳ chọn: báo luôn ticket ĐÃ trễ mà chưa phản hồi (1 lần).
   - Mỗi ticket chỉ báo 1 lần cho mỗi chu kỳ SLA (lưu ở data/jira-frt-alert-state.json) → cron chạy 5 phút/lần không gửi trùng.
   - Gửi: POST { to, cc, subject, html } tới REMINDER_WEBHOOK_URL (dùng chung flow Power Automate với Nhắc SLA).
   - Lịch: cron-job.org gọi POST /api/cron/jira-frt-alert?async=1 kèm header X-Cron-Key = CRON_SECRET, mỗi 5 phút.
   - Lịch sử: chỉ ghi các lượt có gửi mail / lỗi / gửi thử (tránh ghi GitHub mỗi 5 phút). */

const jira = require('./jiraClient');
const { createListStore } = require('./listStore');
const { postWebhook } = require('./slaReminder');

const configStore = createListStore({ repoFilePath: 'data/jira-frt-alert.json', localFile: 'data/jira-frt-alert.json' });
const stateStore = createListStore({ repoFilePath: 'data/jira-frt-alert-state.json', localFile: 'data/jira-frt-alert-state.json' });
const runStore = createListStore({ repoFilePath: 'data/jira-frt-alert-runs.json', localFile: 'data/jira-frt-alert-runs.json' });
const MAX_RUNS = 200;
const STATE_KEEP_MS = 7 * 24 * 3600 * 1000;

const PRIOS = ['P1', 'P2', 'S1', 'P3', 'S2', 'P4', 'S3'];
// Bảng cam kết First Response (phút) — chỉ để đối chiếu với mục tiêu SLA cấu hình trên Jira
const COMMIT_FRT = { P1: 15, P2: 60, S1: 60, P3: 240, S2: 240, P4: 480, S3: 480 };
const DEFAULT_JQL = 'project = "HQ" AND statusCategory != Done AND created >= -30d ORDER BY created DESC';
const DEFAULT_CONFIG = {
  enabled: true,
  // báo khi ticket đã chạy SLA First Response được bấy nhiêu phút mà chưa phản hồi (theo mức P/S; giờ tính theo lịch SLA của Jira)
  afterMinutes: { P1: 5, P2: 30, S1: 30, P3: 60, S2: 60, P4: 60, S3: 60 },
  afterDefault: 60,                // priority không có trong bảng
  to: ['lamlt1@hqsoft.com.vn', 'viltt@hqsoft.com.vn'],
  cc: ['nhatha@hqsoft.com.vn'],
  includeAssignee: true,           // thêm email người được giao trên Jira (nếu Jira cho xem email)
  alertBreached: false,            // báo cả ticket đã trễ mà chưa phản hồi (1 lần)
  jql: DEFAULT_JQL,
};

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emails = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtVN = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); };
const fmtMin = (m) => { const a = Math.abs(Math.round(m)); const h = Math.floor(a / 60); return h ? `${h} giờ ${a % 60} phút` : `${a} phút`; };

async function getConfig() {
  const list = await configStore.readAll();
  const c = (Array.isArray(list) && list[0]) || {};
  const out = { ...DEFAULT_CONFIG, ...c };
  out.afterMinutes = { ...DEFAULT_CONFIG.afterMinutes, ...(c.afterMinutes || {}) };
  delete out.leadMinutes;
  return out;
}
async function saveConfig(input, user) {
  const cur = await getConfig();
  const to = emails(input.to != null ? input.to : cur.to);
  const cc = emails(input.cc != null ? input.cc : cur.cc);
  const bad = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
  if (bad.length) throw new Error(`Email không hợp lệ: ${bad.join(', ')}`);
  const includeAssignee = input.includeAssignee != null ? Boolean(input.includeAssignee) : cur.includeAssignee;
  if (!to.length && !includeAssignee) throw new Error('Cần ít nhất 1 người nhận (hoặc bật gửi cho người được giao).');
  const srcAfter = input.afterMinutes && typeof input.afterMinutes === 'object' ? input.afterMinutes : cur.afterMinutes;
  const afterMinutes = {};
  for (const k of PRIOS) {
    const v = Math.round(Number(srcAfter[k] != null ? srcAfter[k] : DEFAULT_CONFIG.afterMinutes[k]));
    if (!(v >= 1 && v <= 2400)) throw new Error(`Số phút của ${k} phải từ 1 đến 2400.`);
    afterMinutes[k] = v;
  }
  const afterDefault = Math.round(Number(input.afterDefault != null ? input.afterDefault : cur.afterDefault));
  if (!(afterDefault >= 1 && afterDefault <= 2400)) throw new Error('Số phút mặc định phải từ 1 đến 2400.');
  const jql = String(input.jql != null ? input.jql : cur.jql).trim() || DEFAULT_JQL;
  if (jql.length > 1000) throw new Error('JQL quá dài.');
  const next = {
    enabled: input.enabled != null ? Boolean(input.enabled) : cur.enabled,
    afterMinutes, afterDefault, to, cc, includeAssignee,
    alertBreached: input.alertBreached != null ? Boolean(input.alertBreached) : cur.alertBreached,
    jql, updatedAt: new Date().toISOString(), updatedBy: user || '',
  };
  await configStore.mutate(() => ({ list: [next], result: {} }), `jira-frt-alert: cập nhật cấu hình (${user || ''})`);
  return next;
}

const priorityOf = (f) => { const m = String(f.summary || '').match(/\[\s*([PS]\d)\s*\]/i); return String((m ? m[1] : '') || f.ticketPriorityDropdown || (f.priority && f.priority.name) || '').trim().toUpperCase(); };

/** Issue đang chạy SLA First Response: [{ key, hqTicketId, summary, status, priority, assignee, assigneeEmail, remainingMin, dueIso, kind: 'near'|'late', cycle }] */
async function compute(cfg) {
  if (!jira.isConfigured()) throw new Error('Server chưa cấu hình kết nối Jira (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN).');
  const { issues } = await jira.searchIssuesWithTicketPriority({ jql: cfg.jql, maxTotal: 1000 });
  const open = issues.filter((i) => !/^cancel/i.test(String((i.fields.status && i.fields.status.name) || '').trim()));
  const { results, errors } = open.length ? await jira.getIssuesSlaBulk(open.map((i) => i.key)) : { results: {}, errors: {} };
  const now = Date.now();
  const items = []; let running = 0;
  for (const i of open) {
    const def = (results[i.key] || []).find((v) => String(v.name || '').toLowerCase().includes('first response'));
    const cyc = def && def.ongoingCycle;
    if (!cyc || cyc.paused) continue; // đã phản hồi / không áp SLA / đang tạm dừng
    const rem = cyc.remainingTime && typeof cyc.remainingTime.millis === 'number' ? cyc.remainingTime.millis : null;
    if (rem === null) continue;
    running++;
    const f = i.fields || {}; const a = f.assignee || {};
    const prio = priorityOf(f);
    const goal = cyc.goalDuration && typeof cyc.goalDuration.millis === 'number' ? cyc.goalDuration.millis : null;
    const elapsed = cyc.elapsedTime && typeof cyc.elapsedTime.millis === 'number' ? cyc.elapsedTime.millis : (goal !== null ? goal - rem : null);
    const after = cfg.afterMinutes[prio] != null ? cfg.afterMinutes[prio] : cfg.afterDefault;
    const late = Boolean(cyc.breached) || rem < 0;
    if (late ? !cfg.alertBreached : (elapsed === null || elapsed < after * 60000)) continue;
    items.push({
      key: i.key, hqTicketId: f.hqTicketId || '', summary: f.summary || '', status: (f.status && f.status.name) || '',
      priority: prio, afterMin: after, elapsedMin: elapsed === null ? null : Math.round(elapsed / 60000), goalMin: goal === null ? null : Math.round(goal / 60000), commitMin: COMMIT_FRT[prio] || null, assignee: a.displayName || '', assigneeEmail: String(a.emailAddress || '').toLowerCase(),
      remainingMin: Math.round(rem / 60000),
      dueIso: (cyc.breachTime && (cyc.breachTime.iso8601 || (cyc.breachTime.epochMillis && new Date(cyc.breachTime.epochMillis).toISOString()))) || new Date(now + rem).toISOString(),
      kind: late ? 'late' : 'near', cycle: (cyc.startTime && (cyc.startTime.iso8601 || cyc.startTime.epochMillis)) || '',
    });
  }
  items.sort((x, y) => x.remainingMin - y.remainingMin);
  return { at: new Date().toISOString(), checked: open.length, running, slaErrors: Object.keys(errors).length, items };
}

const stateKey = (it) => `${it.key}|${it.cycle}|${it.kind}`;

function buildMail(items, cfg, base) {
  const near = items.filter((i) => i.kind === 'near'); const late = items.filter((i) => i.kind === 'late');
  const th = 'style="background:#1F4E79;color:#fff;padding:6px 8px;text-align:left;font-size:12.5px;border:1px solid #1F4E79"';
  const td = 'style="padding:6px 8px;border:1px solid #D5DDE5;font-size:12.5px;vertical-align:top"';
  const row = (i) => `<tr><td ${td}><a href="${esc(base)}/browse/${encodeURIComponent(i.key)}">${esc(i.key)}</a>${i.hqTicketId ? `<br><span style="color:#666">${esc(i.hqTicketId)}</span>` : ''}</td>`
    + `<td ${td}>${esc(i.priority)}</td><td style="padding:6px 8px;border:1px solid #D5DDE5;font-size:12.5px;vertical-align:top;min-width:220px">${esc(i.summary)}</td>`
    + `<td ${td}>${esc(i.assignee || '(chưa giao)')}</td><td ${td}>${esc(i.status)}</td>`
    + `<td ${td}>${i.elapsedMin != null ? 'Đã chờ ' + fmtMin(i.elapsedMin) + '<br>' : ''}<b style="color:${i.kind === 'late' ? '#B23A48' : '#C77700'}">${i.kind === 'late' ? 'Đã trễ ' + fmtMin(i.remainingMin) : 'Còn ' + fmtMin(i.remainingMin)}</b></td><td ${td}>${esc(fmtVN(i.dueIso))}</td></tr>`;
  const table = (list) => `<table style="border-collapse:collapse;margin:6px 0 14px"><tr><th ${th}>Issue</th><th ${th}>Priority</th><th ${th}>Tiêu đề</th><th ${th}>Người xử lý</th><th ${th}>Trạng thái</th><th ${th}>Thời gian</th><th ${th}>Hạn phản hồi</th></tr>${list.map(row).join('')}</table>`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">`
    + (near.length ? `<p>⏰ Có <b>${near.length} ticket Jira ABI</b> đã quá mốc nhắc mà <b>chưa phản hồi First Response</b> (P1 sau ${cfg.afterMinutes.P1} phút · P2/S1 sau ${cfg.afterMinutes.P2} phút · P3/S2/P4/S3 sau ${cfg.afterMinutes.P3} phút). Vui lòng phản hồi khách ngay để không bị trễ SLA:</p>${table(near)}` : '')
    + (late.length ? `<p>⚠ <b>${late.length} ticket</b> đã trễ First Response mà chưa có phản hồi:</p>${table(late)}` : '')
    + `<p style="color:#777;font-size:12px">Thời gian còn lại lấy theo SLA Jira tự tính (lúc gửi mail). Mỗi ticket chỉ cảnh báo 1 lần. — HQSOFT Ops Console</p></div>`;
  const subject = near.length
    ? `[Cảnh báo SLA] ${near.length} ticket Jira ABI sắp trễ First Response${near[0] ? ` – ${near[0].key} còn ${fmtMin(near[0].remainingMin)}` : ''}`
    : `[Cảnh báo SLA] ${late.length} ticket Jira ABI đã trễ First Response`;
  const to = [...new Set([...cfg.to, ...(cfg.includeAssignee ? items.map((i) => i.assigneeEmail).filter((e) => EMAIL_RE.test(e)) : [])])];
  return { to, cc: cfg.cc.filter((e) => !to.includes(e)), subject, html };
}

async function readRuns() { const r = await runStore.readAll(); return Array.isArray(r) ? r : []; }
async function readState() { const r = await stateStore.readAll(); return (Array.isArray(r) && r[0] && r[0].sent) || {}; }

/** dryRun: chỉ xem (gồm cả ticket đã báo). testTo: gửi về 1 địa chỉ, không đánh dấu đã báo. */
async function run({ dryRun = false, testTo = '', by = 'lịch tự động' } = {}) {
  const cfg = await getConfig();
  if (!dryRun && !testTo && !cfg.enabled) return { skipped: true, reason: 'Cảnh báo đang tắt.' };
  const data = await compute(cfg);
  const sentMap = await readState();
  data.items.forEach((i) => { i.alreadySent = Boolean(sentMap[stateKey(i)]); });
  const base = String(process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  if (dryRun) return { ok: true, dryRun: true, ...data, afterMinutes: cfg.afterMinutes, mail: data.items.some((i) => !i.alreadySent) ? buildMail(data.items.filter((i) => !i.alreadySent), cfg, base) : null };
  const test = emails(testTo)[0];
  if (testTo && !EMAIL_RE.test(test || '')) throw new Error('Email gửi thử không hợp lệ.');
  const list = test ? data.items : data.items.filter((i) => !i.alreadySent);
  if (!list.length) return { ok: true, sent: 0, checked: data.checked, running: data.running, note: test ? 'Không có ticket nào sắp trễ để gửi thử.' : 'Không có ticket mới sắp trễ.' };
  const mail = buildMail(list, cfg, base);
  const out = test ? { to: [test], cc: [], subject: `[THỬ → ${mail.to.join(', ')}] ${mail.subject}`, html: mail.html } : mail;
  let error = '';
  try { await postWebhook(out); } catch (e) { error = e.message; }
  if (!error && !test) {
    const nowMs = Date.now();
    try {
      await stateStore.mutate((all) => {
        const cur = (Array.isArray(all) && all[0] && all[0].sent) || {};
        const next = {};
        Object.entries(cur).forEach(([k, t]) => { if (nowMs - Date.parse(t) < STATE_KEEP_MS) next[k] = t; });
        list.forEach((i) => { next[stateKey(i)] = new Date(nowMs).toISOString(); });
        return { list: [{ sent: next }], result: {} };
      }, `jira-frt-alert: đánh dấu ${list.length} ticket đã báo`);
    } catch (e) { console.error('[jira-frt-alert] không ghi được trạng thái:', e.message); }
  }
  const entry = { at: new Date().toISOString(), by, test: test || '', to: out.to.join(', '), keys: list.map((i) => `${i.key}${i.kind === 'late' ? ' (trễ)' : ` (còn ${i.remainingMin}p)`}`), ok: !error, error };
  try { await runStore.mutate((all) => ({ list: [entry, ...(Array.isArray(all) ? all : [])].slice(0, MAX_RUNS), result: {} }), `jira-frt-alert: ${list.length} ticket${error ? ' (lỗi)' : ''}${test ? ' (thử)' : ''}`); }
  catch (e) { console.error('[jira-frt-alert] không ghi được lịch sử:', e.message); }
  return { ok: !error, sent: error ? 0 : 1, count: list.length, ...entry };
}

module.exports = { PRIOS, COMMIT_FRT, getConfig, saveConfig, compute, run, readRuns, DEFAULT_JQL };
