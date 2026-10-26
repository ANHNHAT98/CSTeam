'use strict';
/* Menu Dự án → "Table Dự Án": danh sách các table của từng màn hình theo dự án, để nhân viên biết SELECT đúng table khi kiểm tra.
   Mỗi bản ghi = 1 màn hình của 1 dự án: { id, project, code (mã màn hình, vd OM10100), name (tên màn hình), module (API|BO|APP|Manager|Report hoặc ''), note,
     tables:[{ name (tên table), role (vai trò), desc (mô tả), where (điều kiện WHERE gợi ý, vd OrderNbr = '...') }], updatedAt, updatedBy }.
   (project, code) là duy nhất. Lưu qua listStore.js: có GITHUB_TOKEN/GITHUB_REPO → mỗi lần thêm/sửa/xoá/import là 1 commit vào data/screen-tables.json; chưa cấu hình → ghi ./data/screen-tables.json. */

const { createListStore } = require('./listStore');

const store = createListStore({ repoFilePath: 'data/screen-tables.json', localFile: 'data/screen-tables.json' });
const MODULES = ['API', 'BO', 'APP', 'Manager', 'Report'];
const ROLES = ['Bảng chính', 'Bảng chi tiết', 'Danh mục', 'Cấu hình', 'Lịch sử / Log', 'Khác']; // cũng là thứ tự sắp xếp table trong 1 màn hình
const MAX_TABLES = 100;
const newId = () => 'scr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
const lc = (s) => String(s || '').trim().toLowerCase();

/** Chuẩn hoá 1 vai trò (không phân biệt hoa thường / dấu tiếng Việt); không khớp → "Khác". */
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/\s+/g, ' ').trim().toLowerCase();
const roleOf = (r) => ROLES.find((x) => plain(x) === plain(r)) || 'Khác';

/** Làm sạch + kiểm tra dữ liệu 1 màn hình nhập vào. */
function clean(input) {
  const project = String(input.project || '').trim().slice(0, 80);
  if (!project) throw new Error('Chưa chọn dự án.');
  const code = String(input.code || '').trim().replace(/\s+/g, '').slice(0, 60);
  if (!code) throw new Error('Chưa nhập Mã màn hình.');
  const seen = new Set();
  const tables = (Array.isArray(input.tables) ? input.tables : []).slice(0, MAX_TABLES).map((t) => ({
    name: String((t && t.name) || '').trim().replace(/;+$/, ''),
    role: roleOf(t && t.role),
    desc: String((t && t.desc) || '').trim().slice(0, 300),
    where: String((t && t.where) || '').trim().replace(/^where\s+/i, '').slice(0, 300),
  })).filter((t) => t.name).filter((t) => { const k = lc(t.name); if (seen.has(k)) return false; seen.add(k); return true; });
  tables.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)); // Bảng chính → Bảng chi tiết → Danh mục → Cấu hình → Lịch sử/Log → Khác (giữ nguyên thứ tự nhập trong cùng vai trò)
  for (const t of tables) if (!/^[A-Za-z0-9_.\[\]#$@]{1,128}$/.test(t.name)) throw new Error(`Tên table không hợp lệ: "${t.name}" (chỉ gồm chữ, số, _ . [ ] #).`);
  return { project, code, name: String(input.name || '').trim().slice(0, 200), module: MODULES.includes(input.module) ? input.module : '', note: String(input.note || '').trim().slice(0, 500), tables };
}

const list = () => store.readAll();

/** Thêm mới (không id) hoặc sửa (có id) 1 màn hình. */
async function upsert(input, user) {
  const f = clean(input); const now = new Date().toISOString(); let saved;
  const r = await store.mutate((all) => {
    const items = all.slice();
    const dup = items.find((x) => x.project === f.project && lc(x.code) === lc(f.code) && x.id !== input.id);
    if (dup) throw new Error(`Mã màn hình "${f.code}" đã có trong dự án này — hãy mở màn hình đó để sửa.`);
    if (input.id) {
      const i = items.findIndex((x) => x.id === input.id);
      if (i < 0) throw new Error('Không tìm thấy màn hình (có thể đã bị xoá).');
      saved = { ...items[i], ...f, updatedAt: now, updatedBy: user || '' }; items[i] = saved;
    } else {
      saved = { id: newId(), ...f, updatedAt: now, updatedBy: user || '' }; items.push(saved);
    }
    return { list: items, result: {} };
  }, `Table Dự Án: ${input.id ? 'sửa' : 'thêm'} ${f.project} / ${f.code}${user ? ' (' + user + ')' : ''}`);
  return { screen: saved, commitUrl: r.commitUrl };
}

/** Import hàng loạt từ Excel: rows = [{code, name, module, table, role, desc, where}] (mỗi dòng 1 table của 1 màn hình).
    Màn hình đã có (cùng mã trong dự án) thì thay tên/phân hệ/danh sách table; chưa có thì thêm. 1 lần = 1 commit. */
async function importRows(project, rows, user) {
  const proj = String(project || '').trim();
  if (!proj) throw new Error('Chưa chọn dự án để import.');
  const byCode = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const code = String((r && r.code) || '').trim().replace(/\s+/g, '');
    if (!code) continue;
    const g = byCode.get(lc(code)) || { code, name: '', module: '', tables: [] };
    if (r.name && !g.name) g.name = r.name;
    if (r.module && !g.module) g.module = r.module;
    if (r.table) g.tables.push({ name: r.table, role: r.role, desc: r.desc, where: r.where });
    byCode.set(lc(code), g);
  }
  if (!byCode.size) throw new Error('Không có dòng hợp lệ để import (cần cột Mã màn hình).');
  const now = new Date().toISOString(); let added = 0; let updated = 0; let tableCount = 0;
  const cleaned = [...byCode.values()].map((g) => clean({ project: proj, ...g }));
  const r = await store.mutate((all) => {
    const items = all.slice();
    for (const f of cleaned) {
      tableCount += f.tables.length;
      const i = items.findIndex((x) => x.project === proj && lc(x.code) === lc(f.code));
      if (i >= 0) { items[i] = { ...items[i], ...f, name: f.name || items[i].name, module: f.module || items[i].module, updatedAt: now, updatedBy: user || '' }; updated++; }
      else { items.push({ id: newId(), ...f, updatedAt: now, updatedBy: user || '' }); added++; }
    }
    return { list: items, result: {} };
  }, `Table Dự Án: import ${cleaned.length} màn hình (${proj})${user ? ' (' + user + ')' : ''}`);
  return { added, updated, tables: tableCount, commitUrl: r.commitUrl };
}

async function remove(id) {
  return store.mutate((all) => {
    if (!all.some((x) => x.id === id)) throw new Error('Không tìm thấy màn hình (có thể đã bị xoá).');
    return { list: all.filter((x) => x.id !== id), result: {} };
  }, 'Table Dự Án: xoá 1 màn hình');
}

module.exports = { store, MODULES, ROLES, list, upsert, importRows, remove, clean };
