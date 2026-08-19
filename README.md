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
- **Crs → PAKD và Báo Giá**: mapping file PAKD sang file Estimate (`/`).
- **Dự Án → ABI → Dashboard Ticket**: upload file Excel ticket, xem dashboard
  tổng hợp + xuất PNG (`/abi/dashboard-ticket`).
- **Dự Án → ABI → Lấy Ticket từ ERP**: gọi trực tiếp erp.hqsoft.vn lấy ticket
  theo project/status, xem trước, xuất Excel (`/abi/erp-tickets`).
- **Dự Án → AnVy → Ticket Slide**: dán/nhập ticket, tự tạo slide + xuất
  PNG/PPTX (`/anvy/ticket-slide`).

## Kết nối ERP (đăng nhập bằng email/mật khẩu, không cần API key)

Module "Lấy Ticket từ ERP" gọi thẳng erp.hqsoft.vn bằng phiên đăng nhập
(giống hệt lúc anh bấm nút Login trên web ERP), không cần API Key/Secret hay
quyền System Manager.

Cấu hình trong `docker-compose.yml`:

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
