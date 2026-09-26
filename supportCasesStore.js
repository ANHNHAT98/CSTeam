// Luu/doc danh sach "Case Ho Tro" (cac case thuong gap + cach xu ly).
// Uu tien nguon that: file trong repo GitHub (qua githubClient) -> moi lan ghi se tao 1
// commit that -> Render (dang auto-deploy) se tu dong deploy lai, du lieu ton tai vinh vien
// trong code, khong bi mat khi container restart.
// Neu chua cau hinh GITHUB_TOKEN/GITHUB_REPO: fallback doc/ghi file local (chi de test,
// SE MAT du lieu khi container restart/redeploy vi Render khong co dia luu tru co dinh).

const fs = require('fs');
const path = require('path');
const github = require('./githubClient');

const REPO_FILE_PATH = 'data/support-cases.json';
const LOCAL_FILE = path.join(__dirname, 'data', 'support-cases.json');

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeLocal(list) {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function isGithubBacked() {
  return github.isConfigured();
}

/** Doc toan bo danh sach case. */
async function readAll() {
  if (isGithubBacked()) {
    const { content } = await github.getFile(REPO_FILE_PATH);
    if (content === null) return [];
    try {
      return JSON.parse(content);
    } catch (e) {
      throw new Error('File support-cases.json trên GitHub bị lỗi định dạng JSON: ' + e.message);
    }
  }
  return readLocal();
}

function newId() {
  return 'case_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Them moi (khong truyen id) hoac cap nhat (truyen id) 1 case.
 * Tra ve { case, commitUrl } — commitUrl chi co khi ghi qua GitHub.
 */
async function upsert(input) {
  const now = new Date().toISOString();
  const fields = {
    project: (input.project || '').trim(),
    title: (input.title || '').trim(),
    symptom: (input.symptom || '').trim(),
    cause: (input.cause || '').trim(),
    solution: (input.solution || '').trim(),
    tags: (input.tags || '').trim(),
  };
  if (!fields.title) throw new Error('Thiếu Tiêu đề case.');

  if (isGithubBacked()) {
    const { content, sha } = await github.getFile(REPO_FILE_PATH);
    const list = content ? JSON.parse(content) : [];
    let saved;
    if (input.id) {
      const idx = list.findIndex((c) => c.id === input.id);
      if (idx === -1) throw new Error('Không tìm thấy case với id: ' + input.id);
      saved = { ...list[idx], ...fields, updatedAt: now };
      list[idx] = saved;
    } else {
      saved = { id: newId(), ...fields, createdAt: now, updatedAt: now };
      list.push(saved);
    }
    const commitMsg = input.id
      ? `case: cập nhật "${fields.title}"`
      : `case: thêm "${fields.title}"`;
    const result = await github.putFile(REPO_FILE_PATH, JSON.stringify(list, null, 2), sha, commitMsg);
    writeLocal(list);
    return { case: saved, commitUrl: result.commit && result.commit.html_url };
  }

  const list = readLocal();
  let saved;
  if (input.id) {
    const idx = list.findIndex((c) => c.id === input.id);
    if (idx === -1) throw new Error('Không tìm thấy case với id: ' + input.id);
    saved = { ...list[idx], ...fields, updatedAt: now };
    list[idx] = saved;
  } else {
    saved = { id: newId(), ...fields, createdAt: now, updatedAt: now };
    list.push(saved);
  }
  writeLocal(list);
  return { case: saved, commitUrl: null };
}

async function remove(id) {
  if (isGithubBacked()) {
    const { content, sha } = await github.getFile(REPO_FILE_PATH);
    const list = content ? JSON.parse(content) : [];
    const filtered = list.filter((c) => c.id !== id);
    if (filtered.length === list.length) throw new Error('Không tìm thấy case với id: ' + id);
    const result = await github.putFile(REPO_FILE_PATH, JSON.stringify(filtered, null, 2), sha, `case: xoá 1 case (id ${id})`);
    writeLocal(filtered);
    return { commitUrl: result.commit && result.commit.html_url };
  }
  const list = readLocal();
  const filtered = list.filter((c) => c.id !== id);
  writeLocal(filtered);
  return { commitUrl: null };
}

module.exports = { readAll, upsert, remove, isGithubBacked };
