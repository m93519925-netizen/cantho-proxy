# Cần Thơ Tuyển Sinh 10 — Proxy Server

Chạy trên Termux (Android), expose qua zrok cho Google Colab crawl.

## Cài đặt

```bash
pkg install nodejs git
git clone https://github.com/TEN_BAN/cantho-proxy
cd cantho-proxy
npm install
```

## Chạy

```bash
# Terminal 1
node server.js

# Terminal 2
zrok share public http://localhost:3000
```

## Endpoints

| Endpoint | Method | Mô tả |
|---|---|---|
| `/init-session` | GET | Khởi tạo session, lấy cookie |
| `/captcha-img` | GET | Lấy ảnh captcha (base64) |
| `/tracuu` | POST | Tra cứu 1 SBD |
