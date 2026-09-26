// Client goi GitHub REST API (Contents API) de doc/ghi 1 file trong repo bang
// Personal Access Token (fine-grained, quyen "Contents: Read and write").
// Dung de luu du lieu "Case Ho Tro" truc tiep vao code -> khi ghi file se tao 1
// commit moi -> Render (dang auto-deploy tu GitHub) se tu dong deploy lai.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || ''; // dang "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
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
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${pathAndQuery}`, {
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

module.exports = { isConfigured, getFile, putFile, GITHUB_REPO, GITHUB_BRANCH };
