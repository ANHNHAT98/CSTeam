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
- **Dự Án → (từng dự án) → Báo cáo tuần khách hàng / Báo cáo tháng khách hàng**:
  slide tổng hợp tình trạng ticket (SLA First Response/Resolution, tiếp nhận, đã xử lý,
  quá hạn, tồn đọng, theo trạng thái/ưu tiên/thời gian tồn) + slide danh sách ticket
  tồn đọng, xuất PNG / Excel chi tiết / PowerPoint. Bản tuần theo kỳ T2 → CN
  (`/duan/bao-cao-khach-hang`), bản tháng cùng thông số nhưng kỳ là cả tháng, xu hướng
  theo tháng, tồn đọng nhóm theo tháng tiếp nhận (`/duan/bao-cao-thang-khach-hang`;
  logic ở `customerReportMonthly.js`, API `/api/projects/customer-report-monthly`).
  Bước 1 của trang Lợi Nhuận Crs có 3 nguồn timesheet: upload file, lấy từ ERP (báo cáo
  Detail Timesheet) hoặc **SynergyHub** (tab "SynergyHub": danh sách dự án lấy từ
  `synergyhub.api.projects.get_filtered_projects`, giờ công từ
  `synergyhub.api.reports.get_detail_time_log_report`, gọi bằng tài khoản ERP đã cấu hình;
  logic đọc/dò cột ở `synergyhub.js`, API `/api/synergyhub/projects` và `/api/synergyhub/time-logs`).
  Đơn giá nhân công lấy từ **bảng master `rate-master.json`** (Thực tập, Học việc, CTV parttime,
  CTV Fulltime, Fresher, Junior, Middle, Senior, Leader/PM, Deputy/Manager) cho cả 3 nguồn timesheet —
  không đọc sheet Monitor trong file PAKD nữa. Đổi đơn giá chỉ cần sửa file này. Chức danh trong
  timesheet được nhận diện theo tiền tố (vd "Middle Business Analyst" → Middle); chức danh không khớp
  thì hỏi chọn cấp bậc ở Bước 3.
- **Báo Cáo → Báo Cáo CS & AM** (`/bao-cao/cs-am`): lấy ticket các dự án từ ERP thành slide "Issues highlight customer" theo mẫu
  Cust · # · Issues · Status · Plan & Deadline · Comment (Cust gộp ô, # đánh số theo từng Cust). Chọn dự án/trạng thái/ưu tiên, tick
  ticket cần đưa vào và sửa trực tiếp từng ô, rồi **tải file PPT** (bảng gốc của PowerPoint, sửa được) hoặc **copy bảng / copy ảnh / tải PNG**
  để dán vào file chung của Manager (nút **Copy cả slide (sửa được)** = 1 bảng gồm số mục + tiêu đề + dữ liệu; **Copy cả slide (ảnh)** = đúng hình dạng slide mẫu). Cust lấy từ **Customer Name** của ticket; ưu tiên chọn được nhiều mức (hoặc Tất cả); **mỗi dự án có bộ slide riêng** với Số mục + Tiêu đề riêng; **Deadline lấy từ Estimated Deadline, nếu ticket không có/để trống thì tính hạn SLA
  = Opening On + ngưỡng SLA xử lý theo Priority** (server tính, API `/api/bao-cao/cs-am/tickets`); Comment lấy từ bình luận gần nhất
  của ticket (`_comments`).
- **Dự Án → AnVy → Ticket Slide**: dán/nhập ticket, tự tạo slide + xuất
  PNG/PPTX (`/anvy/ticket-slide`).
- **Ticket dự án → Tra cứu ERP**: gọi trực tiếp erp.hqsoft.vn lấy ticket theo
  nhiều project + nhiều trạng thái cùng lúc, xem trước, xuất Excel
  (`/tickets/tra-cuu-erp`).
- **Ticket dự án → SLA Phản hồi đầu**: lấy toàn bộ ticket 4 dự án
  (MerapLion_eSales, ABI_eSales_Support, ANVY_eSale_Support, Sabeco_PG, FES_eSales, ANKO_eSales_Support, HaiHa_eSales_Support, Jotun_VN_eSales) từ
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
- **Khác → Mã hóa Password Window**: mã hóa/giải mã password tương thích
  100% với công cụ Windows `DecryptPassHQsoft.exe` đang dùng nội bộ
  (`/khac/ma-hoa-password-window`). Xử lý ở server, key hệ thống không lộ
  ra trình duyệt.
- **Khác → Mã hóa Password MacOS**: cùng thuật toán, nhưng chạy hoàn toàn
  ở trình duyệt qua Web Crypto API (`/khac/ma-hoa-password-macos`), cho
  phép chọn dùng key mặc định hoặc nhập key tùy ý — phù hợp khi cần đổi
  key khác với key hệ thống chuẩn. **Lưu ý:** khác với bản Window (key giữ
  kín ở server), bản này lộ key mặc định ra JS trình duyệt (xem được qua
  View Source) — chấp nhận được vì có tùy chọn tự nhập key khác.
- **KPI Team → Lợi nhuận tháng**: dashboard tính lợi nhuận dự án nâng cao —
  import timesheet, cấu hình bảng đơn giá theo Designation, map thông tin
  dự án (doanh thu, chi phí khác), tự tính lợi nhuận theo tháng kèm biểu đồ
  + cảnh báo (`/kpiteam/loi-nhuan-thang`). Cấu hình bảng giá/dự án lưu ở
  `localStorage` của trình duyệt (không đồng bộ giữa các máy — mỗi người
  dùng tự cấu hình 1 lần trên máy mình).

- **KPI Team → CS01: SLA Phản Hồi** (`/kpiteam/sla-phan-hoi`) và **CS02: SLA Hoàn Tất**
  (`/kpiteam/sla-hoan-tat`): đánh giá KPI theo **tháng** cho 1 thành viên. Bộ lọc: thành viên
  (lấy từ danh sách người tạo ticket trong `ticket-creators.json`), level (Fresher/Junior/Middle/
  Senior), dự án (mặc định AnVy + Merap), tháng. Actual = ticket đúng SLA ÷ tổng ticket trong
  phạm vi; Progress nội suy theo Min/Target/Max (0% → 50% → 100% → trần 150%); KPI Completion =
  Progress × trọng số. Hai trang dùng chung 1 file `protected/kpiteam-sla-danh-gia.html`, logic
  ở `kpiSla.js`, API `/api/kpi/sla-member`. Ngưỡng và trọng số nằm ở `kpi-sla-config.json` (lấy từ
  sheet 02_Master KPI và 03_Ma trận KPI - Vị trí) — HR đổi số thì sửa file này, không cần sửa code.

- **KPI Team → CS03: Complaint Khách Hàng** (`/kpiteam/complaint`): ghi nhận tay complaint của khách
  (email/call/chat/Zalo) theo tháng cho mọi dự án (chọn dự án tính KPI ở bộ lọc), rồi chấm KPI theo thành viên + level + tháng.
  Điểm trừ: 20% / complaint tiến độ từ Manager; mỗi issue/ticket bị phản hồi lặp lại: 1 lần 5%, 2 lần 10%,
  từ 3 lần 15%. **Actual = 100% − tổng điểm trừ**, rồi qua Min/Target/Max + trọng số của CS03 trong Master KPI
  như CS01/CS02. Logic ở `kpiComplaint.js`, cấu hình trong `kpi-sla-config.json` (mục `complaint`), dữ liệu lưu
  qua `listStore.js` (GitHub nếu đã cấu hình `GITHUB_TOKEN`/`GITHUB_REPO` — mỗi lần lưu là 1 commit — ngược lại
  ghi `data/kpi-complaints.json`, cần mount volume `./data`).

**Cấu hình người tạo ticket / thành viên KPI** (`ticket-creators.json`, hoặc biến môi trường `ERP_PROJECT_CREATORS` cùng định dạng — nếu biến này có giá trị thì file bị bỏ qua):
`creators` = người tạo ticket (cũng là danh sách thành viên ở các trang KPI CS01/CS02/CS03 và nhóm "Thành viên khác" ở ô Người xử lý);
`defaults` = dự án → 1 email hoặc **mảng email** (phần tử đầu là người tạo mặc định ở Tạo Ticket; cả mảng là thành viên được tích sẵn dự án đó ở các trang KPI).

- **KPI Team → CS05: Lỗi Lọt Review** (`/kpiteam/loi-lot-review`): đánh giá số lỗi nghiệp vụ lọt qua review (KPI **Thấp tốt**,
  ngưỡng/trọng số CS05 trong Master KPI) theo thành viên + level + dự án + tháng. Tool tự dò từ ticket ERP: (1) ticket chuyển
  **Closed → mở lại** (đọc log `Version` của ERP; cần quyền đọc Version, nếu không có thì chỉ dò được ticket đang Re-open),
  (2) ticket **mới liên quan/lặp lại ticket cũ**: qua trường liên kết tới Ticket (tự dò từ cấu trúc DocType Ticket), nội dung nhắc mã
  ticket cũ (độ tin cậy cao — tự tính), hoặc tiêu đề giống ticket cũ (độ tin cậy thấp — QA bấm Tính mới được tính). Mỗi ticket mới chỉ tính 1 lỗi dù nhắc nhiều ticket cũ; lỗi tính cho người
  xử lý của (các) ticket cũ — lấy từ `_assign`, hoặc lịch sử giao việc (ToDo) vì ERP thường xoá `_assign` khi ticket đóng. Xác nhận của QA lưu qua `listStore.js` (`data/kpi-defect-decisions.json`). Logic ở `kpiDefect.js`, cấu hình trong
  `kpi-sla-config.json` (mục `defect`: lookbackMonths, closedStatuses, ngưỡng tương đồng tiêu đề).

- **KPI Team → CS07: CR Phân Tích Đúng Hạn** (`/kpiteam/cr-phan-tich`): ghi nhận tay các CR được giao phân tích (mã/tên CR, dự án — mặc định
  ANVY, thành viên, ngày giao, hạn phân tích, ngày xong, số lần bị trả lại + lý do) rồi chấm KPI **Cao tốt** theo thành viên + level + tháng.
  Actual = CR xong đúng hạn và không bị trả lại ÷ CR có kết quả; tháng của CR = tháng của hạn phân tích; CR chưa xong mà quá hạn tính là không đạt,
  chưa tới hạn thì "Đang xử lý" (chưa tính). Chỉ Junior/Middle/Senior có KPI này (ngưỡng/trọng số CS07 trong Master KPI). Logic ở `kpiCr.js`,
  cấu hình ở `kpi-sla-config.json` (mục `cr`), dữ liệu lưu qua `listStore.js` (`data/kpi-cr.json`).

- **KPI Team → CS21: AI Workflow Cá Nhân** (`/kpiteam/ai-workflow`): chấm KPI **Cao tốt** "AI adoption cá nhân" theo thành viên + level + tháng,
  Actual = điểm AI workflow ÷ 100, từ bằng chứng nhập tay: (1) 40 điểm — AI soạn email/ticket: nộp **prompt/flow** (tool tự quét dữ liệu nhạy cảm để gợi ý, người chấm tick **checklist rubric** `ai.rubric`,
  tiêu chí bảo mật là bắt buộc) và/hoặc số phút có AI vs thông thường (giảm ≥ 30% là đủ điểm); có cả hai nguồn thì lấy trung bình hệ số; (2) 40 điểm — báo cáo tuần/tháng/ERP đúng hạn có dùng AI (tỷ lệ × 40); (3) 20 điểm — 0 vi phạm AI Data Security (có vi phạm = 0).
  L&D (TDC) có thể nhập điểm điều chỉnh cho từng tiêu chí (để trống = dùng điểm tự tính). Logic ở `kpiAi.js`, cấu hình ở `kpi-sla-config.json`
  (mục `ai`: ngưỡng/trọng số CS21 + điểm các tiêu chí), dữ liệu lưu qua `listStore.js` (`data/kpi-ai.json`).

- **KPI Team → CS23: Chứng Nhận Sản Phẩm** (`/kpiteam/chung-nhan-san-pham`): **quản lý** lập lộ trình theo tháng cho từng nhân viên (nút "＋ Tạo lộ trình KPI theo tháng": các module + trọng số %,
  tổng mỗi nhân viên = 100%, có thể áp dụng cho nhiều nhân viên cùng lúc); nút "👁 Xem lộ trình đã thiết lập" lọc lộ trình đã lập theo tháng / nhân viên. **Nhân viên** gửi bằng chứng / link và tự đánh giá
  % hoàn thành (0–100%) từng module rồi Lưu (1 commit). Actual = Σ (trọng số × % hoàn thành); KPI Cao tốt, Target = Max, chỉ Fresher/Junior. Bảng tổng hợp ở phần kết quả có từng module + bằng chứng.
  Logic ở `kpiCert.js`, cấu hình `kpi-sla-config.json` (mục `cert`), dữ liệu `data/kpi-cert.json`.

- **KPI Team → CS25: Quản Lý Plan CR** (`/kpiteam/quan-ly-cr`) — 2 tab, KPI Cao tốt (Junior/Middle có trọng số), chấm theo tháng, cả hai có nút **Copy tổng hợp** để dán vào KPI trên ERP:
  **Cách 1 (giống CS23)**: quản lý lập lộ trình tháng cho từng nhân viên (nút "＋ Tạo lộ trình KPI theo tháng": các mục plan CR gồm tên, **trọng số % tổng 100%** và **hạn cam kết với khách**; có nút điền mẫu 3 mốc
  40/45/15; nút "👁 Xem lộ trình đã thiết lập" lọc theo tháng / nhân viên). Nhân viên nhập **ngày thực tế**, tick "PM review có lỗi" và dán bằng chứng rồi Lưu (1 commit). Mục đạt = ngày thực tế ≤ hạn và không lỗi;
  Actual = Σ (trọng số × mục đạt) ÷ Σ trọng số các mục đã có kết quả. Logic `kpiCrPlan.js`, dữ liệu `data/kpi-crplan-roadmap.json`.
  **Cách 2 (tự động)**: chọn dự án SynergyHub trong danh sách (lấy từ `get_filtered_projects`), tool lấy task được giao cho thành viên qua hàm
  `synergyhub.api.dynamic_permissions.get_filtered_tasks_with_context` (đúng bộ tham số trang Tasks, phân trang `limit_start`/`limit_page_length`; ghi đè bằng biến `SYNERGYHUB_TASKS_METHOD`),
  Actual = task hoàn thành đúng hạn ÷ task được giao có hạn dự kiến trong tháng (API `/api/kpi/crplan-auto`, chẩn đoán `/api/synergyhub/tasks`).

## Mã hóa Password Window — chi tiết kỹ thuật

Thuật toán và key hệ thống được **reverse-engineer trực tiếp từ file gốc**
(`HQ.eSkyFramework.dll` + `DecryptPassHQsoft.exe`) bằng cách decompile IL rồi
chạy thử chính DLL đó qua Mono để đối chiếu kết quả — không đoán mò.

- AES-256-CBC, PKCS7 padding
- Key (32 byte) + IV (16 byte) suy ra từ key hệ thống qua PBKDF2
  (`Rfc2898DeriveBytes` mặc định .NET Framework = HMAC-SHA1, 1000 vòng lặp),
  salt = chính key hệ thống
- Input UTF8 → mã hóa → Base64 (encrypt); Base64 → giải mã → UTF8 (decrypt)
- Key hệ thống lấy đúng từ code gốc (`Form1.GetPassword()` trong file EXE),
  không phải do người dùng tự đặt — nằm trong `hqPasswordCrypto.js`, chỉ ở
  phía server, không xuất hiện trong bất kỳ file JS nào gửi ra trình duyệt.
- Đã kiểm tra khớp byte-for-byte với DLL gốc (chạy qua Mono) cho nhiều test
  case trước khi đưa vào code — cùng input + cùng key luôn ra đúng cùng
  chuỗi mã hóa như file EXE gốc.

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

## First Response Time (SLA) trên Dashboard

Trang chủ (`/`) đã tính sẵn **First Response Time (SLA)** thật, dùng đúng
công thức ở mục trên, tự đoán field ERP theo tên (Priority/Opening
On/First Responded On/người phụ trách — không có bước xác nhận tay như
trang SLA Phản hồi đầu, vì Dashboard cần hiện ngay không cần thao tác gì).

Có 3 bảng, cùng chung 1 logic tính (tách hàm dùng lại, đảm bảo luôn khớp
số liệu giữa 3 bảng):
- **So sánh 3 tháng gần nhất** — gộp theo tháng (không theo dự án/người phụ
  trách, để bảng gọn), lọc theo `Opening On` trong vòng 3 tháng gần nhất
  (tháng hiện tại + 2 tháng trước) — thay cho "toàn bộ thời gian" vì dữ
  liệu all-time sẽ quá nhiều, không còn ý nghĩa so sánh
- **Tháng hiện tại** — lọc theo `Opening On` rơi vào tháng hiện tại, gộp
  theo dự án + người phụ trách
- **Xu hướng theo tuần (tháng hiện tại)** — mỗi tuần tính từ Thứ 2 → Chủ
  Nhật, chỉ tính ticket có `Opening On` trong tháng hiện tại

Nếu field ERP không tự đoán được (báo "Không tự nhận diện được đủ field"),
qua **Ticket dự án → SLA Phản hồi đầu** để xác nhận tay field đúng, việc đó
không tự động đồng bộ ngược về Dashboard — báo lại tên field chính xác để
sửa cứng vào code cho Dashboard luôn đoán đúng.

## Bật CSAT trên Dashboard

Trang chủ (`/`) còn 1 ô KPI cho CSAT đang hiện "chưa cấu hình" — vì cần
đúng tên field ERPNext lưu điểm hài lòng khách hàng. Cách xác nhận tên
field: vào **Ticket dự án → Tra cứu ERP**, bấm "Lấy dữ liệu từ ERP", xem
tên cột trong bảng kết quả thô (đó là tên field thật) — báo lại tên field
để hoàn thiện chỉ số này.

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
`ABI_eSales_Support`, `ANVY_eSale_Support`, `Sabeco_PG`, `FES_eSales`,
`ANKO_eSales_Support`, `HaiHa_eSales_Support`, `Jotun_VN_eSales`) và **chọn nhiều
trạng thái** (`Open`, `Assign`, `Working`, `Reviewing`, `Waiting`, `Pending`,
`Re-open`, `Closed`, và cả "chưa có trạng thái") cùng lúc.

Cấu hình trong `docker-compose.yml` (hoặc Environment Variables trên Render):

| Biến | Ý nghĩa |
|---|---|
| `ERP_BASE_URL` | Địa chỉ gốc ERP, mặc định `https://erp.hqsoft.vn` |
| `ERP_USER` | Email đăng nhập ERP (tài khoản cá nhân hoặc service account) |
| `ERP_PASS` | Mật khẩu tương ứng |
| `ERP_API_KEY`, `ERP_API_SECRET` | **Khuyên dùng.** Xác thực bằng API key/secret thay cho mật khẩu: tool không tạo phiên đăng nhập nên không làm ai bị đăng xuất ERP (xem mục bên dưới). Có cặp này thì `ERP_PASS` không cần |
| `ERP_CACHE_HOURS` | Số giờ lưu đệm cấu trúc form Ticket và Customer của Project (mặc định 12, `0` = tắt). Nhờ đệm, chỉ mở trang Tạo Ticket không gọi ERP. Lưu ở `data/erp-cache.json` |

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


## Tạo Ticket trên ERP (`/tickets/tao-moi`)

- Form dựng tự động từ cấu trúc DocType `Ticket` trên ERP (`GET /api/erp/ticket-meta`), nên không cần hard-code tên trường.
- `POST /api/erp/tickets` nhận `{ fields, dry_run }`: `dry_run: true` chỉ kiểm tra và trả payload, không ghi vào ERP.
- Chỉ nhận trường có trong DocType Ticket, bỏ qua trường chỉ-đọc/hệ thống; kiểm tra trường bắt buộc; chặn tạo trùng (cùng Project + Subject trong 2 phút).
- Cần tài khoản ERP có quyền **Create** trên DocType Ticket. Mặc định ticket ghi người tạo là `ERP_USER`.

### Ghi nhận người tạo thay mặt (không cần mật khẩu)

Chọn email người tạo trên trang Tạo Ticket (danh sách trong `ticket-creators.json`).
Ticket vẫn gửi bằng tài khoản `ERP_USER` cấu hình trên Render, nhưng người tạo (owner) trên ERP là email đã chọn. Thứ tự thử (`ERP_ONBEHALF_MODE=auto`):

1. **impersonate** — dùng chức năng Impersonate của Frappe (cần ERP bản hỗ trợ và `ERP_USER` là System Manager). ERP tự ghi owner và lưu vết "impersonated by".
2. **set-owner** — tạo bằng `ERP_USER` rồi cập nhật trường `owner` sang email đó, đọc lại để xác nhận. Nếu ERP không cho đổi, ticket vẫn được tạo và trang hiện cảnh báo.

Đặt `ERP_ONBEHALF_MODE=impersonate` hoặc `set-owner` để ép một cách. Email phải là user đang hoạt động trên ERP.

### Tự điền trường cố định khi tạo ticket

File md/AI chỉ điền phần phụ thuộc nội dung (subject, mô tả, request_type, priority, products). Tool tự điền các trường còn trống, **không ghi đè** giá trị đã có:

1. **Customer** — lấy theo Project (theo `fetch_from` của ERP, hoặc trường `customer` của Project).
2. **Mặc định cấu hình** — biến `ERP_TICKET_DEFAULTS` (JSON), áp theo dự án, `"*"` áp cho mọi dự án:
   `{"*":{"contact_role":"HO"},"ABI_eSales_Support":{"contact_role":"IT","customer":"TÊN KHÁCH HÀNG"}}`
   Khoá hỗ trợ: `customer, products (mảng), contact_role, contact, contact_temp, raised_by, region, internal_request_type, request_type, priority, status` hoặc nhãn/tên trường ERP.
3. **Estimated Deadline** — theo Priority: Critical +0, Urgent +1, High +2, Medium +3, Low +5 ngày làm việc (bỏ T7/CN và ngày lễ), 17:30. Tắt bằng `ERP_AUTO_DEADLINE=0`.

Danh sách ngày lễ nằm ở `ticketDefaults.js` (và `HOLIDAYS` trong các trang SLA) — cập nhật cả hai khi có lịch nghỉ mới.
   Khoá hỗ trợ: `customer, contact_role, contact, contact_temp, raised_by, region, internal_request_type, request_type, priority, status` hoặc nhãn/tên trường ERP.

### Tạo ticket theo từng dự án

Menu **Dự Án > (Merap, ABI, AnVy, Sabeco, FES, ANKO, HAIHA, JOTUN) > Tạo Ticket** mở `/tickets/tao-moi?project=<mã dự án>`:

| Menu | Project (mã như dashboard) |
|---|---|
| Merap | `MerapLion_eSales` |
| ABI | `ABI_eSales_Support` |
| AnVy | `ANVY_eSale_Support` |
| Sabeco | `Sabeco_PG` / `Sabeco_B2B_Support` |
| FES | `FES_eSales` |
| ANKO | `ANKO_eSales_Support` |
| HAIHA | `HaiHa_eSales_Support` |
| JOTUN | `Jotun_VN_eSales` |

- Project bị **khoá** theo trang, không đổi được; JSON ghi project khác vẫn dùng project của trang (có cảnh báo). Customer tự lấy theo Project, hoặc đặt cố định trong `ERP_TICKET_DEFAULTS`, ví dụ `{"MerapLion_eSales":{"customer":"CÔNG TY CỔ PHẦN TẬP ĐOÀN MERAP"}}`.
- **Vai trò người liên hệ:** mục 9 của md chỉ ghi vai trò, Khối 2 điền vào `contact_role` (không có thì tool dùng mặc định trong `ERP_TICKET_DEFAULTS`). `contact` do người dùng chọn trên tool: nếu có email ở `Raised By (Email)` và ERP có đúng 1 Contact trùng thì tự chọn, ngoài ra tool hiện nút gợi ý theo email/tên bên dưới ô Contact.

> Lưới an toàn khi AI để trống: đặt mặc định theo dự án cho `request_type`, `products`, `contact_role`, ví dụ
> `{"ABI_eSales_Support":{"request_type":"Lỗi báo cáo, chức năng","products":["eSales Backoffice"],"contact_role":"HO"}}`.
> Tool chỉ dùng khi trường đang trống; giá trị AI hoặc người dùng đã chọn luôn được giữ.

### File hướng dẫn AI cho từng dự án (`ticket-instructions/`)

Mỗi dự án có một file `Project-Instructions-<DỰ ÁN>.md` (MERAP, ABI, ANVY, SABECO-PG, SABECO-B2B, FES, ANKO, HAIHA, JOTUN). Trên trang **Dự Án > (dự án) > Tạo Ticket** có nút **Tải file hướng dẫn AI (.md)** và **Sao chép nội dung** để nhân viên dán vào *Project instructions* / Skill của AI (Claude, ChatGPT...) gen ticket tự động; AI trả Khối 1 (nội dung ticket) + Khối 2 (JSON) để dán vào ô **Nhập từ AI (JSON)**.

- `ticket-instructions/_template.md`: mẫu chung (template ticket, quy tắc JSON, master Request Type / Contact Role / Products).
- `ticket-instructions/projects.json`: cấu hình từng dự án (mã project, tiền tố, môi trường UAT, từ khoá module riêng).
- Sửa master/quy tắc chung → sửa `_template.md`; sửa UAT/từ khoá của dự án → sửa `projects.json`; rồi chạy `node scripts/gen-ticket-instructions.js` (ghi đè các file `.md`).
- Thêm dự án mới: thêm một dòng vào `projects.json` và vào danh sách dự án/menu, chạy lại script.
- API: `GET /api/ticket-instructions` (danh sách), `GET /api/ticket-instructions/:mãProject` (tải file); yêu cầu đăng nhập.

### Người tạo ticket (`ticket-creators.json`)

Ticket luôn gửi bằng tài khoản ERP đã cấu hình trên Render (`ERP_USER`). **Người tạo (create by) ghi vào ticket là email chọn trên trang** — chỉ chọn trong danh sách email cấu hình, không còn cách nhập tài khoản ERP khác hay danh sách `ERP_USERS`.

```
{
  "serviceAccount": "nhatha@hqsoft.com.vn",
  "creators": ["phuctm@hqsoft.com.vn", "viltt@hqsoft.com.vn", "nhuttm@hqsoft.com.vn", "thaontt@hqsoft.com.vn", "nhatha@hqsoft.com.vn"],
  "defaults": { "MerapLion_eSales": "phuctm@hqsoft.com.vn", "ABI_eSales_Support": "viltt@hqsoft.com.vn", "Sabeco_PG": "nhuttm@hqsoft.com.vn", "FES_eSales": "thaontt@hqsoft.com.vn" }
}
```

- `creators`: danh sách hiện ở **mọi** dự án để chọn; `defaults`: email mặc định của từng dự án; thêm email mới = thêm vào `creators`.
- `serviceAccount`: tài khoản đăng nhập Render. Chọn email này thì tạo trực tiếp (không thay mặt). `ERP_USER` trên Render nên trùng email này (server cảnh báo trong log nếu khác).
- Chọn email khác `serviceAccount` thì dùng cơ chế "thay mặt" (mục **Ghi nhận người tạo thay mặt** ở trên); email phải là user đang hoạt động trên ERP.
- Server chặn mọi email ngoài danh sách. Có thể đặt biến `ERP_PROJECT_CREATORS` (cùng định dạng JSON) để ghi đè file.

### Customer ẩn, tiêu đề ngắn, master lấy từ ERP

- **Customer** không còn trong JSON/md và bị ẩn trên trang Tạo Ticket của từng dự án: API tự điền theo Project (theo `fetch_from` của ERP, trường `customer` của Project, hoặc `ERP_TICKET_DEFAULTS`). Khoá `customer` trong JSON (nếu AI vẫn trả) bị bỏ qua. Nếu không lấy được Customer, trang tự hiện ô Customer để chọn tay.
- **Tiêu đề (subject)** theo mẫu `[DỰ ÁN] [Mức N] <Module/màn hình> - <mô tả ngắn>`, tối đa 50 ký tự (gồm cả tiền tố), không chứa mã KH, số đơn, nguyên văn thông báo lỗi (xem mục A2b trong file md).
- **Master trong file md** (Request Type, Internal Request Type, Region, Contact Role, Products): khi tải file từ trang, server thay khối `MASTER` bằng danh sách lấy trực tiếp từ ERP (cache 10 phút, header `X-Masters: live`); ERP không kết nối được thì dùng danh sách có sẵn trong file (`X-Masters: static`).

### Status ẩn và giao ticket (Assign)

- **Status** mặc định Open: ẩn trên trang Tạo Ticket, bỏ khỏi JSON/md (khoá `status` nếu AI trả vẫn bị bỏ qua). ERP tự đặt Open.
- **Người xử lý (Assign):** ô chọn trên trang Tạo Ticket, danh sách `assignees` trong `ticket-creators.json` (mặc định theo dự án: `assignDefaults`, không đặt = "Chưa giao"). Sau khi tạo, server giao ticket qua `frappe.desk.form.assign_to.add` (bằng tài khoản `ERP_USER`) rồi đặt Status = `Assign` nếu Status của Ticket có giá trị đó. Đổi hoặc tắt việc đặt Status: biến `ERP_ASSIGN_STATUS` (rỗng = không đổi Status).
- Giao lỗi (thiếu quyền, user không hợp lệ...) thì ticket vẫn được tạo, trang hiện cảnh báo "chưa giao được". Tạo hàng loạt dùng chung một người xử lý đã chọn cho cả lô.
- Ví dụ cấu hình: `"assignees": ["a@hqsoft.com.vn","b@hqsoft.com.vn"], "assignDefaults": {"ABI_eSales_Support": "b@hqsoft.com.vn"}`.

### Ảnh / file đính kèm vào ticket

Trang Tạo Ticket cho **dán ảnh (Ctrl+V)**, kéo thả hoặc chọn file (ảnh, PDF, văn bản, Office, zip; tối đa 8 file, mỗi file 8 MB). Sau khi tạo ticket thành công, server tải file lên ERP bằng `POST /api/method/upload_file` (file riêng tư, gắn vào đúng ticket, hiện ở mục Attachments).

- Tạo **1 ticket từ form**: ảnh tự đính kèm. Tạo **nhiều ticket từ JSON**: bảng có cột **Ảnh** — tick "gửi kèm" ở những ticket cần đính kèm (mặc định không tick, để tránh gắn nhầm ảnh).
- `POST /api/erp/attachments` chỉ nhận mã ticket do tool vừa tạo trong 2 giờ gần nhất, chặn loại file lạ và file quá lớn.
- Lỗi tải file không làm hỏng ticket: ticket vẫn được tạo, trang liệt kê file chưa tải được để đính kèm tay.
- Tài khoản `ERP_USER` trên Render cần quyền đính kèm file vào Ticket. File do tài khoản này tải lên.
- Quy trình dùng AI ngoài: gửi nội dung + ảnh cho AI (Project/Skill theo file md) → AI đọc ảnh để viết **Khối 1** (dán vào ERP) hoặc **Khối 2** (JSON dán vào tool). AI không trả lại được ảnh, nên ảnh gốc được dán/tải vào tool (Khối 2) hoặc đính kèm tay trong ERP (Khối 1). Mục F trong file md hướng dẫn AI trích tên màn hình, thông báo lỗi, dữ liệu hiển thị từ ảnh và mô tả từng ảnh ("Ảnh 1: …") ở mục 7.


### Ảnh trong nội dung ticket, Status mặc định Open

- **Chèn ảnh vào nội dung ticket:** khung "Ảnh / file đính kèm" có ô **Chèn ảnh vào nội dung (mô tả) ticket** (mặc định bật). Ảnh được tải lên ERP rồi chèn vào mô tả ngay sau mục "Ảnh chụp màn hình / File đính kèm" (không có mục này thì thêm cuối mô tả); tắt ô này thì chỉ đính kèm ở mục Attachments. Tạo nhiều ticket: chỉ ticket được tick cột "Ảnh" nhận ảnh.
- **Status** luôn là Open: ô Status ẩn, được đặt Open khi dựng/nạp form và server cũng tự đặt Open nếu thiếu. **Customer Name** ẩn ở mọi trang.
- Dòng "Trang Tạo Ticket · bản …" ở đầu trang giúp nhận biết đang chạy bản nào (trang không có dòng này, không có khung ảnh = đang chạy bản cũ, cần deploy lại).
- Trong file md: Khối 1 có dòng "[Dán ảnh N tại đây]" dưới mỗi ảnh; JSON thì không có dòng này.

### Người xử lý (Assign) và Status

- Ô **Người xử lý (Assign)** nằm dưới các trường của form (cùng khối New Ticket), vẫn giữ nguyên sau khi dán JSON. **Mặc định giao cho người tạo ticket** (đổi người tạo thì người mặc định đi theo); bấm "+ Thêm người xử lý khác…" để thêm email trong danh sách (`assignees` + `creators` trong `ticket-creators.json`), bấm × để bỏ.
- **Status:** chỉ khi có người xử lý **khác người tạo** thì ticket chuyển sang `Assign` (đổi/tắt bằng `ERP_ASSIGN_STATUS`); chỉ giao cho người tạo hoặc không giao thì giữ `Open`.
- API `POST /api/erp/tickets` nhận `assign_to` là mảng email; mỗi email phải nằm trong danh sách cho phép và là user đang hoạt động trên ERP (tối đa 10). Mục `assignDefaults` cũ trong `ticket-creators.json` không còn dùng.

### Nhóm người xử lý và khi nào chuyển Assign (cập nhật)

`ticket-creators.json` có hai nhóm email:
- `creators`: người tạo ticket (chọn ở "Người tạo ticket"). Cũng có thể chọn thêm làm đồng xử lý, nhưng **không** làm đổi Status.
- `assignees`: **nhóm người xử lý** — hiện: `trungnh1@hqsoft.com.vn`, `tungns@hqsoft.com.vn`, `thanhlt@hqsoft.com.vn`, `tinhcd@hqsoft.com.vn`, `namtn@hqsoft.com.vn` (địa chỉ `tung161020146@gmail.com` cũ được thay bằng `tungns@hqsoft.com.vn`). Chỉ khi chọn thêm một người trong nhóm này (khác người tạo) thì ticket chuyển `Assign`; còn lại ticket giữ `Open`.

Ô chọn thêm chia hai nhóm: "Người xử lý (chuyển Assign)" và "Thành viên khác (giữ Open)". Muốn một người nào đó cũng làm chuyển Assign, thêm email vào `assignees`. Email phải là user đang hoạt động trên ERP (đúng email đăng ký trên ERP).

### Kiểm tra đang chạy đúng bản (tránh deploy thiếu file)

Đầu trang Tạo Ticket có dòng **"Trang Tạo Ticket · bản <mã> · server cùng bản ✓"**. Nếu trang báo "⚠ Trang bản X nhưng server bản Y", hoặc "Server chưa có /api/build", hoặc không có dòng này, tức là chưa deploy đủ file của gói mới (cần cập nhật **toàn bộ** thư mục, không chỉ vài file) rồi tải lại trang bằng Ctrl+F5. Log server khi khởi động có dòng `[build] Ops Console <mã>`. Trang Tạo Ticket được gửi với `Cache-Control: no-store`.

### First Responded On (KPI phản hồi lần đầu)

- Form Tạo Ticket có trường **First Responded On** (ngay cạnh Estimated Deadline) kèm nút **Bây giờ** (điền giờ hiện tại theo múi giờ Việt Nam). Trang SLA First Response tính Pass/Fail theo `first_responded_on` − `Opening On`, nên ticket đã được phản hồi ngay lúc tạo cần ghi trường này, nếu để trống thì KPI tính là chưa phản hồi.
- JSON nhận khoá `first_responded_on` (`YYYY-MM-DD HH:mm:ss`). File md để `""` mặc định, chỉ ghi khi nội dung nêu rõ giờ team đã phản hồi khách. Tool không tự điền trường này.

### Bị đăng xuất khỏi ERP khi dùng tool — nguyên nhân và cách xử lý

**Nguyên nhân:** nếu ERP bật *System Settings > Deny Multiple Sessions* (mỗi người chỉ một phiên), mỗi lần server tool **đăng nhập** ERP bằng `ERP_USER` sẽ huỷ phiên ERP đang mở trên trình duyệt của chính tài khoản đó. Nguồn thứ hai: chế độ ghi người tạo thay mặt bằng *impersonate* tạo phiên mới cho người được chọn, nên người đó cũng bị đăng xuất.

**Cách xử lý (làm lần lượt):**
1. **Dùng API key/secret** (khuyên dùng): vào ERP > User của tài khoản dùng cho tool > mục *API Access* > *Generate Keys* (cần quyền System Manager), rồi đặt `ERP_API_KEY` và `ERP_API_SECRET` trên Render. Tool gửi `Authorization: token key:secret`, không đăng nhập, không tạo phiên. Log khởi động có dòng `[erp] Xác thực ERP bằng API key/secret`.
2. Nếu người được chọn làm **người tạo** vẫn bị đăng xuất khi tạo ticket, đặt `ERP_ONBEHALF_MODE=set-owner` (tạo ticket rồi đổi owner, không tạo phiên cho người đó). Sau khi đổi, tạo thử một ticket và xem cột người tạo trên ERP; nếu ERP không cho đổi owner, trang hiện cảnh báo.
3. Hoặc tắt *Deny Multiple Sessions* trong ERP; hoặc dùng một tài khoản dành riêng cho tool (không ai dùng trên trình duyệt) làm `ERP_USER`.
4. Nếu chưa làm được: log server có dòng `[erp] Đăng nhập ERP bằng ... (tạo phiên mới)` cho biết đúng thời điểm tool đăng nhập (khi khởi động lại hoặc phiên hết hạn).

#### Khi chưa có quyền tạo API key (chỉ đăng nhập ERP bằng tài khoản thường)

- **Chỉ mở trang Tạo Ticket không còn đăng nhập ERP** (bộ nhớ đệm `ERP_CACHE_HOURS`, mặc định 12 giờ; lần đầu sau khi deploy vẫn cần hỏi ERP một lần). Cấu trúc form đổi thì bấm "↻ Làm mới cấu trúc form từ ERP" ở đầu trang (bước này gọi ERP).
- Tool vẫn phải đăng nhập khi **tạo ticket, đính kèm, giao việc, tìm gợi ý** và khi tải dashboard; lúc đó nếu ERP chỉ cho 1 phiên/người dùng, phiên ERP của chính tài khoản đó trên trình duyệt sẽ bị đăng xuất. Cách dứt điểm duy nhất cần quản trị ERP (System Manager): tạo API key/secret cho tài khoản tool (hoặc một tài khoản riêng cho tool), hoặc tắt *Deny Multiple Sessions*.

### Ô ngày giờ trên form (Estimated Deadline, First Responded On)

Các trường ngày giờ không dùng ô `datetime-local` của trình duyệt nữa (hay hiện giờ 12 giờ SA/CH, khó chọn) mà tách thành:
- **Ô ngày** (`dd/mm/yyyy`, bấm biểu tượng lịch để chọn);
- **Ô giờ 24 giờ** (`HH:mm`, có gợi ý 07:00–19:00 mỗi 30 phút). Gõ nhanh được: `1730` → `17:30`, `9h05` → `09:05`, `17.45` → `17:45`; có thể thêm giây (`07:15:30`);
- nút **×** xoá cả ngày và giờ.

Chọn ngày xong thì giờ tự điền (Estimated Deadline: `17:30`; First Responded On: giờ hiện tại theo múi giờ Việt Nam). Giờ nhập sai (ví dụ `25:00`, `9h5`) báo đỏ và chặn Kiểm tra/Tạo ticket cho đến khi sửa. Giá trị gửi sang ERP luôn dạng `YYYY-MM-DD HH:mm:ss`. Nạp JSON hoặc tự điền deadline từ server cũng hiện đúng ngày và giờ trong hai ô này.

### Dashboard Support Tuần theo dự án (`/duan/support-tuan`)

Menu **Dự Án > Merap > Dashboard Support Tuần** mở `/duan/support-tuan?project=MerapLion_eSales`. Hiện mới gắn menu cho Merap; dự án khác dùng cùng trang, chỉ cần thêm liên kết `/duan/support-tuan?project=<mã project ERP>` vào menu của dự án đó (mã dự án như bảng ở mục "Tạo ticket theo từng dự án").

**Dữ liệu:** `GET /api/projects/weekly?project=<mã>&week=<YYYY-MM-DD bất kỳ trong tuần>&weeks=8` lấy ticket của dự án từ ERP bằng 3 truy vấn (mở trong cửa sổ xu hướng · có cập nhật trong cửa sổ · toàn bộ ticket còn tồn đọng), rồi tính bằng `weeklyReport.js`. Kết quả được lưu đệm 3 phút; nút "Tải lại từ ERP" bỏ qua đệm. Tuần = Thứ 2 → Chủ nhật (giờ Việt Nam).

**Chỉ số trên trang**
- Ticket mới (theo `opening_date`), xử lý xong (theo `resolution_date`, hoặc `modified` nếu ticket đã Closed mà thiếu ngày), tồn đọng cuối tuần (mở tới cuối tuần và chưa xong tới thời điểm đó; tuần hiện tại dùng trạng thái hiện tại), kèm chênh lệch so với tuần trước.
- Tỷ lệ đóng = ticket mở trong tuần đã Closed / ticket mở trong tuần.
- SLA phản hồi (`first_responded_on` − `opening_date`) và SLA xử lý (`resolution_date` − `opening_date`) của ticket mở trong tuần: cùng ngưỡng, quy tắc giờ làm việc/24h và trọng số 70/30 với Dashboard Tổng Quan. **Khác một điểm:** ticket chưa có mốc phản hồi/xử lý mà còn trong ngưỡng được xếp "đang chờ" (chưa tính tỷ lệ); Dashboard Tổng Quan hiện tính các ticket này là trượt.
- Biểu đồ: xu hướng 8 tuần (mới / xong / tồn), theo ngày trong tuần, trạng thái, mức ưu tiên, Request Type.
- Bảng: tồn đọng cần chú ý (ưu tiên cao trước rồi lâu nhất trước), tải theo người xử lý (từ `_assign`), ticket mới và ticket xong trong tuần, ticket trượt SLA. Mã ticket liên kết sang ERP.
- Chưa có: thống kê theo Product (trường này nằm trong bảng con, API danh sách ticket không trả về) và số giờ hỗ trợ (timesheet).

### Môi trường SQL Build (`/hotfix/moi-truong`)
**Mở theo dự án:** trong menu **Dự Án → (tên dự án) → Môi trường dự án** (link `/hotfix/moi-truong?project=<mã dự án>`; Sabeco có 2 mục PG và B2B) — trang chỉ hiện môi trường của dự án đó, thêm môi trường mới tự gán đúng dự án. Mục **Hotfix → Môi trường – tất cả dự án** (`/hotfix/moi-truong`) là trang tổng hợp để xem/xuất Excel nhiều dự án.

Lưu thông tin môi trường của từng server dự án (Database, BackOffice, SFA, API, Hangfire…) theo dạng bảng **Items / Info**. Cấu trúc **dự án → nhiều môi trường**: chọn dự án ở danh sách bên trái (hiện số môi trường của từng dự án), mỗi môi trường là 1 tab (UAT, PRODUCTION, DEV…) gồm các dòng "nhóm" và "mục"; có nút **Excel cả dự án** (mỗi môi trường 1 sheet).
- Mỗi dòng gồm **Tiêu đề / Nội dung / Link hoặc thông tin đính kèm** (link tự bấm mở được, có thể nhiều dòng; ghi tên file/nơi lưu nếu là tài liệu đính kèm). Mẫu không có TK/MK vì mỗi người dùng user riêng; dùng **＋ Thêm link API** để thêm API/link riêng của từng dự án (không giới hạn số dòng).
- **Thêm / sửa / xoá / nhân bản**; soạn thảo có nút lên-xuống, thêm nhóm/mục, **Nạp mẫu** (cấu trúc như file Excel đang dùng) và **Dán từ Excel** (dán 2 cột Items/Info, tự nhận nhóm và đánh dấu mật khẩu theo tên cột).
- **Copy bảng** (dán Excel/Word), **Copy văn bản** (dán Zalo/chat), copy từng giá trị; **Xuất Excel** cho 1 môi trường hoặc tất cả môi trường theo bộ lọc (mỗi môi trường 1 sheet + sheet Tổng hợp). Ô "Ẩn mật khẩu khi copy / xuất Excel" áp dụng cho cả copy và xuất.
- Dòng đánh dấu 🔒 được **mã hoá khi lưu** (`hqPasswordCrypto`, tiền tố `enc:`) — file `data/sql-environments.json` (hoặc commit trên GitHub) không chứa mật khẩu dạng chữ thường; giao diện ẩn mật khẩu mặc định, bấm 👁 để xem. Khoá mã hoá nằm trong mã nguồn nên đây là lớp che chắn, không thay thế việc giữ repo ở chế độ private.
- API: `GET/POST /api/sql-env`, `PUT/DELETE /api/sql-env/:id`. Lưu qua `listStore.js` (GitHub nếu đã cấu hình, ngược lại `./data/sql-environments.json`). Mã: `sqlEnv.js`, `protected/hotfix-moi-truong.html`.
