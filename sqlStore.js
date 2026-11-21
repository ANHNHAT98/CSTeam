'use strict';
/* Lưu dữ liệu tool vào SQL Server thay cho commit file JSON lên GitHub.
   Bật khi có biến môi trường (đặt trên Render → Environment, KHÔNG ghi vào code):
     STORE_SQL_SERVER     tên máy / IP / tên miền public của SQL Server (bắt buộc)
     STORE_SQL_PORT       mặc định 1433
     STORE_SQL_DATABASE   ví dụ CSTool (bắt buộc) — database RIÊNG của tool, không dùng DB khách hàng
     STORE_SQL_USER       tài khoản SQL (bắt buộc)
     STORE_SQL_PASSWORD   mật khẩu (bắt buộc)
     STORE_SQL_ENCRYPT    1 (mặc định) = mã hoá kết nối; 0 = tắt
     STORE_SQL_TRUST_CERT 1 (mặc định) = chấp nhận chứng chỉ tự ký (SQL Server cài trên máy cá nhân)
   Bảng tự tạo lần đầu: dbo.CsTool_Store — mỗi "file" JSON cũ (data/xxx.json) = 1 dòng. */

let mssql = null;
const env = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const flag = (k, d) => !['0', 'false', 'no', 'off'].includes(env(k, d).toLowerCase());

function enabled() {
  return Boolean(env('STORE_SQL_SERVER') && env('STORE_SQL_DATABASE') && env('STORE_SQL_USER') && env('STORE_SQL_PASSWORD'));
}

let poolPromise = null;
async function pool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      mssql = mssql || require('mssql');
      const p = new mssql.ConnectionPool({
        server: env('STORE_SQL_SERVER'),
        port: Number(env('STORE_SQL_PORT', '1433')) || 1433,
        database: env('STORE_SQL_DATABASE'),
        user: env('STORE_SQL_USER'),
        password: env('STORE_SQL_PASSWORD'),
        options: { encrypt: flag('STORE_SQL_ENCRYPT', '1'), trustServerCertificate: flag('STORE_SQL_TRUST_CERT', '1') },
        pool: { max: 5, min: 0, idleTimeoutMillis: 60000 },
        connectionTimeout: 15000,
        requestTimeout: 30000,
      });
      p.on('error', (e) => console.error('[sqlStore] pool error:', e.message));
      await p.connect();
      await p.request().batch(`
IF OBJECT_ID(N'dbo.CsTool_Store', N'U') IS NULL
  CREATE TABLE dbo.CsTool_Store (
    FilePath  NVARCHAR(200) NOT NULL PRIMARY KEY,
    Content   NVARCHAR(MAX) NOT NULL,
    UpdatedAt DATETIME2(0)  NOT NULL CONSTRAINT DF_CsTool_Store_UpdatedAt DEFAULT SYSUTCDATETIME(),
    Note      NVARCHAR(300) NULL
  );`);
      console.log(`[sqlStore] đã kết nối SQL Server ${env('STORE_SQL_SERVER')}/${env('STORE_SQL_DATABASE')}`);
      return p;
    })().catch((e) => { poolPromise = null; throw new Error(`Không kết nối được SQL Server lưu dữ liệu: ${e.message}`); });
  }
  return poolPromise;
}

/** Đọc 1 "file": trả { exists, content } (content = chuỗi JSON). */
async function getDoc(filePath) {
  const p = await pool();
  const r = await p.request().input('fp', mssql.NVarChar(200), filePath)
    .query('SELECT Content FROM dbo.CsTool_Store WHERE FilePath = @fp');
  return r.recordset.length ? { exists: true, content: r.recordset[0].Content } : { exists: false, content: null };
}

/** Đọc + ghi trong 1 transaction có khoá dòng (2 người lưu cùng lúc không đè nhau).
    fn({ exists, content }) → Promise<{ content: chuỗi JSON mới | null (không ghi), value }> */
async function updateDoc(filePath, fn, note) {
  const p = await pool();
  const tx = new mssql.Transaction(p);
  await tx.begin(mssql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const cur = await new mssql.Request(tx).input('fp', mssql.NVarChar(200), filePath)
      .query('SELECT Content FROM dbo.CsTool_Store WITH (UPDLOCK, HOLDLOCK) WHERE FilePath = @fp');
    const exists = cur.recordset.length > 0;
    const out = await fn({ exists, content: exists ? cur.recordset[0].Content : null });
    if (out && out.content != null) {
      const rq = new mssql.Request(tx)
        .input('fp', mssql.NVarChar(200), filePath)
        .input('c', mssql.NVarChar(mssql.MAX), out.content)
        .input('n', mssql.NVarChar(300), String(note || '').slice(0, 300));
      await rq.query(exists
        ? 'UPDATE dbo.CsTool_Store SET Content = @c, UpdatedAt = SYSUTCDATETIME(), Note = @n WHERE FilePath = @fp'
        : 'INSERT INTO dbo.CsTool_Store (FilePath, Content, Note) VALUES (@fp, @c, @n)');
    }
    await tx.commit();
    return out ? out.value : undefined;
  } catch (e) {
    try { await tx.rollback(); } catch (_) { /* đã rollback */ }
    throw e;
  }
}

async function status() {
  if (!enabled()) return { enabled: false };
  try {
    const p = await pool();
    const r = await p.request().query('SELECT COUNT(*) AS n, MAX(UpdatedAt) AS last FROM dbo.CsTool_Store');
    return { enabled: true, ok: true, server: env('STORE_SQL_SERVER'), database: env('STORE_SQL_DATABASE'), docs: r.recordset[0].n, lastUpdate: r.recordset[0].last };
  } catch (e) { return { enabled: true, ok: false, error: e.message }; }
}

module.exports = { enabled, getDoc, updateDoc, status };
