'use strict';
/* Kho lưu danh sách bản ghi JSON dùng chung (giống cách "Case Hỗ Trợ" đang lưu):
   - Có GITHUB_TOKEN/GITHUB_REPO: đọc/ghi file trong repo GitHub (mỗi lần ghi = 1 commit thật, không mất khi container restart/deploy lại).
   - Chưa cấu hình GitHub: ghi file local trong ./data (nhớ mount volume ./data trong docker-compose, nếu không sẽ mất khi container bị xoá). */
const fs = require('fs');
const path = require('path');
const github = require('./githubClient');

function createListStore({ repoFilePath, localFile }) {
  const LOCAL = path.join(__dirname, localFile);
  const readLocal = () => { try { return JSON.parse(fs.readFileSync(LOCAL, 'utf8')); } catch (e) { return []; } };
  const writeLocal = (list) => { fs.mkdirSync(path.dirname(LOCAL), { recursive: true }); fs.writeFileSync(LOCAL, JSON.stringify(list, null, 2), 'utf8'); };
  const isGithubBacked = () => github.isConfigured();

  async function readAll() {
    if (isGithubBacked()) {
      const { content } = await github.getFile(repoFilePath);
      if (content === null) return [];
      try { return JSON.parse(content); } catch (e) { throw new Error(`File ${repoFilePath} trên GitHub bị lỗi định dạng JSON: ${e.message}`); }
    }
    return readLocal();
  }
  /** mutate(list) → trả về { list: danhSáchMới, result } ; commitMessage dùng khi ghi qua GitHub. */
  async function mutate(mutateFn, commitMessage) {
    if (isGithubBacked()) {
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
  return { readAll, mutate, isGithubBacked };
}
module.exports = { createListStore };
