# İşletimsel alarm ve personel bildirim aktivasyon planı (Task 053 — Faz A)

Son doğrulama: 2026-09-05. Bu belge yalnız Faz A kapsamındadır: incelenecek bir
**aktivasyon spesifikasyonu**dur, çalışan bir alarm değildir. Bu görev boyunca
hiçbir kod, Wrangler yapılandırması, veritabanı, hesap veya canlı servis
değişmedi; hiçbir gerçek e-posta gönderilmedi. Faz B (gerçek kurulum) yalnız
Codex'in bu belgeyi inceleyip sözleşmeyi ayrıca genişletmesinden sonra
başlayabilir.

Kapsam dışı — bu belge bunları yapmaz: yeni izleme çerçevesi icat etmek,
onaylanmamış bir sağlayıcı/hesap seçmek, veteriner/KVKK onayı vermek, üretim
hedefi kurmak veya `docs/staff-workflow.md`'daki mevcut aktif-sayfa tarayıcı
bildirimini arka planda/güvenilir bir kanalmış gibi göstermek.

## 1. Sinyal-eylem matrisi

Eşikler ve pencereler **öneri niteliğindedir** — onaylanmış klinik yanıt
süresi veya müşteri SLA'sı değildir. Hiçbir satır, değerlendirilmemiş bir
`dead_letter_handoff` işaretini düşük klinik risk olarak yeniden
etiketlemez.

| # | Kaynak | Kapsam | Eşik / gözlem penceresi (öneri) | Tazelik / bilinmeyen durum | Alıcı rolü | Eylem | Dedup / tekrar / kurtarma | Gereken kanıt |
|---|---|---|---|---|---|---|---|---|
| 1 | Webhook HTTP 5xx (`outcome` alanından bağımsız) | `POST /webhooks/whatsapp` yanıtı (`src/index.ts`) | ≥1 adet 5xx / 5 dk pencere (Task 052'nin `outcome=ok` yanında görülen 503'ü kaçırdığı olay temel alınmıştır) | Log kaynağına erişilemezse durum **bilinmiyor**, asla "0 hata" değil | Platform operatörü | Kaydı incele; kaynağı ayır (imza/rota-çözümleme/queue enqueue) | Aynı pencerede tekrar bastır (öneri 15 dk); kurtarma = bir sonraki pencere 5xx içermiyor | Sentetik 5xx tetiklenip alarmın gerçekten geldiğinin kanıtı |
| 2 | `/ready` başarısız/timeout | `GET /ready` (`src/readiness.ts`) | ≥2 ardışık başarısız dış kontrol (öneri) | Kontrol 30 sn isolate cache'i nedeniyle ≥30 sn aralıklı olmalı; kontrolcünün kendisine ulaşılamazsa **bilinmiyor** | Platform operatörü | `/health` ile karşılaştır (Worker mi çöktü, bağımlılık mı) | Arıza sürerken tekrar bastır; kurtarma = tek `ready` yanıtı | Sentetik bağımlılık arızası (mevcut kod üretebiliyor) + alarmın geldiği |
| 3 | Birincil kuyruk yaşlanan/artan backlog — prod `vetai-intake`, staging Faz B `vetai-intake-staging` | `backlog_count` / `oldest_message_timestamp_ms` (salt-okunur REST Queues metrics API, §2/§3) | Öneri: `oldest_message_timestamp_ms` yaşı > 5 dk VEYA `backlog_count` art arda 3 ölçümde artıyor | Metrik kaynağına erişilemezse **bilinmiyor**; outbox/iş sayısı proxy olarak kullanılmaz | Platform operatörü | Consumer/Worker durumunu incele | Backlog sıfırlanana kadar bastırma yok | Sentetik gecikmiş consumer ile metriğin değiştiğinin kanıtı |
| 4 | DLQ backlog — prod `vetai-intake-dlq`, staging Faz B `vetai-intake-dlq-staging` | aynı REST metrics uç noktası, DLQ kuyruğunun `queue_id`'siyle | Öneri: `backlog_count > 0` (herhangi bir DLQ mesajı incelemeyi hak eder) | aynı | Platform operatörü | `finalize_intake_dead_letter` sonucunu ve ilgili işi (`docs/staff-work-items.md`) incele | Aynı mesaj sayısı sabitken tekrar bastır; yeni mesaj = yeni alarm | Sentetik mesajın DLQ'ya düştüğü ve metriğin arttığı kanıtı |
| 5 | Terminal DLQ backlog — prod `vetai-intake-terminal-dlq`, staging Faz B `vetai-intake-terminal-dlq-staging` | aynı REST metrics uç noktası, terminal kuyruğun `queue_id`'siyle (kasıtlı consumer'sız) | Öneri: `backlog_count > 0` VE mesaj yaşı, §3'te belirlenen retention'ın belirli bir payı (örn. kalan sürenin yarısı) | aynı; retention burada bir eşik değil bir **son teslim tarihi**dir | Platform operatörü + kurtarma sorumlusu | Manuel kurtarma/inceleme (bu kuyruğun consumer'ı yok, kasıtlı) | Yaşlanan aynı mesaj için giderek sıklaşan tekrar (öneri: günlük) | Sentetik terminal mesaj + yaş hesabının doğruluğu |
| 6 | Yeni başarısız gönderim (`delivery_status = 'failed'`, `attempts_exhausted`) | `outbound_message_outbox` (`docs/outbound-delivery.md`) | Öneri: her yeni `failed` satırı (deneme sınırı zaten RPC'de 3) | Sorguya erişilemezse **bilinmiyor** | Platform operatörü + ilgili klinik sorumlusu | `staff_work_items`'daki `send_attempts_exhausted` kaydına (yalnız `kind = 'delivery_failure'`) yönlendir | Aynı outbox satırı için tek alarm (terminal durum, tekrar yok) | Sentetik/mevcut bir `failed` satırın alarmı tetiklediği kanıtı |
| 7 | Çözülmemiş **acil** personel işi (`priority = 'urgent'`) | `staff_work_items` (`docs/staff-work-items.md`) | İlk bildirim **bekleme yok**: ilk başarılı gözlemde (Cron'un işi ilk gördüğü an) hemen gönderilir. 15 dk **yalnız onaylanmamış bir eskalasyon/tekrar önerisidir** (§4/§7), ilk gönderimi geciktiren bir eşik değildir | Sorguya erişilemezse **bilinmiyor** | Atanmış klinik personeli + §4'teki sorumlu takip kişisi | Hemen e-posta ile bildir; yanıt/çözüm yoksa sorumlu takip devreye girer | İlk gönderim anında; çözülene kadar sıklaşan tekrar (öneri: 15 dk → 30 dk → saatlik) | Sentetik acil iş oluşturulur oluşturulmaz (gecikmesiz) alarmın tetiklendiği kanıtı |
| 8 | Çözülmemiş **normal** personel işi (`dead_letter_handoff` işaretlisi **hariç**) | `staff_work_items` (**yalnız `kind = 'human_handoff'`**) ⋈ `conversations` (aynı `clinic_id` + `conversation_id` ile tenant-güvenli join; `coalesce(conversations.intake_data @> '{"dead_letter_handoff": true}'::jsonb, false)` **değil**) | Öneri: `open`/`seen`/`in_progress` ve > 4 saat | Sorguya erişilemezse **bilinmiyor** | Atanmış klinik personeli | E-posta ile bildir (acilden daha düşük sıklıkta) | Günlük özet tarzı tekrar (öneri) | Sentetik normal iş ile alarmın tetiklendiği kanıtı |
| 9 | `dead_letter_handoff` işaretli normal-öncelik iş — **değerlendirilmemiş risk** (işaret `staff_work_items` satırında **değil**, `finalize_intake_dead_letter`'ın yazdığı `conversations.intake_data`'da `{"dead_letter_handoff": true}` olarak durur — düzeltilmiş bulgu, Codex Faz A re-review 2026-09-05) | `staff_work_items` (**yalnız `kind = 'human_handoff'`**) ⋈ `conversations` (aynı `clinic_id` + `conversation_id` ile tenant-güvenli join; `coalesce(conversations.intake_data @> '{"dead_letter_handoff": true}'::jsonb, false)`) | İlk bildirim **bekleme yok**: satır 7 ile aynı — ilk başarılı gözlemde hemen, 4 saatlik satır 8 penceresini beklemez | Sorguya erişilemezse **bilinmiyor** | Atanmış klinik personeli + platform operatörü (klinik değil, değerlendirilmemiş risk olduğu için ayrıca platforma da görünür) | Satır 8'den **ayrı**, hemen giden bildirim; içerik klinik olarak **"acil"/"urgent" diye etiketlenmez** — "normal öncelik, değerlendirilmemiş, derhal incelenmeli" ibaresiyle gönderilir | İlk gönderim anında; değerlendirilene/çözülene kadar satır 7'yle aynı sıklaşan tekrar önerisi uygulanabilir (sahip kararı, §7) | Sentetik `dead_letter_handoff` kaydıyla (conversation'ın `intake_data`'sında işaretli) satır 9'un tetiklendiği VE aynı kaydın satır 8'i tetiklemediği kanıtı |

**Sorgu sınırı — düzeltilmiş bulgu (Codex Faz A re-review, 2026-09-05):** satır 8 ve 9,
`staff_work_items` tablosunu tek başına sorgulayarak ayırt edilemez; işaret o tabloda
yoktur. `finalize_intake_dead_letter` işareti yalnız ilişkili `conversations` satırının
`intake_data` sütununa `{"dead_letter_handoff": true}` olarak yazar. Ayrım, açık bir
personel işini kendi `conversations` satırına **tenant-güvenli** biçimde bağlayan bir
join gerektirir — eşleşme yalnız aynı `clinic_id` **ve** aynı `conversation_id` üzerinden,
üstelik yalnız `staff_work_items.kind = 'human_handoff'` satırları için yapılır
(`kind = 'delivery_failure'` işleri bu join'e hiç girmez, §5); başka kliniğin
conversation'ına asla erişilmez. Ardından o satırın
`coalesce(intake_data @> '{"dead_letter_handoff": true}'::jsonb, false)` yüklemiyle
JSON boolean olarak tam kontrol edilir. Yüklem doğruysa
kayıt yalnız satır 9'u, değilse (veya yoksa) yalnız satır 8'i tetikler — aynı kayıt asla
ikisini birden tetiklemez.

**Kapsam sınırı — yalnız işaretli ilk-mesaj alt kümesi, açık Faz B blocker (Opus
Faz A incelemesi, 2026-09-05):** `finalize_intake_dead_letter` işareti yalnız
konuşmanın önceki `conversations.intake_data` değeri tam `{}` olduğunda (ilk
mesajın hiçbir geçerli snapshot üretmediği durum) yazılır. Bu nedenle satır 9
**iki ayrı alt kümeden yalnız birini** kapsar:

- **İşaretli ilk-mesaj alt kümesi:** yukarıdaki tenant-güvenli join ile satır
  9'dan güvenilir biçimde algılanır.
- **Mevcut snapshot'lı işaretsiz alt küme:** konuşma zaten geçerli bir
  `intake_data` snapshot'ı taşırken daha sonraki bir mesaj dead-letter'a
  düşerse, `finalize_intake_dead_letter` mevcut snapshot'ı korur ve hiçbir
  işaret yazmaz (bugünkü kod davranışı, bu turda değiştirilmedi). Bu iş,
  değerlendirilmemiş risk olması bakımından birinci alt kümeyle aynıdır, fakat
  bugün veritabanında **hiçbir dayanıklı ayırt edici** taşımaz — sıradan bir
  açık personel işinden ayırt edilemez ve satır 8'in normal dört saatlik
  dijestine sessizce düşebilir.

İkinci alt küme burada **açık bir Faz B veri modeli/algılama blocker'ı**
olarak kaydedilir, satır 9 tarafından karşılanmış sayılmaz. En güvenli öneri:
her `finalize_intake_dead_letter` handoff'unda (yalnız boş-snapshot
durumunda değil) dayanıklı, tenant-kapsamlı bir kaynak/provenance alanı yazan
bir migration — bu, iki alt kümeyi de aynı sorguyla ayırt edilebilir kılar.
Satır 3-5'teki agregat Queue backlog metriği (`backlog_count` vb.) tek
başına hangi mesajın hangi kliniğe ait olduğunu asla söyleyemez; bu nedenle
ikinci alt kümeyi tespit etmenin yerine geçemez. Bu tasarım tamamlanıp
uygulanana kadar **bütün değerlendirilmemiş dead-letter handoff'ların anında
bildirildiği iddia edilmez** — yalnız işaretli ilk-mesaj alt kümesi için
satır 9 geçerlidir.

Ayrıca işaretin sonraki bir mesajda otomatik olarak değiştirildiğine/
temizlendiğine güvenilmez: [`docs/inbound-queue.md`](inbound-queue.md) satır
473-475, handoff konuşmasındaki sonraki bir mesajın zaten incelenmiş
poison-snapshot fallback'ine ulaşıp işareti geçerli bir güncel-tur
snapshot'ıyla değiştirdiğini söylerken, `src/intakeConsumer.ts` satır 418-423
üzerindeki mevcut `human_handoff` kısa yolu, kanonik olmayan marker
snapshot'ını `readCanonicalPersistedSnapshot` ile reddedip o fallback'e hiç
ulaşmadan `retry` döndürüyor. Bu, Task 053'ün izinli dosyalarının dışındadır
ve burada değiştirilmemiştir; bir sonraki uygulama sözleşmesi için ayrı bir
takip kalemi olarak §7'ye kaydedilmiştir.

## 2. En küçük desteklenen yol

Aşağıdaki her madde, adı geçen resmi Cloudflare belgesinin 2026-09-05'te
kontrol edilmiş halini yansıtır; hesaba/plana özgü kullanılabilirlik ayrıca
**doğrulanmamıştır** (bu fazda gerçek hesap erişimi yoktur).

- **Cloudflare Notifications** ([mevcut bildirim türleri](https://developers.cloudflare.com/notifications/notification-available/),
  kontrol: 2026-09-05): sayfada Workers'a veya Queues'a özgü hiçbir bildirim
  türü yok; yalnız Billing, Bots, DNS, Load Balancing, WAF, Zero Trust Tunnel
  gibi genel zone/ürün düzeyi türler var. Webhook 5xx, `/ready` veya Queue
  backlog'u için bu ürün üzerinde **hazır bir alarm türü mevcut değil**.
- **Workers Observability** ([genel bakış](https://developers.cloudflare.com/workers/observability/),
  son güncelleme 2026-08-03, kontrol: 2026-09-05): yalnız log/trace/metrik/
  sorgu ve OpenTelemetry export sunuyor; sayfada hiçbir alert/notification
  özelliği geçmiyor. Üçüncü taraf bir gözlemlenebilirlik platformuna export
  (ayrı maliyet/kurulum ön koşulu), bu fazda seçilmemiştir.
- **Standalone Health Checks** ([ürün sayfası](https://developers.cloudflare.com/health-checks/),
  son güncelleme 2026-08-14, kontrol: 2026-09-05): Cloudflare'in kendi
  ağından, uygulamanın kendi kodundan **bağımsız** olarak belirli bir yolu
  (`/ready` gibi) düzenli aralıklarla dıştan çağırıp beklenen durum kodunu
  kontrol ediyor ve arıza halinde neredeyse gerçek zamanlı bildirim
  (e-posta/webhook) üretiyor — Pro plan ve üzeri gerektiriyor. **Doğrulanmamış:**
  (a) bu Worker'ın bağlı olduğu zone'un plan seviyesi, (b) Health Checks'in bir
  `workers.dev` alt alan adını veya bu Worker'a bağlı özel bir hostname'i aynı
  geleneksel "origin" modeliyle hedefleyip hedefleyemediği. Bu, §3'teki
  bağımsızlık gereksinimini karşılayan en güçlü aday olsa da, hesap/plan
  incelemesi olmadan seçilemez.
- **Queues backlog metrikleri — düzeltilmiş bulgu (Codex Faz A re-review,
  2026-09-05):** önceki taslağın "DLQ/terminal-DLQ metriğini okumak yeni bir
  producer binding'i gerektirir" ifadesi **yanlıştı** ve gereksiz bir yazma
  yetkisi (`send()`/`sendBatch()`) eklenmesini önerdiği için geri çekildi. Bu
  görevin izin verdiği tek doğru yol, bir üreticiye ihtiyaç duymayan
  salt-okunur REST uç noktasıdır:
  [Queues metrics API](https://developers.cloudflare.com/queues/observability/metrics/)
  (kontrol: 2026-09-05) `GET /accounts/{account_id}/queues/{queue_id}/metrics`
  yanıtında `backlog_count`, `backlog_bytes` ve `oldest_message_timestamp_ms`
  alanlarını döndürür — [değişiklik günlüğü, 2026-04-28](https://developers.cloudflare.com/changelog/post/2026-04-28-improved-queues-metrics/)
  aynı verilerin GraphQL Analytics API ve panelden de okunabildiğini
  doğruluyor. Bu uç nokta yalnız kuyruğun `queue_id`'sini ister; prod
  kuyrukları `vetai-intake`, `vetai-intake-dlq`, `vetai-intake-terminal-dlq`
  ve staging Faz B kuyrukları `vetai-intake-staging`, `vetai-intake-dlq-staging`,
  `vetai-intake-terminal-dlq-staging` (`wrangler.toml` / `wrangler.staging.toml`)
  **hepsinde** aynı şekilde çalışır — hiçbiri için Wrangler producer binding'i
  (`INTAKE_QUEUE` gibi) **gerekmez**, çünkü `queue_id`'nin kendisi gizli
  değildir (gizli olan yalnız API token'ıdır). **Düzeltilmiş bulgu (bu tur,
  Opus Faz A incelemesi 2026-09-05):** Wrangler dosyalarında yalnız yukarıdaki
  kuyruk **adları** bulunur — hiçbir `queue_id` UUID'si repoda görünmez; üç
  kuyruğun gerçek `queue_id`'leri henüz ne repoda ne hesap kanıtında
  mevcuttur (ayrı §7 ön koşulu). Bu çağrı bir yazma değil salt-okunur bir
  hesap API isteğidir.
  Bu, madde 3–5'teki backlog sinyalleri için **gerçek bir ölçüm**dür —
  outbox/iş sayısını proxy olarak kullanmaz. Yetki: hesap düzeyinde
  **`Queues Read`** kapsamlı, dar bir Cloudflare API token'ı (yeni `Env`
  secret — token gizlidir, kuyruk ID'leri değil). Aynı token, aşağıdaki §3'te
  retention'ın fiilen uygulanan değerini doğrulamak için gereken "Get Queue"
  çağrısını (`GET /accounts/{account_id}/queues/{queue_id}`,
  `result.settings.message_retention_period` alanı) da yapabilir — bu, o
  doğrulamanın **açık aktivasyon kanıtı** olarak hâlâ ayrıca çalıştırılması
  gerektiği anlamına gelir, token'ın var olması retention'ın doğrulandığı
  anlamına gelmez. Sorgu/kimlik doğrulaması başarısız olursa sonuç
  **bilinmiyor**, "backlog yok" değil (§3). Token'ın oluşturulması bir
  Wrangler/kod değişikliği değildir — Faz A'da uygulanmamıştır, bir sahip/Codex
  ön koşulu olarak §7'de bırakılmıştır.
- **Webhook HTTP 5xx için gerçek alarm yolu — açık Faz B blocker, birincil
  aday değişti (Codex Faz A re-review, 2026-09-05):** yukarıdaki hiçbir
  Cloudflare ürünü bugün 5xx'i alarma çeviriyor değil, ve mevcut
  `scheduled()` Cron'u da geçmiş HTTP durum kayıtlarını okumuyor (yalnız
  `drainOutboundMessages` çalıştırıyor) — panel/log sorgusu bir alarm
  **değildir**. Önceki taslakta önerilen "Cloudflare GraphQL Analytics API /
  invocation durumu" **kanıt kaynağı olarak yetersizdir**: bu veri seti
  invocation'ın `outcome`'unu (`ok`/`exception` vb.) raporlar, Worker'ın
  istemciye fiilen döndürdüğü HTTP durum kodunu değil.
  [`docs/olaylar/2026-09-05-delivery-latency.md`](olaylar/2026-09-05-delivery-latency.md)
  satır 83–88'de kayıtlı geçmiş olay bunu kanıtlıyor: aynı istek **HTTP 503**
  döndürürken invocation `outcome = ok` olarak görünmüştür — yani
  `outcome`/invocation-durumu bu görev için **güvenilir bir 5xx kanıtı
  değildir**. Teknik olarak desteklenen iki küçük yoldan biri seçilmeden bu
  satır uygulanamaz:
  1. **Cloudflare Workers Observability telemetri sorgu API'si (birincil
     aday):** `POST /accounts/{account_id}/workers/observability/telemetry/query`
     ile Worker'ın panelde de kullanılan Query Builder'ının temelini
     oluşturduğu aynı telemetri verisini sorgulamak; bu veri seti,
     `outcome`'un aksine, Worker'ın gerçekten döndürdüğü yanıtın durum kodunu
     taşır — panelde bu, [Query Builder sayfası](https://developers.cloudflare.com/workers/observability/query-builder/)
     üzerinde (kontrol: 2026-09-05) doğrulanan `$workers.event.response.status`
     alanıyla filtrelenebiliyor. (Bu görevin Codex incelemesi alanı
     `$metadata.statusCode` olarak anmıştır; bu tur bağımsız doğrulamada
     Cloudflare'ın canlı Query Builder sayfasında görülen gerçek alan adı
     `$workers.event.response.status`'tur — tam alan adı, iki isimlendirme
     arasındaki bu fark dahil, hesaba bağlanmadan **doğrulanmamıştır**.) Bu
     kaynak, mevcut olay kaydında kullanılan gerçek yanıt durumuyla aynı
     temel veriye dayandığı için seçenek 2'den daha güvenilir bir adaydır ve
     kenar (edge) taraflı olduğu için uygulama kodunun çalışıp çalışmadığından
     bağımsızdır — §3'ün bağımsızlık gereksinimini seçenek 2'den daha iyi
     karşılar. Gereken API-token izni, hesap/plan kullanılabilirliği, veri
     saklama süresi, örnekleme (sampling) ve maliyet bu hesap için
     **doğrulanmamıştır (NOT VERIFIED)**. Dedup/arızalanma sınırı: sorgu
     başarısız olursa sonuç "bilinmiyor", "0 hata" değil.
  2. **Kendi-içi işaretleme (self-instrumentation) — yalnız yardımcı/
     tamamlayıcı sinyal, tek başına yeterli çözüm değil:** `src/index.ts`'in
     5xx döndürdüğü her noktada, zaten bağlı Supabase bağlantısına (yeni
     secret gerekmez) zaman damgalı tek satır yazmak; Cron bu satırları her
     dakika okuyup eşik aşımında e-posta atmak. Yetki: yok (mevcut servis
     rolü yeterli). Maliyet: ihmal edilebilir (yalnız 5xx anında ek satır).
     Dedup: Cron, son bildirilen satırın zaman damgasını saklayıp §1 satır
     1'in 5 dk bastırma penceresini bu damgaya göre uygular. **Bu yol tek
     başına kabul edilemez:** [`docs/olaylar/2026-09-04-route-resolver-405.md`](olaylar/2026-09-04-route-resolver-405.md)'te
     kayıtlı geçmiş olayda arızalayan bağımlılık Supabase/PostgREST
     katmanının kendisiydi — Supabase'e yazarak Supabase kaynaklı bir
     arızayı raporlamak dairesel bir bağımlılıktır. Ayrıca Worker bu yazım
     noktasına hiç ulaşamadan çökerse (tam kesinti, erken exception) olay
     hiç kaydedilmez. Bu nedenle bu yol §3'teki bağımsızlık gereksinimini
     **karşılamaz**; yalnız seçenek 1'e ek, tamamlayıcı bir yardımcı sinyal
     olarak tutulabilir — sağlayıcının tek/sole kaynağı olarak
     **kullanılamaz**. Bu bir kod/migration değişikliğidir — **Faz A'da
     uygulanmamıştır.**
  Birincil aday seçenek 1'dir; seçenek 2 yalnız tamamlayıcı bir yardımcı
  sinyal olarak eklenebilir, sağlayıcının yerini tutamaz. Hangisinin/
  ikisinin birlikte uygulanacağı sağlayıcı/hesap/maliyet kararına bağlıdır
  (§7); ikisi de bugün **uygulanmamıştır** ve satır 1 bu karar verilene kadar
  yalnız log incelemesi düzeyinde kalır. Tam kesinti hâlâ yalnız satır 2'nin
  (`/ready`, dıştan problanan) sorumluluğudur — bu iki seçenekten hiçbirinin
  yerini almaz; ikisi de kısmi/uygulama-içi 5xx'i, `/ready` ise tam kesintiyi
  bağımsız olarak izler.
- **Sonuç:** yukarıdaki hiçbiri bugün "kaydedilmiş sorgu/panel" ötesinde
  teslim edilmiş bir alarm değildir. Queue backlog sinyalleri (madde 3–5) için
  en küçük gerçekçi tamamlayıcı yol: mevcut her-dakika Cron çağrısını
  (`src/index.ts`'in `scheduled()`'ı) genişletip yeni `Queues Read` API
  token'ıyla REST metrics uç noktasını (yukarıda; producer binding
  **gerekmez**), `staff_work_items`/`conversations` join'ini ve outbox
  sorgularını okuyup eşik aşıldığında **tek bir** minimal e-posta HTTP
  API'sine tek istek atmak. İllüstrasyon amaçlı, seçim/onay gerektiren bir
  aday: [Resend `POST /emails`](https://resend.com/docs/api-reference/emails/send-email)
  (kontrol: 2026-09-05) — `Authorization: Bearer <API key>`, JSON gövdede
  `from`/`to`/`subject`/`html` alanları, doğrulanmış gönderim alan adı
  gerektiriyor. Bu **bir sağlayıcı taahhüdü değildir**; sağlayıcı/hesap seçimi
  §7'de açık bırakılmıştır. Uygulanmayan ön koşullar: `Queues Read` kapsamlı
  Cloudflare API token'ı, madde 5xx seçeneği 1 seçilirse yeni Workers
  Observability telemetri API token'ı, Health Checks seçilirse zone plan
  yükseltmesi, doğrulanmış gönderim alan adı DNS kayıtları. **Yalnız e-posta
  API anahtarı** (Resend veya seçilecek sağlayıcı) ve gereken Cloudflare
  salt-okunur API token'ları (Queues Read; seçilirse Observability telemetri
  token'ı) bir `Env` **secret**'ıdır. Platform alarm alıcısı ve klinik başına
  personel alıcı listesi **buna dahil değildir** — bunlar tek bir global
  secret'a gömülmez; §4'teki ayrı tenant-kapsamlı (klinik personeli) ve
  platform-kapsamlı (platform alarm alıcısı) kayıt tasarımlarına tabidir.
  Kuyruk ID'leri secret değildir. Alıcı listeleri de `Env` secret'ı değildir,
  fakat erişim kontrollü kişisel/operasyonel veridir; herkese açık sayılamaz.

## 3. Bağımsızlık

- `/ready` için tek prob kaynağı uygulamanın kendi Cron'u **olamaz**;
  yukarıdaki Standalone Health Checks (plan doğrulanırsa) veya üçüncü taraf
  bir harici uptime servisi (plan uygun değilse, owner kararı) dıştan
  çağırmalıdır.
- **Cron tek nokta arızası — klinik e-posta kanalı da etkilenir (Opus Faz A
  incelemesi, 2026-09-05):** Klinik acil/normal e-posta bildirimleri de (§4)
  şu anda önerilen aynı Worker Cron'una (`scheduled()`) bağımlıdır. Worker
  veya Cron durursa platform alarmları kadar klinik bildirimleri de sessiz
  kalır — bu iki kanal birbirinden bağımsız değildir. Harici `/ready` alarmı
  (yukarıdaki Standalone Health Checks veya üçüncü taraf uptime servisi)
  platform operatörüne yalnız uygulamanın durduğunu değil, **klinik e-posta
  kanalının da aynı anda durmuş olabileceğini** açıkça söylemelidir. Ayrıca
  Cron'un son başarılı çalışma zamanı, Cron'un kendisinden bağımsız, dıştan
  gözlenen ayrı bir heartbeat ile izlenmelidir — durmuş bir Cron hiçbir şey
  çalıştıramayacağı için sorgu hatası bile üretemez, bu yüzden yalnız "sorgu
  başarısız = bilinmiyor" kuralına güvenmek yeterli değildir. Bu heartbeat'in
  nerede tutulacağı ve hangi bağımsız sistem tarafından kontrol edileceği bir
  Faz B tasarım/aktivasyon ön koşuludur (§7), burada tasarlanmamıştır.
- Metrik kaynağı veya kimlik doğrulaması başarısız olursa sonuç **bilinmiyor/
  unavailable** olarak sunulur, asla sağlıklı sıfır değil — bu kural Queue
  metrik okumalarına ve `staff_work_items`/outbox sorgularına da eşit
  uygulanır: sorgu RPC/Data API çağrısı başarısız olursa "backlog yok" veya
  "açık iş yok" sonucu **çıkarılmaz**.
- **Kuyruk retention'ı — düzeltilmiş bulgu (Codex Faz A incelemesi,
  2026-09-05):** [Cloudflare Queues limitleri](https://developers.cloudflare.com/queues/platform/limits/)
  ve [kuyruk yapılandırma sayfası](https://developers.cloudflare.com/queues/configuration/configure-queues/)
  (kontrol: 2026-09-05), `message_retention_period` **açıkça
  yapılandırılmazsa varsayılanın 345.600 saniye (4 gün)** olduğunu ve
  `--message-retention-period-secs` ile **en fazla 1.209.600 saniyeye (14 gün)**
  kadar yapılandırılabildiğini belirtiyor. Ancak bu tavan/varsayılan,
  retention'ın **plan bazında yapılandırılabilir olduğu** duruma aittir. Ayrı bir
  sayfa, [Cloudflare Queues fiyatlandırma sayfası](https://developers.cloudflare.com/queues/platform/pricing/)
  (`docs/staging-runbook.md` §2'de zaten alıntılı), Workers Free planının Queue
  kullanımını **24 saat sabit retention** ile kapsadığını, Workers Paid'in
  (aylık en az $5) daha uzun/yapılandırılabilir retention sağladığını belirtiyor.
  Bu Worker'ın bağlı olduğu Cloudflare hesabının **plan seviyesi ve üç kuyruğun
  fiilen uygulanan (etkin) retention değeri bu fazda doğrulanmamıştır** —
  `wrangler.toml`'da alanın ayarlı olmaması planın Free olmadığı anlamına
  gelmez. **Doğrulanana kadar konservatif kurtarma bütçesi 24 saattir**, 4 gün
  veya 14 gün değil; bu sayı §1 satır 5'teki terminal-DLQ eşiğini ve
  [`docs/production-readiness.md`](production-readiness.md) §5 adım 11'deki
  smoke-test kurtarma penceresini de bağlar. Plan/etkin retention doğrulanıp
  Free olmadığı kesinleşirse bu taban yükseltilebilir; Codex/sahip isterse
  Paid planda `vetai-intake-terminal-dlq` için değeri 14 güne kadar
  yükseltebilir. Bu bir Wrangler yapılandırma değişikliğidir — **burada
  uygulanmamıştır**, yalnız §7'de bir seçenek olarak bırakılmıştır.
- Aynı sayfa ayrıca kuyruk başına 25 GB backlog boyutu tavanını belirtiyor;
  aşılırsa `send()`/`sendBatch()` "Storage Limit Exceeded" ile başarısız olur
  — bu, zaman tabanlı retention'dan **ayrı** bir arıza modudur ve madde
  3–5'teki backlog metriklerinin aynı "bilinmiyor, asla sıfır değil"
  kuralına tabidir.

## 4. Personel bildirim sınırı

Platform alarmları (§1–3, operatöre) ile klinik bildirimleri (bu bölüm,
personele) ayrı kalır. `docs/staff-workflow.md`'daki mevcut 30 saniyelik
aktif-sayfa anketi ve opt-in tarayıcı `Notification` API'si **yalnız
aktif-sayfa pilot yardımcısıdır**; sekme/tarayıcı kapanmasını kapsamaz ve bu
plandaki e-posta kanalıyla **karıştırılmaz** — e-posta kanalı bu mevcut
mekanizmanın yerini almaz, ona ek bir sinyal yoludur.

- **Seçilen kanal:** 2026-09-05'te sahip tarafından e-posta, artı acil işler
  için sorumlu-kişi takip planı olarak seçildi (CURRENT_TASK.md, "Verified
  starting facts"). Sağlayıcı/hesap seçimi henüz yapılmadı (§7).
- **Önerilen minimal yol:** Worker'dan tek bir HTTP çağrısıyla tek bir e-posta
  sağlayıcısına (§2'deki illüstrasyon), doğrulanmış gönderim alan adı,
  credential ve maliyet ön koşullarıyla. Telegram, SMS, push veya çoklu
  sağlayıcı soyutlaması **eklenmez**. Supabase Auth şifre-sıfırlama e-postası
  işletimsel bildirim kanalı olarak **yeniden kullanılmaz** (ayrı amaç, ayrı
  onay/rate-limit rejimi).
- **Alıcı sınırı:** yalnız o kliniğin yetkili personeli alır; hiçbir bildirim
  paylaşılan/ortak bir hedefe yayın yapmaz (tenant izolasyonu). Yeni bir
  personel aboneliği, Auth e-postasının otomatik yeniden kullanımı veya
  varsayılan onay burada yetkilendirilmemiştir — açık bir yetkilendirme adımı
  (mekanizması Faz B) gerekir.
- **Alıcı depolama tasarım sınırı — iki ayrı kapsam (Codex Faz A re-review,
  2026-09-05):** klinik personel alıcı adresleri ile platform alarm alıcısı
  **aynı kapsamda değildir** ve birbirine karıştırılmaz; ikisi de **`Env`
  secret'ı olarak tasarlanmaz** — §2'de yalnız e-posta API anahtarı (ve
  seçilirse Observability telemetri token'ı, ve Queues Read token'ı) bir
  `Env` secret'tır.
  - **Klinik personel alıcıları (tenant-kapsamlı):** bir kliniğe aittir,
    mevcut tenant-scoped/RLS'li veri katmanında (`docs/staff-workflow.md`'daki
    personel kaydına benzer) tutulur, klinik yetkisi altında yönetilir,
    denetlenebilir/geri alınabilirdir ve KVKK/gizlilik incelemesi gerektiren
    kişisel veridir.
  - **Platform alarm alıcısı (platform-kapsamlı):** hiçbir kliniğe **ait
    değildir** — bir `clinic_id`'ye bağlanamaz ve tenant-scoped/RLS'li klinik
    veri katmanında **tutulmaz**. Ayrı, platform-yönetici benzeri bir yetki
    kapsamında (platform operatör/sahip erişimiyle) ayrıca yetkilendirilir;
    yine de tek bir global `Env` secret'ına gömülmez — kendi başına
    denetlenebilir/geri alınabilir bir kayıt olarak tutulur, böylece kaldırma
    işlemi de bir kod deploy'u gerektirmez.
  Her iki liste de tek bir düz secret listesine gömülemez: bir `Env`
  secret'ı değiştirmek her zaman yeniden deploy/`wrangler secret put`
  gerektirir ve ne tenant başına ne de platform düzeyinde denetim/iptal izi
  tutar. Faz B tasarımı bu iki kapsamı ayrı tutmalı, böylece §5'teki "alıcı
  kaldırma kod deploy'u gerektirmez" şartı her ikisi için de doğal olarak
  sağlanır.
- **İçerik:** genel bildirim isim, telefon, mesaj, tıbbi gerekçe, hasta veya
  iş kimliği **içermez**. Örnek metin: "Kliniğinizde açık bir [acil/normal] iş
  var. Görmek için: {sabit `/staff` giriş linki}." Sabit giriş linki hiçbir
  yetki vermez; erişimi hâlâ Supabase Auth oturumu ve RLS belirler.
- **Platform kopyasının içerik sınırı (satır 9, sahip/KVKK kararı — Opus Faz A
  incelemesi, 2026-09-05):** satır 9'un platform operatörüne giden kopyasında
  klinik kimliğini aktarma kararı burada verilmez; iki seçenek açık kalır:
  (1) yalnız toplam sayaç + zaman damgası + sabit platform giriş bağlantısı
  (klinik kimliği yok); (2) hukuken/KVKK onayıyla izin verilirse yalnız
  klinik `id` (UUID) — klinik adı, kişi, telefon, mesaj, şikayet veya tıbbi
  içerik asla yok. Her iki seçenekte de bu, üçüncü taraf bir e-posta
  sağlayıcısına operasyonel bilgi aktarımıdır ve ayrı bir KVKK değerlendirmesi
  (§7) tamamlanmadan etkinleştirilemez.
- **Acil iş için sorumlu takip:** matris madde 7'deki tekrar sıklığı boyunca
  atanan/bildirilen personelden gözlemlenebilir bir çözüm gelmezse, ikinci,
  adlandırılmış bir sorumlu takip kişisi aynı genel bildirimi alır. Bu kişinin
  rolü, iletişim bilgisi ve zamanlaması bir sahip kararıdır (§7), burada
  seçilmemiştir.

## 5. Doğru teslim ve eskalasyon

Beş ayrı durum birbirine karıştırılmaz: (1) Worker gönderim denemesi yaptı,
(2) sağlayıcı API çağrıyı kabul etti, (3) sağlayıcı teslim edildiğini
bildirdi (sağlayıcıya özgü webhook — seçilecek sağlayıcıya göre
**doğrulanmamış**), (4) bir insan bunu gördü/onayladı (bugün hiçbir tıklama-
onay mekanizması yok — inşa edilmemiştir), (5) ilgili `staff_work_items`
satırı gerçekten `resolved` oldu (mevcut, ayrı mekanizma). Bir alarm hiçbir
zaman bir iş kaydını kendiliğinden çözmez veya bir hasta sahibine mesaj
göndermez — hasta sahibine mesaj yolu yalnız Task 048'in personel-yazımlı
yanıt hattıdır (`docs/outbound-delivery.md`).

- **Başarısız gönderim tekrar sınırı:** tetikleyen olay başına e-posta
  API'sine en fazla 3 claim/gönderim denemesi. Sayaç claim anında artar;
  Worker sağlayıcı çağrısından sonra ama kabul/serbest-bırakma kaydından önce
  düşse bile süresi dolan üçüncü lease satırı `attempts_exhausted` ile kapatır
  ve dördüncü e-posta gönderilmez. Sağlayıcı reddi üçüncü denemede sabit
  `send_failed` nedeniyle kapanır; ham sağlayıcı hatası saklanmaz.
- **Tekrar bastırma:** §1 matrisindeki satır başına pencereler kullanılır; bir
  koşul bir sonraki kontrolde hâlâ doğruysa penceresi içinde yeniden
  gönderilmez.
- **Alıcı kaldırma:** kapanan bir klinik veya ayrılan bir personel, kod
  deploy'u gerektirmeden kaldırılabilmelidir — bu mekanizma burada
  tasarlanmamıştır, go-live öncesi açık bir ön koşuldur (§7).
- **Sorumlu takip:** §4'teki fallback kişi, atanan personelden gözlemlenebilir
  çözüm gelmediğinde devreye girer; tam tetikleyici koşul ve zamanlama bir
  sahip kararıdır (§7).
- Mevcut aktif-sayfa `Notification` API pilotu bu planda **arka plan
  teslimatı** olarak iddia edilmez; sekme kapalıyken veya izin
  reddedildiğinde hâlâ sessiz kalır (`docs/staff-workflow.md`).
- **Kind bazlı ayrık yönlendirme (zorunlu, karşılıklı dışlayan kural — Opus
  Faz A incelemesi, 2026-09-05):** `staff_work_items.kind` yalnız iki değer
  alır: `human_handoff` ve `delivery_failure` (`docs/staff-work-items.md`).
  Satır 6 yalnız `kind = 'delivery_failure'` kayıtlarını okur; satır 7, 8 ve 9
  yalnız `kind = 'human_handoff'` kayıtlarını okur (§1). İşaretli bir
  konuşmaya bağlı bir `delivery_failure` işi bu nedenle asla satır 8/9'a
  girmez ve satır 6 ile aynı olay için çift bildirim oluşturmaz — iki satır
  grubu birbirini dışlar, tek bir `staff_work_items` satırı ikisini birden
  hiçbir zaman tetiklemez.

## 6. Aktivasyon kanıt matrisi

Tüm satırlar başlangıçta **NOT RUN**. Hiçbir test aktif staging webhook'unu
bozmaz, gerçek bir kliniği askıya almaz, credential'ları zehirlemez veya
kuyrukları temizlemez; yalnız ayrı sentetik/canary veri veya sağlayıcının
kendi test tesisleri kullanılır. Tek bir test e-postasının ulaşması tek
başına doğru yönlendirmeyi kanıtlamaz (yanlış-klinik reddi ayrıca test
edilir).

| # | Durum | Yapılandırıldı | Sentetik tetikleme | Onaylı hedefe teslim | İnsan onayı | Kurtarma | Rollback |
|---|---|---|---|---|---|---|---|
| 1 | Webhook 503, `outcome=ok` ile birlikte (Task 052 tarzı) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 2 | `/ready` başarısız/timeout | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 3 | Queue metriği ulaşılamıyor/bayat (kimlik doğrulama veya kaynak arızası) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 4 | Tek, izole başarısız iş örneği (outbox `failed` veya tek `staff_work_items` kaydı) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 5 | Tarayıcı bildirim izni reddedildi / sekme kapalı (mevcut pilot, dürüstlük yeniden doğrulaması) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 6 | Yanlış-klinik alıcı reddi (cross-tenant e-posta asla gitmez) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 7 | Tekrarlanan/duplicate tetikleme (aynı koşul penceresinde bastırılır) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 8 | Kurtarma + rollback (koşul temizlenince alarm "recovered" işaretler; mekanizma devre dışı bırakılınca mevcut ürün yolları etkilenmez) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| 9 | `dead_letter_handoff` işaretli iş, satır 8'in normal 4 saatlik yolundan ayrı ve hemen giden bildirim üretir; "acil" etiketlenmediğinin doğrulanması | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Gelecekte implementasyon gerektiren durumlar (bugünkü kodun üretemeyeceği bir
test icat edilmez): madde 1, §2'deki webhook 5xx yolu (Workers Observability
telemetri API'si veya tamamlayıcı self-instrumentation) seçilip uygulanana
kadar yürütülemez; madde 3 ve 4, `Queues Read` kapsamlı Cloudflare API
token'ı oluşturulup §2'deki REST metrics uç noktasına bağlanana kadar tam
olarak yürütülemez (producer binding'e bağlı değildir, yalnız token'ın
oluşturulmasına bağlıdır); madde 6, 7 ve 9, e-posta yolu implemente edilene
kadar yalnız tasarım incelemesi düzeyinde kalır.

## 7. Sahip kararları ve çıkış

Aşağıdakiler dışında hiçbir prod/aktivasyon kutusu bu görevde işaretlenmez;
bunların hepsi açık, çözülmemiş ön koşullardır:

- Platform alarm alıcısı (kim, hangi e-posta) — hiçbir kliniğe ait olmayan,
  ayrı platform-kapsamlı, denetlenebilir bir kayıt olarak (§4), `Env`
  secret'ı değil.
- Klinik başına personel alıcı listesi ve yetkilendirme mekanizması — ayrı,
  tenant-kapsamlı kayıt (§4), `Env` secret'ı değil.
- E-posta servisi/hesabı/planı seçimi (§2'deki Resend yalnız illüstrasyondur).
- Webhook HTTP 5xx alarm yolu seçimi: Workers Observability telemetri API'si
  (birincil aday) mi, artı/veya tamamlayıcı kendi-içi işaretleme mi (§2),
  ilgili yetki/hesap kullanılabilirliği/saklama/örnekleme/maliyet
  doğrulamasıyla birlikte.
- `Queues Read` kapsamlı Cloudflare API token'ının oluşturulması ve üç
  kuyruğun `queue_id`'siyle test edilmesi (§2/§3).
- Staging'deki üç kuyruğun (`vetai-intake-staging`, `vetai-intake-dlq-staging`,
  `vetai-intake-terminal-dlq-staging`) gerçek `queue_id` UUID'lerinin List
  Queues API'si veya Cloudflare panosu üzerinden çözülüp kanıtlanması —
  bugün ne repoda ne hesap kanıtında mevcutlar (§2).
- Çözülen kimliklerin ortam başına **non-secret** bir yapılandırma
  kaynağında mı tutulacağı, yoksa her çağrıda kuyruk adını doğrulayan,
  ad eşleşmezse başarısız olan (fail-closed) bir List Queues çözümlemesi mi
  kullanılacağının Faz B sözleşmesinde kararlaştırılması — kuyruk
  adları/ID'leri kendisi secret değildir, yalnız API token'ı secret'tır.
- Bağımsız `/ready` sağlayıcısı seçimi: Cloudflare Standalone Health Checks
  bu Worker'ın gerçek `workers.dev`/özel hostname'i ve hesabın Workers plan
  seviyesiyle fiilen kullanılabiliyorsa o yol; kullanılamıyorsa bağımsız bir
  üçüncü taraf uptime sağlayıcısı (§3). Bu ikisinden en az biri seçilip
  staging'de gerçek bir kanıt (yapılandırma + tetiklenmiş alarm) üretilmeden
  Faz B aktivasyonu tamamlanamaz.
- Scheduled monitor/Cron için bağımsız heartbeat tasarımı: son başarılı çalışma
  zamanı Cron tarafından güncellenir, fakat tazeliği aynı Cron dışında çalışan
  bir gözlemci tarafından denetlenir. Heartbeat'in tenant kapsamı, saklama yeri,
  yazma yetkisi, bayatlık eşiği ve durmuş Worker senaryosundaki staging alarm
  kanıtı Faz B sözleşmesinde belirlenmeden klinik e-posta yolu aktif sayılamaz
  (§3).
- Operasyonel saatler: 7/24 mü, yalnız mesai saatleri mi.
- Yanıt/eskalasyon sorumlusu (isim/rol) — hem platform hem klinik tarafı için.
- Cloudflare hesabının/zone'un Workers plan seviyesi ve üç kuyruğun fiilen
  uygulanan retention değeri (§3) — doğrulanana kadar konservatif 24 saat
  kabul edilir; doğrulanıp Free olmadığı kesinleşirse Terminal-DLQ retention'ı
  4 günde mi kalacak yoksa 14 güne mi yükseltilecek.
- KVKK/veri saklama onayı — ayrı, hâlâ açık bir üretim kapısıdır; bu görev bu
  kararı vermez. En az iki ayrı ön koşula ayrılır (Opus Faz A incelemesi,
  2026-09-05):
  1. Yeni klinik e-posta alıcı deposunun/tablosunun tasarımı — saklama-imha
     süresi, erişim/audit/geri alma kurallarıyla birlikte —
     [`docs/kvkk-inceleme-paketi.md`](kvkk-inceleme-paketi.md) envanterine
     Faz B kapsamında eklenecektir. Bu dosya bugün Task 053'ün izin verilen
     dosyaları arasında değildir; Faz B'nin zorunlu izin-verilen-değişiklikler
     listesine dahil edilecektir.
  2. Seçilen e-posta sağlayıcısı yeni bir veri işleyen (processor) olarak;
     veri konumu, alt işleyenler (sub-processors) ve olası yurt dışı aktarım
     açısından hukuk/KVKK incelemesinden ayrıca geçecektir.
- Webhook imza doğrulama hataları / tekrar eden Meta teslim hataları ile
  tekrarlayan OpenAI extraction hataları
  ([`docs/production-readiness.md`](production-readiness.md) §6'daki iki açık
  kutu) — mevcut dokuz satırlık aktivasyon matrisi (§1/§6) bunları **tam
  karşılamaz**: imza hatası HTTP 401 döner, satır 1'in 5xx kapsamına girmez;
  OpenAI extraction hatası yalnız sonradan DLQ'ya ulaşırsa satır 4 üzerinden
  dolaylı görünür, kendi başına doğrudan bir sinyali yoktur. Bunlar Faz B
  sözleşmesinde ayrıca tasarlanacak açık sinyallerdir; burada uygulanmış gibi
  sunulmaz.
- `dead_letter_handoff` marker-replacement drift'i: mevcut
  [`docs/inbound-queue.md`](inbound-queue.md) sonraki mesajın işareti
  değiştireceğini söylüyor, ancak `src/intakeConsumer.ts` mevcut işaretli
  `human_handoff` snapshot'ını poison fallback'ten önce reddediyor. Faz B,
  sonraki-tur işaretsiz dead-letter provenance tasarımıyla birlikte bu kod ve
  belgeyi tek bir doğrulanmış davranışta uzlaştırmalı; alarm yönlendirmesi
  otomatik marker replacement varsayımına dayanamaz (§1).

Bu belgede veya depoda hiçbir gerçek e-posta adresi, telefon numarası, token,
proje kimliği veya hasta verisi kullanılmamıştır. **Faz A PASS, incelenmiş bir
aktivasyon planı anlamına gelir — satış veya üretim PASS'i değildir.**

## 8. Faz B uygulama durumu (2026-09-05)

Kod ve migration yazıldı. Implementer bunları hiçbir veritabanında veya gerçek
Resend/Cloudflare hesabında çalıştırmadı. Codex daha sonra migration'ı yalnız
disposable `vetai-test` üzerinde doğrudan sorgu olarak uyguladı; düzeltilmiş
rollback fixture'ı geçti ve bağımsız kontrolde sentetik artık bulunmadı.
Migration-history satırı eklenmedi; staging/production, gerçek e-posta ve
aktivasyon hâlâ **NOT RUN**. Ayrıntılı kayıt `CURRENT_TASK.md`'dedir. Bu bölüm
yalnız §7'nin açık maddelerinden hangilerinin kodda karşılığı olduğunu işaretler:

- §7'deki `dead_letter_handoff` marker-replacement drift'i çözüldü:
  `src/intakeConsumer.ts` artık `human_handoff` aşamasındaki tam işaretli
  snapshot'ı poison-fallback'ten önce özel olarak tanıyor ve yanıtsız
  ack'liyor (belge ve davranış artık tek; bkz.
  [`docs/inbound-queue.md`](inbound-queue.md)). Bu, sonraki mesajın işareti
  otomatik değiştirdiği varsayımını kaldırır — konuşma yalnız `/staff`
  üzerinden insan müdahalesiyle açılır.
- Platform e-postası içeriği (§1/§7) ortam adı, tekrar sayısı, ilk-kayıt
  zamanı ve ayrı bir `/admin` bağlantısı içerecek şekilde netleştirildi;
  `/admin` bağlantısı yeni bir `Env` secret'ı eklenmeden, mevcut
  `STAFF_LOGIN_URL`'den aynı origin üzerinde türetiliyor (`/staff` ve
  `/admin` aynı Worker'da servis ediliyor). Tekrar sayısı
  `alert_deliveries.occurrence_count` ile tutuluyor:
  `record_platform_signal`'ın `on conflict` dalı yeni satır eklemek yerine bu
  sayacı artırıyor.
- Cloudflare Queues çözümlemesi, aynı isimde birden fazla kuyruk eşleşirse
  hangi `queue_id`'nin gerçek olduğunu tahmin etmek yerine o çalışmada tüm
  backlog kontrolünü atlıyor (fail-closed).
- Workers Observability sorgusu henüz uygulanmadı: Worker bu aşamada hiçbir
  telemetri çağrısı yapmadan `unavailable` döndüren yan etkisiz bir saplama
  kullanıyor. Gelecekteki sorgunun POST `/webhooks/whatsapp` ile nasıl
  daraltılacağı ve gerçek alan adları hesapta doğrulanmadan bu aşama başarı
  sayılmayacak; §7'nin ilgili maddesi hâlâ açık.
- Heartbeat artık yalnız backlog kontrolü, webhook telemetrisi,
  `sync_alert_delivery_candidates` ve teslim drain'i tamamlandıktan **sonra**
  yazılıyor; çökme/erken dönüş senaryosunda bayat kalır, yanlışlıkla taze
  görünmez.

### Disposable veritabanı kanıtı (2026-09-06)

Codex'in açık sahip onayıyla yürüttüğü disposable `vetai-test` kapısında ilk
fixture koşuları güvenli biçimde rollback ederek üç statik-test boşluğunu açığa
çıkardı: strict-allowlist ingest tanığı için eksik sentetik `ai` rotası,
`claim_alert_delivery` içindeki belirsiz `id` başvurusu ve daha önce kabul
edilmiş bir bildirimi yeni tekrar sanan fixture kapsamı. Kaynak migration ve
fixture dar biçimde düzeltildikten sonra tam rollback fixture'ı geçti; fixture
sonucu altı sentetik artık sayacını `0` verdi. Ayrı katalog sorgusu da RLS'nin
dört alarm tablosunda açık/policy sayısının sıfır olduğunu, claim RPC'sinin
`VOLATILE` + `FOR NO KEY UPDATE` kaldığını, `next_attempt_at` alanının nullable
olduğunu, durum kısıtının doğrulandığını ve heartbeat'in başlangıçta bayat
olduğunu doğruladı.

Bu doğrudan-sorgu kanıtı migration history'yi güncellemedi ve gerçek iki-
oturum yarışını, PostgREST/Worker yolunu, sağlayıcı teslimini veya staging'i
kanıtlamaz. §6'daki dokuz aktivasyon satırının tamamı bu nedenle `NOT RUN`
kalmaya devam eder.

§7'nin geri kalan tüm maddeleri (alıcı listeleri, sağlayıcı/hesap seçimi,
gerçek `queue_id` çözümü, bağımsız `/ready` sağlayıcısı, KVKK/hukuk incelemesi,
operasyonel saatler, yanıt sorumlusu, retention doğrulaması, imza/OpenAI
hataları için ayrı sinyal tasarımı) hâlâ açık ön koşullardır; bu görev
hiçbirini karara bağlamaz.

### Codex incelemesi düzeltmeleri (2026-09-06)

Codex'in `CHANGES_REQUIRED` kararlı incelemesindeki 5 maddeye karşılık gelen
düzeltmeler (ayrıntılar `CURRENT_TASK.md`'deki Task 053 Faz B teslim
kaydında):

- Etkin/yapılandırılmış ayrımı netleşti: `OPERATIONAL_ALERTS_ENABLED` tek
  başına yalnız açık/kapalı anahtarı. Scheduled monitor, teslim claim'i,
  `/ready` ve heartbeat-yazma kararı ayrıca
  Resend, Cloudflare izleme, `STAFF_LOGIN_URL` ve `DEPLOYMENT_NAME`'in hepsinin
  dolu ve geçerli olmasını zorunlu kılan ayrı bir kontrolle kilitleniyor;
  eksik/bozuk yapılandırmada `/ready` artık heartbeat RPC'sine hiç gitmeden
  503 dönüyor.
- Heartbeat artık BEŞ aşamanın (kuyruk backlog, webhook telemetrisi,
  `sync_alert_delivery_candidates`, tekrar/iyileşme zamanlaması,
  teslim drain) HEPSİ kapalı bir "success" sonucu dönmeden yazılmıyor. Webhook
  telemetrisi aşağıdaki doğrulanmamış-API-şekli maddesi yüzünden kalıcı olarak
  "unavailable" döndüğünden, bu haliyle heartbeat şu an hiç ilerlemiyor — bu
  kasıtlı ve sözleşme gereği bir sonuçtur, gerçek hesap doğrulaması
  tamamlanana kadar geçerlidir.
- `schedule_alert_repeat_notifications` RPC'si artık her tick'te sync ile
  teslim drain'i arasında çağrılıyor (migration'da vardı ama önceden hiç
  tetiklenmiyordu).
- Kuyruk backlog kuralları tekilleştirildi: birincil kuyrukta yaş > 5dk VEYA
  art arda 3 ölçümde artan `backlog_count`; DLQ'da `backlog_count > 0`
  koşulsuz; terminal DLQ'da `backlog_count > 0` VE yaş > 12sa birlikte. Daha
  önceki, üçüne birden uygulanan ortak `>= 50` eşiği ve onu pinleyen test
  kaldırıldı.
- Kuyruk id çözümü, üç kuyruk adının HER BİRİ tam ve tekil bir id'ye
  çözülmeden hiçbir sonucu cache'lemiyor veya kullanmıyor; kısmi bir çözüm
  bir sonraki tick'te sıfırdan tekrar denenir.
- `readAlertClaim`, `claim_alert_delivery()`'nin döndürdüğü 10 sütunu tam ve
  kapalı doğruluyor (UUID, e-posta, ISO tarih, pozitif tamsayı, bilinen
  sinyal türü, scope/`clinic_id` tutarlılığı); bilinmeyen `recipient_scope`
  artık `clinic`'e düşürülmüyor, reddediliyor.
- Resend başarı yanıtı artık yalnız 2xx durum koduna değil, dokümante edilen
  `{id: string}` gövdesine göre doğrulanıyor; `id` eksik/boşsa gönderim
  başarısız sayılıyor ve sabit `send_failed` nedeniyle release ediliyor.

### Opus son incelemesi düzeltmeleri (2026-09-06)

- `record_platform_signal`, etkin platform alıcısı yoksa artık koşulsuz
  `recorded` demez; `no_recipients` döner ve Worker bunu `unavailable` sayar.
  Heartbeat yazma ve tazelik sorgusu da en az bir etkin platform alıcısını
  zorunlu kılar; son alıcı kaldırıldığında eski zaman damgası sistemi yeşil
  tutamaz.
- Scheduled monitor ve teslim drain'i tüm yapılandırma tamamlanmadan başlamaz.
  Eksik `STAFF_LOGIN_URL`, `DEPLOYMENT_NAME`, Resend/Cloudflare bilgisi veya
  kuyruk adı artık bir satırı claim edip `send_failed` denemesi tüketemez.
- Claim'in iş kaydı kilidi `FOR NO KEY UPDATE` oldu. Böylece hem açık çözüm
  RPC'sinin `FOR UPDATE` kilidiyle hem de teslim callback tetikleyicilerinin
  sıradan `UPDATE` kilidiyle çakışır; çözülmüş bir teslim-hatası işi için yarış
  sonucu yanlış-pozitif e-posta üretmez. Kilit sırası teslim satırı → iş kaydı
  olarak korunur.
- Teslim deneme sayacı claim anında artar ve `claimed`/`accepted` durumlarında
  1–3 aralığıyla sınırlandırılır. Üçüncü claim'in lease'i cevapsız dolarsa
  sonraki claim çağrısı satırı `attempts_exhausted` ile terminal kapatır;
  release sayacı ikinci kez artırmaz. Kalıcı hata nedenleri yalnız
  `send_failed | attempts_exhausted` kapalı kümesidir.
- Çözülmüş işe bağlı seçilemeyen `pending` artıklar, serbest metin alıcı-audit
  gerekçesi ve isolate-yerel backlog trend geçmişi bloklayıcı olmayan izleme/
  KVKK kalemleri olarak açık kalır. Telemetri saplaması nedeniyle heartbeat'in
  ilerlememesi de aktivasyon öncesi sahip kararı olmaya devam eder.

## Referanslar

- [Cloudflare Queues — limitler (retention/backlog boyutu)](https://developers.cloudflare.com/queues/platform/limits/) — kontrol 2026-09-05
- [Cloudflare Queues — fiyatlandırma (Free plan 24 saat sabit retention)](https://developers.cloudflare.com/queues/platform/pricing/) — kontrol 2026-09-05, ayrıca `docs/staging-runbook.md` §2'de alıntılı
- [Cloudflare Queues — kuyruk yapılandırma (`message_retention_period`)](https://developers.cloudflare.com/queues/configuration/configure-queues/) — kontrol 2026-09-05
- [Cloudflare Queues — dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) — kontrol 2026-09-05
- [Cloudflare Queues — değişiklik günlüğü, gerçek zamanlı backlog metrikleri (2026-04-28)](https://developers.cloudflare.com/changelog/post/2026-04-28-improved-queues-metrics/) — kontrol 2026-09-05
- [Cloudflare Queues — JavaScript API referansı](https://developers.cloudflare.com/queues/configuration/javascript-apis/) (`dateModified: 2026-07-06`) — kontrol 2026-09-05; bu görevde kullanılan yol değildir (producer binding gerektirir), yalnız arka plan referansı
- [Cloudflare Queues — gerçek zamanlı backlog metrikleri (REST API)](https://developers.cloudflare.com/queues/observability/metrics/) — kontrol 2026-09-05; §2/§3'te kullanılan `GET /accounts/{account_id}/queues/{queue_id}/metrics` uç noktasının kaynağı
- [Cloudflare Queues — Get Queue Metrics API referansı (`Queues Read` izni burada listelenir)](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/) — kontrol 2026-09-05; Codex Faz A incelemesinin kabul ettiği doğrudan API-referans kaynağı (yalnız gözlemlenebilirlik rehberine ek); gerçek token oluşturma/staging çağrısı hâlâ NOT RUN
- [Cloudflare Notifications — mevcut bildirim türleri](https://developers.cloudflare.com/notifications/notification-available/) — kontrol 2026-09-05
- [Cloudflare Workers Observability](https://developers.cloudflare.com/workers/observability/) (son güncelleme 2026-08-03) — kontrol 2026-09-05
- [Cloudflare Workers Observability — Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/) — kontrol 2026-09-05; §2'de kullanılan `$workers.event.response.status` alanının kaynağı
- [Cloudflare Standalone Health Checks](https://developers.cloudflare.com/health-checks/) (son güncelleme 2026-08-14) — kontrol 2026-09-05
- [Resend API referansı — e-posta gönderme](https://resend.com/docs/api-reference/emails/send-email) (illüstrasyon amaçlı, sağlayıcı seçimi değildir) — kontrol 2026-09-05
- İç: [`docs/staff-workflow.md`](staff-workflow.md), [`docs/outbound-delivery.md`](outbound-delivery.md), [`docs/staff-work-items.md`](staff-work-items.md), [`docs/production-readiness.md`](production-readiness.md) §5–6, [`docs/olaylar/2026-09-04-route-resolver-405.md`](olaylar/2026-09-04-route-resolver-405.md), [`docs/olaylar/2026-09-05-delivery-latency.md`](olaylar/2026-09-05-delivery-latency.md)
