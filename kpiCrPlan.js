'use strict';
/* KPI Team → CS25 "Quản lý CR" — giữ đúng plan CR đã cam kết với khách hàng, chấm THEO THÁNG cho từng thành viên (KPI Cao tốt; Junior/Middle có trọng số).
   Mỗi CR được giao có 3 mốc cam kết với khách (cấu hình ở kpi-sla-config.json → "crplan.criteria", tổng trọng số 100):
     1. Bàn giao đầy đủ testcase CRs + tài liệu CRs trước khi lên Staging            — 40%
     2. Up gói CRs + review CRs từ PM không lỗi trên Staging, đúng hạn theo kế hoạch của khách — 45%
     3. Up PROD hoàn thành theo kế hoạch của khách                                   — 15%
   Mỗi mốc ghi: hạn cam kết với khách (ghi hạn GỐC — hạn bị lùi vẫn tính theo hạn gốc) và ngày thực tế; mốc 2 có thêm cờ "PM review có lỗi".
   Mốc thuộc THÁNG của hạn cam kết (so với cuối tháng). Mốc ĐẠT: có ngày thực tế ≤ hạn (và mốc 2: PM review không lỗi). Không đạt: trễ hạn, PM review có lỗi, hoặc
   chưa có ngày thực tế mà hạn đã qua. Chưa tới hạn: "Đang chờ" (không tính).
   Tỷ lệ từng tiêu chí = số mốc đạt ÷ số mốc đã có kết quả của tiêu chí đó trong tháng.
   Actual = Σ (trọng số tiêu chí × tỷ lệ tiêu chí) ÷ Σ trọng số các tiêu chí có dữ liệu trong tháng (tiêu chí chưa có mốc nào tới hạn thì bỏ ra khỏi mẫu số). */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');
const { vnNow } = require('./customerReport');

const store = createListStore({ repoFilePath: 'data/kpi-crplan.json', localFile: 'data/kpi-crplan.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'crp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());

function cleanEntry(input, { config, allowedMembers, allowedProjects }) {
  const cr = String(input.cr || '').trim().slice(0, 200); if (!cr) throw new Error('Thiếu mã / tên CR.');
  const member = lc(input.member); if (!allowedMembers.includes(member)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  const project = String(input.project || '').trim(); if (!allowedProjects.includes(project)) throw new Error('Dự án không hợp lệ.');
  const ms = {}; let any = false;
  for (const c of config.crplan.criteria) {
    const src = (input.milestones && input.milestones[c.key]) || {};
    const planned = String(src.planned || '').trim(); const actual = String(src.actual || '').trim();
    if (planned && !isDate(planned)) throw new Error(`Hạn cam kết của mốc "${c.label}" không hợp lệ (YYYY-MM-DD).`);
    if (actual && !isDate(actual)) throw new Error(`Ngày thực tế của mốc "${c.label}" không hợp lệ (YYYY-MM-DD).`);
    if (actual && !planned) throw new Error(`Mốc "${c.label}" có ngày thực tế thì phải có hạn cam kết với khách.`);
    if (planned) any = true;
    ms[c.key] = { planned, actual, ...(c.key === 'staging' ? { pmErrors: src.pmErrors === true || src.pmErrors === 'true' } : {}) };
  }
  if (!any) throw new Error('Cần ít nhất 1 mốc có hạn cam kết với khách.');
  return { cr, member, project, milestones: ms, note: String(input.note || '').trim().slice(0, 1000) };
}

/** Phân loại 1 mốc tại ngày today. */
function classify(key, m, today) {
  if (!m || !m.planned) return null;
  if (m.actual) {
    if (m.actual > m.planned) return { status: 'Trễ hạn', pass: false, decided: true };
    if (key === 'staging' && m.pmErrors) return { status: 'PM review có lỗi', pass: false, decided: true };
    return { status: 'Đạt', pass: true, decided: true };
  }
  if (m.planned < today) return { status: 'Quá hạn chưa xong', pass: false, decided: true };
  return { status: 'Đang chờ', pass: false, decided: false };
}

function scoreMember(all, { month, member, level, projects, config, today = vnNow().toISOString().slice(0, 10) }) {
  const c = config.crplan; const who = lc(member);
  const mine = all.filter((e) => lc(e.member) === who && projects.includes(e.project));
  const crs = []; const stats = Object.fromEntries(c.criteria.map((k) => [k.key, { pass: 0, fail: 0, pending: 0 }]));
  for (const e of mine) {
    const row = { ...e, ms: {} }; let inMonth = false;
    for (const k of c.criteria) {
      const m = e.milestones[k.key]; const cl = classify(k.key, m, today);
      const mine_ = Boolean(m && m.planned && m.planned.slice(0, 7) === month);
      row.ms[k.key] = cl ? { ...m, ...cl, inMonth: mine_ } : null;
      if (mine_) { inMonth = true; if (cl.decided) { if (cl.pass) stats[k.key].pass++; else stats[k.key].fail++; } else stats[k.key].pending++; }
    }
    if (inMonth) crs.push(row);
  }
  crs.sort((a, b) => a.cr.localeCompare(b.cr, 'vi'));
  const criteria = c.criteria.map((k) => { const s = stats[k.key]; const dec = s.pass + s.fail; return { key: k.key, label: k.label, weight: k.weight, ...s, decided: dec, rate: dec ? round((s.pass / dec) * 100) : null }; });
  const used = criteria.filter((k) => k.decided > 0); const wSum = used.reduce((s, k) => s + k.weight, 0);
  const actual = wSum ? round(used.reduce((s, k) => s + k.weight * k.rate, 0) / wSum) : null;
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOf(actual, th) : null;
  return {
    month, member: who, level, projects,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { crs: crs.length, weightUsed: wSum, actual, progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    criteria, entries: crs,
  };
}
function overview(all, { month, projects, config, today = vnNow().toISOString().slice(0, 10) }) {
  const members = [...new Set(all.filter((e) => projects.includes(e.project)).map((e) => lc(e.member)))];
  return members.map((m) => { const r = scoreMember(all, { month, member: m, level: 'Junior', projects, config, today }); return { member: m, crs: r.result.crs, actual: r.result.actual }; }).filter((o) => o.crs > 0).sort((a, b) => a.member.localeCompare(b.member));
}

const add = (input, ctx) => { const e = { id: newId(), ...cleanEntry(input, ctx), createdAt: new Date().toISOString() }; return store.mutate((list) => ({ list: [...list, e], result: { entry: e } }), `crplan: thêm ${e.cr} (${e.member})`); };
const update = (id, input, ctx) => store.mutate((list) => {
  const i = list.findIndex((x) => x.id === id); if (i < 0) throw new Error('Không tìm thấy CR với id: ' + id);
  const e = { ...list[i], ...cleanEntry(input, ctx), updatedAt: new Date().toISOString() }; const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
}, `crplan: cập nhật ${id}`);
const remove = (id) => store.mutate((list) => { const next = list.filter((x) => x.id !== id); if (next.length === list.length) throw new Error('Không tìm thấy CR với id: ' + id); return { list: next, result: {} }; }, `crplan: xoá ${id}`);

module.exports = { store, classify, scoreMember, overview, add, update, remove };
