'use strict';
/* Thư viện AI dùng chung cho team: Prompt, Skill (Claude), Hướng dẫn dự án (CLAUDE.md).
   - Lưu qua listStore (data/ai-library.json → Supabase nếu có STORE_PG_URL).
   - Dùng chung tài khoản admin: ai đăng nhập cũng xem / thêm / sửa / xoá được (ghi lại tài khoản sửa gần nhất).
   - "Nhân bản" = sao chép 1 mục thành mục mới (forkOf = id gốc) để chỉnh theo yêu cầu riêng, bản gốc giữ nguyên.
   - Skill: content = SKILL.md, files = file phụ dạng chữ (references/*.md, scripts/*.py…) — trang tự đóng gói .zip khi tải. */

const crypto = require('crypto');
const { createListStore } = require('./listStore');

const store = createListStore({ repoFilePath: 'data/ai-library.json', localFile: 'data/ai-library.json' });
const TYPES = ['prompt', 'skill', 'guide'];
const MAX_CONTENT = 100 * 1024;      // 100 KB / nội dung chính
const MAX_FILES = 20;
const MAX_FILE = 100 * 1024;         // 100 KB / file phụ
const MAX_ITEM = 400 * 1024;         // 400 KB / mục

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const str = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').slice(0, max);
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';

async function list() { const r = await store.readAll(); return Array.isArray(r) ? r : []; }

function cleanFiles(files) {
  if (!Array.isArray(files)) return [];
  const seen = new Set(); const out = [];
  for (const f of files.slice(0, MAX_FILES)) {
    let name = String((f && f.name) || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) continue;
    if (name.split('/').some((p) => p === '..' || p === '.' || !p)) throw new Error(`Tên file không hợp lệ: ${name}`);
    if (!/^[\w.\-/ ]{1,120}$/.test(name)) throw new Error(`Tên file chỉ dùng chữ không dấu, số, dấu . - _ /: ${name}`);
    if (/^skill\.md$/i.test(name)) continue; // SKILL.md là nội dung chính
    if (seen.has(name.toLowerCase())) throw new Error(`Trùng tên file: ${name}`);
    seen.add(name.toLowerCase());
    const content = String((f && f.content) || '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw new Error(`File ${name} quá 100 KB.`);
    out.push({ name, content: content.replace(/\r\n/g, '\n') });
  }
  return out;
}

/** Thêm (không có id) hoặc sửa (có id). */
async function upsert(input, by) {
  const i = input || {};
  const type = TYPES.includes(i.type) ? i.type : '';
  if (!type) throw new Error('Loại phải là prompt / skill / guide.');
  const title = str(i.title, 150).trim();
  if (!title) throw new Error('Chưa nhập tên.');
  const author = str(i.author, 80).trim(); // không bắt buộc — ghi chú người phụ trách nếu muốn
  const content = str(i.content, MAX_CONTENT + 1);
  if (!content.trim()) throw new Error('Nội dung đang trống.');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) throw new Error('Nội dung quá 100 KB.');
  const item = {
    type, title,
    description: str(i.description, 1000).trim(),
    project: str(i.project, 80).trim(),
    tags: [...new Set((Array.isArray(i.tags) ? i.tags : String(i.tags || '').split(/[,;]/)).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12).map((t) => t.slice(0, 30)),
    author,
    content,
    skillName: type === 'skill' ? slug(i.skillName || title) : '',
    files: type === 'skill' ? cleanFiles(i.files) : [],
    guideFile: type === 'guide' ? (/^[\w.\-]{1,60}$/.test(String(i.guideFile || '')) ? String(i.guideFile) : 'CLAUDE.md') : '',
  };
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM) throw new Error('Mục này quá lớn (tối đa 400 KB tính cả file phụ).');
  const now = new Date().toISOString();
  let saved;
  const r = await store.mutate((all) => {
    const arr = Array.isArray(all) ? all : [];
    if (i.id) {
      const idx = arr.findIndex((x) => x.id === i.id);
      if (idx < 0) throw new Error('Không tìm thấy mục cần sửa (có thể đã bị xoá).');
      saved = { ...arr[idx], ...item, updatedAt: now, updatedBy: by || '' };
      const next = arr.slice(); next[idx] = saved;
      return { list: next, result: {} };
    }
    saved = { id: crypto.randomUUID(), ...item, forkOf: str(i.forkOf, 60), uses: 0, createdAt: now, updatedAt: now, updatedBy: by || '' };
    return { list: [saved, ...arr], result: {} };
  }, `ai-library: ${i.id ? 'sửa' : 'thêm'} ${type} "${title.slice(0, 50)}"`);
  return { item: saved, commitUrl: r.commitUrl };
}

async function remove(id) {
  let found = false;
  await store.mutate((all) => {
    const arr = Array.isArray(all) ? all : [];
    found = arr.some((x) => x.id === id);
    return { list: arr.filter((x) => x.id !== id), result: {} };
  }, `ai-library: xoá ${id}`);
  if (!found) throw new Error('Không tìm thấy mục cần xoá.');
  return { ok: true };
}

/** Đếm lượt dùng (copy / tải) để biết mục nào hữu ích. */
async function markUsed(id) {
  let uses = 0;
  await store.mutate((all) => {
    const arr = Array.isArray(all) ? all : [];
    return { list: arr.map((x) => (x.id === id ? { ...x, uses: (uses = (x.uses || 0) + 1) } : x)), result: {} };
  }, `ai-library: dùng ${id}`);
  return { uses };
}

module.exports = { store, TYPES, list, upsert, remove, markUsed, slug };
