'use strict';
/* KPI Team → CS23 "Hoàn thành chứng nhận sản phẩm" — chấm THEO KỲ (tháng) cho từng thành viên từ lộ trình module chứng nhận.
   Actual = Σ (trọng số module × % hoàn thành module) ÷ Σ trọng số  (KPI Cao tốt, Target = Max; chỉ Fresher/Junior có KPI này).
   - QUẢN LÝ lập lộ trình của kỳ cho từng nhân viên: danh sách module + trọng số % (tổng các module của 1 nhân viên trong 1 tháng phải = 100%).
   - NHÂN VIÊN gửi bằng chứng / link và tự đánh giá % hoàn thành (0–100%) cho từng module; Lưu = 1 commit.
   - Bảng tổng hợp ở trang gồm từng module: trọng số, % hoàn thành, điểm đóng góp, bằng chứng.
   Dữ liệu cũ (chỉ có "ngày hoàn thành", chưa có % hoàn thành): có ngày hoàn thành = 100%, chưa có = 0%.
   Nguồn của KPI là LMS/TDC nhưng tool chưa nối LMS nên ghi nhận tay. */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');

const store = createListStore({ repoFilePath: 'data/kpi-cert.json', localFile: 'data/kpi-cert.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'cert_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
const completionOf = (e) => (e.completion != null && e.completion !== '' ? Math.max(0, Math.min(100, Number(e.completion) || 0)) : (e.doneDate ? 100 : 0));

function cleanEntry(input, { allowedMembers }) {
  const module_ = String(input.module || '').trim().slice(0, 200);
  if (!module_) throw new Error('Thiếu tên module chứng nhận.');
  const member = lc(input.member);
  if (!allowedMembers.includes(member)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  const month = String(input.month || '').trim();
  if (!isMonth(month)) throw new Error('Kỳ (tháng) không hợp lệ (YYYY-MM).');
  const weight = input.weight === '' || input.weight == null ? 1 : Number(input.weight);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new Error('Trọng số (%) phải lớn hơn 0 và không quá 100.');
  const dueDate = String(input.dueDate || '').trim(); if (dueDate && !isDate(dueDate)) throw new Error('Hạn không hợp lệ (YYYY-MM-DD).');
  const doneDate = String(input.doneDate || '').trim(); if (doneDate && !isDate(doneDate)) throw new Error('Ngày hoàn thành không hợp lệ (YYYY-MM-DD).');
  const completion = input.completion === '' || input.completion == null ? 0 : Number(input.completion);
  if (!Number.isFinite(completion) || completion < 0 || completion > 100) throw new Error('% hoàn thành phải từ 0 đến 100.');
  return { module: module_, member, month, weight, dueDate, doneDate, completion, evidence: String(input.evidence || '').trim().slice(0, 500), note: String(input.note || '').trim().slice(0, 1000) };
}

function scoreMember(all, { month, member, level, config }) {
  const c = config.cert; const who = lc(member);
  const entries = all.filter((e) => e.month === month && lc(e.member) === who).map((e) => ({ ...e, completion: completionOf(e) }))
    .sort((a, b) => a.module.localeCompare(b.module, 'vi'));
  const W = entries.reduce((s, e) => s + e.weight, 0);
  const rows = entries.map((e) => ({ ...e, contribution: W > 0 ? round((e.weight * e.completion) / W) : 0 }));
  const actual = W > 0 ? round(rows.reduce((s, e) => s + e.weight * e.completion, 0) / W) : null;
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOf(actual, th) : null;
  return {
    month, member: who, level,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { total: rows.length, done: rows.filter((e) => e.completion >= 100).length, totalWeight: round(W, 2), weightOk: Math.abs(W - 100) < 0.01, actual,
      progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    entries: rows,
  };
}

/** Các lộ trình của tháng (lọc theo thành viên nếu có): mỗi nhân viên 1 dòng gồm danh sách module + tổng trọng số + Actual. */
function roadmaps(all, { month, member }) {
  const by = new Map();
  for (const e of all.filter((x) => x.month === month && (!member || lc(x.member) === lc(member)))) { const a = by.get(lc(e.member)) || []; a.push({ ...e, completion: completionOf(e) }); by.set(lc(e.member), a); }
  return [...by.entries()].map(([m, es]) => {
    const W = es.reduce((s, e) => s + e.weight, 0);
    return { member: m, weightSum: round(W, 2), weightOk: Math.abs(W - 100) < 0.01, actual: W ? round(es.reduce((s, e) => s + e.weight * e.completion, 0) / W) : null,
      modules: es.sort((a, b) => a.module.localeCompare(b.module, 'vi')).map((e) => ({ id: e.id, module: e.module, weight: e.weight, completion: e.completion, evidence: e.evidence, note: e.note })) };
  }).sort((a, b) => a.member.localeCompare(b.member));
}

/** QUẢN LÝ lập / cập nhật lộ trình tháng cho 1 hoặc nhiều nhân viên bằng 1 lần ghi. Module trùng tên (không phân biệt hoa thường) giữ nguyên % hoàn thành + bằng chứng, chỉ đổi trọng số; module bị bỏ khỏi danh sách thì bị xoá. */
function setRoadmap({ members, month, modules }, { allowedMembers }) {
  if (!isMonth(month)) throw new Error('Kỳ (tháng) không hợp lệ (YYYY-MM).');
  const ms = [...new Set((Array.isArray(members) ? members : []).map(lc))]; if (!ms.length) throw new Error('Chọn ít nhất 1 nhân viên.');
  if (ms.length > 30) throw new Error('Tối đa 30 nhân viên mỗi lần.');
  for (const m of ms) if (!allowedMembers.includes(m)) throw new Error(`Thành viên "${m}" không nằm trong danh sách người tạo ticket.`);
  const mods = (Array.isArray(modules) ? modules : []).map((x) => ({ module: String(x.module || '').trim().slice(0, 200), weight: Number(x.weight) }));
  if (!mods.length) throw new Error('Lộ trình cần ít nhất 1 module.');
  if (mods.length > 30) throw new Error('Tối đa 30 module mỗi lộ trình.');
  const seen = new Set();
  for (const m of mods) {
    if (!m.module) throw new Error('Có module chưa có tên.');
    if (!Number.isFinite(m.weight) || m.weight <= 0 || m.weight > 100) throw new Error(`Trọng số của module "${m.module}" phải lớn hơn 0 và không quá 100 (%).`);
    const k = lc(m.module); if (seen.has(k)) throw new Error(`Module "${m.module}" bị trùng tên.`); seen.add(k);
  }
  const sum = mods.reduce((s, m) => s + m.weight, 0);
  if (Math.abs(sum - 100) > 0.01) throw new Error(`Tổng trọng số các module phải bằng 100% (hiện là ${round(sum, 2)}%).`);
  const now = new Date().toISOString();
  return store.mutate((list) => {
    let kept = list.filter((e) => !(e.month === month && ms.includes(lc(e.member))));
    const old = list.filter((e) => e.month === month && ms.includes(lc(e.member)));
    let created = 0; let updated = 0;
    for (const m of ms) {
      for (const md of mods) {
        const prev = old.find((e) => lc(e.member) === m && lc(e.module) === lc(md.module));
        if (prev) { kept.push({ ...prev, module: md.module, weight: md.weight, updatedAt: now }); updated++; }
        else { kept.push({ id: newId(), module: md.module, member: m, month, weight: md.weight, dueDate: '', doneDate: '', completion: 0, evidence: '', note: '', createdAt: now }); created++; }
      }
    }
    const removed = old.filter((e) => !mods.some((md) => lc(md.module) === lc(e.module))).length;
    return { list: kept, result: { members: ms.length, modules: mods.length, created, updated, removed } };
  }, `cert: lộ trình ${month} cho ${ms.length} nhân viên (${mods.length} module)`);
}

/** NHÂN VIÊN gửi bằng chứng + % hoàn thành cho các module của mình (1 lần ghi = 1 commit). items: [{id, completion, evidence, note}] */
function submit({ member, month, items }, { allowedMembers }) {
  const who = lc(member); if (!allowedMembers.includes(who)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  if (!isMonth(month)) throw new Error('Kỳ (tháng) không hợp lệ (YYYY-MM).');
  if (!Array.isArray(items) || !items.length) throw new Error('Không có module nào để lưu.');
  const upd = new Map();
  for (const it of items) {
    const c = it.completion === '' || it.completion == null ? 0 : Number(it.completion);
    if (!Number.isFinite(c) || c < 0 || c > 100) throw new Error('% hoàn thành phải từ 0 đến 100.');
    upd.set(String(it.id), { completion: c, evidence: String(it.evidence || '').trim().slice(0, 500), note: String(it.note || '').trim().slice(0, 1000) });
  }
  const now = new Date().toISOString();
  return store.mutate((list) => {
    let n = 0;
    const next = list.map((e) => {
      const u = upd.get(e.id); if (!u) return e;
      if (lc(e.member) !== who || e.month !== month) throw new Error('Module không thuộc nhân viên / kỳ này.');
      n++; return { ...e, ...u, doneDate: u.completion >= 100 ? (e.doneDate || now.slice(0, 10)) : '', submittedAt: now };
    });
    if (n !== upd.size) throw new Error('Có module không tồn tại (có thể quản lý vừa đổi lộ trình) — tải lại trang.');
    return { list: next, result: { saved: n } };
  }, `cert: ${who} gửi bằng chứng ${month} (${upd.size} module)`);
}

const add = (input, ctx) => { const e = { id: newId(), ...cleanEntry(input, ctx), createdAt: new Date().toISOString() }; return store.mutate((list) => ({ list: [...list, e], result: { entry: e } }), `cert: thêm ${e.module} (${e.member})`); };
const update = (id, input, ctx) => store.mutate((list) => {
  const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error('Không tìm thấy module với id: ' + id);
  const e = { ...list[i], ...cleanEntry(input, ctx), updatedAt: new Date().toISOString() }; const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
}, `cert: cập nhật ${id}`);
const remove = (id) => store.mutate((list) => { const next = list.filter((x) => x.id !== id); if (next.length === list.length) throw new Error('Không tìm thấy module với id: ' + id); return { list: next, result: {} }; }, `cert: xoá ${id}`);

module.exports = { store, scoreMember, roadmaps, setRoadmap, submit, add, update, remove };
