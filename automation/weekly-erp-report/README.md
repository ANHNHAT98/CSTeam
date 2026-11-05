# Báo Cáo Tuần ERP — tự động theo lịch

Đến lịch, tool tự lấy dữ liệu **kỳ vừa kết thúc** cho từng dự án, tính y như nút "Lấy dữ liệu" trên trang
**Báo Cáo Tuần ERP**, rồi **thêm 1 Note mới** vào bản ghi của dự án trong **Project Progress Update**
(giống bấm tab Progress → New Note → Add), kèm ảnh biểu đồ đính kèm vào bản ghi đó.
Mỗi dự án / kỳ chỉ ghi 1 lần: nếu đã có note "Tuần báo cáo: (…)" của kỳ đó (kể cả note dán tay) thì bỏ qua.

## 1. Cấu hình trên trang (1 lần)
Trang **Báo Cáo → Báo Cáo Tuần ERP**, khung "⚙ Tự động gửi vào ERP theo lịch":
1. DocType: `Project Progress Update` → **Tải trường** (tool tự chọn bảng Note và trường nội dung Note).
2. Cách ghi: **Thêm Note vào bản ghi của dự án**; Tên bản ghi: `{project}` (vd `MerapLion_eSales`).
3. **Kỳ báo cáo**: chọn đúng kỳ team đang dùng (vd Thứ 6 → Thứ 5) — đặt lịch chạy vào ngày ngay sau ngày cuối kỳ.
4. Tick **Bật chạy tự động**, chọn dự án → **Lưu cấu hình**. Bấm **Xem thử** để xem nội dung trước khi ghi.

Tài khoản ERP của tool (ERP_API_KEY/SECRET) cần quyền **Read / Write** trên Project Progress Update và quyền tạo **File**.
Mỗi dự án phải có sẵn bản ghi Project Progress Update tên = mã dự án (không có thì lịch sử chạy báo lỗi cho dự án đó).

## 2. Biến môi trường trên Render
`CRON_SECRET` = 1 chuỗi ngẫu nhiên dài ≥ 16 ký tự (vd tạo bằng `openssl rand -hex 24`). Không có biến này thì lịch ngoài không gọi được.

## 3. Đặt lịch (chọn 1 cách)
- **GitHub Actions**: xem `github-actions-weekly-erp.yml`.
- **GitLab**: xem `gitlab-ci-weekly-erp.yml`.
- **cron-job.org**: URL `https://csteam.onrender.com/api/cron/weekly-erp`, method POST, header `X-Cron-Key: <CRON_SECRET>`,
  lịch thứ 2 08:00 (Asia/Ho_Chi_Minh), timeout tối đa.

Thử tay: `curl -X POST -H "X-Cron-Key: <CRON_SECRET>" https://csteam.onrender.com/api/cron/weekly-erp`
(thêm `?from=2026-10-26&to=2026-11-01` để chạy 1 tuần cụ thể). Kết quả từng lần chạy xem ở bảng "Lịch sử chạy" trên trang.
