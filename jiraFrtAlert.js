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
const zalo = require('./zaloBot');

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
  zaloEnabled: false,              // gửi thêm tin Zalo (Zalo Bot, env ZALO_BOT_TOKEN) — mặc định tắt
  zaloChatIds: [],                 // chat id đã chọn (lấy từ danh sách người/nhóm đã nhắn bot)
};

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emails = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtVN = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }); };
const fmtMin = (m) => { const a = Math.abs(Math.round(m)); const d = Math.floor(a / 1440); const h = Math.floor((a % 1440) / 60); const mi = a % 60;
  return d ? `${d} ngày ${h} giờ` : h ? `${h} giờ ${mi} phút` : `${mi} phút`; };

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
    jql,
    zaloEnabled: input.zaloEnabled != null ? Boolean(input.zaloEnabled) : Boolean(cur.zaloEnabled),
    zaloChatIds: zaloIds(input.zaloChatIds != null ? input.zaloChatIds : cur.zaloChatIds),
    updatedAt: new Date().toISOString(), updatedBy: user || '',
  };
  if (next.zaloEnabled && !next.zaloChatIds.length) throw new Error('Bật gửi Zalo thì cần chọn ít nhất 1 người/nhóm nhận.');
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
  const F = 'font-family:Segoe UI,Arial,Helvetica,sans-serif';
  const PCOL = { P1: '#C62828', P2: '#E65100', S1: '#E65100', P3: '#B7791F', S2: '#B7791F', P4: '#5F6B7A', S3: '#5F6B7A' };
  const badge = (txt, bg, fg = '#fff') => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${fg};font-size:11.5px;font-weight:600;white-space:nowrap">${esc(txt)}</span>`;
  const nowTxt = fmtVN(new Date().toISOString());
  const row = (i, n) => {
    const bg = n % 2 ? '#F7F9FC' : '#FFFFFF';
    const td = `style="padding:10px 12px;border-bottom:1px solid #E3E8EF;vertical-align:top;background:${bg};${F};font-size:13px;color:#1F2933"`;
    const isLate = i.kind === 'late';
    const remain = isLate ? badge('Trễ ' + fmtMin(i.remainingMin), '#FDECEC', '#B42318') : badge('Còn ' + fmtMin(i.remainingMin), '#FFF4E5', '#B54708');
    return `<tr>`
      + `<td ${td}><a href="${esc(base)}/browse/${encodeURIComponent(i.key)}" style="color:#1A56DB;font-weight:700;text-decoration:none">${esc(i.key)}</a><br>${badge(i.priority || '—', PCOL[i.priority] || '#5F6B7A')}${i.hqTicketId ? `<div style="color:#8792A2;font-size:11.5px;margin-top:4px">${esc(i.hqTicketId)}</div>` : ''}</td>`
      + `<td ${td}><div style="font-weight:600">${esc(i.summary)}</div><div style="color:#6B7685;font-size:12px;margin-top:3px">${esc(i.status)} · ${esc(i.assignee || 'chưa giao')}</div></td>`
      + `<td ${td} nowrap>${remain}${i.elapsedMin != null ? `<div style="color:#6B7685;font-size:12px;margin-top:4px">Đã chờ ${fmtMin(i.elapsedMin)}</div>` : ''}</td>`
      + `<td ${td} nowrap><b>${esc(fmtVN(i.dueIso))}</b></td></tr>`;
  };
  const section = (title, color, list) => `<tr><td style="padding:18px 24px 6px;${F}"><div style="font-size:14px;font-weight:700;color:${color}">${title}</div></td></tr>`
    + `<tr><td style="padding:0 24px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E3E8EF;border-radius:8px">`
    + `<tr>${['Issue', 'Tiêu đề · Trạng thái · Người xử lý', 'Thời gian', 'Hạn phản hồi'].map((h) => `<th align="left" style="padding:8px 12px;background:#EEF2F7;color:#52606D;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #E3E8EF;${F}">${h}</th>`).join('')}</tr>`
    + list.map(row).join('') + `</table></td></tr>`;
  const stat = (n, label, color) => `<td style="padding:0 18px 0 0;${F}"><div style="font-size:24px;font-weight:700;color:${color};line-height:1">${n}</div><div style="font-size:12px;color:#6B7685">${label}</div></td>`;
  const html = `<div style="background:#F2F4F7;padding:20px 0;${F}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:820px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #E3E8EF">`
    + `<tr><td style="background:${late.length && !near.length ? '#B42318' : '#1F4E79'};padding:16px 24px;${F}"><div style="color:#fff;font-size:17px;font-weight:700">${near.length ? '⏰' : '⚠️'} Cảnh báo SLA First Response · Jira ABI</div><div style="color:#D6E4F0;font-size:12.5px;margin-top:4px">Kiểm tra lúc ${esc(nowTxt)} — vui lòng phản hồi khách ngay</div></td></tr>`
    + `<tr><td style="padding:16px 24px 4px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${near.length ? stat(near.length, 'sắp trễ', '#B54708') : ''}${late.length ? stat(late.length, 'đã trễ', '#B42318') : ''}</tr></table></td></tr>`
    + (near.length ? section('Sắp trễ — đã quá mốc nhắc mà chưa phản hồi', '#B54708', near) : '')
    + (late.length ? section('Đã trễ First Response — chưa có phản hồi', '#B42318', late) : '')
    + `<tr><td style="padding:12px 24px 18px;${F};font-size:11.5px;color:#8792A2;border-top:1px solid #EEF2F7">Mốc nhắc: P1 sau ${cfg.afterMinutes.P1}p · P2/S1 sau ${cfg.afterMinutes.P2}p · P3/S2/P4/S3 sau ${cfg.afterMinutes.P3}p. Thời gian lấy theo SLA Jira lúc gửi; mỗi ticket chỉ cảnh báo 1 lần.<br>HQSOFT Ops Console</td></tr>`
    + `</table></div>`;
  const subject = near.length
    ? `[Cảnh báo SLA] ${near.length} ticket Jira ABI sắp trễ First Response${near[0] ? ` – ${near[0].key} còn ${fmtMin(near[0].remainingMin)}` : ''}`
    : `[Cảnh báo SLA] ${late.length} ticket Jira ABI đã trễ First Response`;
  const to = [...new Set([...cfg.to, ...(cfg.includeAssignee ? items.map((i) => i.assigneeEmail).filter((e) => EMAIL_RE.test(e)) : [])])];
  return { to, cc: cfg.cc.filter((e) => !to.includes(e)), subject, html };
}

const zaloIds = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter((x) => /^[\w.:-]{1,100}$/.test(x)))].slice(0, 30);

/** Tin Zalo (chữ thường, không HTML). */
function buildZaloText(items, cfg, base) {
  const near = items.filter((i) => i.kind === 'near'); const late = items.filter((i) => i.kind === 'late');
  const line = (i) => `• ${i.key} [${i.priority || '—'}] ${i.kind === 'late' ? 'TRỄ ' + fmtMin(i.remainingMin) : 'còn ' + fmtMin(i.remainingMin)} · hạn ${fmtVN(i.dueIso)}\n   ${String(i.summary || '').slice(0, 90)} — ${i.assignee || 'chưa giao'}\n   ${base}/browse/${i.key}`;
  return [`⏰ CẢNH BÁO SLA FIRST RESPONSE · JIRA ABI`, [near.length ? `${near.length} sắp trễ` : '', late.length ? `${late.length} đã trễ` : ''].filter(Boolean).join(' · ') + ' — vui lòng phản hồi khách ngay', '',
    ...(near.length ? ['🟠 SẮP TRỄ', ...near.map(line), ''] : []),
    ...(late.length ? ['🔴 ĐÃ TRỄ', ...late.map(line), ''] : []),
    `Mốc nhắc: P1 ${cfg.afterMinutes.P1}p · P2/S1 ${cfg.afterMinutes.P2}p · P3–S3 ${cfg.afterMinutes.P3}p`].join('\n').trim();
}

/** Gửi thử Zalo tới các chat chọn (không cần bật, không đánh dấu đã báo). */
async function zaloTest({ chatIds } = {}) {
  const cfg = await getConfig();
  const ids = zaloIds(chatIds && chatIds.length ? chatIds : cfg.zaloChatIds);
  if (!ids.length) throw new Error('Chưa chọn người/nhóm Zalo để gửi thử.');
  let text;
  try {
    const data = await compute(cfg);
    const base = String(process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
    text = data.items.length ? buildZaloText(data.items, cfg, base) : '';
  } catch (e) { text = ''; }
  text = '[THỬ] ' + (text || 'Tin thử từ CS Tool — hiện không có ticket Jira ABI nào sắp trễ First Response.');
  return zalo.sendText(ids, text);
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
  let zaloInfo = '';
  if (!test && cfg.zaloEnabled && cfg.zaloChatIds.length) {
    if (!zalo.ready()) zaloInfo = 'Zalo: server chưa có ZALO_BOT_TOKEN';
    else {
      const z = await zalo.sendText(cfg.zaloChatIds, buildZaloText(list, cfg, base));
      const bad = z.results.filter((r) => !r.ok);
      zaloInfo = bad.length ? `Zalo lỗi ${bad.length}/${z.results.length}: ${bad[0].error}` : `Zalo ✓ ${z.results.length}`;
      if (error && bad.length < z.results.length) error = ''; // mail lỗi nhưng Zalo tới được → vẫn coi là đã báo
    }
  }
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
  const entry = { at: new Date().toISOString(), by, test: test || '', to: out.to.join(', '), keys: list.map((i) => `${i.key}${i.kind === 'late' ? ' (trễ)' : ` (còn ${i.remainingMin}p)`}`), ok: !error, error, zalo: zaloInfo };
  try { await runStore.mutate((all) => ({ list: [entry, ...(Array.isArray(all) ? all : [])].slice(0, MAX_RUNS), result: {} }), `jira-frt-alert: ${list.length} ticket${error ? ' (lỗi)' : ''}${test ? ' (thử)' : ''}`); }
  catch (e) { console.error('[jira-frt-alert] không ghi được lịch sử:', e.message); }
  return { ok: !error, sent: error ? 0 : 1, count: list.length, ...entry };
}

module.exports = { PRIOS, COMMIT_FRT, getConfig, saveConfig, compute, run, readRuns, zaloTest, DEFAULT_JQL };
