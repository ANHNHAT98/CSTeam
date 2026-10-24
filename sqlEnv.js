'use strict';
/* Hotfix → "Môi trường SQL Build": thông tin môi trường (DB, BackOffice, SFA, API, Hangfire...) của từng server dự án.
   Mỗi bản ghi = 1 môi trường của 1 dự án: { id, project, name, kind, note, rows[], updatedAt, updatedBy }.
   rows = danh sách dòng Tiêu đề / Nội dung / Link-đính kèm (như bảng Items/Info trong Excel, thêm cột link): { type:'group'|'item', key (tiêu đề), value (nội dung), link (link hoặc thông tin đính kèm) }.
   Mỗi dòng 'item' có thể kèm files:[{id,name,size,assetId,by,at}] — file (APK, zip…) thành viên tải lên qua envFiles.js (GitHub Releases), thành viên khác tải về.
   Mật khẩu do từng thành viên tự quản lý nên lưu và hiển thị như mọi nội dung khác (không che/ẩn).
   Dữ liệu cũ có dòng mật khẩu mã hoá ("enc:...") vẫn đọc được: giải mã khi đọc, lần lưu kế tiếp ghi lại dạng chữ thường.
   Lưu qua listStore.js: có GITHUB_TOKEN/GITHUB_REPO → mỗi lần thêm/sửa/xoá là 1 commit lên repo (data/sql-environments.json); chưa cấu hình → ghi ./data/sql-environments.json. */

const { createListStore } = require('./listStore');
const { hqDecrypt } = require('./hqPasswordCrypto');
const envFiles = require('./envFiles');

const store = createListStore({ repoFilePath: 'data/sql-environments.json', localFile: 'data/sql-environments.json' });
const KINDS = ['UAT', 'PRODUCTION', 'DEV', 'TEST', 'DEMO', 'Khác'];
const MAX_ROWS = 300;
const newId = () => 'env_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

function decode(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value || '';
  try { return hqDecrypt(value.slice(4)); } catch (e) { return ''; }
}

const cleanFiles = (files) => (Array.isArray(files) ? files : []).slice(0, 10).map((f) => ({
  id: String((f && f.id) || '').replace(/[^\w-]/g, '').slice(0, 40),
  name: String((f && f.name) || '').slice(0, 150),
  size: Number(f && f.size) || 0,
  assetId: String((f && f.assetId) || '').replace(/[^\w.:\-]/g, '').slice(0, 160),
  by: String((f && f.by) || '').slice(0, 80),
  at: String((f && f.at) || '').slice(0, 40),
})).filter((f) => f.id && f.name && f.assetId);
const filesOf = (env) => (env && env.rows ? env.rows.flatMap((r) => r.files || []) : []);

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
    const files = type === 'group' ? [] : cleanFiles(r && r.files);
    return { type, key, value, link, files };
  }).filter((r) => r.key || r.value || r.link || r.files.length);
  if (!rows.length) throw new Error('Môi trường chưa có dòng thông tin nào.');
  return { project, name, kind, note: String(input.note || '').trim().slice(0, 500), rows };
}

const toPublic = (e) => ({ ...e, rows: (e.rows || []).map(({ secret, ...r }) => ({ ...r, link: r.link || '', files: r.files || [], value: decode(r.value) })) });

async function list() { return (await store.readAll()).map(toPublic); }

async function add(input, user) {
  const entry = { id: newId(), ...cleanEntry(input), updatedAt: new Date().toISOString(), updatedBy: user || '' };
  const r = await store.mutate((all) => ({ list: [...all, entry], result: { id: entry.id } }), `Môi trường SQL Build: thêm ${entry.project} / ${entry.name}${user ? ' (' + user + ')' : ''}`);
  return { id: entry.id, commitUrl: r.commitUrl };
}

async function update(id, input, user) {
  const clean = cleanEntry(input); let dropped = [];
  const r = await store.mutate((all) => {
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('Không tìm thấy môi trường (có thể đã bị xoá).');
    const keep = new Set(clean.rows.flatMap((x) => x.files).map((f) => f.assetId));
    dropped = filesOf(all[i]).filter((f) => !keep.has(f.assetId));
    const next = all.slice(); next[i] = { ...all[i], ...clean, id, updatedAt: new Date().toISOString(), updatedBy: user || '' };
    return { list: next, result: { id } };
  }, `Môi trường SQL Build: sửa ${clean.project} / ${clean.name}${user ? ' (' + user + ')' : ''}`);
  await Promise.all(dropped.map((f) => envFiles.remove(f.assetId).catch((e) => console.error('[sql-env] không xoá được file cũ:', e.message))));
  return r;
}

async function remove(id) {
  let dropped = [];
  const r = await store.mutate((all) => {
    const env = all.find((x) => x.id === id);
    if (!env) throw new Error('Không tìm thấy môi trường (có thể đã bị xoá).');
    dropped = filesOf(env);
    return { list: all.filter((x) => x.id !== id), result: { id } };
  }, 'Môi trường SQL Build: xoá 1 môi trường');
  await Promise.all(dropped.map((f) => envFiles.remove(f.assetId).catch((e) => console.error('[sql-env] không xoá được file:', e.message))));
  return r;
}

/** Tìm meta 1 file của 1 môi trường (để tải về). */
async function findFile(envId, fileId) {
  const env = (await store.readAll()).find((x) => x.id === envId);
  return filesOf(env).find((f) => f.id === fileId) || null;
}

/** Bỏ file vừa tải lên nhưng chưa được lưu vào môi trường nào (người dùng huỷ form). */
async function discardUpload(assetId) {
  const used = (await store.readAll()).some((e) => filesOf(e).some((f) => f.assetId === assetId));
  if (!used) await envFiles.remove(assetId);
  return { removed: !used };
}

module.exports = { store, KINDS, list, add, update, remove, cleanEntry, findFile, discardUpload };
