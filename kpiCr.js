'use strict';
/* KPI Team → CS07 "CR phân tích đúng hạn & đạt chất lượng" — chấm THEO THÁNG cho từng thành viên, từ danh sách CR được giao phân tích do QA/Manager ghi nhận.
   Actual = số CR phân tích xong ĐÚNG HẠN và KHÔNG BỊ TRẢ LẠI ÷ tổng số CR được giao phân tích × 100%  (KPI Cao tốt; chỉ Junior/Middle/Senior có KPI này).
   Mỗi CR ghi: mã/tên CR, dự án, thành viên, ngày giao, hạn phân tích, ngày phân tích xong, số lần bị trả lại (+ lý do).
   Tháng của 1 CR = tháng của HẠN phân tích (CR có hạn rơi vào tháng đánh giá).
   Phân loại: Đạt (xong ≤ hạn, chưa bị trả lại) · Trễ hạn (xong > hạn) · Bị trả lại (≥ 1 lần) · Quá hạn chưa xong (chưa xong, hạn < hôm nay) · Đang xử lý (chưa xong, hạn ≥ hôm nay — chưa tính vào mẫu số).
   Trễ hạn / bị trả lại / quá hạn chưa xong đều là KHÔNG đạt. */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');
const { vnNow } = require('./customerReport');

const store = createListStore({ repoFilePath: 'data/kpi-cr.json', localFile: 'data/kpi-cr.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'cr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());

function cleanEntry(input, { allowedMembers, allowedProjects }) {
  const cr = String(input.cr || '').trim().slice(0, 200);
  if (!cr) throw new Error('Thiếu mã / tên CR.');
  const member = lc(input.member);
  if (!allowedMembers.includes(member)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  const project = String(input.project || '').trim();
  if (!allowedProjects.includes(project)) throw new Error('Dự án không hợp lệ.');
  const dueDate = String(input.dueDate || '').trim();
  if (!isDate(dueDate)) throw new Error('Hạn phân tích không hợp lệ (YYYY-MM-DD).');
  const assignedDate = String(input.assignedDate || '').trim();
  if (assignedDate && !isDate(assignedDate)) throw new Error('Ngày giao không hợp lệ (YYYY-MM-DD).');
  const doneDate = String(input.doneDate || '').trim();
  if (doneDate && !isDate(doneDate)) throw new Error('Ngày phân tích xong không hợp lệ (YYYY-MM-DD).');
  const returnCount = Math.max(0, Math.min(20, parseInt(input.returnCount, 10) || 0));
  return { cr, member, project, assignedDate, dueDate, month: dueDate.slice(0, 7), doneDate, returnCount, returnReason: String(input.returnReason || '').trim().slice(0, 500), note: String(input.note || '').trim().slice(0, 1000) };
}

/** Phân loại 1 CR tại ngày `today` (YYYY-MM-DD, giờ VN). */
function classify(e, today) {
  const returned = e.returnCount > 0;
  if (e.doneDate) {
    const late = e.doneDate > e.dueDate;
    if (late && returned) return { status: 'Trễ hạn & bị trả lại', pass: false, decided: true, late, returned };
    if (late) return { status: 'Trễ hạn', pass: false, decided: true, late, returned };
    if (returned) return { status: 'Bị trả lại', pass: false, decided: true, late, returned };
    return { status: 'Đạt', pass: true, decided: true, late: false, returned: false };
  }
  if (returned) return { status: 'Bị trả lại (chưa xong)', pass: false, decided: true, late: e.dueDate < today, returned };
  if (e.dueDate < today) return { status: 'Quá hạn chưa xong', pass: false, decided: true, late: true, returned: false };
  return { status: 'Đang xử lý', pass: false, decided: false, late: false, returned: false };
}

function summarize(entries, today) {
  const rows = entries.map((e) => ({ ...e, ...classify(e, today) }));
  const decided = rows.filter((r) => r.decided); const pass = rows.filter((r) => r.pass).length;
  return {
    rows,
    total: rows.length, decided: decided.length, pass, fail: decided.length - pass,
    late: decided.filter((r) => r.late).length, returned: decided.filter((r) => r.returned).length, pending: rows.length - decided.length,
    actual: decided.length ? round((pass / decided.length) * 100) : null,
  };
}
const inScope = (e, { month, projects }) => e.month === month && projects.includes(e.project);

function scoreMember(all, { month, member, level, projects, config, today = vnNow().toISOString().slice(0, 10) }) {
  const c = config.cr; const who = lc(member);
  const entries = all.filter((e) => inScope(e, { month, projects }) && lc(e.member) === who).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const s = summarize(entries, today);
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOf(s.actual, th) : null;
  return {
    month, member: who, level, projects,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { total: s.total, decided: s.decided, pass: s.pass, fail: s.fail, late: s.late, returned: s.returned, pending: s.pending, actual: s.actual,
      progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    entries: s.rows,
  };
}

function overview(all, { month, projects, today = vnNow().toISOString().slice(0, 10) }) {
  const by = new Map();
  for (const e of all.filter((x) => inScope(x, { month, projects }))) { const a = by.get(lc(e.member)) || []; a.push(e); by.set(lc(e.member), a); }
  return [...by.entries()].map(([member, es]) => { const s = summarize(es, today); return { member, total: s.total, pass: s.pass, fail: s.fail, pending: s.pending, actual: s.actual }; }).sort((a, b) => a.member.localeCompare(b.member));
}

const add = (input, ctx) => { const e = { id: newId(), ...cleanEntry(input, ctx), createdAt: new Date().toISOString() }; return store.mutate((list) => ({ list: [...list, e], result: { entry: e } }), `cr: thêm ${e.cr} (${e.member})`); };
const update = (id, input, ctx) => store.mutate((list) => {
  const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error('Không tìm thấy CR với id: ' + id);
  const e = { ...list[i], ...cleanEntry(input, ctx), updatedAt: new Date().toISOString() }; const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
}, `cr: cập nhật ${id}`);
const remove = (id) => store.mutate((list) => { const next = list.filter((x) => x.id !== id); if (next.length === list.length) throw new Error('Không tìm thấy CR với id: ' + id); return { list: next, result: {} }; }, `cr: xoá ${id}`);

module.exports = { store, classify, scoreMember, overview, add, update, remove };
