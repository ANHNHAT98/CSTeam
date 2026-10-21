'use strict';
/* KPI Team → CS05 "Functional defect escape sau review" — số lỗi nghiệp vụ lọt qua bước review chức năng, chỉ bị phát hiện ở bước sau (khách hàng nhắn lại, phải fix tiếp lỗi cũ).
   Actual = số lỗi (KPI Thấp tốt: 0 là tốt nhất). Nguồn: ticket ERP của tháng đánh giá, dò ra các ỨNG VIÊN lỗi lọt:
     1. MỞ LẠI: ticket chuyển trạng thái từ Closed về lại trạng thái chưa đóng trong tháng (log thay đổi "Version" của ERP), hoặc đang ở trạng thái Re-open.
     2. LIÊN QUAN / LẶP LẠI: ticket MỚI mở trong tháng liên quan tới 1 ticket CŨ — qua trường liên kết tới Ticket, hoặc nội dung nhắc mã ticket cũ,
        hoặc tiêu đề giống ticket cũ (độ tương đồng cao; mức này chỉ là gợi ý, cần QA xác nhận).
   Lỗi được tính cho người xử lý (_assign) của ticket CŨ (người đã review/fix lần đầu); với trường hợp mở lại là người xử lý của chính ticket đó.
   Ứng viên độ tin cậy cao tự được tính; QA có thể bấm "Tính / Không tính" từng dòng (lưu lại), ứng viên độ tin cậy thấp mặc định chưa tính. */

const { createListStore } = require('./listStore');
const { progressOfLow } = require('./kpiSla');
const { normalize } = require('./customerReport');
const { monthStartOf, monthEndOf, addMonths } = require('./customerReportMonthly');

const store = createListStore({ repoFilePath: 'data/kpi-defect-decisions.json', localFile: 'data/kpi-defect-decisions.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ');
const fold = (s) => stripHtml(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const words = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 2);
const ID_TOKEN = /[A-Za-z][A-Za-z0-9_]*[-_/]?\d{3,}[A-Za-z0-9_-]*|\b\d{4,}\b/g;

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Đọc log Version → các lần ticket chuyển từ trạng thái đóng về trạng thái chưa đóng. */
function reopenEventsFromVersions(versions, closed) {
  const out = [];
  for (const v of versions || []) {
    let d; try { d = typeof v.data === 'string' ? JSON.parse(v.data) : v.data; } catch (_) { continue; }
    for (const ch of (d && d.changed) || []) {
      if (Array.isArray(ch) && ch[0] === 'status' && closed.includes(ch[1]) && !closed.includes(ch[2])) out.push({ ticket: v.docname, from: ch[1], to: ch[2], at: String(v.creation || '').slice(0, 19), by: v.owner || '' });
    }
  }
  return out;
}

/**
 * rows: ticket ERP (khoảng lookback → hết tháng, các dự án chọn, cộng thêm ticket mở lại ngoài khoảng); versions: log Version trong tháng (có thể null nếu không đọc được);
 * linkFields: tên trường liên kết tới DocType Ticket (dò từ cấu trúc Ticket). Trả về { candidates, diagnostics }.
 */
function buildCandidates({ rows, versions, versionsError, linkFields = [], month, projects, config }) {
  const dc = config.defect; const ms = monthStartOf(month); const me = monthEndOf(month);
  const seen = new Set(); const T = new Map();
  for (const r of rows || []) {
    if (!r || !r.name || seen.has(r.name)) continue; seen.add(r.name);
    const n = normalize(r);
    T.set(r.name, { ...n, project: r.project || '', description: r.description || '', raw: r, handlers: n.assign.map(lc), modified: String(r.modified || '') });
  }
  const inScope = (t) => projects.includes(t.project);
  const candidates = new Map();
  const add = (c) => { const prev = candidates.get(c.id); if (prev) { prev.evidence.push(...c.evidence); if (c.confidence === 'high') prev.confidence = 'high'; } else candidates.set(c.id, c); };
  const brief = (t) => (t ? { name: t.name, subject: t.subject, status: t.status, opening: t.opening, project: t.project, handlers: t.handlers } : null);

  // 1) mở lại
  const events = versions ? reopenEventsFromVersions(versions, dc.closedStatuses) : [];
  const reopenSeen = new Set();
  for (const e of events) {
    const t = T.get(e.ticket); if (!t || !inScope(t) || reopenSeen.has(e.ticket)) continue; reopenSeen.add(e.ticket);
    add({ id: `reopen|${e.ticket}|${month}`, kind: 'reopen', month, ticket: brief(t), old: null, handlers: t.handlers, at: e.at, confidence: 'high', evidence: [`Chuyển trạng thái ${e.from} → ${e.to} lúc ${e.at}${e.by ? ' (bởi ' + e.by + ')' : ''}`] });
  }
  for (const t of T.values()) { // dự phòng khi không đọc được log, hoặc log không ghi: đang ở Re-open và cập nhật trong tháng
    if (!inScope(t) || reopenSeen.has(t.name)) continue;
    if (/^re-?open$/i.test(t.status) && t.modified.slice(0, 10) >= ms && t.modified.slice(0, 10) <= me) {
      add({ id: `reopen|${t.name}|${month}`, kind: 'reopen', month, ticket: brief(t), old: null, handlers: t.handlers, at: t.modified.slice(0, 19), confidence: 'high', evidence: ['Trạng thái hiện tại là Re-open (không có log chuyển từ Closed trong tháng)'] });
    }
  }

  // 2) ticket mới (mở trong tháng) liên quan / lặp lại ticket cũ
  const olds = [...T.values()].filter((t) => t.openDay);
  const idx = olds.map((t) => ({ t, w: new Set(words(t.subject)) }));
  const known = (name) => T.get(name);
  for (const n of T.values()) {
    if (!inScope(n) || !n.openDay || n.openDay < ms || n.openDay > me) continue;
    const link = (o, ev, conf) => {
      if (!o || o.name === n.name) return;
      if (o.openDt && n.openDt && o.openDt >= n.openDt) return; // chỉ coi ticket mở TRƯỚC là "cũ"
      add({ id: `rel|${n.name}|${o.name}`, kind: 'related', month, ticket: brief(n), old: brief(o), handlers: o.handlers, at: n.opening, confidence: conf, evidence: [ev] });
    };
    // 2a) trường liên kết tới Ticket
    for (const f of linkFields) {
      const v = String(n.raw[f] || '').trim();
      if (v) { const o = known(v); if (o) link(o, `Trường liên kết "${f}" trỏ tới ${v}`, 'high'); else add({ id: `rel|${n.name}|${v}`, kind: 'related', month, ticket: brief(n), old: { name: v, subject: '(ticket cũ ngoài phạm vi đã tải)', handlers: [] }, handlers: [], at: n.opening, confidence: 'high', evidence: [`Trường liên kết "${f}" trỏ tới ${v}`] }); }
    }
    // 2b) nội dung nhắc mã ticket khác
    const text = `${n.subject} ${stripHtml(n.description)}`;
    const toks = new Set(text.match(ID_TOKEN) || []);
    for (const tk of toks) { const o = known(tk); if (o) link(o, `Nội dung nhắc tới mã ticket ${tk}`, 'high'); }
    // 2c) tiêu đề giống ticket cũ (gợi ý, độ tin cậy thấp)
    const nw = new Set(words(n.subject));
    if (nw.size >= dc.minSimilarTokens) {
      let best = null;
      for (const { t: o, w } of idx) {
        if (o.name === n.name || o.project !== n.project || !o.openDt || !n.openDt || o.openDt >= n.openDt) continue;
        const s = jaccard(nw, w);
        if (s >= dc.similarityThreshold && (!best || s > best.s)) best = { o, s };
      }
      if (best) link(best.o, `Tiêu đề giống ticket cũ ${best.o.name} (${Math.round(best.s * 100)}%)`, 'low');
    }
  }
  const list = [...candidates.values()].map((c) => ({ ...c, evidence: [...new Set(c.evidence)] })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const kindCounts = list.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {});
  return {
    candidates: list,
    diagnostics: {
      ticketsScanned: T.size, linkFields, versions: versions ? { ok: true, count: versions.length, reopenEvents: events.length } : { ok: false, error: versionsError || 'không đọc được' },
      kindCounts, unattributed: list.filter((c) => !c.handlers.length).length, lookbackFrom: monthStartOf(addMonths(month, -dc.lookbackMonths)),
    },
  };
}

/** Chấm 1 thành viên từ danh sách ứng viên + quyết định của QA. */
function scoreMember(candidates, decisions, { member, level, config }) {
  const dc = config.defect; const who = lc(member);
  const dmap = new Map((decisions || []).map((d) => [d.id, d]));
  const mine = candidates.filter((c) => c.handlers.includes(who)).map((c) => {
    const d = dmap.get(c.id);
    const counted = d ? d.decision === 'include' : c.confidence === 'high';
    return { ...c, decision: d ? d.decision : null, note: d ? d.note || '' : '', counted };
  });
  const actual = mine.filter((c) => c.counted).length;
  const th = dc.thresholds[level]; const weight = dc.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOfLow(actual, th) : null;
  return {
    member: who, level, kpi: { code: dc.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { actual, candidates: mine.length, auto: mine.filter((c) => c.counted && !c.decision).length, confirmed: mine.filter((c) => c.decision === 'include').length, excluded: mine.filter((c) => c.decision === 'exclude').length,
      progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    candidates: mine,
  };
}

async function setDecision({ id, decision, note, by }) {
  if (!/^(reopen|rel)\|/.test(String(id || ''))) throw new Error('Mã ứng viên không hợp lệ.');
  if (!['include', 'exclude', 'clear'].includes(decision)) throw new Error('Quyết định không hợp lệ.');
  return store.mutate((list) => {
    const rest = list.filter((x) => x.id !== id);
    if (decision === 'clear') return { list: rest, result: {} };
    const rec = { id, decision, note: String(note || '').slice(0, 500), at: new Date().toISOString(), by: by || '' };
    return { list: [...rest, rec], result: { decision: rec } };
  }, `defect: ${decision} ${id}`);
}

module.exports = { store, buildCandidates, scoreMember, setDecision, reopenEventsFromVersions };
