// Client goi GitHub REST API (Contents API) de doc/ghi 1 file trong repo bang
// Personal Access Token (fine-grained, quyen "Contents: Read and write").
// Dung de luu du lieu "Case Ho Tro" truc tiep vao code -> khi ghi file se tao 1
// commit moi -> Render (dang auto-deploy tu GitHub) se tu dong deploy lai.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // dang "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';
const GITHUB_UPLOAD_URL = process.env.GITHUB_UPLOAD_URL || 'https://uploads.github.com';
const GITHUB_COMMITTER_NAME = process.env.GITHUB_COMMITTER_NAME || 'HQSOFT Ops Console';
const GITHUB_COMMITTER_EMAIL = process.env.GITHUB_COMMITTER_EMAIL || 'ops-console@hqsoft.vn';

function isConfigured() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

async function githubFetch(pathAndQuery, options = {}) {
  if (!isConfigured()) {
    const err = new Error('Chưa cấu hình GITHUB_TOKEN / GITHUB_REPO trên server.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPO}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (e) {
    const err = new Error(`GitHub trả về không phải JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.message || `Lỗi HTTP ${res.status} khi gọi GitHub API`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Doc noi dung 1 file trong repo. Tra ve { content: string (da decode base64), sha } hoac
 * { content: null, sha: null } neu file chua ton tai (404).
 */
async function getFile(filePath) {
  try {
    const data = await githubFetch(`/contents/${filePath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, sha: data.sha };
  } catch (e) {
    if (e.status === 404) return { content: null, sha: null };
    throw e;
  }
}

/**
 * Ghi (tao moi hoac cap nhat) 1 file trong repo -> tao 1 commit moi tren nhanh GITHUB_BRANCH.
 * sha: truyen sha cu neu la cap nhat file da co (bat buoc de tranh ghi de xung dot); bo qua
 * (undefined) neu la tao file lan dau.
 */
async function putFile(filePath, contentString, sha, commitMessage) {
  const body = {
    message: commitMessage || `chore: cập nhật ${filePath}`,
    content: Buffer.from(contentString, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH,
    committer: { name: GITHUB_COMMITTER_NAME, email: GITHUB_COMMITTER_EMAIL },
  };
  if (sha) body.sha = sha;
  return githubFetch(`/contents/${filePath}`, { method: 'PUT', body: JSON.stringify(body) });
}

/* ---------- File nhị phân (APK, zip…) qua GitHub Releases ----------
   Không commit file lớn vào repo (tránh phình repo + kích hoạt deploy lại trên Render): mỗi file là 1 "asset" của 1 release (tối đa 2GB/file). */
const authHeaders = (extra) => ({ Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', ...(extra || {}) });

/** Lấy release theo tag; chưa có thì tạo (pre-release, không phải "latest"). */
async function ensureRelease(tag, title, description) {
  try { return await githubFetch(`/releases/tags/${encodeURIComponent(tag)}`); }
  catch (e) { if (e.status !== 404) throw e; }
  return githubFetch('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: GITHUB_BRANCH, name: title || tag, body: description || '', draft: false, prerelease: true, make_latest: 'false' }) });
}

/** Tải 1 file (Buffer) lên release → { id, name, size }. */
async function uploadReleaseAsset(releaseId, name, buffer, contentType) {
  if (!isConfigured()) { const err = new Error('Chưa cấu hình GITHUB_TOKEN / GITHUB_REPO trên server.'); err.code = 'NOT_CONFIGURED'; throw err; }
  const res = await fetch(`${GITHUB_UPLOAD_URL}/repos/${GITHUB_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: authHeaders({ Accept: 'application/vnd.github+json', 'Content-Type': contentType || 'application/octet-stream' }),
    body: buffer,
  });
  const raw = await res.text(); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch (e) { /* giữ rỗng */ }
  if (!res.ok) { const err = new Error(data.message || `Lỗi HTTP ${res.status} khi tải file lên GitHub`); err.status = res.status; throw err; }
  return data;
}

/** Mở luồng tải 1 asset (GitHub trả 302 sang kho lưu file; fetch tự bỏ header Authorization khi sang host khác). Trả về Response. */
async function openReleaseAsset(assetId) {
  if (!isConfigured()) { const err = new Error('Chưa cấu hình GITHUB_TOKEN / GITHUB_REPO trên server.'); err.code = 'NOT_CONFIGURED'; throw err; }
  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPO}/releases/assets/${encodeURIComponent(assetId)}`, { headers: authHeaders({ Accept: 'application/octet-stream' }), redirect: 'follow' });
  if (!res.ok) { const err = new Error(`Không tải được file từ GitHub (HTTP ${res.status}).`); err.status = res.status; throw err; }
  return res;
}

async function deleteReleaseAsset(assetId) {
  if (!isConfigured()) return;
  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPO}/releases/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE', headers: authHeaders({ Accept: 'application/vnd.github+json' }) });
  if (!res.ok && res.status !== 404) throw new Error(`Không xoá được file trên GitHub (HTTP ${res.status}).`);
}

module.exports = { isConfigured, getFile, putFile, ensureRelease, uploadReleaseAsset, openReleaseAsset, deleteReleaseAsset, GITHUB_REPO, GITHUB_BRANCH };
