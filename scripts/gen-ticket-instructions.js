/* Sinh file hướng dẫn AI cho từng dự án từ ticket-instructions/_template.md + projects.json.
   Chạy:  node scripts/gen-ticket-instructions.js
   LƯU Ý: ghi đè các file Project-Instructions-*.md. Chỉnh mục 0 (UAT, từ khoá) trong projects.json rồi chạy lại,
   hoặc sửa trực tiếp file .md của dự án (nhưng sẽ mất khi chạy lại script). */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'ticket-instructions');
const template = fs.readFileSync(path.join(dir, '_template.md'), 'utf8');
const projects = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'));
const NO_UAT = '(Chưa cấu hình thông tin môi trường UAT)';

function fill(tpl, map) {
  let out = tpl;
  for (const [k, v] of Object.entries(map)) out = out.split(`@@${k}@@`).join(v);
  return out;
}

for (const p of projects) {
  const uatMd = p.uat.length
    ? p.uat.map(([k, v]) => `  - **${k}**: ${v}`).join('\n')
    : `  - ${NO_UAT} — dán thông tin môi trường UAT của dự án vào đây (User, Password, Mã dự án, IP DB, Databasename DB). Chưa có thì AI ghi dòng này ở mục 8.`;
  const uatJson = p.uat.length ? p.uat.map(([k, v]) => `- **${k}**: ${v}`).join('\\n') : NO_UAT;
  const kwMd = p.keywords.length
    ? p.keywords.map(([k, v]) => `  - ${k} → ${v}`).join('\n')
    : '  - (Chưa có — bổ sung các từ khoá/màn hình đặc thù của dự án và Product tương ứng)';
  const text = fill(template, { CODE: p.code, LABEL: p.label, UAT_MD: uatMd, UAT_JSON: uatJson, KEYWORDS_MD: kwMd });
  fs.writeFileSync(path.join(dir, p.file), text, 'utf8');
  console.log('đã tạo', p.file);
}
