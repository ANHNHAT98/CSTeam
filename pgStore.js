'use strict';
/* Lưu dữ liệu tool vào PostgreSQL (Supabase / Neon...) thay cho commit file JSON lên GitHub.
   Bật khi có biến môi trường (đặt trên Render → Environment, KHÔNG ghi vào code):
     STORE_PG_URL   chuỗi kết nối, ví dụ Supabase → Connect → "Session pooler":
                    postgresql://postgres.<ref>:<mật khẩu>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
     STORE_PG_SSL   1 (mặc định) = kết nối mã hoá SSL; 0 = tắt (chỉ dùng cho Postgres chạy local để test)
   Bảng tự tạo lần đầu: public.cstool_store — mỗi "file" JSON cũ (data/xxx.json) = 1 dòng. */

let PgPool = null;
const env = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const enabled = () => /^postgres(ql)?:\/\//i.test(env('STORE_PG_URL'));

function connectionString() {
  // bỏ sslmode trong URL — SSL cấu hình bằng tuỳ chọn ssl bên dưới (tránh pg hiểu sslmode=require thành verify-full)
  try { const u = new URL(env('STORE_PG_URL')); u.searchParams.delete('sslmode'); return u.toString(); }
  catch (_) { return env('STORE_PG_URL'); }
}
function hostOf() { try { return new URL(env('STORE_PG_URL')).hostname; } catch (_) { return '?'; } }

let poolPromise = null;
async function pool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      PgPool = PgPool || require('pg').Pool;
      const ssl = !['0', 'false', 'no', 'off'].includes(env('STORE_PG_SSL', '1').toLowerCase());
      const p = new PgPool({
        connectionString: connectionString(),
        ssl: ssl ? { rejectUnauthorized: false } : false,
        max: 4,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 15000,
      });
      p.on('error', (e) => console.error('[pgStore] pool error:', e.message));
      await p.query(`CREATE TABLE IF NOT EXISTS cstool_store (
        file_path  TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        note       TEXT
      )`);
      console.log(`[pgStore] đã kết nối PostgreSQL ${hostOf()}`);
      return p;
    })().catch((e) => { poolPromise = null; throw new Error(`Không kết nối được PostgreSQL lưu dữ liệu: ${e.message}`); });
  }
  return poolPromise;
}

/** Đọc 1 "file": trả { exists, content } (content = chuỗi JSON). */
async function getDoc(filePath) {
  const p = await pool();
  const r = await p.query('SELECT content FROM cstool_store WHERE file_path = $1', [filePath]);
  return r.rows.length ? { exists: true, content: r.rows[0].content } : { exists: false, content: null };
}

/** Đọc + ghi trong 1 transaction, khoá theo file (2 người lưu cùng lúc không đè nhau).
    fn({ exists, content }) → Promise<{ content: chuỗi JSON mới | null (không ghi), value }> */
async function updateDoc(filePath, fn, note) {
  const p = await pool();
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [filePath]);
    const cur = await c.query('SELECT content FROM cstool_store WHERE file_path = $1', [filePath]);
    const exists = cur.rows.length > 0;
    const out = await fn({ exists, content: exists ? cur.rows[0].content : null });
    if (out && out.content != null) {
      await c.query(`INSERT INTO cstool_store (file_path, content, updated_at, note) VALUES ($1, $2, now(), $3)
        ON CONFLICT (file_path) DO UPDATE SET content = EXCLUDED.content, updated_at = now(), note = EXCLUDED.note`,
      [filePath, out.content, String(note || '').slice(0, 300)]);
    }
    await c.query('COMMIT');
    return out ? out.value : undefined;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* đã rollback */ }
    throw e;
  } finally { c.release(); }
}

async function status() {
  if (!enabled()) return { enabled: false };
  try {
    const p = await pool();
    const docs = await p.query(`SELECT file_path, octet_length(content) AS bytes, updated_at, note
      FROM cstool_store ORDER BY updated_at DESC`);
    const db = await p.query('SELECT pg_database_size(current_database()) AS bytes');
    return {
      enabled: true, ok: true, kind: 'postgres', host: hostOf(),
      dbBytes: Number(db.rows[0].bytes),
      docs: docs.rows.map((r) => ({ file: r.file_path, bytes: Number(r.bytes), updatedAt: r.updated_at, note: r.note })),
    };
  } catch (e) { return { enabled: true, ok: false, kind: 'postgres', error: e.message }; }
}

module.exports = { enabled, getDoc, updateDoc, status };
