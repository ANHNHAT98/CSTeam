'use strict';
/* KPI Team → CS03 "Complaint khách hàng" — chấm THEO THÁNG cho từng thành viên, từ các complaint được ghi nhận tay (email/call/chat).
   Mong muốn: không có khách hàng nào phàn nàn. Phạm vi dự án: ABI và Sabeco.
   Cách tính (cấu hình ở kpi-sla-config.json → "complaint"):
     Điểm trừ  = 20% × số complaint về TIẾN ĐỘ từ Manager
               + Σ theo từng issue/ticket bị phản hồi LẶP LẠI: 1 phản hồi = 5%, 2 phản hồi = 10%, từ 3 phản hồi = 15%
     Actual    = 100% − điểm trừ (tối thiểu 0%)
   Actual rồi đi qua Min/Target/Max của level (KPI Cao tốt, ngưỡng CS03 trong Master KPI) → Progress → KPI Completion = Progress × trọng số. */

const { createListStore } = require('./listStore');
const { progressOf } = require('./kpiSla');
const { isMonthKey } = require('./customerReportMonthly');

const store = createListStore({ repoFilePath: 'data/kpi-complaints.json', localFile: 'data/kpi-complaints.json' });
const TYPES = { progress: 'Complaint về tiến độ công việc (từ Manager)', repeat: 'Phản hồi lặp lại của 1 issue/ticket' };
const lc = (s) => String(s || '').trim().toLowerCase();
const round = (x, d = 4) => { const f = 10 ** d; return Math.round(x * f) / f; };
const newId = () => 'cmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

/** Làm sạch + kiểm tra 1 bản ghi nhập vào. allowedMembers: danh sách email hợp lệ. */
function cleanEntry(input, { config, allowedMembers }) {
  const c = config.complaint;
  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) throw new Error('Ngày không hợp lệ (YYYY-MM-DD).');
  const member = lc(input.member);
  if (!allowedMembers.includes(member)) throw new Error('Thành viên không nằm trong danh sách người tạo ticket.');
  const project = String(input.project || '').trim();
  if (!c.projects.includes(project)) throw new Error('Dự án không thuộc phạm vi KPI này (chỉ ABI và Sabeco).');
  const type = String(input.type || '');
  if (!TYPES[type]) throw new Error('Loại complaint không hợp lệ.');
  const issue = String(input.issue || '').trim().slice(0, 200);
  if (type === 'repeat' && !issue) throw new Error('Phản hồi lặp lại phải ghi mã ticket hoặc tên issue để gom các lần lặp lại.');
  const channel = c.channels.includes(input.channel) ? input.channel : 'Khác';
  return { date, month: date.slice(0, 7), member, project, type, issue, channel, note: String(input.note || '').trim().slice(0, 1000) };
}

function repeatPenalty(n, c) {
  const t = c.repeatPenaltyByCount; // {"1":5,"2":10,"3+":15}
  if (n >= 3) return Number(t['3+'] ?? t['3'] ?? 0);
  return Number(t[String(n)] ?? 0);
}

/** Điểm trừ + chi tiết cho 1 danh sách complaint (đã lọc đúng thành viên/tháng/dự án). */
function penaltyOf(entries, c) {
  const progress = entries.filter((e) => e.type === 'progress');
  const groups = new Map();
  for (const e of entries.filter((x) => x.type === 'repeat')) {
    const k = `${e.project}|${lc(e.issue)}`;
    const g = groups.get(k) || { project: e.project, issue: e.issue, count: 0, entries: [] };
    g.count++; g.entries.push(e.id); groups.set(k, g);
  }
  const repeatGroups = [...groups.values()].map((g) => ({ ...g, penalty: repeatPenalty(g.count, c) })).sort((a, b) => b.penalty - a.penalty);
  const progressPenalty = progress.length * c.progressComplaintPenalty;
  const repeatPen = repeatGroups.reduce((s, g) => s + g.penalty, 0);
  return { progressCount: progress.length, progressPenalty, repeatGroups, repeatFeedbacks: repeatGroups.reduce((s, g) => s + g.count, 0), repeatPenalty: repeatPen, penalty: progressPenalty + repeatPen };
}

function inScope(e, { month, projects }) { return e.month === month && projects.includes(e.project); }

function scoreMember(all, { month, member, level, projects, config }) {
  const c = config.complaint; const who = lc(member);
  const entries = all.filter((e) => inScope(e, { month, projects }) && lc(e.member) === who).sort((a, b) => a.date.localeCompare(b.date));
  const p = penaltyOf(entries, c);
  const actual = Math.max(0, 100 - p.penalty);
  const th = c.thresholds[level]; const weight = c.weights[level];
  const applicable = Boolean(th) && weight != null;
  const pr = applicable ? progressOf(actual, th) : null;
  return {
    month, member: who, level, projects,
    kpi: { code: c.code, applicable, thresholds: th || null, weight: applicable ? weight : null },
    result: { ...p, actual, progress: pr ? round(pr.progress) : null, tier: pr ? pr.tier : null, band: pr ? pr.band : '', points: pr && applicable ? round((pr.progress * weight) / 100) : null },
    entries,
  };
}

/** Tổng hợp mọi thành viên có complaint trong tháng (chưa gắn level). */
function overview(all, { month, projects, config }) {
  const by = new Map();
  for (const e of all.filter((x) => inScope(x, { month, projects }))) { const a = by.get(lc(e.member)) || []; a.push(e); by.set(lc(e.member), a); }
  return [...by.entries()].map(([member, es]) => { const p = penaltyOf(es, config.complaint); return { member, complaints: es.length, progressCount: p.progressCount, repeatFeedbacks: p.repeatFeedbacks, penalty: p.penalty, actual: Math.max(0, 100 - p.penalty) }; })
    .sort((a, b) => b.penalty - a.penalty || a.member.localeCompare(b.member));
}

async function add(input, ctx) {
  const e = { id: newId(), ...cleanEntry(input, ctx), createdAt: new Date().toISOString() };
  const r = await store.mutate((list) => ({ list: [...list, e], result: { entry: e } }), `complaint: thêm ${e.type} ${e.member} ${e.date}`);
  return r;
}
async function update(id, input, ctx) {
  return store.mutate((list) => {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Không tìm thấy complaint với id: ' + id);
    const e = { ...list[i], ...cleanEntry(input, ctx), updatedAt: new Date().toISOString() };
    const next = [...list]; next[i] = e; return { list: next, result: { entry: e } };
  }, `complaint: cập nhật ${id}`);
}
async function remove(id) {
  return store.mutate((list) => {
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) throw new Error('Không tìm thấy complaint với id: ' + id);
    return { list: next, result: {} };
  }, `complaint: xoá ${id}`);
}

module.exports = { TYPES, store, cleanEntry, penaltyOf, scoreMember, overview, add, update, remove, isMonthKey };
