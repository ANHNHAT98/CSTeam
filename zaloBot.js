'use strict';
/* Gửi tin Zalo qua Zalo Bot API (tạo bot ở https://bot.zapps.vn, lấy token → env ZALO_BOT_TOKEN).
   - API: POST https://bot-api.zapps.me/bot<TOKEN>/<method>  body JSON → { ok, result | description }
   - Chỉ gửi được chữ thường, tối đa 2000 ký tự/tin (dài hơn tự tách nhiều tin).
   - Bot chỉ nhắn được cho người/nhóm đã nhắn bot trước: mỗi người nhắn 1 tin bất kỳ cho bot,
     rồi bấm "Lấy danh sách" để tool đọc getUpdates và lưu chat id (data/zalo-chats.json).
   - getUpdates không dùng được khi bot đang đặt webhook. */

const { createListStore } = require('./listStore');

const chatStore = createListStore({ repoFilePath: 'data/zalo-chats.json', localFile: 'data/zalo-chats.json' });
const MAX_LEN = 2000;

const token = () => String(process.env.ZALO_BOT_TOKEN || '').trim();
const ready = () => Boolean(token());
const apiBase = () => String(process.env.ZALO_API_BASE || 'https://bot-api.zapps.me').replace(/\/+$/, '');

async function api(method, body = {}, timeoutMs = 20000) {
  if (!ready()) throw new Error('Server chưa cấu hình ZALO_BOT_TOKEN.');
  let res;
  try {
    res = await fetch(`${apiBase()}/bot${token()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw new Error(`Không gọi được Zalo (${method}): ${e.message}`); }
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* không phải JSON */ }
  if (!res.ok || !j || j.ok === false) {
    const msg = (j && (j.description || j.message)) || text.slice(0, 200) || res.statusText;
    throw new Error(`Zalo ${method} lỗi ${res.status}${j && j.error_code ? '/' + j.error_code : ''}: ${msg}`);
  }
  return j.result;
}

async function getMe() {
  const r = await api('getMe');
  return { id: r && r.id, name: (r && (r.display_name || r.account_name)) || '' };
}

async function listChats() { const r = await chatStore.readAll(); return Array.isArray(r) ? r : []; }

/** Đọc các tin mới nhắn cho bot (getUpdates trả từng tin một) → lưu chat id. */
async function pullChats() {
  const found = new Map();
  for (let n = 0; n < 15; n++) {
    let r;
    try { r = await api('getUpdates', { timeout: 1 }, 15000); }
    catch (e) { if (n === 0) throw e; break; }
    const ups = Array.isArray(r) ? r : r ? [r] : [];
    const msgs = ups.map((u) => (u && (u.message || (u.result && u.result.message))) || null).filter((m) => m && m.chat && m.chat.id);
    if (!msgs.length) break;
    msgs.forEach((m) => {
      const isGroup = String(m.chat.chat_type || '').toUpperCase() === 'GROUP';
      found.set(String(m.chat.id), {
        id: String(m.chat.id),
        type: isGroup ? 'group' : 'private',
        name: isGroup ? (m.chat.title || m.chat.name || 'Nhóm Zalo') : ((m.from && (m.from.display_name || m.from.account_name)) || 'Người dùng Zalo'),
        lastText: String(m.text || '').slice(0, 60),
        at: new Date().toISOString(),
      });
    });
  }
  if (found.size) {
    await chatStore.mutate((all) => {
      const map = new Map((Array.isArray(all) ? all : []).map((c) => [c.id, c]));
      found.forEach((c, id) => map.set(id, { ...(map.get(id) || {}), ...c }));
      return { list: [...map.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))), result: {} };
    }, `zalo: lưu ${found.size} chat`);
  }
  return { added: found.size, chats: await listChats() };
}

/** Tách văn bản thành các đoạn ≤ 2000 ký tự, ưu tiên ngắt theo dòng. */
function split(text) {
  const out = []; let cur = '';
  for (const line of String(text).split('\n')) {
    const l = line.length > MAX_LEN ? line.slice(0, MAX_LEN - 1) + '…' : line;
    if ((cur ? cur.length + 1 : 0) + l.length > MAX_LEN) { out.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l;
  }
  if (cur) out.push(cur);
  return out;
}

/** Gửi tới nhiều chat; trả { ok, results:[{id, ok, error}] } */
async function sendText(chatIds, text) {
  const parts = split(text);
  const results = [];
  for (const id of chatIds) {
    try { for (const p of parts) await api('sendMessage', { chat_id: id, text: p }); results.push({ id, ok: true }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

module.exports = { ready, getMe, listChats, pullChats, sendText, split };
