'use strict';
/* Kho lưu danh sách bản ghi JSON dùng chung. Thứ tự ưu tiên:
   0. Có STORE_PG_URL (xem pgStore.js — Supabase/PostgreSQL): mỗi file = 1 dòng bảng cstool_store.
   1. Có STORE_SQL_* (xem sqlStore.js): lưu trong SQL Server, mỗi file = 1 dòng bảng dbo.CsTool_Store.
      Không commit GitHub nữa → không còn bị deploy lại / đăng xuất vì lưu dữ liệu.
      Lần đầu đọc một file chưa có trong SQL: tự chuyển dữ liệu cũ từ GitHub (nếu cấu hình) hoặc ./data vào SQL.
   2. Có GITHUB_TOKEN/GITHUB_REPO: đọc/ghi file trong repo GitHub (mỗi lần ghi = 1 commit).
   3. Không có gì: ghi file local trong ./data. */
const fs = require('fs');
const path = require('path');
const github = require('./githubClient');
const pgStore = require('./pgStore');
const sqlServerStore = require('./sqlStore');

/** Database đang dùng (PostgreSQL ưu tiên trước SQL Server), null = không dùng database. */
function dbBackend() { return pgStore.enabled() ? pgStore : sqlServerStore.enabled() ? sqlServerStore : null; }
const sqlStore = {
  enabled: () => Boolean(dbBackend()),
  getDoc: (...a) => dbBackend().getDoc(...a),
  updateDoc: (...a) => dbBackend().updateDoc(...a),
};
const registry = []; // mọi kho đã tạo — dùng cho "chuyển toàn bộ dữ liệu sang database"

function createListStore({ repoFilePath, localFile }) {
  if (registry.some((r) => r.repoFilePath === repoFilePath)) console.warn(`[listStore] ${repoFilePath} được tạo 2 lần`);
  const LOCAL = path.join(__dirname, localFile);
  const readLocal = () => { try { return JSON.parse(fs.readFileSync(LOCAL, 'utf8')); } catch (e) { return []; } };
  const writeLocal = (list) => {
    try { fs.mkdirSync(path.dirname(LOCAL), { recursive: true }); fs.writeFileSync(LOCAL, JSON.stringify(list, null, 2), 'utf8'); }
    catch (e) { console.error(`[listStore] không ghi được bản sao ${localFile}: ${e.message}`); }
  };
  const useGithub = () => !sqlStore.enabled() && github.isConfigured();
  // giữ tên cũ cho các trang: true = dữ liệu được lưu bền (SQL Server hoặc GitHub), không mất khi redeploy
  const isGithubBacked = () => sqlStore.enabled() || github.isConfigured();
  const parse = (content, where) => {
    try { return JSON.parse(content); } catch (e) { throw new Error(`Dữ liệu ${repoFilePath} (${where}) bị lỗi định dạng JSON: ${e.message}`); }
  };

  /** Dữ liệu cũ trước khi chuyển sang SQL: GitHub nếu đang cấu hình, không thì ./data. */
  async function readLegacy() {
    if (github.isConfigured()) {
      const { content } = await github.getFile(repoFilePath);
      return content === null ? [] : parse(content, 'GitHub');
    }
    return readLocal();
  }

  async function readAll() {
    if (sqlStore.enabled()) {
      const doc = await sqlStore.getDoc(repoFilePath);
      if (doc.exists) return parse(doc.content, 'database');
      // chưa có trong SQL → chuyển dữ liệu cũ sang (trong transaction, tránh 2 request cùng chuyển)
      return sqlStore.updateDoc(repoFilePath, async (cur) => {
        if (cur.exists) return { content: null, value: parse(cur.content, 'database') };
        const legacy = await readLegacy();
        console.log(`[listStore] chuyển ${repoFilePath} sang database`);
        return { content: JSON.stringify(legacy), value: legacy };
      }, 'chuyển dữ liệu cũ sang database');
    }
    if (useGithub()) {
      const { content } = await github.getFile(repoFilePath);
      if (content === null) return [];
      return parse(content, 'GitHub');
    }
    return readLocal();
  }

  /** mutate(list) → trả về { list: danhSáchMới, result } ; commitMessage dùng khi ghi qua GitHub / ghi chú trong SQL. */
  async function mutate(mutateFn, commitMessage) {
    if (sqlStore.enabled()) {
      let saved;
      const result = await sqlStore.updateDoc(repoFilePath, async (cur) => {
        const before = cur.exists ? parse(cur.content, 'database') : await readLegacy();
        const { list, result: r } = mutateFn(before);
        saved = list;
        return { content: JSON.stringify(list), value: r };
      }, commitMessage);
      writeLocal(saved); // bản sao local, chỉ để tham khảo
      return { ...result, commitUrl: null };
    }
    if (useGithub()) {
      const { content, sha } = await github.getFile(repoFilePath);
      const { list, result } = mutateFn(content ? JSON.parse(content) : []);
      const put = await github.putFile(repoFilePath, JSON.stringify(list, null, 2), sha, commitMessage);
      writeLocal(list);
      return { ...result, commitUrl: put.commit && put.commit.html_url };
    }
    const { list, result } = mutateFn(readLocal());
    writeLocal(list);
    return { ...result, commitUrl: null };
  }
  const api = { readAll, mutate, isGithubBacked, isSqlBacked: () => sqlStore.enabled() };
  registry.push({ repoFilePath, api });
  return api;
}

/** Đọc mọi kho 1 lượt → kho nào chưa có trong database sẽ được chuyển sang. */
async function migrateAll() {
  if (!sqlStore.enabled()) throw new Error('Chưa cấu hình database (STORE_PG_URL hoặc STORE_SQL_*).');
  const out = [];
  for (const { repoFilePath, api } of registry) {
    try { const list = await api.readAll(); out.push({ file: repoFilePath, ok: true, items: Array.isArray(list) ? list.length : null }); }
    catch (e) { out.push({ file: repoFilePath, ok: false, error: e.message }); }
  }
  return out;
}

async function storeStatus() {
  const b = dbBackend();
  const db = b ? await b.status() : { enabled: false };
  return {
    backend: pgStore.enabled() ? 'postgres' : sqlServerStore.enabled() ? 'sqlserver' : github.isConfigured() ? 'github' : 'local',
    db, files: registry.map((r) => r.repoFilePath),
  };
}

module.exports = { createListStore, migrateAll, storeStatus };
