// Client goi ERPNext (Frappe) bang phien dang nhap email/mat khau,
// KHONG can API Key / API Secret (khong can quyen System Manager).

const ERP_BASE_URL = (process.env.ERP_BASE_URL || '').replace(/\/+$/, '');
const ERP_USER = process.env.ERP_USER || '';
const ERP_PASS = process.env.ERP_PASS || '';

let cachedCookie = null;
let loginPromise = null;

function assertConfigured() {
  if (!ERP_BASE_URL || !ERP_USER || !ERP_PASS) {
    const err = new Error(
      'Chưa cấu hình ERP_BASE_URL / ERP_USER / ERP_PASS trên server (xem docker-compose.yml).'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
}

async function erpLogin() {
  assertConfigured();
  const res = await fetch(`${ERP_BASE_URL}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usr: ERP_USER, pwd: ERP_PASS }).toString(),
  });

  if (!res.ok) {
    const err = new Error(`Đăng nhập ERP thất bại (HTTP ${res.status}) — kiểm tra lại ERP_USER/ERP_PASS.`);
    err.code = 'LOGIN_FAILED';
    throw err;
  }

  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  if (!cookies.length) {
    const err = new Error('Đăng nhập ERP không trả về cookie phiên — kiểm tra lại địa chỉ ERP_BASE_URL.');
    err.code = 'NO_COOKIE';
    throw err;
  }

  cachedCookie = cookies.map((c) => c.split(';')[0]).join('; ');
  return cachedCookie;
}

function ensureLoggedIn() {
  if (cachedCookie) return Promise.resolve(cachedCookie);
  if (!loginPromise) {
    loginPromise = erpLogin().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

async function erpFetch(pathWithQuery, { retry = true } = {}) {
  assertConfigured();
  await ensureLoggedIn();

  const res = await fetch(`${ERP_BASE_URL}${pathWithQuery}`, {
    headers: { Cookie: cachedCookie, Accept: 'application/json' },
  });

  if ((res.status === 401 || res.status === 403) && retry) {
    cachedCookie = null;
    await ensureLoggedIn();
    return erpFetch(pathWithQuery, { retry: false });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ERP API lỗi HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.code = 'ERP_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Lay danh sach ticket theo doctype "Ticket", loc theo project/status neu co.
 * Tra ve nguyen JSON cua ERPNext (data.data la mang ban ghi).
 */
async function fetchTickets({ project, status, limit = 200 } = {}) {
  const filters = [];
  if (project) filters.push(['project', '=', project]);
  if (status) filters.push(['status', '=', status]);

  const qs = new URLSearchParams();
  qs.set('filters', JSON.stringify(filters));
  qs.set('fields', JSON.stringify(['*']));
  qs.set('limit_page_length', String(limit));

  return erpFetch(`/api/resource/Ticket?${qs.toString()}`);
}

module.exports = { fetchTickets, isConfigured: () => Boolean(ERP_BASE_URL && ERP_USER && ERP_PASS) };
