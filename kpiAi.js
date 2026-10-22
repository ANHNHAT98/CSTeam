'use strict';
/* KPI Team → CS21 "AI adoption cá nhân" — điểm AI workflow cá nhân chấm THEO THÁNG từ bằng chứng nhập tay.
   Actual = điểm AI workflow đạt được ÷ tổng điểm tối đa (100) × 100%; KPI Cao tốt, ngưỡng theo level trong Master KPI (nguồn: đánh giá L&D / TDC).
   3 tiêu chí (cấu hình ở kpi-sla-config.json → "ai"):
     1. Dùng AI soạn email/ticket giảm thời gian ≥ 30%  — 40 điểm. Có 2 nguồn bằng chứng, dùng được cả hai:
        a) Số phút: các mẫu "thời gian làm thông thường" và "thời gian làm có AI". Mức giảm = (Σ thông thường − Σ có AI) ÷ Σ thông thường;
           hệ số = min(1, mức giảm ÷ 30%).
        b) Prompt / flow (workflow): thành viên nộp prompt + flow; tool tự quét dữ liệu nhạy cảm (gợi ý cho người chấm); người chấm tick checklist rubric
           (config "ai.rubric", tổng trọng số 100; tiêu chí có gate = bảo mật, không tick thì workflow đó 0 điểm). Hệ số = trung bình điểm rubric (0–1) của các workflow ĐÃ CHẤM.
        Điểm tiêu chí 1 = 40 × hệ số; có cả hai nguồn thì lấy trung bình hai hệ số, chỉ có một thì dùng hệ số đó.
     2. AI hỗ trợ báo cáo tuần/tháng/ERP đúng hạn — 40 điểm. Ghi từng báo cáo (hạn, ngày xong, có dùng AI không).
        Tỷ lệ = số báo cáo xong đúng hạn VÀ có dùng AI ÷ số báo cáo đã có kết quả (xong, hoặc chưa xong mà quá hạn); điểm = tỷ lệ × 40.
     3. 0 lần vi phạm AI Data Security — 20 điểm. Có ≥ 1 lần vi phạm trong tháng thì 0 điểm, không có thì đủ 20 (cần người có trách nhiệm xác nhận không phát sinh).
   L&D (TDC) có thể ghi ĐIỂM ĐIỀU CHỈNH cho từng tiêu chí của 1 tháng — nếu có thì dùng điểm đó thay cho điểm tự tính. */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');
const { vnNow } = require('./customerReport');

const store = createListStore({ repoFilePath: 'data/kpi-ai.json', localFile: 'data/kpi-ai.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
const KINDS = ['time', 'report', 'violation', 'workflow'];

/** Quét prompt/flow tìm dấu hiệu dữ liệu nhạy cảm (chỉ để gợi ý cho người chấm, KHÔNG gửi đi đâu). */
const SENSITIVE = [
  ['Email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['Số điện thoại', /(?:\+?84|\b0)(?:[ .-]?\d){8,10}\b/g],
  ['Dãy số dài (CMND/tài khoản/thẻ/MST)', /\b\d{9,}\b/g],
  ['Địa chỉ IP', /\b\d{1,3}(?:\.\d{1,3}){3}\b/g],
  ['Mật khẩu / key / token', /(?:password|passwd|m[aậ]t kh[aẩ]u|api[_ -]?key|secret|token|bearer)\s*[:=]\s*\S+/gi],
];
function scanSensitive(text) {
  const out = [];
  for (const [type, re] of SENSITIVE) {
    const m = String(text || '').match(re);
    if (m && m.length) out.push({ type, count: m.length, example: m[0].length > 4 ? m[0].slice(0, 3) + '***' : '***' });
  }
  return out;
}

function cleanEntry(input, { config, allowedMembers }) {
  const c = config.ai;
  const kind = String(input.kind || '');
  if (!KINDS.includes(kind)) throw new Error('Loại bằng chứng không hợp lệ.');
  const member = lc(input.member);
  if (!allowedMembers.includes(member)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  const text = (v, n) => String(v || '').trim().slice(0, n);
  const base = { kind, member, evidence: text(input.evidence, 500), note: text(input.note, 1000) };
  if (kind === 'time') {
    const date = text(input.date, 10); if (!isDate(date)) throw new Error('Ngày không hợp lệ (YYYY-MM-DD).');
    const task = text(input.task, 200); if (!task) throw new Error('Thiếu nội dung công việc (email/ticket đã soạn).');
    const n = Number(input.minutesNormal); const a = Number(input.minutesAi);
    if (!(n > 0) || !(a >= 0)) throw new Error('Thời gian làm thông thường phải > 0 và thời gian làm có AI phải ≥ 0 (phút).');
    return { ...base, date, month: date.slice(0, 7), task, taskKind: c.timeKinds.includes(input.taskKind) ? input.taskKind : 'Khác', minutesNormal: n, minutesAi: a };
  }
  if (kind === 'workflow') {
    const date = text(input.date, 10); if (!isDate(date)) throw new Error('Ngày không hợp lệ (YYYY-MM-DD).');
    const title = text(input.title, 200); if (!title) throw new Error('Thiếu tên workflow (email/ticket/việc dùng AI).');
    const prompt = text(input.prompt, 4000); const flow = text(input.flow, 2000);
    if (!prompt && !flow) throw new Error('Cần dán prompt hoặc mô tả flow làm bằng chứng.');
    const n = input.minutesNormal === '' || input.minutesNormal == null ? null : Number(input.minutesNormal);
    const a = input.minutesAi === '' || input.minutesAi == null ? null : Number(input.minutesAi);
    if ((n != null && !(n > 0)) || (a != null && !(a >= 0)) || ((n == null) !== (a == null))) throw new Error('Số phút: nhập cả "thông thường" (> 0) và "có AI" (≥ 0), hoặc để trống cả hai.');
    return { ...base, date, month: date.slice(0, 7), title, taskKind: c.timeKinds.includes(input.taskKind) ? input.taskKind : 'Khác', prompt, flow, minutesNormal: n, minutesAi: a, sensitive: scanSensitive(`${prompt}\n${flow}`) };
  }
  if (kind === 'report') {
    const dueDate = text(input.dueDate, 10); if (!isDate(dueDate)) throw new Error('Hạn báo cáo không hợp lệ (YYYY-MM-DD).');
    const doneDate = text(input.doneDate, 10); if (doneDate && !isDate(doneDate)) throw new Error('Ngày hoàn thành không hợp lệ (YYYY-MM-DD).');
    const report = text(input.report, 200); if (!report) throw new Error('Thiếu tên báo cáo / tổng hợp.');
    return { ...base, report, reportKind: c.reportKinds.includes(input.reportKind) ? input.reportKind : 'Khác', dueDate, month: dueDate.slice(0, 7), doneDate, usedAi: input.usedAi === true || input.usedAi === 'true' || input.usedAi === 1 || input.usedAi === '1' };
  }
  const date = text(input.date, 10); if (!isDate(date)) throw new Error('Ngày không hợp lệ (YYYY-MM-DD).');
  const description = text(input.description, 500); if (!description) throw new Error('Thiếu mô tả vi phạm AI Data Security.');
  return { ...base, date, month: date.slice(0, 7), description };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function scoreMember(all, { month, member, level, config, today = vnNow().toISOString().slice(0, 10) }) {
  const c = config.ai; const who = lc(member); const pts = c.criteria;
  const mine = all.filter((e) => lc(e.member) === who && e.month === month);
  // 1) AI soạn email/ticket: (a) số phút  (b) prompt/flow chấm bằng checklist rubric
  const times = mine.filter((e) => e.kind === 'time').sort((a, b) => a.date.localeCompare(b.date));
  const workflows = mine.filter((e) => e.kind === 'workflow').sort((a, b) => a.date.localeCompare(b.date));
  const minuteRows = [...times, ...workflows.filter((w) => w.minutesNormal != null && w.minutesAi != null)];
  const sumN = minuteRows.reduce((s, e) => s + e.minutesNormal, 0); const sumA = minuteRows.reduce((s, e) => s + e.minutesAi, 0);
  const reduction = sumN > 0 ? round(((sumN - sumA) / sumN) * 100) : null;
  const timeFactor = reduction == null ? null : Math.min(1, Math.max(0, reduction) / pts.time.targetReductionPct);
  const rubric = c.rubric || []; const rTotal = rubric.reduce((s, r) => s + r.weight, 0) || 100;
  const wf = workflows.map((w) => {
    const ticked = Array.isArray(w.rubric) ? w.rubric : [];
    const graded = Boolean(w.graded);
    const gateFail = graded && rubric.some((r) => r.gate && !ticked.includes(r.key));
    const raw = rubric.filter((r) => ticked.includes(r.key)).reduce((s, r) => s + r.weight, 0);
    return { ...w, graded, gateFail, ratio: graded ? (gateFail ? 0 : round(raw / rTotal)) : null, rawPoints: raw };
  });
  const gradedWf = wf.filter((w) => w.graded);
  const rubricFactor = gradedWf.length ? round(gradedWf.reduce((s, w) => s + w.ratio, 0) / gradedWf.length) : null;
  const factors = [timeFactor, rubricFactor].filter((x) => x != null);
  const factor = factors.length ? factors.reduce((s, x) => s + x, 0) / factors.length : 0;
  const auto1 = round(factor * pts.time.points);
  // 2) báo cáo
  const reports = mine.filter((e) => e.kind === 'report').sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((e) => {
    const onTime = Boolean(e.doneDate) && e.doneDate <= e.dueDate;
    let status; let decided = true;
    if (e.doneDate) status = onTime ? (e.usedAi ? 'Đạt (đúng hạn, có dùng AI)' : 'Đúng hạn nhưng không dùng AI') : (e.usedAi ? 'Trễ hạn' : 'Trễ hạn, không dùng AI');
    else if (e.dueDate < today) status = 'Quá hạn chưa xong'; else { status = 'Đang thực hiện'; decided = false; }
    return { ...e, onTime, status, decided, pass: onTime && e.usedAi };
  });
  const decided = reports.filter((r) => r.decided); const passN = reports.filter((r) => r.pass).length;
  const rate = decided.length ? round((passN / decided.length) * 100) : null;
  const auto2 = rate == null ? 0 : round((rate / 100) * pts.report.points);
  // 3) bảo mật
  const violations = mine.filter((e) => e.kind === 'violation').sort((a, b) => a.date.localeCompare(b.date));
  const auto3 = violations.length ? 0 : pts.security.points;
  // điểm điều chỉnh của L&D (nếu có)
  const assess = mine.find((e) => e.kind === 'assess') || null;
  const pick = (auto, key, max) => (assess && assess[key] != null && assess[key] !== '' ? clamp(Number(assess[key]), 0, max) : auto);
  const s1 = pick(auto1, 'c1', pts.time.points); const s2 = pick(auto2, 'c2', pts.report.points); const s3 = pick(auto3, 'c3', pts.security.points);
  const maxTotal = pts.time.points + pts.report.points + pts.security.points;
  const total = round(s1 + s2 + s3); const actual = round((total / maxTotal) * 100);
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOf(actual, th) : null;
  return {
    month, member: who, level,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    criteria: {
      time: { max: pts.time.points, auto: auto1, score: s1, overridden: s1 !== auto1, samples: minuteRows.length, sumNormal: sumN, sumAi: sumA, reductionPct: reduction, targetPct: pts.time.targetReductionPct, timeFactor: timeFactor == null ? null : round(timeFactor), rubricFactor, workflows: wf.length, workflowsGraded: gradedWf.length, workflowsPending: wf.length - gradedWf.length },
      report: { max: pts.report.points, auto: auto2, score: s2, overridden: s2 !== auto2, total: reports.length, decided: decided.length, pass: passN, pending: reports.length - decided.length, ratePct: rate },
      security: { max: pts.security.points, auto: auto3, score: s3, overridden: s3 !== auto3, violations: violations.length },
    },
    result: { total, maxTotal, actual, progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    assess: assess ? { c1: assess.c1, c2: assess.c2, c3: assess.c3, note: assess.note || '', by: assess.by || '', at: assess.at || '' } : null,
    entries: { time: times, workflow: wf, report: reports, violation: violations },
  };
}

const add = (input, ctx) => { const e = { id: newId(), ...cleanEntry(input, ctx), createdAt: new Date().toISOString() }; return store.mutate((list) => ({ list: [...list, e], result: { entry: e } }), `ai: thêm ${e.kind} ${e.member}`); };
const update = (id, input, ctx) => store.mutate((list) => {
  const i = list.findIndex((x) => x.id === id && x.kind !== 'assess'); if (i < 0) throw new Error('Không tìm thấy bản ghi với id: ' + id);
  const e = { ...list[i], ...cleanEntry({ ...input, kind: list[i].kind }, ctx), updatedAt: new Date().toISOString() };
  if (e.kind === 'workflow') { e.graded = false; delete e.rubric; delete e.gradedBy; delete e.gradedAt; delete e.gradeNote; } // sửa nội dung workflow thì phải chấm lại
  const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
}, `ai: cập nhật ${id}`);
const remove = (id) => store.mutate((list) => { const next = list.filter((x) => x.id !== id); if (next.length === list.length) throw new Error('Không tìm thấy bản ghi với id: ' + id); return { list: next, result: {} }; }, `ai: xoá ${id}`);

/** L&D ghi / xoá điểm điều chỉnh cho 1 thành viên 1 tháng (mỗi tiêu chí để trống = dùng điểm tự tính). */
function setAssess({ member, month, c1, c2, c3, note, clear, by }, { config, allowedMembers }) {
  const who = lc(member); if (!allowedMembers.includes(who)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('Tháng không hợp lệ.');
  const pts = config.ai.criteria;
  const num = (v, max, label) => { if (v === '' || v == null) return ''; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`Điểm ${label} phải từ 0 đến ${max}.`); return n; };
  const rec = clear ? null : { c1: num(c1, pts.time.points, 'tiêu chí 1'), c2: num(c2, pts.report.points, 'tiêu chí 2'), c3: num(c3, pts.security.points, 'tiêu chí 3') };
  return store.mutate((list) => {
    const rest = list.filter((x) => !(x.kind === 'assess' && lc(x.member) === who && x.month === month));
    if (!rec || (rec.c1 === '' && rec.c2 === '' && rec.c3 === '')) return { list: rest, result: { assess: null } };
    const e = { id: newId(), kind: 'assess', member: who, month, ...rec, note: String(note || '').trim().slice(0, 500), by: by || '', at: new Date().toISOString() };
    return { list: [...rest, e], result: { assess: e } };
  }, `ai: điểm L&D ${who} ${month}`);
}

/**
 * Nhân viên ghi nhận bằng chứng cho cả 3 tiêu chí MỘT LẦN và tự đánh giá:
 *   workflow (prompt/flow + số phút tuỳ chọn + checklist rubric tự tick) · time (chỉ số phút) · reports[] (báo cáo, có dùng AI?) · violation (có vi phạm AI Data Security?)
 * Mọi bản ghi được ghi trong 1 lần mutate (1 commit). Workflow nhân viên tự chấm được đánh dấu graded (gradedBy = "tự đánh giá"); L&D vẫn có thể chấm lại.
 */
function submit(input, ctx) {
  const { config } = ctx; const c = config.ai;
  const member = lc(input.member); const date = String(input.date || '').trim();
  if (!isDate(date)) throw new Error('Ngày ghi nhận không hợp lệ (YYYY-MM-DD).');
  const common = { member, evidence: input.evidence, note: input.note };
  const now = new Date().toISOString(); const out = [];
  const w = input.workflow || {};
  if (w.title || w.prompt || w.flow) {
    const e = { id: newId(), ...cleanEntry({ ...common, kind: 'workflow', date, ...w }, ctx), createdAt: now };
    const keys = (c.rubric || []).map((r) => r.key);
    e.rubric = (Array.isArray(w.rubric) ? w.rubric : []).filter((k) => keys.includes(k)); e.graded = true; e.gradedBy = 'tự đánh giá'; e.gradedAt = now;
    out.push(e);
  }
  const t = input.time || {};
  if (t.task || t.minutesNormal || t.minutesAi) out.push({ id: newId(), ...cleanEntry({ ...common, kind: 'time', date, ...t }, ctx), createdAt: now });
  for (const r of Array.isArray(input.reports) ? input.reports : []) {
    if (r && (r.report || r.dueDate)) out.push({ id: newId(), ...cleanEntry({ ...common, kind: 'report', ...r }, ctx), createdAt: now });
  }
  const v = input.violation || {};
  if (v.has === true || v.has === 'true') out.push({ id: newId(), ...cleanEntry({ ...common, kind: 'violation', date, description: v.description }, ctx), createdAt: now });
  if (!out.length) throw new Error('Chưa nhập bằng chứng nào — điền ít nhất 1 mục (prompt/flow, số phút, báo cáo hoặc vi phạm).');
  return store.mutate((list) => ({ list: [...list, ...out], result: { entries: out } }), `ai: ghi nhận ${out.length} bằng chứng ${member} ${date.slice(0, 7)}`);
}

/** Người chấm tick checklist rubric cho 1 workflow (clear = bỏ chấm). */
function gradeWorkflow({ id, rubric, note, clear, by }, { config }) {
  const keys = (config.ai.rubric || []).map((r) => r.key);
  const ticked = (Array.isArray(rubric) ? rubric : []).filter((k) => keys.includes(k));
  return store.mutate((list) => {
    const i = list.findIndex((x) => x.id === id && x.kind === 'workflow'); if (i < 0) throw new Error('Không tìm thấy workflow với id: ' + id);
    const e = { ...list[i] };
    if (clear) { delete e.rubric; e.graded = false; delete e.gradedBy; delete e.gradedAt; delete e.gradeNote; }
    else { e.rubric = ticked; e.graded = true; e.gradedBy = by || ''; e.gradedAt = new Date().toISOString(); e.gradeNote = String(note || '').trim().slice(0, 500); }
    const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
  }, `ai: chấm workflow ${id}`);
}

module.exports = { submit, gradeWorkflow, scanSensitive, store, scoreMember, add, update, remove, setAssess };
