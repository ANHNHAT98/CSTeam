'use strict';
// Thư viện "Case Hỗ Trợ" (các case thường gặp + nguyên nhân + câu lệnh SQL / kiểm tra PROC + cách xử lý + hình ảnh).
// Lưu qua listStore.js: có GITHUB_TOKEN/GITHUB_REPO → mỗi lần thêm/sửa/xoá là 1 commit vào data/support-cases.json (không mất khi container restart);
// chưa cấu hình → ghi ./data/support-cases.json (chỉ để chạy thử, MẤT khi redeploy nếu không mount volume ./data).
// Hình ảnh: tải lên kho riêng (envFiles.createFileStore → GitHub Releases tag "support-case-files"), bản ghi chỉ giữ meta ảnh.
// Case cũ (chỉ có project/title/symptom/cause/solution/tags) vẫn đọc bình thường — các trường mới là sql, images và module (phân hệ: API / BO / APP / Manager).
// Giao diện hiện gộp: "Tiêu đề + mô tả sự cố" (dòng đầu = title, các dòng sau = symptom) và "Cách xử lý + câu lệnh SQL" (lưu trong solution; sql chỉ còn ở case cũ).

const { createListStore } = require('./listStore');
const { createFileStore, cleanFiles } = require('./envFiles');

const store = createListStore({ repoFilePath: 'data/support-cases.json', localFile: 'data/support-cases.json' });
const images = createFileStore({
  tag: 'support-case-files', title: 'Ảnh Case Hỗ Trợ', description: 'Ảnh/tài liệu đính kèm do tool Case Hỗ Trợ quản lý — đừng xoá tay.',
  localDir: 'support-case-files', allowed: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'sql', 'zip'], maxBytes: 20 * 1024 * 1024,
});
const MAX_IMAGES = 20;
const MODULES = ['API', 'BO', 'APP', 'Manager']; // phân hệ (chọn 1 trong combobox)
const newId = () => 'case_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
const filesOf = (c) => (c && c.images) || [];

const isGithubBacked = () => store.isGithubBacked();
const readAll = async () => (await store.readAll()).map((c) => ({ ...c, sql: c.sql || '', module: c.module || '', images: c.images || [] }));

/** Làm sạch + kiểm tra dữ liệu nhập vào. Câu lệnh SQL giữ nguyên xuống dòng/thụt lề (chỉ cắt khoảng trắng đầu-cuối). */
function clean(input) {
  const f = {
    project: String(input.project || '').trim().slice(0, 80),
    title: String(input.title || '').trim().slice(0, 200),
    symptom: String(input.symptom || '').trim().slice(0, 10000),
    cause: String(input.cause || '').trim().slice(0, 10000),
    sql: String(input.sql || '').replace(/\r\n/g, '\n').replace(/^\s*\n|\s+$/g, '').slice(0, 30000),
    solution: String(input.solution || '').trim().slice(0, 10000),
    tags: String(input.tags || '').trim().slice(0, 300), // tag tự do của case cũ — giữ nguyên, giao diện mới dùng phân hệ (module)
    module: MODULES.includes(input.module) ? input.module : '',
    images: cleanFiles(input.images, MAX_IMAGES),
  };
  if (!f.title) throw new Error('Thiếu Tiêu đề case.');
  return f;
}

/** Thêm mới (không truyền id) hoặc cập nhật (truyền id). Trả về { case, commitUrl }. */
async function upsert(input, user) {
  const fields = clean(input); const now = new Date().toISOString(); let saved; let dropped = [];
  const r = await store.mutate((all) => {
    const list = all.slice();
    if (input.id) {
      const idx = list.findIndex((c) => c.id === input.id);
      if (idx === -1) throw new Error('Không tìm thấy case với id: ' + input.id);
      const keep = new Set(fields.images.map((x) => x.assetId));
      dropped = filesOf(list[idx]).filter((x) => !keep.has(x.assetId));
      saved = { ...list[idx], ...fields, updatedAt: now, updatedBy: user || '' };
      list[idx] = saved;
    } else {
      saved = { id: newId(), ...fields, createdAt: now, updatedAt: now, createdBy: user || '', updatedBy: user || '' };
      list.push(saved);
    }
    return { list, result: {} };
  }, input.id ? `case: cập nhật "${fields.title}"` : `case: thêm "${fields.title}"`);
  await Promise.all(dropped.map((x) => images.remove(x.assetId).catch((e) => console.error('[support-cases] không xoá được ảnh cũ:', e.message))));
  return { case: saved, commitUrl: r.commitUrl };
}

async function remove(id) {
  let dropped = [];
  const r = await store.mutate((all) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error('Không tìm thấy case với id: ' + id);
    dropped = filesOf(c);
    return { list: all.filter((x) => x.id !== id), result: {} };
  }, `case: xoá 1 case (id ${id})`);
  await Promise.all(dropped.map((x) => images.remove(x.assetId).catch((e) => console.error('[support-cases] không xoá được ảnh:', e.message))));
  return { commitUrl: r.commitUrl };
}

async function findImage(caseId, fileId) {
  const c = (await store.readAll()).find((x) => x.id === caseId);
  return filesOf(c).find((f) => f.id === fileId) || null;
}

/** Bỏ ảnh vừa tải lên nhưng chưa được lưu vào case nào (người dùng huỷ form). */
async function discardUpload(assetId) {
  const used = (await store.readAll()).some((c) => filesOf(c).some((f) => f.assetId === assetId));
  if (!used) await images.remove(assetId);
  return { removed: !used };
}

module.exports = { readAll, upsert, remove, isGithubBacked, images, findImage, discardUpload, MAX_IMAGES, MODULES };
