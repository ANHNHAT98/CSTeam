# Dashboard Ticket ABI — Script gửi báo cáo tự động

## Chức năng
Đọc file `Ticket_list_ABI_*.xlsx` -> render đúng dashboard (dùng chung công thức/thống kê
với bản web) -> xuất ra file PDF -> gửi email theo template kèm PDF đính kèm.

## Cài đặt (1 lần trên server)
```bash
npm install
sudo apt-get install -y wkhtmltopdf   # nếu server chưa có
```

## Cấu hình
Mở `send-dashboard-report.js`, sửa phần `CONFIG`:
- `smtp`: thông tin SMTP server công ty (host/port/user/pass)
- `mail.from` / `mail.to`: người gửi và danh sách các Sếp nhận mail
- `mail.cc`: (tuỳ chọn) thêm địa chỉ email của kênh Teams vào đây

## Gửi kèm lên Teams (không cần code thêm)
Mỗi channel Teams có thể bật email riêng:
Channel > "..." > **Get email address** > copy địa chỉ dạng
`ten-channel.xxxxxxxx@apac.teams.ms`

Dán địa chỉ đó vào `mail.cc` trong CONFIG — mọi email gửi ra (kèm PDF)
sẽ tự động được đăng vào channel Teams đó luôn, không cần viết thêm
tích hợp Teams API riêng.

## Chạy
```bash
node send-dashboard-report.js /duong-dan/Ticket_list_ABI_2026-07-20.xlsx
```

Có thể đặt lịch chạy tự động bằng `cron`, ví dụ 8h sáng mỗi ngày:
```
0 8 * * * cd /path/to/script && node send-dashboard-report.js /path/to/Ticket_list_ABI.xlsx >> /var/log/abi-dashboard.log 2>&1
```

## File đi kèm
- `send-dashboard-report.js` — script chính
- `dashboardLogic.js` — logic tính toán/render dashboard (đã tách từ bản web, dùng chung công thức)
- `style-block.html` — CSS để PDF xuất ra giống hệt bản web
