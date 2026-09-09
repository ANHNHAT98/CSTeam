// Client goi Jira Cloud / Jira Service Management bang API token (Basic Auth email:token).
// Khac voi ERP (dang nhap bang session cookie), Jira Cloud dung API token gan voi email,
// gui kem moi request qua header Authorization: Basic base64(email:token).
// Tao token tai: https://id.atlassian.com/manage-profile/security/api-tokens

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';

function isConfigured() {
  return Boolean(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN);
}

function authHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraFetch(pathAndQuery, options = {}) {
  if (!isConfigured()) {
    const err = new Error(
      'Chưa cấu hình JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN trên server (xem docker-compose.yml).'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(`${JIRA_BASE_URL}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (e) {
    const err = new Error(`Jira trả về không phải JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
    err.code = 'BAD_RESPONSE';
    throw err;
  }
  if (!res.ok) {
    const msg =
      (data && Array.isArray(data.errorMessages) && data.errorMessages.length && data.errorMessages.join('; ')) ||
      (data && data.message) ||
      `Lỗi HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = 'HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Tim issue theo JQL, tu dong phan trang (Jira gioi han toi da ~100 issue/lan goi).
 * fields=['*all'] de lay het field (ke ca custom field) - giong triet ly dang dung voi ERP.
 */
async function searchIssues({ jql, maxTotal = 3000 }) {
  const pageSize = 100;
  let startAt = 0;
  let all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const body = { jql, startAt, maxResults: pageSize, fields: ['*all'] };
    const data = await jiraFetch('/rest/api/3/search', { method: 'POST', body: JSON.stringify(body) });
    const issues = Array.isArray(data.issues) ? data.issues : [];
    all = all.concat(issues);
    const total = typeof data.total === 'number' ? data.total : issues.length;
    startAt += issues.length;
    if (!issues.length || startAt >= total || all.length >= maxTotal) break;
  }
  return all;
}

/**
 * Lay du lieu SLA (Time to first response / Time to resolution...) cua 1 issue qua
 * Jira Service Management API. Tra ve mang cac dinh nghia SLA cua issue do, moi phan tu
 * co dang { id, name, completedCycles: [...], ongoingCycle: {...} }.
 */
async function getIssueSla(issueKey) {
  const data = await jiraFetch(`/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/sla`);
  return Array.isArray(data.values) ? data.values : [];
}

/**
 * Lay SLA cho nhieu issue cung luc, gioi han so luong goi dong thoi de tranh qua tai / bi
 * Jira rate-limit (HTTP 429). Tra ve { results: {issueKey: slaValues[]}, errors: {issueKey: message} }.
 */
async function getIssuesSlaBulk(issueKeys, concurrency = 6) {
  const results = {};
  const errors = {};
  let idx = 0;
  async function worker() {
    while (idx < issueKeys.length) {
      const myIdx = idx++;
      const key = issueKeys[myIdx];
      try {
        results[key] = await getIssueSla(key);
      } catch (e) {
        errors[key] = e.message;
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, issueKeys.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { results, errors };
}

module.exports = {
  isConfigured,
  searchIssues,
  getIssueSla,
  getIssuesSlaBulk,
};
