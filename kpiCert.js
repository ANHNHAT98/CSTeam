'use strict';
/* KPI Team → CS23 "Hoàn thành chứng nhận sản phẩm" — chấm THEO KỲ (tháng) cho từng thành viên từ lộ trình module chứng nhận được giao.
   Actual = số module chứng nhận hoàn thành ÷ tổng số module trong lộ trình của kỳ × 100%  (KPI Cao tốt, Target = Max; chỉ Fresher/Junior có KPI này).
   Mỗi module có trọng số (mặc định 1 = các module ngang nhau; có thể nhập 50/50… nếu các phần có tỷ trọng khác nhau): Actual = Σ trọng số module hoàn thành ÷ Σ trọng số cả lộ trình.
   Module "hoàn thành" khi có NGÀY HOÀN THÀNH (nên kèm bằng chứng: link tài liệu tổng hợp, ảnh chụp kết quả…). Nguồn dữ liệu của KPI là LMS/TDC nhưng tool chưa nối LMS nên ghi nhận tay. */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');

const store = createListStore({ repoFilePath: 'data/kpi-cert.json', localFile: 'data/kpi-cert.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'cert_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));

function cleanEntry(input, { allowedMembers }) {
  const module_ = String(input.module || '').trim().slice(0, 200);
  if (!module_) throw new Error('Thiếu tên module chứng nhận.');
  const member = lc(input.member);
  if (!allowedMembers.includes(member)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  const month = String(input.month || '').trim();
  if (!isMonth(month)) throw new Error('Kỳ (tháng) không hợp lệ (YYYY-MM).');
  const weight = input.weight === '' || input.weight == null ? 1 : Number(input.weight);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) throw new Error('Trọng số phải là số lớn hơn 0 (mặc định 1).');
  const dueDate = String(input.dueDate || '').trim(); if (dueDate && !isDate(dueDate)) throw new Error('Hạn không hợp lệ (YYYY-MM-DD).');
  const doneDate = String(input.doneDate || '').trim(); if (doneDate && !isDate(doneDate)) throw new Error('Ngày hoàn thành không hợp lệ (YYYY-MM-DD).');
  return { module: module_, member, month, weight, dueDate, doneDate, evidence: String(input.evidence || '').trim().slice(0, 500), note: String(input.note || '').trim().slice(0, 1000) };
}

function scoreMember(all, { month, member, level, config }) {
  const c = config.cert; const who = lc(member);
  const entries = all.filter((e) => e.month === month && lc(e.member) === who).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.module.localeCompare(b.module, 'vi'));
  const W = entries.reduce((s, e) => s + e.weight, 0); const D = entries.filter((e) => e.doneDate).reduce((s, e) => s + e.weight, 0);
  const actual = W > 0 ? round((D / W) * 100) : null;
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOf(actual, th) : null;
  return {
    month, member: who, level,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { total: entries.length, done: entries.filter((e) => e.doneDate).length, totalWeight: W, doneWeight: D, actual,
      progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    entries,
  };
}
function overview(all, { month }) {
  const by = new Map();
  for (const e of all.filter((x) => x.month === month)) { const a = by.get(lc(e.member)) || []; a.push(e); by.set(lc(e.member), a); }
  return [...by.entries()].map(([member, es]) => { const W = es.reduce((s, e) => s + e.weight, 0); const D = es.filter((e) => e.doneDate).reduce((s, e) => s + e.weight, 0); return { member, total: es.length, done: es.filter((e) => e.doneDate).length, actual: W ? round((D / W) * 100) : null }; }).sort((a, b) => a.member.localeCompare(b.member));
}

const add = (input, ctx) => { const e = { id: newId(), ...cleanEntry(input, ctx), createdAt: new Date().toISOString() }; return store.mutate((list) => ({ list: [...list, e], result: { entry: e } }), `cert: thêm ${e.module} (${e.member})`); };
/** Thêm nhiều module cho 1 thành viên trong 1 kỳ bằng 1 lần ghi (1 commit). items: [{module, weight?, dueDate?}] */
const addMany = (base, items, ctx) => {
  if (!Array.isArray(items) || !items.length) throw new Error('Chưa có module nào để thêm.');
  if (items.length > 50) throw new Error('Tối đa 50 module mỗi lần thêm.');
  const now = new Date().toISOString();
  const es = items.map((it) => ({ id: newId(), ...cleanEntry({ ...base, ...it }, ctx), createdAt: now }));
  return store.mutate((list) => ({ list: [...list, ...es], result: { entries: es } }), `cert: thêm ${es.length} module (${es[0].member}, ${es[0].month})`);
};
const update = (id, input, ctx) => store.mutate((list) => {
  const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error('Không tìm thấy module với id: ' + id);
  const e = { ...list[i], ...cleanEntry(input, ctx), updatedAt: new Date().toISOString() }; const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
}, `cert: cập nhật ${id}`);
const remove = (id) => store.mutate((list) => { const next = list.filter((x) => x.id !== id); if (next.length === list.length) throw new Error('Không tìm thấy module với id: ' + id); return { list: next, result: {} }; }, `cert: xoá ${id}`);

module.exports = { store, scoreMember, overview, add, addMany, update, remove };
