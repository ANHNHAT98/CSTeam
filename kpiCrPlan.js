'use strict';
/* KPI Team → CS25 "Quản lý CR" — giữ đúng plan CR đã cam kết với khách hàng, chấm THEO THÁNG cho từng thành viên (KPI Cao tốt; Junior/Middle có trọng số).
   CÁCH 1 (file này) — quản lý lập lộ trình tháng, nhân viên nhập ngày thực tế + bằng chứng (giống CS23):
     • QUẢN LÝ lập cho từng nhân viên một danh sách "mục plan CR" của tháng: tên mục (CR + mốc), TRỌNG SỐ %, HẠN cam kết với khách. Tổng trọng số các mục của 1 nhân viên = 100%.
       Gợi ý 3 mốc (config "crplan.criteria"): bàn giao testcase+tài liệu CRs trước Staging 40% · up gói + PM review không lỗi trên Staging đúng hạn 45% · up PROD đúng kế hoạch 15%.
     • NHÂN VIÊN nhập NGÀY THỰC TẾ hoàn thành, tick "có lỗi / không đạt" nếu PM review có lỗi, và dán bằng chứng / link; Lưu = 1 commit.
     • Mục ĐẠT: có ngày thực tế ≤ hạn cam kết và không có lỗi. Không đạt: trễ hạn, có lỗi, hoặc chưa có ngày thực tế mà hạn đã qua. Mục chưa tới hạn = "Đang chờ" (chưa tính, trọng số các mục còn lại được chuẩn hóa).
     • Actual = Σ (trọng số × mục đạt) ÷ Σ trọng số các mục đã có kết quả × 100%.
   CÁCH 2 (server.js) — tự động từ task SynergyHub. */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');
const { vnNow } = require('./customerReport');

const store = createListStore({ repoFilePath: 'data/kpi-crplan-roadmap.json', localFile: 'data/kpi-crplan-roadmap.json' });
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'crp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime());
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
const today0 = () => vnNow().toISOString().slice(0, 10);

/** Phân loại 1 mục tại ngày today. */
function classify(e, today) {
  if (e.actualDate) {
    if (e.actualDate > e.plannedDate) return { status: 'Trễ hạn', pass: false, decided: true };
    if (e.hasError) return { status: 'Có lỗi / không đạt', pass: false, decided: true };
    return { status: 'Đạt', pass: true, decided: true };
  }
  if (e.hasError) return { status: 'Có lỗi / không đạt', pass: false, decided: true };
  if (e.plannedDate < today) return { status: 'Quá hạn chưa xong', pass: false, decided: true };
  return { status: 'Đang chờ', pass: false, decided: false };
}

function scoreMember(all, { month, member, level, config, today = today0() }) {
  const c = config.crplan; const who = lc(member);
  const entries = all.filter((e) => e.month === month && lc(e.member) === who).sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || a.module.localeCompare(b.module, 'vi'));
  const rows = entries.map((e) => ({ ...e, ...classify(e, today) }));
  const W = rows.reduce((s, e) => s + e.weight, 0); const decided = rows.filter((r) => r.decided); const Wd = decided.reduce((s, e) => s + e.weight, 0);
  const actual = Wd > 0 ? round((decided.filter((r) => r.pass).reduce((s, e) => s + e.weight, 0) / Wd) * 100) : null;
  rows.forEach((r) => { r.contribution = r.decided && Wd > 0 ? round((r.pass ? r.weight : 0) / Wd * 100) : null; });
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const p = applicable ? progressOf(actual, th) : null;
  return {
    month, member: who, level,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { total: rows.length, decided: decided.length, pass: decided.filter((r) => r.pass).length, fail: decided.filter((r) => !r.pass).length, pending: rows.length - decided.length,
      totalWeight: round(W, 2), weightOk: Math.abs(W - 100) < 0.01, weightDecided: round(Wd, 2), actual,
      progress: p ? round(p.progress) : null, tier: p ? p.tier : null, band: p ? p.band : '', points: p && applicable ? round((p.progress * weight) / 100) : null },
    entries: rows,
  };
}

/** Lộ trình đã lập theo tháng (lọc nhân viên nếu có). */
function roadmaps(all, { month, member, config, today = today0() }) {
  const members = [...new Set(all.filter((e) => e.month === month && (!member || lc(e.member) === lc(member))).map((e) => lc(e.member)))];
  return members.map((m) => {
    const r = scoreMember(all, { month, member: m, level: 'Junior', config, today });
    return { member: m, weightSum: r.result.totalWeight, weightOk: r.result.weightOk, actual: r.result.actual, pending: r.result.pending,
      modules: r.entries.map((e) => ({ id: e.id, module: e.module, weight: e.weight, plannedDate: e.plannedDate, actualDate: e.actualDate, status: e.status, evidence: e.evidence })) };
  }).sort((a, b) => a.member.localeCompare(b.member));
}

/** QUẢN LÝ lập / cập nhật lộ trình tháng cho 1+ nhân viên (1 lần ghi). Mục trùng tên giữ ngày thực tế / bằng chứng, đổi trọng số + hạn; mục bỏ khỏi danh sách bị xoá. */
function setRoadmap({ members, month, modules }, { allowedMembers }) {
  if (!isMonth(month)) throw new Error('Tháng không hợp lệ (YYYY-MM).');
  const ms = [...new Set((Array.isArray(members) ? members : []).map(lc))]; if (!ms.length) throw new Error('Chọn ít nhất 1 nhân viên.');
  if (ms.length > 30) throw new Error('Tối đa 30 nhân viên mỗi lần.');
  for (const m of ms) if (!allowedMembers.includes(m)) throw new Error(`Thành viên "${m}" không nằm trong danh sách người tạo ticket.`);
  const mods = (Array.isArray(modules) ? modules : []).map((x) => ({ module: String(x.module || '').trim().slice(0, 200), weight: Number(x.weight), plannedDate: String(x.plannedDate || '').trim() }));
  if (!mods.length) throw new Error('Lộ trình cần ít nhất 1 mục.'); if (mods.length > 40) throw new Error('Tối đa 40 mục mỗi lộ trình.');
  const seen = new Set();
  for (const m of mods) {
    if (!m.module) throw new Error('Có mục chưa có tên.');
    if (!Number.isFinite(m.weight) || m.weight <= 0 || m.weight > 100) throw new Error(`Trọng số của mục "${m.module}" phải lớn hơn 0 và không quá 100 (%).`);
    if (!isDate(m.plannedDate)) throw new Error(`Mục "${m.module}" cần có hạn cam kết với khách (YYYY-MM-DD).`);
    const k = lc(m.module); if (seen.has(k)) throw new Error(`Mục "${m.module}" bị trùng tên.`); seen.add(k);
  }
  const sum = mods.reduce((s, m) => s + m.weight, 0);
  if (Math.abs(sum - 100) > 0.01) throw new Error(`Tổng trọng số các mục phải bằng 100% (hiện là ${round(sum, 2)}%).`);
  const now = new Date().toISOString();
  return store.mutate((list) => {
    const old = list.filter((e) => e.month === month && ms.includes(lc(e.member)));
    const kept = list.filter((e) => !(e.month === month && ms.includes(lc(e.member))));
    let created = 0; let updated = 0;
    for (const m of ms) for (const md of mods) {
      const prev = old.find((e) => lc(e.member) === m && lc(e.module) === lc(md.module));
      if (prev) { kept.push({ ...prev, module: md.module, weight: md.weight, plannedDate: md.plannedDate, updatedAt: now }); updated++; }
      else { kept.push({ id: newId(), module: md.module, member: m, month, weight: md.weight, plannedDate: md.plannedDate, actualDate: '', hasError: false, evidence: '', note: '', createdAt: now }); created++; }
    }
    const removed = old.filter((e) => !mods.some((md) => lc(md.module) === lc(e.module))).length;
    return { list: kept, result: { members: ms.length, modules: mods.length, created, updated, removed } };
  }, `crplan: lộ trình ${month} cho ${ms.length} nhân viên (${mods.length} mục)`);
}

/** NHÂN VIÊN nhập ngày thực tế + bằng chứng cho các mục của mình (1 lần ghi = 1 commit). items: [{id, actualDate, hasError, evidence, note}] */
function submit({ member, month, items }, { allowedMembers }) {
  const who = lc(member); if (!allowedMembers.includes(who)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  if (!isMonth(month)) throw new Error('Tháng không hợp lệ (YYYY-MM).');
  if (!Array.isArray(items) || !items.length) throw new Error('Không có mục nào để lưu.');
  const upd = new Map();
  for (const it of items) {
    const a = String(it.actualDate || '').trim(); if (a && !isDate(a)) throw new Error('Ngày thực tế không hợp lệ (YYYY-MM-DD).');
    upd.set(String(it.id), { actualDate: a, hasError: it.hasError === true || it.hasError === 'true', evidence: String(it.evidence || '').trim().slice(0, 500), note: String(it.note || '').trim().slice(0, 1000) });
  }
  const now = new Date().toISOString();
  return store.mutate((list) => {
    let n = 0;
    const next = list.map((e) => { const u = upd.get(e.id); if (!u) return e; if (lc(e.member) !== who || e.month !== month) throw new Error('Mục không thuộc nhân viên / tháng này.'); n++; return { ...e, ...u, submittedAt: now }; });
    if (n !== upd.size) throw new Error('Có mục không tồn tại (có thể quản lý vừa đổi lộ trình) — tải lại trang.');
    return { list: next, result: { saved: n } };
  }, `crplan: ${who} gửi bằng chứng ${month} (${upd.size} mục)`);
}

module.exports = { store, classify, scoreMember, roadmaps, setRoadmap, submit };
