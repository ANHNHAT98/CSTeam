'use strict';
/* Hộp thư chờ + nguồn RSS cho Power Automate (dùng khi công ty không cho gọi webhook flow từ bên ngoài).
   - Khi có env MAIL_FEED_KEY: thay vì POST tới REMINDER_WEBHOOK_URL, tool ghi mail vào data/mail-outbox.json.
   - Power Automate dùng trigger RSS "Khi một mục nguồn cấp được phát hành" đọc
       https://<tool>/feed/mail/<MAIL_FEED_KEY>
     mỗi mục = 1 mail: <title> = tiêu đề, <description> = base64 của JSON { to, cc, subject, html } (to/cc nối bằng ';').
     Flow: RSS → Phân tích JSON (Content = base64ToString(summary)) → Gửi email (V2).
   - Giữ tối đa 100 mục / 3 ngày. */

const crypto = require('crypto');
const { createListStore } = require('./listStore');

const store = createListStore({ repoFilePath: 'data/mail-outbox.json', localFile: 'data/mail-outbox.json' });
const MAX_ITEMS = 100;
const KEEP_MS = 3 * 24 * 3600 * 1000;

const feedKey = () => String(process.env.MAIL_FEED_KEY || '').trim();
const enabled = () => feedKey().length >= 16;

function keyOk(got) {
  const k = feedKey(); const g = String(got || '');
  return k.length >= 16 && g.length === k.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(k));
}

async function enqueue(mail) {
  const item = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    to: (mail.to || []).join(';'),
    cc: (mail.cc || []).join(';'),
    subject: String(mail.subject || ''),
    html: String(mail.html || ''),
  };
  await store.mutate((all) => {
    const now = Date.now();
    const list = [item, ...(Array.isArray(all) ? all : []).filter((x) => now - Date.parse(x.at) < KEEP_MS)].slice(0, MAX_ITEMS);
    return { list, result: {} };
  }, `mail-outbox: ${item.subject.slice(0, 60)}`);
  return item;
}

async function list() { const r = await store.readAll(); return Array.isArray(r) ? r : []; }

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

async function rss(selfUrl) {
  const items = await list();
  const body = items.map((x) => {
    const payload = Buffer.from(JSON.stringify({ to: x.to, cc: x.cc, subject: x.subject, html: x.html }), 'utf8').toString('base64');
    return `<item><guid isPermaLink="false">${xmlEsc(x.id)}</guid><title>${xmlEsc(x.subject)}</title><link>${xmlEsc(selfUrl)}#${xmlEsc(x.id)}</link><pubDate>${new Date(x.at).toUTCString()}</pubDate><description>${payload}</description></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>CS Tool - mail cho Power Automate</title><link>${xmlEsc(selfUrl)}</link><description>Hộp thư chờ gửi</description>${body}</channel></rss>`;
}

module.exports = { enabled, keyOk, enqueue, list, rss };
