/**
 * send-dashboard-report.js
 * -------------------------------------------------------------------------
 * Đọc file Ticket_list_ABI_*.xlsx -> render Dashboard (dùng chung logic với
 * bản web) -> xuất PDF -> gửi email kèm PDF theo template.
 *
 * Vì Microsoft Teams cho phép mỗi kênh (channel) có SẴN 1 địa chỉ email
 * riêng (bật ở "..." > Get email address trên channel đó), nên KHÔNG cần
 * viết thêm code riêng để "gửi lên Teams" — chỉ cần thêm địa chỉ email của
 * channel đó vào danh sách "to" / "cc" bên dưới, mọi thứ gửi qua email
 * (kèm PDF đính kèm) sẽ tự động được đăng lên channel Teams đó luôn.
 *
 * Cài đặt trước khi chạy:
 *   npm install xlsx nodemailer
 *   (cần có sẵn "wkhtmltopdf" trên server — cài bằng: apt-get install wkhtmltopdf)
 *
 * Chạy:
 *   node send-dashboard-report.js /path/to/Ticket_list_ABI.xlsx
 * -------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const { buildDashboard } = require('./dashboardLogic');

/* ========================= CẤU HÌNH — SỬA THEO Ý BẠN ===================== */

const CONFIG = {
  // Đường dẫn file Excel nguồn (có thể override bằng tham số dòng lệnh)
  xlsxPath: process.argv[2] || './Ticket_list_ABI.xlsx',

  // SMTP để gửi email — thay bằng thông tin mail server công ty bạn
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false, // true nếu dùng port 465
    auth: {
      user: process.env.SMTP_USER || 'your-report-bot@company.com',
      pass: process.env.SMTP_PASS || 'your-app-password',
    },
  },

  mail: {
    from: '"HQ Ops Report" <your-report-bot@company.com>',
    to: [
      'sep1@company.com',
      'sep2@company.com',
    ],
    // Thêm địa chỉ email của Teams channel vào đây (hoặc "cc") để
    // email + file PDF tự động được đăng vào channel đó luôn.
    cc: [
      // 'abi-project.xxxxxxxx@apac.teams.ms',
    ],
    subjectPrefix: 'Dashboard Ticket ABI',
  },
};

/* ========================================================================= */

function pad(n) { return String(n).padStart(2, '0'); }

async function main() {
  if (!fs.existsSync(CONFIG.xlsxPath)) {
    console.error(`Không tìm thấy file: ${CONFIG.xlsxPath}`);
    process.exit(1);
  }

  // 1) Đọc Excel
  const wb = XLSX.readFile(CONFIG.xlsxPath, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  // 2) Render dashboard (dùng đúng logic/công thức như bản web)
  const today = new Date();
  const reportDateStr = `${pad(today.getDate())}/${pad(today.getMonth() + 1)}/${today.getFullYear()}`;
  const bodyHtml = buildDashboard(rawRows, reportDateStr);

  const styleBlock = fs.readFileSync(path.join(__dirname, 'style-block.html'), 'utf8');
  const dateTag = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const fullHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Dashboard Ticket ABI — ${dateTag}</title>
<style>${styleBlock}</style>
</head>
<body style="background:#F3F6F8;margin:0;">
<div id="dashboard" style="display:block">${bodyHtml}</div>
</body>
</html>`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-dashboard-'));
  const htmlPath = path.join(tmpDir, `dashboard_${dateTag}.html`);
  const pdfPath = path.join(tmpDir, `Dashboard_Ticket_ABI_${dateTag}.pdf`);
  fs.writeFileSync(htmlPath, fullHtml, 'utf8');

  // 3) Xuất PDF bằng wkhtmltopdf
  await new Promise((resolve, reject) => {
    execFile('wkhtmltopdf', [
      '--enable-local-file-access',
      '--page-size', 'A4',
      '--orientation', 'Landscape',
      '--margin-top', '5mm', '--margin-bottom', '5mm',
      '--margin-left', '5mm', '--margin-right', '5mm',
      htmlPath, pdfPath,
    ], (err) => {
      // wkhtmltopdf có thể trả exit code khác 0 nếu không load được asset
      // ngoài mạng (không ảnh hưởng vì trang này không cần script/asset ngoài).
      if (err && !fs.existsSync(pdfPath)) return reject(err);
      resolve();
    });
  });

  console.log('Đã tạo PDF:', pdfPath);

  // 4) Gửi email kèm PDF theo template
  const transporter = nodemailer.createTransport(CONFIG.smtp);

  const kpiSummary = extractKpiSummary(bodyHtml);

  const mailHtml = `
    <p>Chào các Sếp,</p>
    <p>Đây là <b>Dashboard Ticket ABI</b> cập nhật ngày <b>${reportDateStr}</b> (xem chi tiết trong file PDF đính kèm).</p>
    <ul>
      ${kpiSummary.map(k => `<li>${k}</li>`).join('\n      ')}
    </ul>
    <p>Trân trọng.</p>
  `;

  await transporter.sendMail({
    from: CONFIG.mail.from,
    to: CONFIG.mail.to,
    cc: CONFIG.mail.cc,
    subject: `${CONFIG.mail.subjectPrefix} - ${reportDateStr}`,
    html: mailHtml,
    attachments: [
      { filename: path.basename(pdfPath), path: pdfPath },
    ],
  });

  console.log('Đã gửi email thành công tới:', CONFIG.mail.to.join(', '));

  // dọn file tạm
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function extractKpiSummary(bodyHtml) {
  const items = [];
  const re = /<div class="num">([^<]*)<\/div><div class="label">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    items.push(`<b>${m[1]}</b> — ${m[2]}`);
  }
  return items;
}

main().catch(err => {
  console.error('Lỗi:', err);
  process.exit(1);
});
