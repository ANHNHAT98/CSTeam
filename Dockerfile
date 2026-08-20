FROM node:20-alpine

WORKDIR /app

# Python + openpyxl: dùng để build file "Lợi nhuận Crs" (xuất file .xlsx giữ
# nguyên màu sắc/định dạng gốc — SheetJS ở trình duyệt không ghi lại được style
# khi xuất file mới, nên bước build file cuối cùng chuyển sang đây).
RUN apk add --no-cache python3 py3-pip \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir openpyxl
ENV PATH="/opt/venv/bin:$PATH"

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
