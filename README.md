# VetAI

WhatsApp üzerinden çalışan dijital resepsiyon ve randevu sisteminin Cloudflare Worker temeli.

## İnsan onay paketleri

- [Veteriner hekim inceleme ve onay paketi](docs/veteriner-hekim-onay-paketi.md)
  ([PDF](output/pdf/veteriner-hekim-onay-paketi.pdf))
- [Türk hukuku ve KVKK inceleme paketi](docs/kvkk-inceleme-paketi.md)
  ([PDF](output/pdf/kvkk-inceleme-paketi.pdf))
- [Üretime hazırlık kontrol listesi](docs/production-readiness.md)

## Gereksinimler

- Node.js 20+
- pnpm

## Kurulum

```bash
pnpm install
cp .dev.vars.example .dev.vars
# .dev.vars içindeki değerleri gerçek/local secret'larla doldur
```

## Çalıştırma (yerel)

```bash
pnpm dev
```

Worker `http://localhost:8787` adresinde başlar.

- `GET /health` — durum ve sürüm bilgisi döner.
- `GET /ready` — yapılandırma denetimi: gerekli tüm secret/URL/queue binding'leri dolu ve geçerli görünüyorsa `200 { "status": "ready" }`, değilse `503 { "status": "unavailable" }` döner. Hiçbir dış servise gerçek istek atmaz; eksik alanın adını, değerini ya da secret'ını asla döndürmez veya loglamaz.
- `GET /webhooks/whatsapp` — Meta webhook doğrulama (`hub.mode`, `hub.verify_token`, `hub.challenge`).
- `POST /webhooks/whatsapp` — ham gövdeyi `X-Hub-Signature-256` (HMAC-SHA256, `WHATSAPP_APP_SECRET`) ile doğrular, ardından JSON'u parse edip temel event zarfını kontrol eder. Content-Type `application/json` olmalı (aksi halde 415), gövde 256 KiB'yi geçemez (aksi halde 413), imza eksik/bozuk/yanlışsa 401 döner ve gövde hiç parse edilmez.

Yerel testte gerçek bir isteği imzalamak için `.dev.vars` içindeki `WHATSAPP_APP_SECRET` ile aynı secret'ı kullanarak `sha256=<hex>` üretmeniz gerekir.

## Yerel Türkçe test ekranı

Gerçek WhatsApp/yapay zekâ/veritabanı olmadan karar mantığını denemek için:
`pnpm.cmd demo` — bkz. [docs/local-demo.md](docs/local-demo.md).

## Canlı yapay zekâ test ekranı

Sentetik metinle gerçek OpenAI çağrısı deneyip planlayıcı sonucunu görmek
için: `pnpm.cmd live-demo` — bkz. [docs/live-ai-demo.md](docs/live-ai-demo.md).

## Test

```bash
pnpm test
```

## Typecheck

```bash
pnpm typecheck
```
