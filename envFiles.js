'use strict';
/* Kho file đính kèm dùng chung (APK, zip, ảnh, tài liệu…) — mỗi tool tạo 1 kho riêng bằng createFileStore():
   - Có GITHUB_TOKEN/GITHUB_REPO: lưu thành asset của 1 release (tag riêng của kho) → không commit vào repo (không phình repo, không kích hoạt deploy lại). Tối đa maxBytes/file qua tool.
   - Chưa cấu hình GitHub: ghi vào ./data/<localDir> (chỉ để chạy thử; nhớ mount volume ./data).
   assetId lưu trong bản ghi: "<số id asset GitHub>" hoặc "local:<tên file trên đĩa>".
   Mặc định (module.exports) là kho của "Môi trường SQL Build" (tag sql-env-files). Kho của "Case Hỗ Trợ": xem supportCasesStore.js. */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const github = require('./githubClient');

const MIME = { apk: 'application/vnd.android.package-archive', zip: 'application/zip', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain; charset=utf-8', sql: 'text/plain; charset=utf-8', json: 'application/json', csv: 'text/csv; charset=utf-8', md: 'text/plain; charset=utf-8' };
const extOf = (n) => path.extname(String(n || '')).slice(1).toLowerCase();
const mimeOf = (n) => MIME[extOf(n)] || 'application/octet-stream';
const safeName = (n) => String(n || 'file').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'file';
const newId = () => 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function createFileStore({ tag, title, description, localDir, allowed, maxBytes }) {
  const LOCAL_DIR = path.join(__dirname, 'data', localDir);
  const ALLOWED = new Set(allowed);
  const MAX_BYTES = maxBytes || 100 * 1024 * 1024;
  const maxLabel = MAX_BYTES >= 1048576 ? Math.round(MAX_BYTES / 1048576) + 'MB' : Math.round(MAX_BYTES / 1024) + 'KB';

  let releasePromise = null;
  const release = () => (releasePromise = releasePromise || github.ensureRelease(tag, title, description).catch((e) => { releasePromise = null; throw e; }));

  /** Lưu 1 file → meta { id, name, size, assetId, by, at } để gắn vào bản ghi. */
  async function save(buffer, originalName, user) {
    const ext = extOf(originalName);
    if (!ALLOWED.has(ext)) throw new Error(`Loại file ".${ext || '?'}" không được phép. Cho phép: ${[...ALLOWED].join(', ')}.`);
    if (!buffer || !buffer.length) throw new Error('File rỗng.');
    if (buffer.length > MAX_BYTES) throw new Error(`File lớn hơn ${maxLabel} — hãy nén/giảm dung lượng hoặc dán link (Drive/SharePoint…).`);
    const id = newId(); const stored = `${id}-${safeName(originalName)}`;
    let assetId;
    if (github.isConfigured()) {
      const rel = await release();
      const asset = await github.uploadReleaseAsset(rel.id, stored, buffer, mimeOf(originalName));
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

  return { save, open, remove, MAX_BYTES, ALLOWED };
}

/** Làm sạch danh sách meta file lấy từ client (chỉ giữ trường hợp lệ). */
const cleanFiles = (files, max = 10) => (Array.isArray(files) ? files : []).slice(0, max).map((f) => ({
  id: String((f && f.id) || '').replace(/[^\w-]/g, '').slice(0, 40),
  name: String((f && f.name) || '').slice(0, 150),
  size: Number(f && f.size) || 0,
  assetId: String((f && f.assetId) || '').replace(/[^\w.:\-]/g, '').slice(0, 160),
  by: String((f && f.by) || '').slice(0, 80),
  at: String((f && f.at) || '').slice(0, 40),
})).filter((f) => f.id && f.name && f.assetId);

/** Gửi 1 file (meta) về trình duyệt: ảnh xem trực tiếp (inline), file khác tải về. */
async function sendFile(store, res, f, { inline } = {}) {
  const { stream, size } = await store.open(f.assetId);
  const mime = mimeOf(f.name); const isImg = mime.startsWith('image/');
  res.set('Content-Type', inline || isImg ? mime : 'application/octet-stream');
  res.set('Content-Disposition', ((inline || isImg) ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name));
  res.set('Cache-Control', 'private, max-age=3600');
  if (size) res.set('Content-Length', String(size));
  stream.on('error', (e) => { console.error('[file] lỗi stream:', e.message); res.destroy(e); });
  stream.pipe(res);
}

const envStore = createFileStore({
  tag: 'sql-env-files', title: 'Tệp môi trường SQL Build', description: 'File đính kèm do tool Môi trường SQL Build quản lý — đừng xoá tay.',
  localDir: 'env-files', allowed: ['apk', 'aab', 'zip', '7z', 'rar', 'ipa', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'json', 'sql', 'png', 'jpg', 'jpeg', 'csv', 'md'], maxBytes: 100 * 1024 * 1024,
});

module.exports = { ...envStore, createFileStore, cleanFiles, sendFile, mimeOf };
