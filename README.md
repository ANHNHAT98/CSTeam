# HQSOFT Ops Console — server (Docker)

Bản này chạy như một server thật (Node.js + Express) trên máy/server của anh, thay vì
file HTML tĩnh. Tài khoản & phân quyền lưu tập trung tại `db/accounts.json` trên server
đó — cả team dùng chung 1 địa chỉ, admin đổi quyền là áp dụng ngay cho mọi người.

## Chạy nhanh bằng Docker Compose

Yêu cầu: máy đã cài **Docker Desktop** (Windows/Mac) hoặc **Docker Engine + Docker
Compose** (Linux/Windows Server).

```bash
cd estimate-mapper-server
docker compose up -d --build
```

Sau khi container chạy, mở trình duyệt vào:

```
http://localhost:4000
```

Từ máy khác trong cùng mạng LAN công ty, dùng địa chỉ IP nội bộ của máy chạy server, ví dụ:

```
http://192.168.1.25:4000
```

(xem IP máy chạy server bằng `ipconfig` trên Windows hoặc `ip addr` trên Linux/Mac).

Tài khoản admin mặc định: **admin / admin123@** — nên đổi mật khẩu ngay sau lần đăng
nhập đầu (đăng nhập admin → mở "Quản lý tài khoản" → tạo admin mới với mật khẩu riêng,
hoặc sửa biến môi trường `ADMIN_PASS` bên dưới rồi khởi động lại lần đầu).

## Dừng / khởi động lại

```bash
docker compose down        # dừng
docker compose up -d       # chạy lại (không build lại)
docker compose logs -f     # xem log realtime
```

## Dữ liệu tài khoản được lưu ở đâu

File `db/accounts.json` trên máy host (được mount vào container qua `docker-compose.yml`),
nên **dừng/khởi động lại container không mất dữ liệu tài khoản**. Chỉ mất nếu xóa hẳn
thư mục `db/` trên máy host.

Nên backup định kỳ file này (copy ra chỗ khác) nếu coi đây là danh sách quan trọng.

## Đổi cấu hình

Sửa trong `docker-compose.yml`, mục `environment`:

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng server lắng nghe | `4000` |
| `SESSION_SECRET` | Chuỗi bí mật ký session — **nên đổi** trước khi dùng thật | `doi-chuoi-nay...` |
| `ADMIN_USER` | Username admin, chỉ áp dụng lần đầu tạo DB | `admin` |
| `ADMIN_PASS` | Mật khẩu admin, chỉ áp dụng lần đầu tạo DB | `admin123@` |
| `COOKIE_SECURE` | Đặt `1` nếu đã chạy sau HTTPS (reverse proxy) | tắt |

`ADMIN_USER`/`ADMIN_PASS` chỉ có tác dụng ở **lần chạy đầu tiên** (khi `db/accounts.json`
chưa tồn tại). Sau đó phải đổi mật khẩu qua giao diện (Quản lý tài khoản) hoặc xóa file
`db/accounts.json` để server tạo lại từ đầu.

Sau khi sửa `docker-compose.yml`:

```bash
docker compose up -d --build
```

## Chạy không dùng Docker (thẳng bằng Node, để test nhanh)

```bash
cd estimate-mapper-server
npm install
node server.js
```

Mặc định chạy ở `http://localhost:4000`.

## Lưu ý triển khai thật (khuyến nghị, không bắt buộc để dùng thử)

- Server hiện chạy HTTP thường. Nếu mở ra ngoài internet (không chỉ trong mạng nội bộ
  công ty), nên đặt sau một reverse proxy có HTTPS (Nginx/Caddy/Traefik) rồi bật
  `COOKIE_SECURE=1`, để tránh lộ mật khẩu/cookie khi truyền qua mạng.
- `SESSION_SECRET` mặc định chỉ để test — đổi thành chuỗi ngẫu nhiên dài trước khi dùng
  thật cho cả team.
- Đây là lưu trữ dạng file JSON đơn giản, phù hợp quy mô đội nhóm nội bộ (vài chục tài
  khoản). Nếu sau này cần audit log, phân quyền chi tiết theo từng thao tác, hoặc số
  lượng tài khoản lớn, nên nâng cấp sang một database thật (PostgreSQL/MySQL) — báo lại
  khi cần, phần API đã được viết tách riêng (`accountsStore.js`) nên nâng cấp không ảnh
  hưởng giao diện.

## Cấu trúc thư mục

```
estimate-mapper-server/
├─ server.js           # Express server, API auth + phân quyền
├─ accountsStore.js     # đọc/ghi db/accounts.json, định nghĩa danh sách module
├─ db/
│  └─ accounts.json     # dữ liệu tài khoản (tự tạo khi chạy lần đầu)
├─ public/
│  └─ index.html        # giao diện Estimate Mapper + trang quản trị
├─ Dockerfile
├─ docker-compose.yml
└─ package.json
```

Thêm chức năng mới (module) sau này: thêm 1 dòng vào mảng `MODULES` trong
`accountsStore.js`, phần giao diện bên `public/index.html` sẽ tự đọc danh sách này qua
API `/api/modules` — không cần sửa gì thêm ở phần đăng nhập/phân quyền.
