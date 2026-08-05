# VetAI — AI geliştirme protokolü

## Roller

- **Claude Sonnet:** Ana geliştirici. Kendisine verilen tek fazı kodlar, testini ekler ve teslim raporu yazar.
- **Codex:** Teknik lider ve doğrulayıcı. Görev promptlarını hazırlar; diff, güvenlik, build ve testleri kontrol eder; gerekli küçük düzeltmeleri yapar.
- **Claude Opus:** Yalnızca kritik mimari, triyaj güvenliği, KVKK ve tenant izolasyonu incelemelerinde kullanılır.

## Değişmez çalışma kuralları

1. Aynı anda yalnızca bir geliştirme görevi yürütülür.
2. Sonnet yalnızca promptta izin verilen dosyalara ve kapsama dokunur.
3. Her teslim çalışan kod, gerekli migration, en az bir anlamlı test ve kısa teslim raporu içerir.
4. Sonnet tamamladığını söyledikten sonra değişiklikler Codex kontrolünden geçmeden sonraki faza başlanmaz.
5. Codex çalışan kodu sebepsiz yeniden yazmaz; doğrulanabilir sorunları hedefli biçimde düzeltir.
6. Gerçek secret, telefon numarası, hasta verisi veya API anahtarı repoya yazılmaz.
7. AI hiçbir zaman serbest SQL çalıştırmaz. Veritabanı işlemleri doğrulanmış servis fonksiyonlarından geçer.
8. Tıbbi sınırlar, trust-boundary doğrulamaları, tenant izolasyonu ve hata yönetimi sadeleştirilmez.

## Sonnet teslim formatı

Her görevin sonunda şunları yaz:

1. Değiştirilen/eklenen dosyalar
2. Uygulanan kabul kriterleri
3. Çalıştırılan komutlar ve sonuçları
4. Bilinen eksikler veya gerçek entegrasyon gerektiren noktalar
5. Codex'in özellikle kontrol etmesi gereken riskler

## Görev 01 — Sonnet'e gönderilecek prompt

```text
VetAI projesinin ana geliştiricisisin. Bu bir veteriner teşhis ürünü değil; WhatsApp üzerinden çalışan güvenli bir dijital resepsiyon ve randevu sistemi olacak.

Repository şu anda boş ve greenfield kabul ediliyor. Bu görevde yalnızca minimum, çalışan proje temelini kur. Tüm ürünü oluşturmaya çalışma.

Teknik temel:
- TypeScript strict mode
- Cloudflare Workers
- pnpm
- Supabase/PostgreSQL entegrasyonuna hazır yapı
- Vitest ile küçük ve anlamlı testler
- Secret'lar yalnızca Worker environment binding üzerinden
- Europe/Istanbul uygulama zaman dilimi

Bu görevde yap:
1. Minimum Cloudflare Worker TypeScript projesini oluştur.
2. GET /health endpoint'i ekle; dış servise ihtiyaç duymadan durum ve sürüm dönsün.
3. GET /webhooks/whatsapp endpoint'inde Meta webhook doğrulamasını uygula:
   - hub.mode, hub.verify_token ve hub.challenge alanlarını doğrula.
   - Token eşleşirse challenge'ı düz metin döndür.
   - Hatalı/eksik isteklerde güvenli 403/400 döndür.
   - Token'ı loglama.
4. POST /webhooks/whatsapp için yalnızca güvenli iskelet oluştur:
   - JSON gövdesini parse et.
   - Desteklenmeyen veya bozuk gövdede 400 döndür.
   - Henüz LLM, Supabase veya WhatsApp gönderim çağrısı yapma.
   - Geçerli gövdeyi ayrıntılı loglamadan 200 ile kabul et.
5. Environment binding tiplerini ve .dev.vars.example dosyasını placeholder değerlerle ekle.
6. README'ye yerel kurulum, test ve çalıştırma komutlarını yaz.
7. Health ve webhook doğrulaması için test ekle.

Kapsam dışı:
- Admin paneli
- RAG/embedding
- LLM entegrasyonu
- Veritabanı tabloları ve migration'lar
- Randevu motoru
- Triyaj motoru
- Mesaj gönderimi
- Queue/retry altyapısı
- Gereksiz interface, factory, repository katmanı veya geleceğe dönük soyutlama

Kabul kriterleri:
- pnpm test başarılı.
- TypeScript typecheck başarılı.
- Worker yerelde başlatılabilir.
- Kaynak kodda gerçek secret bulunmaz.
- Webhook verify token yanlışken challenge döndürülmez.
- Görev kapsamı dışındaki özellikler eklenmez.

Önce mevcut klasörü kontrol et, sonra kodu oluştur. İş bitince standart teslim formatını kullan. Commit veya push yapma.
```

## Görev 01 sonrası Codex kontrol promptu

Sonnet teslimini tamamladıktan sonra Codex'e şu istek verilir:

```text
Sonnet Görev 01'i tamamladı. Mevcut diff'i ve çağrı akışını incele. Kabul kriterlerini doğrula; dependency install, typecheck ve testleri çalıştır. Cloudflare request/response davranışı, webhook doğrulaması, secret sızıntısı ve gereksiz mimari açısından kontrol et. Doğrulanabilir sorunları minimum değişiklikle düzelt. Çalışan bölümleri yeniden yazma. Sonuçta geçti/kaldı kararı ve bir sonraki Sonnet görev promptunu hazırla.
```

## Opus ne zaman devreye girecek?

Opus ilk bootstrap görevinde kullanılmaz. İlk kez veritabanı şeması, RLS ve multi-tenant güvenlik tasarımı hazırlandıktan sonra salt inceleme için kullanılacaktır. Daha sonra veteriner onaylı triyaj kuralları uygulanmadan önce ikinci kez çağrılacaktır.

## Görev 01 Codex sonucu

**Karar: GEÇTİ.** Codex; unsupported POST gövde kontrolünü sıkılaştırdı, yerel Claude API yönlendirmesini kaldırdı, local Claude ayarlarını git dışında bıraktı, pnpm sürümünü sabitledi ve placeholder değerleri netleştirdi. Typecheck, 13 test ve Wrangler dry-run başarılıdır.

## Görev 02 — Sonnet'e gönderilecek prompt

```text
VetAI Görev 02'yi uygula. Önce AI_WORKFLOW.md ve mevcut kaynak/test dosyalarını oku. Bu görevde yalnızca WhatsApp POST webhook imza doğrulamasını production güvenliğine yaklaştır; veritabanı, LLM, queue, randevu, triyaj veya admin panel ekleme.

Amaç:
Meta'dan geldiği iddia edilen POST /webhooks/whatsapp isteklerini, JSON parse edilmeden önce ham gövde üzerinden X-Hub-Signature-256 ile doğrulamak.

Yapılacaklar:
1. WHATSAPP_APP_SECRET ile Web Crypto API kullanarak HMAC-SHA256 doğrulaması uygula.
2. Header tam olarak sha256=<hex-digest> biçiminde olmalı. Eksik, bozuk veya eşleşmeyen imza güvenli biçimde reddedilmeli.
3. İmza karşılaştırmasını byte dizileri üzerinde sabit süreli bir döngüyle yap; secret veya imzayı loglama.
4. Request body'yi yalnızca bir kez oku. Aynı ham byte'ları önce imza doğrulamasında, sonra UTF-8/JSON parse işleminde kullan.
5. Content-Type application/json değilse 415 döndür.
6. Ham gövde için 256 KiB üst sınır uygula. Content-Length güvenilir tek kaynak değildir; okunan byte uzunluğunu da kontrol et. Büyük gövdede 413 döndür.
7. Geçerli imzadan sonra mevcut temel WhatsApp event-envelope doğrulamasını koru.
8. Başarılı istekte mevcut 200 cevabı koru; event gövdesini loglama.
9. README'de POST endpoint'in imza doğruladığını ve yerelde APP_SECRET gerektiğini açıkla.

Testler:
- Test içinde gerçek HMAC imzası üret ve geçerli imzanın 200 aldığını doğrula.
- Eksik imza reddedilir.
- Yanlış imza reddedilir.
- Bozuk hex veya yanlış uzunluk reddedilir.
- Geçerli imzalı fakat bozuk JSON 400 alır.
- Yanlış Content-Type 415 alır.
- 256 KiB üzeri gövde 413 alır.
- GET webhook doğrulama ve health testleri bozulmaz.

Kısıtlar:
- Yeni dependency ekleme; Cloudflare Web Crypto ve standart API'leri kullan.
- HMAC'i Node'a özel crypto modülüyle yazma.
- Gereksiz class/interface/factory oluşturma.
- Gerçek secret ekleme.
- .claude/settings.local.json veya pnpm build izinlerini değiştirme.
- Commit veya push yapma.

Kabul kriterleri:
- pnpm install --frozen-lockfile başarılı.
- pnpm typecheck başarılı.
- pnpm test başarılı.
- pnpm exec wrangler deploy --dry-run başarılı.
- İmza doğrulanmadan JSON işlenmez.
- Standart teslim formatıyla rapor ver.
```

## Görev 02 Codex sonucu

**Karar: GEÇTİ.** Codex; medya türü kontrolünü tam eşleşmeye çevirdi, boş APP_SECRET durumunu fail-closed yaptı ve JSON çözümlemesini geçersiz UTF-8 için katılaştırdı. Frozen install, typecheck, 30 test ve Wrangler dry-run başarılıdır. Güvenli başlangıç durumu `e50a2f7` commit'i olarak kaydedilmiştir.

## Görev 03 — Sonnet'e gönderilecek prompt

```text
VetAI Görev 03'ü uygula. Önce AI_WORKFLOW.md, mevcut Git durumu ve mevcut kaynakları oku. Bu görev yalnızca Supabase/PostgreSQL çekirdek tenant şeması, RLS politikaları ve ilgili kısa dokümantasyon içindir. Worker runtime entegrasyonu, Supabase JS client, webhook event işleme, LLM, randevu, triyaj, RAG ve admin panel ekleme.

Başlamadan önce:
- git status ile başlangıç durumunu kaydet.
- Mevcut commit ve dosyaları değiştirme veya yeniden biçimlendirme.
- Docker bu makinede kurulu değil. Migration'ı yerel veritabanında çalıştırmadıysan çalıştırılmış gibi raporlama.

Oluştur:
1. Gerekliyse minimal supabase/config.toml.
2. Tek bir ileri yönlü migration: supabase/migrations/20260805_core_tenant_schema.sql
3. docs/database-schema.md

Migration'da yalnızca şu tabloları oluştur:
- clinics
- clinic_staff
- whatsapp_accounts
- owners
- pets
- conversations
- messages
- webhook_events

Zorunlu veri modeli:
- UUID primary key ve timestamptz alanları kullan.
- Tenant altındaki her tabloda clinic_id NOT NULL olsun.
- clinic_staff, auth.users ile user_id üzerinden ilişkilensin; (clinic_id, user_id) primary key olsun.
- whatsapp_accounts.phone_number_id global unique olsun; secret/token veritabanında tutulmasın.
- owners için (clinic_id, phone_e164) unique ve temel E.164 CHECK kullan.
- Pet'in owner'ı aynı clinic'e ait olmalı.
- Conversation owner ve opsiyonel pet ilişkisi aynı clinic/owner sınırını aşamamalı. Bunu yalnızca uygulama koduna bırakma; composite foreign key/unique constraint ile uygula.
- Message'ın conversation ilişkisi aynı clinic içinde composite foreign key ile korunmalı.
- messages.whatsapp_message_id için NULL olmayan değerlerde clinic bazlı partial unique index oluştur.
- webhook_events için clinic bazlı provider_event_id unique olsun; payload_hash, processing_status, received_at, processed_at ve maskelenmiş last_error alanlarını değerlendir. Ham WhatsApp payload'ını bu tabloda saklama.
- Yalnızca gerçekten sorgulanacak foreign key, telefon, durum ve zaman alanlarına gerekli indexleri ekle.
- Tek bir set_updated_at() trigger fonksiyonunu mutable tablolarda yeniden kullan.
- Gelişmesi zor PostgreSQL enum tipleri oluşturma; text + CHECK kullan.

Minimum durum değerleri:
- clinic_staff.role: admin, veterinarian, receptionist
- conversations.status: active, handoff, completed
- messages.direction: inbound, outbound, system
- webhook_events.processing_status: received, processing, processed, failed

RLS ve yetki kuralları:
- Tüm tablolarda RLS enable et.
- auth.uid() ve clinic_staff üyeliğini kullanan, SECURITY DEFINER + sabit search_path içeren tek küçük is_clinic_staff(uuid) helper oluştur.
- Helper'da SQL injection'a açık dynamic SQL kullanma.
- public execute yetkisini revoke et; yalnızca authenticated ve service_role için gereken yetkiyi ver.
- anon rolüne hiçbir tablo erişimi verme ve mevcut yetkileri açıkça revoke et.
- clinics, clinic_staff ve whatsapp_accounts için authenticated rolüne sadece aynı tenant verisini okuma izni ver. Üyelik/klinik/WhatsApp hesap yönetimi service_role üzerinden olsun.
- owners, pets, conversations ve messages için authenticated staff'a aynı clinic içinde SELECT/INSERT/UPDATE/DELETE politikaları yaz; USING ve WITH CHECK birlikte doğru uygulanmalı.
- webhook_events için authenticated/anon policy oluşturma; yalnızca güvenli backend service_role işlesin.
- Service role anahtarını veya gerçek proje bilgisini hiçbir dosyaya yazma.
- Bir kullanıcının başka clinic_id yazarak çapraz tenant kayıt oluşturmasını veya ilişki kurmasını DB constraint + RLS birlikte engellesin.

Dokümantasyon:
- Her tablonun amacını ve temel ilişkilerini kısa açıkla.
- Neden ham webhook payload'ı tutulmadığını belirt.
- Service role'un yalnızca Worker secret binding'inde kullanılacağını belirt.
- Migration'ın henüz gerçek Supabase projesine uygulanmadığını açıkça yaz.
- Sonraki aşamada uygulanmadan önce Opus güvenlik incelemesi ve gerçek test projesinde migration/RLS testleri gerektiğini belirt.

Doğrulama:
- Yeni dependency ekleme.
- pnpm install --frozen-lockfile, pnpm typecheck, pnpm test ve Wrangler dry-run çalıştır.
- Supabase CLI mevcutsa yalnızca syntax/yerel kontrol için güvenli, bağlantısız komutları kullan. Docker veya linked test projesi yoksa DB migration/RLS testlerini BLOCKED/NOT RUN olarak raporla; sahte başarı yazma.
- Migration dosyasında gerçek DROP, seed hasta verisi, secret veya production URL bulunmasın.
- git diff --check çalıştır.
- Commit veya push yapma.

Standart teslim formatına ek olarak şunları raporla:
- DB üzerinde gerçekten çalıştırılan kontroller
- Çalıştırılamayan DB kontrolleri ve nedeni
- Opus'un özellikle incelemesi gereken RLS/composite-FK kararları
```
