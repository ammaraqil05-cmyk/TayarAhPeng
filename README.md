# Kedai Tayar Ah Peng — Skrin Tempahan Layan Diri & Admin CMS

Sistem tempahan makanan layan diri berasaskan **Cloudflare Workers**, **Cloudflare D1**, dan **HTML/CSS/JavaScript tulen**.

## Ciri Utama
- **Skrin Kiosk (`/`)**: Paparan kategori aktif, kad menu dengan gambar & fallback emoji, kawalan kuantiti troli, pilihan **Makan Sini** atau **Bungkus**, serta tiket **Nombor Giliran Berjujukan** (`AP-001`, `AP-002`, ...) dengan kemas kini status langsung.
- **Panel Admin CMS (`/admin.html`)**: Log masuk menggunakan `ADMIN_PASSWORD` (memulangkan `503` jika belum diset), pengurusan pesanan dapur, tambah/edit/salin/padam item, tukar harga cepat, aktif/nyahaktif item & kategori (sekatan `409` jika kategori masih ada item), pemampatan gambar `<canvas>` (max 480px, latar putih, `< 95 KB`) ke D1, serta tetapan nama kedai, banner dan status buka/tutup kedai.

## Konfigurasi & Auto-Deploy Cloudflare Dashboard (GitHub)
1. Sambungkan repositori GitHub ke **Cloudflare Dashboard > Workers & Pages**.
2. Tetapkan build command `npm install` (atau lalai) dan deploy command `npx wrangler deploy`.
3. Pastikan binding D1 dalam `wrangler.toml` sepadan dengan database `tayarahpeng` (`724d6082-0d96-4b54-a92a-3952acc9db54`).
4. Tambah secret **`ADMIN_PASSWORD`** di **Settings > Variables and Secrets** (atau jalankan `npx wrangler secret put ADMIN_PASSWORD`).

## Pembangunan & Ujian Tempatan
```bash
npm install
npm test
npm run dev
```
Untuk pembangunan tempatan, cipta fail `.dev.vars` (diabaikan oleh git):
```env
ADMIN_PASSWORD=kata-laluan-anda
```
