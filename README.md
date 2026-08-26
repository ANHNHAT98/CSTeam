# HQSOFT Ops Console — server (Docker)

Server thật (Node.js + Express) chạy trên máy/server của anh — cả team dùng
chung **1 tài khoản đăng nhập**, cấu hình qua biến môi trường. Không lưu tài
khoản động nào cả, nên **không có gì để mất** khi server restart (kể cả trên
gói miễn phí của Render — server "ngủ" rồi dậy lại vẫn đăng nhập được bình
thường bằng đúng tài khoản đã cấu hình).

## Chạy nhanh bằng Docker Compose

```bash
cd estimate-mapper-server
docker compose up -d --build
```

Mở trình duyệt: `http://localhost:4000` (hoặc `http://<IP-máy>:4000` từ máy
khác trong mạng LAN công ty).

Tài khoản mặc định: **admin / admin123@**

## Đổi tài khoản dùng chung

Sửa trong `docker-compose.yml`, mục `environment`:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng server lắng nghe | `4000` |
| `SESSION_SECRET` | Chuỗi bí mật ký session — nên đổi | `doi-chuoi-nay...` |
| `ADMIN_USER` | Tài khoản dùng chung cho cả team | `admin` |
| `ADMIN_PASS` | Mật khẩu dùng chung cho cả team | `admin123@` |
| `COOKIE_SECURE` | Đặt `1` nếu đã chạy sau HTTPS | tắt |

Sau khi sửa:

```bash
docker compose up -d --build
```

## Chạy không dùng Docker (test nhanh)

```bash
cd estimate-mapper-server
npm install
node server.js
```

## Deploy lên Render.com (không phụ thuộc máy cá nhân)

1. Push code lên GitHub (đã làm).
2. Trên Render: New → Web Service → chọn repo → Runtime tự nhận Docker.
3. Thêm Environment Variables: `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASS`.
4. Create Web Service — Render cho 1 link dạng `https://ten-app.onrender.com`
   dùng chung cho cả team.

Vì không còn lưu tài khoản động, **không cần** Persistent Disk trên Render
nữa — server "ngủ" rồi dậy lại (~30-60s lần đầu sau khi ngủ) vẫn đăng nhập
bình thường.

## Lưu ý bảo mật

- Tài khoản dùng chung nghĩa là **không phân biệt được ai đang thao tác** —
  phù hợp cho nội bộ team nhỏ, tin cậy lẫn nhau.
- Nếu sau này cần phân quyền riêng từng người, báo lại — có thể khôi phục
  cơ chế tài khoản đa người dùng (đã từng làm ở phiên bản trước) kèm database
  bền vững.
- Nếu mở ra ngoài internet, nên đặt sau HTTPS (reverse proxy) và bật
  `COOKIE_SECURE=1`.

## Cấu trúc thư mục

```
estimate-mapper-server/
├─ server.js           # Express server, login/logout dùng chung 1 tài khoản
├─ public/
│  └─ index.html        # Trang chính (menu trái: Crs, Dự Án...)
├─ protected/
│  └─ abi-dashboard-ticket.html   # Module Dự Án > ABI > Dashboard Ticket
├─ Dockerfile
├─ docker-compose.yml
└─ package.json
```

**Thêm chức năng mới (module) sau này** — 2 bước:
1. Bỏ file HTML của module đó vào thư mục `protected/` (không phải `public/`,
   để bắt buộc phải đăng nhập mới xem được).
2. Trong `server.js`, thêm 1 route theo mẫu:
   ```js
   app.get('/du-an/ten-du-an', requirePageAuth, (req, res) => {
     res.sendFile(path.join(__dirname, 'protected', 'ten-file.html'));
   });
   ```
   (đặt route này TRƯỚC dòng `app.use(express.static(...))`).
3. Trong `public/index.html`, phần `<aside class="side-nav">`, thêm mục
   menu trỏ tới đường dẫn đó, theo đúng mẫu mục "Dashboard Ticket" đang có
   dưới ABI.

Module hiện có:
- **Tổng quan → Dashboard** (`/`, trang chủ sau khi đăng nhập): tổng hợp
  ticket đang mở toàn bộ 4 dự án từ ERP theo project/status. CSAT và First
  Response Time có sẵn khung nhưng **chưa bật** vì chưa xác nhận tên field
  ERP tương ứng (xem hướng dẫn ngay trên trang).
- **Crs → PAKD và Báo Giá**: mapping file PAKD sang file Estimate
  (`/crs/pakd-bao-gia`).
- **Crs → Lợi Nhuận Crs**: upload file PAKD + lấy Timesheet trực tiếp từ ERP
  (hoặc file Detail Timesheet Report export tay) → tự tính chi phí nhân công
  theo giờ làm thực tế, ra lợi nhuận, xuất Excel giữ nguyên định dạng gốc
  gửi sếp (`/crs/loi-nhuan-du-an`).
- **Dự Án → ABI → Dashboard Ticket**: upload file Excel ticket, xem dashboard
  tổng hợp (SLA theo Priority, xu hướng theo tuần, aging theo đội xử lý),
  xuất PNG / PDF / file HTML độc lập hoặc gửi thẳng qua email
  (`/abi/dashboard-ticket`).
- **Dự Án → AnVy → Ticket Slide**: dán/nhập ticket, tự tạo slide + xuất
  PNG/PPTX (`/anvy/ticket-slide`).
- **Ticket dự án → Tra cứu ERP**: gọi trực tiếp erp.hqsoft.vn lấy ticket theo
  nhiều project + nhiều trạng thái cùng lúc, xem trước, xuất Excel
  (`/tickets/tra-cuu-erp`).
- **Ticket dự án → SLA Phản hồi đầu**: lấy toàn bộ ticket 4 dự án
  (MerapLion_eSales, ABI_eSales_Support, ANVY_eSale_Support, Sabeco_PG) từ
  ERP, tính Pass/Fail SLA phản hồi đầu theo Priority, xem theo dự
  án/priority, xuất Excel (`/tickets/sla-first-response`).
- **Hotfix → Gom Sql và Back up SQL**: upload nhiều file .sql, gộp lại, tự nhận diện các
  PROC cần backup, tạo query lấy definition hiện tại, tạo SQL backup, xác
  nhận rồi mới cho tải `Deploy_All.sql` (`/hotfix/gop-sql`). Hoàn toàn xử lý
  ở trình duyệt, không gửi gì lên server.
- **Hotfix → Gom build**: gom file build qua nhiều lần release (nhiều đợt
  RLS), tự phân loại file theo loại (bin/view/script/sql), file trùng đường
  dẫn giữa các đợt sẽ lấy bản mới nhất ghi đè, xuất ra 1 file ZIP tổng hợp
  duy nhất (`/hotfix/gom-build`).
- **Hotfix → Backup build**: nhận file ZIP đã gom (từ "Gom build") + thư mục
  Prod hiện tại, so sánh đường dẫn, file nào sắp bị deploy ghi đè sẽ được
  lấy đúng bản đang chạy trên Prod, đóng gói lại thành 1 ZIP backup riêng
  trước khi deploy (`/hotfix/backup-build`).

### Công thức SLA Phản hồi đầu

```
W = First Responded On − Opening On (phút)
Nếu chưa có First Responded On → W = 1.1 → Fail
Ngưỡng theo Priority (phút): Critical=60, Urgent=240, High=480, Medium=4320,
  còn lại (vd Low)=7200
Kết quả = Pass nếu W < ngưỡng, ngược lại Fail
```

Trang tự đoán field ERP tương ứng Priority/Opening On/First Responded On dựa
theo tên field, nhưng luôn bắt xác nhận lại trước khi tính (bước 2 trên
trang) — vì tên field thật trong `Ticket` doctype có thể khác giữa các lần
export/cấu hình.

## Bật CSAT / First Response Time trên Dashboard

Trang chủ (`/`) đã có sẵn 2 ô KPI cho CSAT và First Response Time nhưng đang
hiện "chưa cấu hình" — vì cần đúng tên field ERPNext lưu điểm hài lòng và
thời điểm phản hồi đầu tiên. Cách xác nhận tên field: vào **Ticket dự án →
Tra cứu ERP**, bấm "Lấy dữ liệu từ ERP", xem tên cột trong bảng kết quả thô
(đó là tên field thật) — báo lại tên field để hoàn thiện 2 chỉ số này.

## Gửi báo cáo Dashboard Ticket ABI tự động qua email (cron)

Ngoài 3 cách xuất tay trên trang `/abi/dashboard-ticket` (PNG/PDF/HTML/Email
thủ công), thư mục `automation/abi-dashboard-report/` chứa một **script
Node.js độc lập** để tự động tạo + gửi báo cáo này qua email theo lịch (ví
dụ mỗi sáng), không cần ai mở trình duyệt.

- Dùng chung công thức/thống kê với bản web (`dashboardLogic.js` là bản port
  từ logic trong `protected/abi-dashboard-ticket.html`) — nếu sau này sửa
  công thức ở 1 bên, nhớ soát lại bên còn lại cho khớp.
- Xuất PDF bằng **wkhtmltopdf** (khác với bản web dùng html2canvas+jsPDF
  ngay trong trình duyệt), nên cần cài `wkhtmltopdf` trên máy chạy script.
  Script này **không chạy trong Docker image chính** (Alpine không có sẵn
  gói wkhtmltopdf ổn định) — nên chạy trực tiếp trên 1 máy chủ Ubuntu/Debian
  (có thể là máy đang chạy Docker container chính, chạy song song ở host,
  hoặc 1 máy/cron job riêng), theo hướng dẫn trong
  `automation/abi-dashboard-report/README.md`.
- Cấu hình SMTP + danh sách người nhận trong `send-dashboard-report.js`
  (mục `CONFIG`) trước khi chạy — **đừng commit mật khẩu SMTP thật lên
  GitHub**, nên dùng biến môi trường (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
  đã hỗ trợ sẵn qua `process.env`).
- Muốn gửi luôn vào 1 channel Teams: lấy địa chỉ email riêng của channel đó
  (`...` > Get email address) rồi thêm vào `mail.cc` — không cần code thêm
  gì để tích hợp Teams.

## Export "Lợi nhuận Crs" giữ nguyên định dạng file gốc

Khác với Estimate Mapper (xử lý hoàn toàn ở trình duyệt bằng SheetJS), bước
xuất file cuối của "Lợi Nhuận Crs" được giao cho `scripts/build_loi_nhuan_report.py`
chạy ở server (dùng `openpyxl`) — vì SheetJS bản miễn phí chỉ đọc được style
(màu nền, in đậm...) chứ không ghi lại được khi xuất file mới. Vì vậy
`Dockerfile` có cài thêm Python + `openpyxl`, và `server.js` có route
`POST /api/crs/loi-nhuan/export` nhận file PAKD gốc + dữ liệu đã tính ở
trình duyệt, gọi script Python build file, rồi trả file về cho người dùng
tải xuống. Nếu deploy không qua Docker (chạy thẳng `node server.js`), cần
tự cài `python3` + `pip install openpyxl` trên máy đó.

## Kết nối ERP (đăng nhập bằng email/mật khẩu, không cần API key)

Module "Ticket dự án → Tra cứu ERP" gọi thẳng erp.hqsoft.vn bằng phiên đăng
nhập (giống hệt lúc anh bấm nút Login trên web ERP), không cần API
Key/Secret hay quyền System Manager.

Bộ lọc hỗ trợ **chọn nhiều project** (`MerapLion_eSales`,
`ABI_eSales_Support`, `ANVY_eSale_Support`, `Sabeco_PG`) và **chọn nhiều
trạng thái** (`Open`, `Assign`, `Working`, `Reviewing`, `Waiting`, `Pending`,
`Re-open`, `Closed`, và cả "chưa có trạng thái") cùng lúc.

Cấu hình trong `docker-compose.yml` (hoặc Environment Variables trên Render):

| Biến | Ý nghĩa |
|---|---|
| `ERP_BASE_URL` | Địa chỉ gốc ERP, mặc định `https://erp.hqsoft.vn` |
| `ERP_USER` | Email đăng nhập ERP (tài khoản cá nhân hoặc service account) |
| `ERP_PASS` | Mật khẩu tương ứng |

Server tự đăng nhập lại nếu phiên hết hạn, không cần thao tác gì thêm.

**Lưu ý bảo mật:** mật khẩu ERP được lưu dạng biến môi trường trên server —
không hiển thị ra trình duyệt, nhưng ai có quyền truy cập server (SSH, đọc
file `docker-compose.yml`) sẽ thấy được. Nếu có thể, nên dùng một tài khoản
ERP riêng chỉ có quyền đọc ticket (không phải tài khoản cá nhân có toàn
quyền), để giảm rủi ro nếu server bị lộ.

**Doctype hiện giả định là `Ticket`** (khớp với URL anh gửi
`/app/ticket?project=...`). Field trả về hiện là **toàn bộ field thô** của
ERPNext — chưa map vào đúng cột Hạng mục/Nội dung/Chi tiết/Trạng thái/Hạn/
Ghi chú vì chưa biết tên field chính xác. Sau khi anh chạy thử và xem được
dữ liệu thật, báo lại tên field tương ứng để em hoàn thiện mapping tự động.

## Vì sao thỉnh thoảng bị đá về màn hình đăng nhập giữa chừng?

Trên gói **miễn phí của Render**, server tự "ngủ" sau ~15 phút không có ai
truy cập, và khi "thức" lại thì toàn bộ phiên đăng nhập đang lưu trong RAM bị
mất (không có gì để giữ lại vì không dùng database cho phiên đăng nhập, cố ý
để tránh phức tạp không cần thiết). Đây không phải lỗi — là đặc điểm của gói
miễn phí. Để đỡ khó chịu, đã thêm cơ chế: nếu bị đá về đăng nhập giữa chừng,
đăng nhập lại xong sẽ **tự động quay đúng về trang đang xem** thay vì phải
bấm menu lại từ đầu. Nếu muốn hết hẳn tình trạng này, cần nâng cấp lên gói
Render trả phí (không bị "ngủ") hoặc tự host trên máy/server luôn bật.
