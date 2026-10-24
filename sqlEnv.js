'use strict';
/* Hotfix → "Môi trường SQL Build": thông tin môi trường (DB, BackOffice, SFA, API, Hangfire...) của từng server dự án.
   Mỗi bản ghi = 1 môi trường của 1 dự án: { id, project, name, kind, note, rows[], updatedAt, updatedBy }.
   rows = danh sách dòng Tiêu đề / Nội dung / Link-đính kèm (như bảng Items/Info trong Excel, thêm cột link): { type:'group'|'item', key (tiêu đề), value (nội dung), link (link hoặc thông tin đính kèm) }.
   Mật khẩu do từng thành viên tự quản lý nên lưu và hiển thị như mọi nội dung khác (không che/ẩn).
   Dữ liệu cũ có dòng mật khẩu mã hoá ("enc:...") vẫn đọc được: giải mã khi đọc, lần lưu kế tiếp ghi lại dạng chữ thường.
   Lưu qua listStore.js: có GITHUB_TOKEN/GITHUB_REPO → mỗi lần thêm/sửa/xoá là 1 commit lên repo (data/sql-environments.json); chưa cấu hình → ghi ./data/sql-environments.json. */

const { createListStore } = require('./listStore');
const { hqDecrypt } = require('./hqPasswordCrypto');

const store = createListStore({ repoFilePath: 'data/sql-environments.json', localFile: 'data/sql-environments.json' });
const KINDS = ['UAT', 'PRODUCTION', 'DEV', 'TEST', 'DEMO', 'Khác'];
const MAX_ROWS = 300;
const newId = () => 'env_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

function decode(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value || '';
  try { return hqDecrypt(value.slice(4)); } catch (e) { return ''; }
}

/** Làm sạch + kiểm tra 1 bản ghi nhập vào. */
function cleanEntry(input) {
  const project = String(input.project || '').trim().slice(0, 80);
  if (!project) throw new Error('Chưa nhập dự án.');
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Chưa nhập tên môi trường.');
  const kind = KINDS.includes(input.kind) ? input.kind : 'Khác';
  const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, MAX_ROWS).map((r) => {
    const type = r && r.type === 'group' ? 'group' : 'item';
    const key = String((r && r.key) || '').trim().slice(0, 120);
    const value = type === 'group' ? '' : String((r && r.value) || '').slice(0, 2000);
    const link = type === 'group' ? '' : String((r && r.link) || '').trim().slice(0, 2000);
    return { type, key, value, link };
  }).filter((r) => r.key || r.value || r.link);
  if (!rows.length) throw new Error('Môi trường chưa có dòng thông tin nào.');
  return { project, name, kind, note: String(input.note || '').trim().slice(0, 500), rows };
}

const toPublic = (e) => ({ ...e, rows: (e.rows || []).map(({ secret, ...r }) => ({ ...r, link: r.link || '', value: decode(r.value) })) });

async function list() { return (await store.readAll()).map(toPublic); }

async function add(input, user) {
  const entry = { id: newId(), ...cleanEntry(input), updatedAt: new Date().toISOString(), updatedBy: user || '' };
  const r = await store.mutate((all) => ({ list: [...all, entry], result: { id: entry.id } }), `Môi trường SQL Build: thêm ${entry.project} / ${entry.name}${user ? ' (' + user + ')' : ''}`);
  return { id: entry.id, commitUrl: r.commitUrl };
}

async function update(id, input, user) {
  const clean = cleanEntry(input);
  return store.mutate((all) => {
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Không tìm thấy môi trường (có thể đã bị xoá).');
    const next = all.slice(); next[i] = { ...all[i], ...clean, id, updatedAt: new Date().toISOString(), updatedBy: user || '' };
    return { list: next, result: { id } };
  }, `Môi trường SQL Build: sửa ${clean.project} / ${clean.name}${user ? ' (' + user + ')' : ''}`);
}

async function remove(id) {
  return store.mutate((all) => {
    if (!all.some((x) => x.id === id)) throw new Error('Không tìm thấy môi trường (có thể đã bị xoá).');
    return { list: all.filter((x) => x.id !== id), result: { id } };
  }, 'Môi trường SQL Build: xoá 1 môi trường');
}

module.exports = { store, KINDS, list, add, update, remove, cleanEntry };
