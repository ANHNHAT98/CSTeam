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
 * Tim issue theo JQL, tu dong phan trang. Dung API moi /rest/api/3/search/jql
 * (API cu /rest/api/3/search da bi Atlassian go bo - xem CHANGE-2046). API moi
 * phan trang bang con tro nextPageToken thay vi startAt/total.
 */
async function searchIssues({ jql, maxTotal = 3000 }) {
  const pageSize = 100;
  let nextPageToken;
  let all = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const body = { jql, maxResults: pageSize, fields: ['*all'] };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraFetch('/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify(body) });
    const issues = Array.isArray(data.issues) ? data.issues : [];
    all = all.concat(issues);
    nextPageToken = data.nextPageToken;
    const isLast = typeof data.isLast === 'boolean' ? data.isLast : !nextPageToken;
    if (!issues.length || isLast || all.length >= maxTotal) break;
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

/**
 * Jira co the co nhieu field trung ten nhung khac kieu (vd "Ticket priority" vua co ban
 * kieu "Priority Field" mac dinh, vua co ban custom kieu "Select List (dropdown)"). Khi do
 * Jira JQL bat phai ghi ro "Ticket priority[dropdown]" de phan biet. Ham nay tra cuu dung
 * field custom kieu dropdown/select co ten khop (khong phan biet hoa/thuong), tra ve id
 * dang "customfield_XXXXX". Ket qua duoc cache trong bo nho (theo tien trinh server).
 */
let fieldIdCache = new Map();
async function resolveFieldId(displayName, { preferType } = {}) {
  const cacheKey = `${displayName.toLowerCase()}::${preferType || ''}`;
  if (fieldIdCache.has(cacheKey)) return fieldIdCache.get(cacheKey);

  const allFields = await jiraFetch('/rest/api/3/field');
  const target = String(displayName || '').trim().toLowerCase();
  const candidates = (Array.isArray(allFields) ? allFields : []).filter(
    (f) => String(f.name || '').trim().toLowerCase() === target
  );

  let picked = null;
  if (candidates.length === 1) {
    picked = candidates[0];
  } else if (candidates.length > 1) {
    // Nhieu field trung ten -> uu tien field custom kieu dropdown/select (schema.type === 'option'
    // hoac schema.custom chua 'select'), dung nhu Jira dang phan biet bang hau to "[dropdown]".
    picked =
      candidates.find((f) => {
        const schemaType = f.schema && f.schema.type;
        const customType = (f.schema && f.schema.custom) || '';
        if (preferType === 'dropdown') {
          return schemaType === 'option' || customType.toLowerCase().includes('select');
        }
        return false;
      }) || candidates[0];
  }

  const id = picked ? picked.id : null;
  fieldIdCache.set(cacheKey, id);
  return id;
}

/** Doc gia tri hien thi cua 1 custom field kieu select/dropdown tu object fields cua issue Jira.
 * Cac dang co the gap: string thuan, { value: "P2" }, { name: "P2" }, hoac null/undefined. */
function extractSelectValue(rawFieldValue) {
  if (rawFieldValue === null || rawFieldValue === undefined || rawFieldValue === '') return '';
  if (typeof rawFieldValue === 'string') return rawFieldValue;
  if (typeof rawFieldValue === 'object') {
    if (typeof rawFieldValue.value === 'string') return rawFieldValue.value;
    if (typeof rawFieldValue.name === 'string') return rawFieldValue.name;
  }
  return String(rawFieldValue);
}

/**
 * Tim issue theo JQL (nhu searchIssues) roi gan them field
 * `ticketPriorityDropdown` = gia tri cua field custom "Ticket priority" (kieu dropdown) —
 * dung field nay de tinh SLA theo Priority (P1/P2/P3...), KHONG dung field "Priority" chuan
 * cua Jira (fields.priority.name) vi la field khac.
 */
async function searchIssuesWithTicketPriority({ jql, maxTotal }) {
  const [issues, ticketPriorityFieldId] = await Promise.all([
    searchIssues({ jql, maxTotal }),
    resolveFieldId('Ticket priority', { preferType: 'dropdown' }).catch(() => null),
  ]);
  issues.forEach((issue) => {
    const raw = ticketPriorityFieldId ? issue.fields[ticketPriorityFieldId] : undefined;
    issue.fields.ticketPriorityDropdown = extractSelectValue(raw);
  });
  return { issues, ticketPriorityFieldId };
}

module.exports = {
  isConfigured,
  searchIssues,
  searchIssuesWithTicketPriority,
  getIssueSla,
  getIssuesSlaBulk,
};
