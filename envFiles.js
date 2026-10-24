'use strict';
/* File đính kèm của "Môi trường SQL Build" (APK, file zip đã nén, tài liệu…): thành viên tải lên tool, thành viên khác tải về.
   - Có GITHUB_TOKEN/GITHUB_REPO: lưu thành asset của release tag "sql-env-files" (không commit vào repo → không phình repo, không kích hoạt deploy lại). Tối đa 100MB/file qua tool.
   - Chưa cấu hình GitHub: ghi vào ./data/env-files (chỉ để chạy thử; nhớ mount volume ./data).
   assetId lưu trong bản ghi môi trường: "<số id asset GitHub>" hoặc "local:<tên file trên đĩa>". */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const github = require('./githubClient');

const TAG = 'sql-env-files';
const LOCAL_DIR = path.join(__dirname, 'data', 'env-files');
const MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED = new Set(['apk', 'aab', 'zip', '7z', 'rar', 'ipa', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'json', 'sql', 'png', 'jpg', 'jpeg', 'csv', 'md']);
const extOf = (n) => path.extname(String(n || '')).slice(1).toLowerCase();
const safeName = (n) => String(n || 'file').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'file';
const newId = () => 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MIME = { apk: 'application/vnd.android.package-archive', zip: 'application/zip', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', json: 'application/json' };

let releasePromise = null;
const release = () => (releasePromise = releasePromise || github.ensureRelease(TAG, 'Tệp môi trường SQL Build', 'File đính kèm do tool Môi trường SQL Build quản lý — đừng xoá tay.').catch((e) => { releasePromise = null; throw e; }));

/** Lưu 1 file → meta { id, name, size, assetId, by, at } để gắn vào dòng của môi trường. */
async function save(buffer, originalName, user) {
  const ext = extOf(originalName);
  if (!ALLOWED.has(ext)) throw new Error(`Loại file ".${ext || '?'}" không được phép. Cho phép: ${[...ALLOWED].join(', ')}. File khác hãy nén thành .zip.`);
  if (!buffer || !buffer.length) throw new Error('File rỗng.');
  if (buffer.length > MAX_BYTES) throw new Error('File lớn hơn 100MB — hãy dán link (Drive/SharePoint…) vào cột Link / Đính kèm.');
  const id = newId(); const stored = `${id}-${safeName(originalName)}`;
  let assetId;
  if (github.isConfigured()) {
    const rel = await release();
    const asset = await github.uploadReleaseAsset(rel.id, stored, buffer, MIME[ext]);
    assetId = String(asset.id);
  } else {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, stored), buffer);
    assetId = 'local:' + stored;
  }
  return { id, name: String(originalName).slice(0, 150), size: buffer.length, assetId, by: user || '', at: new Date().toISOString() };
}

const localPath = (assetId) => { const n = String(assetId).slice(6); return /^[\w.\-]+$/.test(n) ? path.join(LOCAL_DIR, n) : null; };

/** Mở file để gửi cho người tải: { stream (Node Readable), size }. */
async function open(assetId) {
  if (String(assetId).startsWith('local:')) {
    const p = localPath(assetId);
    if (!p || !fs.existsSync(p)) throw new Error('File không còn trên server.');
    return { stream: fs.createReadStream(p), size: fs.statSync(p).size };
  }
  const res = await github.openReleaseAsset(assetId);
  return { stream: Readable.fromWeb(res.body), size: Number(res.headers.get('content-length')) || null };
}

/** Xoá file khỏi kho (bỏ qua nếu không còn). */
async function remove(assetId) {
  if (String(assetId).startsWith('local:')) { const p = localPath(assetId); if (p) { try { fs.unlinkSync(p); } catch (e) { /* không còn */ } } return; }
  await github.deleteReleaseAsset(assetId);
}

module.exports = { save, open, remove, MAX_BYTES, ALLOWED };
