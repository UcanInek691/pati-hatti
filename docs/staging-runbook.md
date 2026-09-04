# Staging kurulum ve gerçek kanıt runbook'u (Görev 034)

Son güncelleme: 2026-08-23. Faz E yürütüldü ve **gerçek uçtan uca zincir ilk
kez kanıtlandı**: gerçek inbound → imzalı webhook → kalıcılık → `ai` rotası →
Queue → OpenAI → atomik finalize → outbox → gerçek outbound → Meta teslim
durumu callback'i. Kuyruk yönlendirme düzeltmesi deploy edildi, uygulama
yayınlandı, pilot numara bağlandı, personel kullanıcısı ve tek `ai` whitelist
rotası kuruldu, erişim token'ı kalıcı token'la değiştirildi.
Hâlâ `NOT RUN`: §7 seçmeli otomasyon matrisi, §8 manuel devralma yarışı,
§9 güvenlik/randevu smoke'u ve `/staff` arayüzü.

Bu belge yürütülebilir bir kontrol listesidir; bir üretim onayı değildir.
`[x]` yalnızca gerçekten yürütülüp sanitize sonucu kaydedilen adımı gösterir.
Meta uygulaması 2026-08-23'te yayınlandı; §6 zinciri artık kanıtlanmıştır,
ancak §7-§9 hâlâ `NOT RUN` ve üretim onayları (veteriner hekim, KVKK,
hukukçu onaylı gizlilik yüzeyi) kapanmamıştır.

Bu runbook `CURRENT_TASK.md` Faz B'nin uygulama kılavuzudur; sözleşme
`CURRENT_TASK.md` dosyasıdır, bu belge değil.

## 1. Yetki ve maliyet kapısı

Aşağıdaki adımların hiçbiri kullanıcının açık onayı olmadan çalıştırılmaz.
Codex her biri için önce kaynak planını ve varsa beklenen ücreti kullanıcıya
sunar (bkz. `CURRENT_TASK.md` Faz B, madde 2-3):

- [x] Yeni ayrık Supabase staging projesi oluşturma (ücretli plana geçiş
      gerekebilir; bkz. §3).
- [x] Üç Cloudflare staging Queue kaynağının oluşturulması:
      `vetai-intake-staging`, `vetai-intake-dlq-staging`,
      `vetai-intake-terminal-dlq-staging`.
- [x] Yedi secret'ın staging Worker'a yalnızca maskeli/güvenli girdiyle
      girilmesi (bkz. §4 için tam liste).
- [x] `wrangler deploy --config wrangler.staging.toml` ile gerçek deploy.
- [x] Supabase migration-history push (`supabase db push` veya eşdeğeri)
      staging projesine.
- [x] Meta geliştirici panelinde webhook subscription URL/verify token
      değişikliği.
- [ ] Meta test işletme numarasında Coexistence/embedded signup denemesi.
- [ ] Herhangi bir kaynağın silinmesi (bkz. §12).

Bu listedeki hiçbir adım, önceki bir onayın gelecekteki tüm çalıştırmalar
için geçerli olduğu anlamına gelmez; her oturumda yeniden teyit edilir.

## 2. Salt-okunur ön kontrol

Herhangi bir mutasyondan önce, salt-okunur komutlarla:

- [x] Doğrulanmış Cloudflare hesabı ve hesap kimliği (`wrangler whoami`).
- [x] Doğrulanmış Supabase CLI oturumu ve mevcut proje portföyü
      (`supabase projects list`) — link atmadan.
- [x] Doğrulanmış Meta geliştirici hesabı ve ücretsiz test WABA/uygulama erişimi.
- [x] Mevcut Cloudflare Queue/Worker listesi (`wrangler queues list`, Workers
      panosu) — isim çakışması olmadığını teyit için.
- [x] Supabase hedef proje bölgesi ile Cloudflare hesap/Workers planı.
- [x] Beklenen harcama kademesi mutasyondan önce kullanıcıya sunulur. Güncel
      resmi sınırlar ayrıca yeniden kontrol edilir: [Workers Free bugün Queue
      kullanımını kapsar](https://developers.cloudflare.com/queues/platform/pricing/)
      (10.000 işlem/gün, 24 saat sabit retention); Workers Paid en az aylık $5
      ve daha uzun Queue retention sağlar. [Supabase Free iki aktif projeyle
      sınırlıdır](https://supabase.com/pricing) ve boş bir slot varsa staging
      $0 olabilir; yoksa seçilecek ücretli plan ayrıca onaylanır.

## 3. Supabase

- [x] Ayrı, disposable `vetai-test`'ten bağımsız bir staging projesi
      oluştur veya seç. Proje ref'ini yalnızca kullanıcıya onay için göster;
      Git'e, loga veya ekran görüntüsüne ham ref yazma (bkz. §11).
- [x] Onay sonrası `supabase link --project-ref <ref>`.
- [x] Önce migration dry-run çalıştır, çıktısını incele.
- [x] Ardından migration-history push (`supabase db push` veya eşdeğer
      yönetilen akış) — SQL Editor'e yapıştırma değil.
- [x] `20260822000100_strict_ai_allowlist.sql` yalnız bu yönetilen,
      dosya-başına atomik migration akışıyla uygulanır. İfadeleri SQL
      Editor'de tek tek çalıştırma: constraint/default dönüşümü ile
      `pending | processing` outbox temizliği tek transaction olmalıdır.
- [x] `supabase migration list` yerel/uzak karşılaştırması,
      `supabase/migrations/` dizinindeki dosya sırasıyla (şu an son dosya:
      `20260822000100_strict_ai_allowlist.sql`) tam eşleşmeli.
- [ ] `supabase/tests/*.sql` altındaki hiçbir rollback fixture'ı staging'e
      karşı **çalıştırma** — bunların hepsi `rollback;` ile biter ve yalnızca
      disposable `vetai-test` için tasarlanmıştır.
- [x] Gerçek/production verisi kopyalama veya seed etme (hiç yapılmadı).

Sapma kaydı: rollback-only SQL fixture'ları runbook'un ilk sürümündeki
"staging'e karşı çalıştırma" uyarısına rağmen Codex tarafından staging
SQL Editor'de bir kez çalıştırıldı. Tüm dosyalar `rollback;` ile bitti,
17/17 geçti ve sıfır fixture kalıntısı doğrulandı. Bu tekrar edilmez.

Not (Görev 041): `20260831000100_clinic_lifecycle.sql` ve
`supabase/tests/041_clinic_lifecycle.sql` bu runbook'un kapsamı dışında
eklendi — implementer tarafından hiçbir veritabanına uygulanmadı ve
`vetai-staging`'e karşı çalıştırılmadı. Bu dosya bu migration'ı kapsamaz;
bkz. [`docs/clinic-lifecycle.md`](clinic-lifecycle.md).

## 4. Cloudflare

- [x] Üç staging Queue'sunu oluştur:
      `wrangler queues create vetai-intake-staging`,
      `wrangler queues create vetai-intake-dlq-staging`,
      `wrangler queues create vetai-intake-terminal-dlq-staging`.
- [x] Aşağıdaki yedi secret'ı maskeli/güvenli girdiyle gir; dört altyapı
      secret'ı interaktif Wrangler akışıyla, üç Meta secret'ı Cloudflare'ın
      şifreli dashboard alanıyla kaydedildi;
      hiçbir zaman izlenen bir dosyadan pipe etme veya bu belgeye/commit'e
      değer yazma:
      `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
      `WHATSAPP_ACCOUNT_CREDENTIALS_JSON`,
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
      `OPENAI_API_KEY`.
      Meta erişim token'ı geçicidir; kalıcı staging/pilot için süreli
      sistem-kullanıcısı token'ı ayrı bir üretim öncesi gereksinimdir.

      **Not (Task 040 sonrası):** Worker artık `WHATSAPP_ACCESS_TOKEN`'ı
      okumuyor; kod tek bir `WHATSAPP_ACCOUNT_CREDENTIALS_JSON` registry
      secret'ı bekliyor (`whatsapp_account_id`, `phone_number_id`,
      `access_token` alanlı, klinik/hesap başına bir JSON kaydı — bkz.
      [`docs/outbound-delivery.md`](outbound-delivery.md)). Task 040'ın
      Worker'ını staging'e deploy etmeden önce bu secret'ın
      `wrangler secret put WHATSAPP_ACCOUNT_CREDENTIALS_JSON --config
      wrangler.staging.toml` ile ayrıca girilmesi gerekir; tek bir hesabın
      token'ını yenilemek artık registry'deki o hesabın kaydını güncelleyip
      secret'ı yeniden yazmak demektir. Geçiş sırası zorunludur: önce V2 RPC
      migration'ı, sonra yeni encrypted registry secret'ı, unpublished/canary
      `/ready` kontrolü, yeni Worker deploy'u ve hesap başına sentetik
      outbound/status smoke. Eski `WHATSAPP_ACCESS_TOKEN` yalnızca süreli
      rollback penceresinde tutulur; kapı geçince silinir veya döndürülür.
      Rollback gerekirse önce Task 039 Worker'ı geri yüklenir; bu eski Worker
      korunmuş V1 RPC'yi ve rollback penceresindeki legacy secret'ı kullanır.
      V2 için yıkıcı down migration yapılmaz.
- [x] Yalnızca `vetai-staging` Worker'ını deploy et:
      `wrangler deploy --config wrangler.staging.toml`.
- [x] Binding'leri doğrula: Queue producer/consumer, Cron tetikleyicisi
      (`* * * * *`) panoda görünür.
- [x] `GET /health` → `200 { "status": "ok" }`.
- [x] `GET /ready` → `200 { "status": "ready" }`. `503` dönerse dur; hangi
      alanın eksik olduğu loglanmaz, yalnızca yeniden kontrol et.

## 5. Sentetik ön koşullar

- [x] Bir sentetik klinik satırı, adında açıkça "STAGING TEST" ibaresiyle
      (gerçek bir klinikle karıştırılamayacak şekilde).
- [x] Klinik için `whatsapp_accounts` satırı. 2026-08-23'e kadar Meta **test**
      numarasının `phone_number_id`'sini taşıyordu; o tarihte §14.4 uyarınca
      `staging-pilot-number` değerine güncellendi.
- [x] Bir sentetik personel Supabase Auth kullanıcısı ve klinik personel
      üyeliği satırı (2026-08-23). Faz B'de atlanmıştı; `auth.users` boş
      olduğu sürece `/staff` girişi ve `set_whatsapp_contact_route`
      kullanılamıyordu.
- [ ] Bir sentetik sahip ve hayvan.
- [ ] En az bir gelecekteki randevu slotu, UTC yarım saatlik hizada
      (`docs/appointment-booking-engine.md`). Klinik haftalık çalışma saati
      satırı da şu an 0; §9 randevu smoke'u öncesi gereklidir.
- [x] Bölüm 6-9 boyunca tutarlı kullanılacak tek bir belirlenmiş test
      gönderici E.164 numarası kullanıcı tarafından belirlendi. Ham numara
      bu belgeye yazılmaz; `staging-test-sender` takma adıyla anılır.

Gerçek bir hasta veya arkadaş konuşması bu ortama asla girmez.

## 6. Meta

- [x] Webhook challenge: staging Worker'a `GET /webhooks/whatsapp?hub.mode=
      subscribe&hub.verify_token=<staging WHATSAPP_VERIFY_TOKEN>&hub.
      challenge=<rastgele>` isteği tam `hub.challenge` değerini `200` ile
      döner.
- [x] Meta panelinde `messages` alanı staging Worker URL'sine abone edilir.
- [x] §5'teki belirlenmiş göndericiden gerçek imzalı inbound WhatsApp metin
      mesajı gönderildi (Meta'nın "Customer replies" QR akışıyla başlatıldı;
      QR, doğru numara ve WABA'ya gittiğini garanti ettiği için önceki
      belirsizliği ortadan kaldırdı).
- [x] Mesajın işlenip persist edildiğini doğrula
      (`docs/inbound-queue.md`, `docs/database-schema.md`).
- [x] Outbound gönderim ve teslim durum callback'inin
      (`docs/outbound-status.md`) alındığını doğrula. İki outbox satırı ilk
      denemede `accepted` oldu ve ikisinde de `provider_status_at` doldu.
- [x] Sanitize kanıt alanlarını §11 formatında kaydet.

Canlı Meta sonucu (2026-08-23, güncel): uygulama yayınlandıktan ve pilot
numara bağlandıktan sonra gerçek zincir uçtan uca çalıştı — imzalı inbound →
kalıcılık → `ai` rotası → Queue → OpenAI → atomik finalize → VetAI outbox →
gerçek outbound → Meta teslim durumu callback'i. Konuşma
`pet_identification` aşamasına ilerledi.

Önceki (2026-08-15) sonuç tarihsel kayıt olarak durur: o tarihte yalnız
ücretsiz test WABA numarasından Meta'nın sabit şablon mesajı ulaşmıştı; bu
VetAI outbox tarafından üretilmediği için tam outbound kanıtı sayılmamıştı ve
uygulama yayımlanmamış olduğu için Worker'a webhook gelmiyordu.

Teşhis notu: yayın sonrası ilk denemelerde de webhook gelmedi ve nedeni
uzun süre bulunamadı. Ayırt edici test, Meta'nın kendi `messages` alan
`Test` düğmesiydi: o istek Worker'a **ulaştı**, yani callback kaydı, imza
katmanı ve Worker sağlamdı. Gerçek mesajın Worker'a ulaşması ancak Meta'nın
"Customer replies" **QR akışı** kullanıldığında gerçekleşti. Bu, sorunun
yapılandırmada değil, mesajın hedeflenmesinde olduğunu gösterir; ileride
aynı belirsizliğe düşmemek için gerçek inbound testleri **her zaman QR
akışıyla** başlatılmalıdır.

- [ ] Okundu (`read`) durum callback'i ayrıca doğrulanmadı; Worker mesajları
      okundu olarak işaretlemediği için bu beklenen bir boşluktur.

## 7. Seçmeli otomasyon matrisi

Aynı belirlenmiş göndericiyle sırayla (`docs/selective-automation.md`). Önce
hesap varsayılanının `personal` olduğunu doğrula; whitelist dışında AI
çalışması bir test başarısızlığıdır:

0. **Whitelist dışında** — hiçbir kişi rotası eklemeden gönder. Beklenen:
   webhook `200` ack, yalnız zarf yönlendirmesi; içerik okunmaz/hashlenmez/
   kaydedilmez, Queue ve OpenAI çağrılmaz, bot yanıtı yoktur.
   - [ ] Doğrulandı.

1. **Kişisel** — `/staff` üzerinden rotayı kişisel yap, gönder. Beklenen:
   webhook `200` ack, hiçbir owner/conversation/message/`webhook_events`
   satırı oluşmaz, Queue'ya hiçbir iş gönderilmez, OpenAI çağrılmaz, outbox
   satırı oluşmaz.
   - [ ] Doğrulandı.
2. **Sadece insan (manual)** — rotayı manuel yap, gönder. Beklenen: event/
   owner/conversation/message normal gibi persist edilir, intake event
   hemen terminal `completed` olur, Queue'ya gönderilmez, OpenAI çağrılmaz,
   bot yanıtı ve outbox satırı oluşmaz.
   - [ ] Doğrulandı.
3. **AI açık** — exact gönderen numarasını AI olarak whiteliste ekle ve
   gönder. Beklenen: tam zincir — Queue gönderimi, OpenAI çağrısı,
   deterministik yanıt, outbox satırı, teslim.
   - [ ] Doğrulandı.
4. **Whitelist'ten çıkar** — aynı numarada `Numara varsayılanı` seç ve tekrar
   gönder. Beklenen: 0. adım gibi `personal`; yeni AI çağrısı/yanıt yoktur.
   - [ ] Doğrulandı.

## 8. Manuel devralma yarışı

- [ ] AI modundaki bir mesaj Queue tarafından claim edilmişken, finalize
      tamamlanmadan önce aynı kişiyi `/staff` üzerinden manuele çevir.
- [ ] Finalizer'ın güncel rota kontrolü nedeniyle o tur için **yeni bir
      outbox satırı commit edilmediğini** doğrula
      (`docs/selective-automation.md`).
- [ ] Şunu açıkça kaydet: geçişten önce Meta'ya kabul ettirilmiş bir yanıt
      geri çağrılamaz — bu bilinen ve kabul edilen bir sınırdır, hata
      değildir.
- [x] Strict-allowlist aktivasyonu açık AI rotası olmayan `pending` ve
      `processing` satırlarını siler; bu, süresi dolan claim'in yeniden
      gönderilmesini önler. Silinmeden önce sender tarafından Meta'ya verilmiş
      tek bir ağ isteği yine geri çağrılamaz.

## 9. Randevu ve güvenlik smoke

- [ ] Sentetik bir güvenlik/insan-devri ifadesi tetikle; konuşmanın
      `human_handoff`'a ulaştığını ve doğru öncelikle (acil sinyal varsa
      `urgent`) bir `staff_work_items` satırının göründüğünü doğrula.
- [ ] `/staff` ekranında işin görünür/sahiplenilebilir/çözülebilir
      olduğunu doğrula.
- [ ] Ayrı bir sentetik konuşmada randevu teklifi → `EVET` onayını yürüt.
- [ ] Ayrı bir sentetik konuşmada randevu teklifi → `HAYIR` reddini yürüt.

## 10. Coexistence kanıtı

- [ ] Seçilen pilot numara için Meta İşletme Yöneticisi/WhatsApp
      Yöneticisi'nde Business App → Cloud API Coexistence/embedded-signup
      akışını dene (mevcut kullanıcılar için resmi Meta akışı).
- [x] Sonucu §13'teki kapalı tabloya göre tam olarak `VERIFIED` veya
      `UNAVAILABLE` olarak kaydet.
- [ ] `VERIFIED` ise: inbound mesajın Business App gelen kutusunda
      göründüğünü, §6/§7 AI akışından gönderilen API yanıtının Business App
      konuşmasında göründüğünü doğrula; Business App'ten elle bir mesaj
      gönder ve `smb_message_echoes` alanının webhook'a gelip gelmediğini,
      geldiyse mevcut handler'ın onu tanınmayan/desteklenmeyen tür olarak
      ele alıp bot döngüsü veya istenmeyen persist **yaratmadığını**
      gözlemleyerek (koddan varsaymadan) doğrula.
- [x] `UNAVAILABLE` ise: tam sanitize Meta UI/API engelleyici metnini
      (telefon/hesap kimliği redakte edilmiş) kanıt olarak kaydet.

## 11. Kanıt şablonu

Yalnızca şu alanlar kaydedilir: zaman damgası (UTC + `Europe/Istanbul`),
adım adı, kapalı `PASS` / `FAIL` / `NOT RUN` sonucu, HTTP durumu veya kapalı
RPC sonuç adı (örn. `applied`, `already_completed`, `suppressed`), redakte
edilmiş kaynak takma adı (örn. `staging-project`, `staging-worker`,
`test-waba`), ve yalnızca ekran görüntüsü dosya adı.

**Asla kaydedilmez:** ham istek/yanıt gövdesi, telefon numarası, doğrulama/
erişim token'ı, imza, sağlayıcı mesaj kimliği, service-role veya anon
anahtarı, sahip/hayvan adı, mesaj metni.

| Zaman (UTC) | Adım | Sonuç | HTTP/RPC | Kaynak takma adı | Ekran görüntüsü |
|---|---|---|---|---|---|
| 2026-08-14 21:35 UTC / 2026-08-15 00:35 TRT | Meta sabit test şablonu alıcıya ulaştı | `PASS` | Meta paneli: sent | `test-waba` | — |
| 2026-08-14 21:36 UTC / 2026-08-15 00:36 TRT | Worker status webhook gözlemi | `NOT RUN` | Uygulama yayımlanmamış; callback gelmedi | `staging-worker` | — |
| 2026-08-14 21:36 UTC / 2026-08-15 00:36 TRT | Coexistence uygunluğu | `UNAVAILABLE` | WhatsApp Business App hesabı/pilot numarası yok; yalnızca Meta test numarası var | `test-waba` | — |
| 2026-08-22 17:14 UTC / 2026-08-22 20:14 TRT | Strict AI allowlist staging migration | `PASS` | 6/6 katalog kontrolü; migration geçmişi 18/18; dry-run güncel | `staging-project` | — |
| 2026-08-22 | Business App ve doğrudan Coexistence yeniden kontrolü | `UNAVAILABLE` | Business App send/receive çalıştı; Meta direct setup yalnız standart `Add new number` sundu, Coexistence/QR yoktu; wizard gönderimden önce kapatıldı | `staging-app` | — |
| 2026-08-23 11:00 UTC / 14:00 TRT | Staging `GET /privacy` | `PASS` | HTTP 200, Türkçe bildirim tam | `staging-worker` | — |
| 2026-08-23 11:02 UTC / 14:02 TRT | Staging cache-bust'lı `GET /ready` | `PASS` | HTTP 200 `ready` (yalnız biçim denetimi) | `staging-worker` | — |
| 2026-08-23 11:05 UTC / 14:05 TRT | Webhook aboneliği gözden geçirildi | `PASS` | callback URL girili; `messages` abone, `message_echoes` kapalı | `staging-app` | — |
| 2026-08-23 11:20 UTC / 14:20 TRT | Privacy Policy URL girildi ve kaydedildi | `PASS` | "Changes saved"; Yayın sayfası tüm gereksinimleri tamam gösterdi, Publish etkinleşti | `staging-app` | — |
| 2026-08-23 11:25 UTC / 14:25 TRT | Pilot numara kaydı okundu | `PASS` | `Registered`, "Subscribe webhooks" açık | `staging-pilot-number` | — |
| 2026-08-23 11:40 UTC / 14:40 TRT | Staging DB başlangıç durumu okundu | `PASS` | tek hesap/tek sentetik rota; auth kullanıcı, personel, sahip, konuşma, mesaj, event, outbox ve saatler 0 | `staging-project` | — |
| 2026-08-23 11:45 UTC / 14:45 TRT | Hesap `phone_number_id` pilot numaraya bağlandı | `PASS` | 1 satır güncellendi; eski değer test numarasıydı; `personal` korundu | `staging-project` | — |
| 2026-08-23 14:47 UTC / 17:47 TRT | Kuyruk yönlendirme düzeltmesinin deploy'u | `PASS` | `Consumer for vetai-intake-staging` ve `...-dlq-staging` bildirildi | `staging-worker` | — |
| 2026-08-23 14:55 UTC / 17:55 TRT | Uygulamanın yayınlanması | `PASS` | "successfully published"; mod `Published` | `staging-app` | — |
| 2026-08-23 15:00 UTC / 18:00 TRT | Meta `messages` alan `Test` düğmesi | `PASS` | `POST /webhooks/whatsapp`; imza geçti; sahte hesap kimliği beklendiği gibi `failed: 1` sayıldı | `staging-worker` | — |
| 2026-08-23 15:16 UTC / 18:16 TRT | Gerçek inbound (QR akışı) | `PASS` | `processed: 1`; `Queue vetai-intake-staging (1 message) - Ok` | `staging-test-sender` | — |
| 2026-08-23 15:16 UTC / 18:16 TRT | OpenAI + atomik finalize | `PASS` | konuşma `pet_identification` aşamasına ilerledi; outbox satırı oluştu | `staging-project` | — |
| 2026-08-23 15:22 UTC / 18:22 TRT | İlk outbox satırının gönderimi | `FAIL` | 3 deneme, `attempts_exhausted`; sebep eski/geçersiz erişim token'ı | `staging-worker` | — |
| 2026-08-23 15:35 UTC / 18:35 TRT | Yeni token sonrası outbound | `PASS` | iki satır da ilk denemede `accepted` | `staging-worker` | — |
| 2026-08-23 15:35 UTC / 18:35 TRT | Meta teslim durumu callback'i | `PASS` | her iki satırda `provider_status_at` doldu | `staging-worker` | — |
| 2026-08-23 11:55 UTC / 14:55 TRT | Sentetik personel Auth kullanıcısı doğrulandı | `PASS` | kullanıcı mevcut ve e-postası onaylı | `staging-project` | — |
| 2026-08-23 12:00 UTC / 15:00 TRT | `clinic_staff` üyeliği eklendi | `PASS` | 1 satır, rol `admin`, sentetik klinikte | `staging-project` | — |
| 2026-08-23 12:02 UTC / 15:02 TRT | AI whitelist rotası eklendi | `PASS` | RPC `updated`; personel kimliğiyle çağrıldı, `is_clinic_staff` gerçekten geçti | `staging-test-sender` | — |
| 2026-08-23 | `/staff` arayüzünün kendisi | `NOT RUN` | rota RPC ile eklendi; tarayıcı girişi yapılmadı | `staging-worker` | — |

## 12. Durdurma / geri alma / temizlik

1. Önce Meta webhook subscription'ını kaldır veya staging Worker route'unu
   devre dışı bırak/duraklat — yeni inbound kabul edilmesin.
2. Uçuştaki Queue batch'lerinin doğal olarak drain olmasına veya DLQ'ya
   düşmesine izin ver — bir queue'yu asla purge etme.
3. Bir migration düzeltmesi gerekirse, geçmişi düzenlemek yerine
   forward-only bir düzeltme migration'ı yaz ve incelet.
4. Kaynak silme (Supabase staging projesi, Cloudflare Queue'ları, Worker)
   yalnızca açıkça onaylanmış, ayrı bir son adım olarak listelenir —
   oturum sonunda otomatik temizlik yapılmaz.

### 12.1 Migration ve Worker deploy sırası (zorunlu)

Şema değiştiren her görevde sıra sabittir: **önce migration, sonra Worker.**
Geri alırken tam tersi: **önce Worker, sonra (gerekiyorsa) forward-only
düzeltme migration'ı.**

Neden bu yönde:

- Migration önce uygulandığında eski Worker çalışmaya devam eder. Task 035'in
  `finalize_intake_queue_job` genişletmesi buna örnektir: yeni parametreler
  (`p_create_pet_name`, `p_create_pet_species`) `default null` olduğu için,
  9 parametre gönderen eski Worker yeni fonksiyonu sorunsuz çağırır.
- Ters sırada — Worker önce — yeni Worker henüz var olmayan bir imzayı çağırır;
  PostgREST bunu bir fonksiyon-bulunamadı hatasına çevirir ve o inbound mesaj
  batch'i başarısız olup DLQ'ya doğru yol alır. Kullanıcıya giden yanıt kaybolur.
- Geri alırken de aynı asimetri geçerlidir: Worker'ı eski sürüme döndürmek
  tek başına güvenlidir (yeni şema eski çağrıyı kabul eder), ama şemayı önce
  geri almak hâlâ ayakta olan yeni Worker'ı kırar.

Bu sıra, bir migration ve bir Worker değişikliğini aynı görevde taşıyan her
uygulamada geçerlidir; Task 035 (pet onboarding) ilk kullanıcısıdır.

## 13. Karar tablosu

| Coexistence sonucu | Pilot kararı |
|---|---|
| `VERIFIED` — Business App gelen kutusu inbound+API yanıtlarını gösteriyor, echo döngüsü yok, istenmeyen persist yok | Aynı numarayla pilot, `docs/production-readiness.md` §1 insan onayları da kapandığında ilerleyebilir. Personelin bileşik yanıt arayüzü yoktur — insan kanalı Business App'in kendisidir. |
| `UNAVAILABLE` — herhangi bir engelleyici | `CURRENT_TASK.md`'ye göre incelenmiş bir personel Cloud API composer'ı kontrollü pilot öncesi yeni bir bloklayıcı görev olur; bu görevde composer inşa edilmez, yeni bir görev olarak eskale edilir. |

## 14. Faz E — ayrık Cloud API pilot numarası ve staging yayını

`CURRENT_TASK.md` Faz E'nin yürütme kılavuzu. Sözleşme yine
`CURRENT_TASK.md`'dir. Bu bölümdeki her canlı adım `[ ]` başlar ve yalnız
gerçekten yürütülüp sanitize sonucu §11 tablosuna yazıldığında `[x]` olur.

Kullanıcı, mevcut staging WABA'sına Coexistence olmayan ayrı bir pilot
numara kaydetti. Bu bölüm **üretim dağıtımını, üretim verisini, hukuki/KVKK
onay iddiasını veya liste dışı gönderici kullanımını yetkilendirmez.**

### 14.0 Zorunlu ön koşul — kuyruk yönlendirme düzeltmesinden sonra redeploy

`src/index.ts` 2026-08-23'e kadar Queue işlemcisini yalnız production kaynak
adlarıyla (`vetai-intake`, `vetai-intake-dlq`) seçiyordu. `batch.queue`
gerçek kaynak adını taşır ve `wrangler.staging.toml` `-staging` ekli adlar
bildirir; bu nedenle staging'de her batch işlemcisiz kalıp retry'a düşüyor,
üç denemede `vetai-intake-dlq-staging`'e, orada da üç denemede
`vetai-intake-terminal-dlq-staging`'e gidiyordu. Faz E'nin asıl kanıtı olan
gerçek zincir bu haliyle **geçemezdi**.

- [ ] Düzeltilmiş `src/index.ts` ile `vetai-staging` yeniden deploy edilir.
      Redeploy'dan **önce** toplanmış hiçbir staging Queue kanıtı geçerli
      değildir.
- [ ] `vetai-intake-terminal-dlq-staging` içindeki mevcut mesajlar bu hatanın
      sonucudur, gerçek bir arıza değildir. Purge etme (§12/2); yalnızca
      kanıt yorumlarken bu kökeni kaydet.

### 14.1 Deploy ve genel yüzey doğrulaması

- [x] `pnpm exec wrangler deploy --config wrangler.staging.toml` çalıştırıldı.
      Çıktı `Consumer for vetai-intake-staging` ve
      `Consumer for vetai-intake-dlq-staging` bildirdi; §14.0 düzeltmesi
      böylece canlıya çıktı.
- [ ] `GET /health` → `200`. Ayrıca doğrulanmadı; `/ready` ve `/privacy`
      geçtiği için ayrı bir kanıt olarak sayılmadı.
- [x] `GET /privacy` → `200`, Türkçe staging bildirimi tarayıcıda okundu.
      Sayfada uzak varlık, izleme, secret, telefon numarası veya "hukukçu
      onaylı" iddiası yok. Not: bu, gizlilik sayfasını içeren daha önceki bir
      deploy'un kanıtıdır; §14.0 kuyruk düzeltmesi bu sürümde **yok**.
- [ ] `POST /privacy` → `405` ve `Allow: GET`. Tarayıcıdan yalnız `GET`
      yapılabildiği için canlıda doğrulanmadı; yerel testte geçiyor.
- [x] Cache-bust'lı `GET /ready` → `200 { "status": "ready" }`.
      `checkReadiness` yalnız biçim denetimi yapar, hiçbir dış servise istek
      atmaz; bu nedenle `ready` sonucu Meta erişim token'ının **geçerli
      olduğunu kanıtlamaz** (bkz. §14.2).

### 14.2 Meta erişim token'ının tazelenmesi

Faz B kaydındaki `WHATSAPP_ACCESS_TOKEN` Meta'nın 24 saatlik geçici
token'ıdır. Meta panelinin Step 1 konsolu 2026-08-23'te `Not generated yet`
gösterdi ve `/ready` yalnız biçim denetimi yaptığı için token'ın geçerliliği
hakkında hiçbir kanıt vermez. Token'ın durumu bu nedenle **bilinmiyor**;
kesin sonuç ilk gerçek outbound denemesinde görülecektir (`401` ⇒ yenile).

- [x] Meta'nın "Send message" adımındaki **Generate token** akışıyla kalıcı
      bir erişim token'ı üretildi. Eski geçici token'ın gerçekten geçersiz
      olduğu ampirik olarak kanıtlandı: ilk outbox satırı üç denemede de
      reddedilip `attempts_exhausted` ile `failed` oldu.
- [x] Yeni token Cloudflare'ın şifreli secret alanına girildi. Deploy
      gerekmedi; sonraki cron turunda gönderim ilk denemede kabul edildi.
- [ ] **AÇIK GÜVENLİK BORCU:** bu token oturum sırasında bir sohbete
      yapıştırıldı, yani artık bir konuşma geçmişinde duruyor. Kalıcı ve
      mesaj gönderme yetkisi taşıyor. Pilot bittiğinde Meta panelinden
      yeniden üretilerek geçersiz kılınmalı. Bu kayıt, sorunun sessizce
      geçiştirilmemesi için buraya konmuştur.

### 14.3 Meta uygulaması — gizlilik URL'si ve yayın

Yayımlanmamış uygulama yalnız pano kaynaklı test webhook'u alır; gerçek
inbound ve durum callback'i almaz. Faz B'nin takıldığı engel tam olarak
budur ve gerçek zincir kanıtı için bu adım zorunludur.

- [x] App Settings → Basic → **Privacy Policy URL** = `<staging worker>/privacy`
      girildi ve kaydedildi; Yayın sayfası ardından "All required app settings
      are complete" gösterdi ve Publish etkinleşti.
- [x] Zorunlu alanlar Meta tarafından karşılanmış sayıldı; ek alan
      doldurulmadı. **Açık borç:** `Terms of Service URL` ve
      `User data deletion` hâlâ Faz B'den kalma `https://www.facebook.com/`
      değerini taşıyor. Meta yayını bloklamıyor ama bunlar doğru değil ve
      üretim öncesi hukukçu onaylı gerçek sayfalarla değiştirilmelidir.
- [ ] Uygulama **yayınlanır** (Live). Bu geri alınabilir ama kamuya açık bir
      durum değişikliğidir; yalnız kullanıcının o an verdiği açık onayla
      yapılır.
- [ ] Yayın sonrası webhook challenge yeniden doğrulanır ve `messages`
      alanının hâlâ abone olduğu teyit edilir. Yayın öncesi durum (2026-08-23):
      callback URL girili, `messages` abone, `message_echoes` kapalı (echo
      döngüsü riski bu yüzden şimdilik yok), webhook alan sürümü `v26.0`.
- [x] Pilot numaranın `phone_number_id` değeri panodan alındı. Ham değer
      belgeye/commit'e yazılmadı; §11'de `staging-pilot-number` takma adıyla
      anılır. Numara `Registered` ve "Subscribe webhooks" açık.
- [ ] **Açık uyum riski:** webhook alanları `v26.0`, Worker'ın
      `WHATSAPP_GRAPH_API_VERSION` değişkeni ise `v25.0`. İkisi farklı
      yönler (gelen payload vs. giden Graph çağrısı) olduğu için bugün
      bloklayıcı değil, ama Meta'nın kendi uyarısı sürüm hizası ister; ilk
      gerçek akıştan sonra gözden geçirilmelidir.

### 14.4 Supabase staging — numara bağlama ve katı AI whitelist'i

Şema hatırlatması: `whatsapp_accounts (id, clinic_id, phone_number_id,
automation_default)`; `automation_default` Faz D'den beri **yalnız
`personal`** olabilir. `whatsapp_contact_routes (whatsapp_account_id,
clinic_id, contact_e164, mode)` ve yalnız `mode = 'ai'` olan tam satır
otomasyona girer.

Okunan başlangıç durumu (2026-08-23, salt-okunur):
tek klinik, tek `whatsapp_accounts` satırı (`automation_default = personal`),
tek `whatsapp_contact_routes` satırı (sentetik `manual`), ve
`auth.users`, `clinic_staff`, `owners`, `pets`, `conversations`, `messages`,
`webhook_events`, outbox, randevu slotları, personel iş kalemleri ile klinik
haftalık saatlerinin **tamamı 0**.

- [x] Mevcut sentetik "STAGING TEST" kliniğinin `whatsapp_accounts` satırı
      yeni pilot numaranın `phone_number_id` değeriyle güncellendi; satır
      Faz B'den beri hâlâ eski Meta **test** numarasına bağlıydı, yani
      düzeltilmeseydi her gerçek inbound `unknown_account` olurdu.
      `automation_default` `personal` kaldı. Eski değer geri alma için
      oturum kaydında tutuldu; ham kimlikler bu belgeye yazılmadı.
- [x] Personel Supabase Auth kullanıcısı kullanıcı tarafından oluşturuldu
      (e-postası onaylı) ve onun `clinic_staff (clinic_id, user_id, role)`
      üyelik satırı `admin` rolüyle eklendi. `/staff`
      Supabase Auth e-posta+parola ile giriş yapar ve
      `set_whatsapp_contact_route` yalnız o kliniğin personeli için çalışır;
      bu kullanıcı olmadan whitelist adımı yürütülemez.
- [x] Yalnız **tek** belirlenmiş test göndericisi tam `ai` rotası olarak
      eklendi; RPC `updated` döndü. Sapma: `/staff` arayüzünden değil, SQL
      oturumunda personel kimliğine geçilerek (`set local role
      authenticated` + gerçek `auth.uid()`, fixture'ların kullandığı desen)
      **aynı RPC** çağrıldı. Doğrudan tablo yazımı yapılmadı ve
      `is_clinic_staff` yetkilendirmesi gerçekten geçti; ancak bu `/staff`
      arayüzünü test etmiş sayılmaz.
- [ ] `/staff` tarayıcıdan açılır, "katı politika etkin" ifadesini
      gösteriyor mu doğrulanır; göstermiyorsa hesap yükü `personal`
      varsayılanını doğrulamamış demektir ve durulur. §7-§9 zaten `/staff`
      girişini gerektirdiği için bu adım atlanamaz.

### 14.5 Gerçek zincir kanıtı

Buradan sonrası §6-§9'un aynısıdır ve ancak 14.0-14.4 kapandıktan sonra
çalıştırılır.

- [ ] §7/0 — whitelist dışı gönderici: `200` ack, içerik okunmaz/kaydedilmez,
      Queue ve OpenAI çağrılmaz.
- [ ] §6 — belirlenmiş göndericiden gerçek inbound; Queue → OpenAI → atomik
      finalize → VetAI outbox → gerçek outbound → durum callback'i.
      **Queue adımının gerçekten koştuğu** ayrıca teyit edilir (Worker tail
      veya `vetai-intake-staging` metriği); 14.0 hatasının nüksü buradan
      görünür.
- [ ] §7/1-4 — `personal`, `manual`, `ai`, ardından whitelist'ten çıkarma.
- [ ] §8 — manuel devralma yarışı.
- [ ] §9 — güvenlik devri, personel görünürlüğü, randevu `EVET` ve `HAYIR`.
- [ ] Her adım §11 şablonuyla kaydedilir.

### 14.5b Zincir kanıtlandıktan sonra açık kalan kusurlar

Bunlar bu oturumda bulundu, düzeltilmedi ve ayrı birer görev olarak ele
alınmalıdır:

1. **`unknown_account` için `503` dönülüyor.** `src/index.ts` tanınmayan bir
   hesabı `failed` sayıp `503` veriyor. Meta, sürekli `5xx` alan bir
   endpoint'e teslimatı kısabilir; yani bu, kendi kendini besleyen bir arıza
   hâline gelebilir. Doğrusu `200` dönüp olayı sessizce yok saymaktır.
   Meta'nın `Test` düğmesi bu davranışı doğrudan tetikliyor.
2. **Portföyde üç kopya "weosa" WABA'sı var** (`1747631286525524`,
   `853733087706981`, `3647635165398837`); yalnız ilkinde numara var.
   Bu duplikasyon teşhis sırasında ciddi kafa karışıklığı yarattı.
   Temizlenmeli, ama numara bağlıyken silme işine girişilmemeli.
3. **İşletme-başlatmalı mesajlar bloklu:** Meta panelinde "Add payment"
   adımı tamamlanmadığı için şablon gönderimi devre dışı. Kullanıcı-başlatmalı
   24 saatlik pencere içindeki yanıtlar etkilenmiyor, ama hatırlatma/
   bilgilendirme gibi işletme-başlatmalı akışlar üretim öncesi bunu gerektirir.
4. **Erişim token'ı rotasyon borcu** — bkz. §14.2.
5. **`/staff` arayüzü hiç açılmadı.** Whitelist rotası RPC ile eklendi;
   arayüzün kendisi, "katı politika etkin" göstergesi ve personel iş akışı
   test edilmedi.
6. **§9 randevu smoke'unun ön koşulları eksik:** klinik haftalık çalışma
   saatleri ve gelecekteki randevu slotu satırları hâlâ 0.
7. **BLOKLAYICI — kayıtlı hayvanı olmayan sahip sonsuz döngüde kalıyor.**
   Gerçek sohbette gözlendi: kullanıcı "kedim pampık sıkıntılı" yazdı,
   güvenlik kapısı temizlendikten sonra sistem hayvanın adını sordu,
   kullanıcı "pampık" yanıtını verdi ve **aynı soru tekrar soruldu.**
   Kök neden model değil: `conversations.intake_data` içinde
   `pet_name = "pampık"` ve `species = "KEDİ"` **doğru** çıkarılmıştı.
   `resolvePet` (`src/intakeExtraction.ts:236`) yalnız **zaten kayıtlı**
   hayvanlarla eşleştirme yapıyor; eşleşme yoksa `needs_clarification`
   dönüyor ve `src/intakeReply.ts:92` sabit "adını belirtin" metnini
   yeniden gönderiyor. Runtime'da hayvan kaydı **oluşturan hiçbir yol yok**
   (`insert into public.pets` çağrısı mevcut değil).
   Sonuç: ilk kez yazan her hayvan sahibi bu döngüye takılır; kontrollü
   pilot öncesi kapatılması gereken bir ürün boşluğudur. §5'teki "sentetik
   sahip ve hayvan" maddesinin işaretsiz kalması bu boşluğu maskelemişti —
   runbook, hayvanın önceden elle eklenmiş olacağını varsayıyordu.
   Not: bir hayvan oluşturma akışı; kimin adına, hangi onayla ve hangi
   KVKK dayanağıyla kayıt açıldığı sorularını da beraberinde getirir, bu
   yüzden kendi sözleşmesiyle tasarlanmalıdır.

### 14.6 Faz E'nin kapatmadığı şeyler

Bu bölüm tamamlansa bile şunlar açık kalır ve üretim yayınını engeller:
veteriner hekim kopya onayı, Türk hukuku/KVKK onay paketi, hukukçu onaylı
üretim gizlilik yüzeyi (`/privacy` bunun yerine geçmez), ve Coexistence
`UNAVAILABLE` olduğu için §13'e göre gereken incelenmiş personel Cloud API
composer'ı.

## 15. Platform-admin TOTP MFA smoke (Task 045, tamamlandı)

Bu bölüm, Task 045'in `/admin` TOTP MFA sınırını staging'de doğrulamak için
Codex/Opus incelemesinden sonra izlenecek sırayı tarif eder. Uygulayan hiçbir
veritabanı adımı çalıştırmadı. Codex migration ve rollback-only fixture'ı
(`supabase/migrations/20260901000200_platform_admin_totp_mfa.sql`,
`supabase/tests/045_platform_admin_totp_mfa.sql`) yalnız disposable
`vetai-test` üzerinde başarıyla doğruladı. Migration ve Worker 2026-09-01'de
yalnız `vetai-staging` üzerinde etkinleştirildi; katalog denetimi `aal2`
yüklemini ve grant sınırlarını doğruladı. Gerçek parola-kurtarma, yarım kurulum
yenileme, TOTP doğrulama, üyeliksiz reddi ve allowlist sonrası genel bakış
2026-09-02'de geçti; production değişmemiştir. Eski geçersiz e-posta test
hesabının platform yetkisi kaldırıldı, allowlist `1 / 1` doğrulanmış MFA oldu,
fresh-session challenge geçti ve rate-limit değeri kaydedildi. Sıra §1 (yetki
kapısı) ve §3 (Supabase) sonrasını varsayar.

1. **Migration sırası.** `20260901000200_platform_admin_totp_mfa.sql`,
   Task 043'ün `20260831000300_platform_admin_overview.sql` migration'ından
   *sonra* uygulanmalı; fonksiyon `create or replace function` ile yeniden
   tanımlanır, tabloyu veya grantları değiştirmez. Worker/`/admin` shell'i
   migration uygulanmadan önce deploy edilmemeli — deploy edilirse, aal2
   kontrolü olmayan eski fonksiyon hâlâ çalışıyor demektir.
2. **Parola-yalnız reddi.** Migration uygulandıktan hemen sonra, TOTP kurulu
   olmayan bir `platform_admins` hesabıyla `/admin`'e parola ile giriş
   yapılır; genel bakış verisi görünmeden önce kurulum ekranına
   yönlendirildiği doğrulanır (parola tek başına asla yetmemeli).
3. **İlk kurulum.** Aynı oturumda QR kod veya metin anahtarı bir doğrulayıcı
   uygulamaya (ör. Google Authenticator) eklenir, uygulamanın ürettiği 6
   haneli kod girilir; genel bakış verisinin ancak bundan sonra göründüğü
   doğrulanır.
4. **Yarım kalan kurulumun güvenli yenilenmesi.** Ayrı bir sentetik
   platform-admin hesabında kurulum ekranı göründükten sonra kod girmeden
   sayfa yenilenir. Sonraki parola girişinin genel bakış verisini göstermeden
   yalnız tek `unverified` TOTP faktörünü kaldırdığı, yeni bir kurulumla (güvenli
   QR veya doğrulanmış metin anahtarı) devam ettiği ve doğrulama tamamlanınca
   `aal2`'ye ulaştığı doğrulanır.
   Doğrulanmış faktör silinmez; birden fazla, TOTP-olmayan veya bozuk faktör
   durumu operatör ekranında kapalı kalmalıdır. QR, sır ve kod kaydedilmez.
5. **Çıkış ve yeniden challenge.** `Logout` sonrası aynı hesapla tekrar
   parola girişi yapılır; bu kez doğrudan challenge ekranına düşüldüğü
   (yeniden kurulum istenmediği) ve yeni bir 6 haneli kodun tekrar istendiği
   doğrulanır — sayfa yeniden yüklendiğinde de (saklı jeton olsa bile) aynı
   şekilde bir kod istenmelidir.
6. **Üyeliksiz/aal1 reddi.** `platform_admins`'te olmayan bir hesap TOTP
   kurup doğrulasa bile genel bakışın `forbidden` sentinel'iyle reddedildiği;
   ve `platform_admins` üyesi ama aal2'ye ulaşmamış bir oturumun da aynı
   `forbidden` sentinel'iyle reddedildiği (iki durumun UI'dan ayırt
   edilemediği) doğrulanır.
7. **Sunucu tarafı deneme sınırı.** Supabase Auth'un bu proje için uyguladığı
   MFA-verify rate-limit ayarı panelden veya sağlayıcının yetkili yönetim
   yüzeyinden okunur ve yalnız değer/inceleme tarihi kanıt kaydına yazılır.
   İstemcinin kendi başına brute-force sınırı sağladığı varsayılmaz; ayar
   doğrulanamıyorsa production MFA kutusu açık bırakılır.

Bu smoke sırasında **hiçbir QR kodu, metin anahtarı, TOTP kodu veya erişim
jetonu** kanıt şablonuna (§11) veya başka bir kalıcı kayda yazılmaz; yalnızca
"kurulum ekranı göründü / genel bakış göründü / reddedildi" gibi gözlemlenen
sonuçlar ve rate-limit'in hassas olmayan yapılandırma değeri not edilir. Bu
bölüm tamamlanmadan
[`docs/production-readiness.md`](production-readiness.md) 1. bölümündeki MFA
maddesi işaretlenemez.

## 16. Platform-admin parola kurtarma smoke (Task 046)

1. `vetai-staging` Worker, doğrulanmış Task 046 koduyla deploy edilir.
2. Supabase Auth URL Configuration içinde Site URL tam olarak
   `https://vetai-staging.mehmetsait7072.workers.dev/admin` yapılır ve aynı
   tam adres allowed redirect listesinde bulunur. Production URL'i eklenmez.
3. Sentetik staging platform-admin hesabına yeni bir recovery e-postası
   gönderilir. Eski `localhost` bağlantısı veya daha önce paylaşılan bağlantı
   kullanılmaz.
4. Bağlantı `/admin` üzerindeki "Yeni parola belirle" görünümünü açmalı ve
   adres çubuğundaki fragment sayfa yüklenir yüklenmez kaybolmalıdır. Parola,
   URL, kanıt veya loglara yazılmaz.
5. Operatörün seçtiği yeni parola iki kez girilir. Başarıdan sonra normal giriş
   görünmeli; aynı hesapla giriş TOTP kurulum/challenge ekranına gitmeli ve
   parola kurtarma tek başına genel bakışı göstermemelidir.
6. Reload, bozuk/yanlış türde fragment ve süresi geçmiş/yeniden kullanılan
   bağlantı sabit hata metniyle kapanmalıdır. Herhangi bir refresh/recovery/
   access token, parola, QR sırrı veya OTP kanıta alınmaz.

2026-09-01 olay kaydı: eski Site URL nedeniyle ilk e-posta `localhost:3000`e
döndü ve bağlantı içeriği yanlışlıkla sohbete yapıştırıldı. İlgili staging
hesabının `auth.sessions` satırları açık kullanıcı onayıyla silindi; ardından
salt-okunur sayım `0` kalan oturum gösterdi. Ham bağlantı veya bearer değeri
hiçbir repo belgesine kaydedilmedi.

### 16.1 Canlı kanıt — 2026-09-02

- Worker yalnız staging'e deploy edildi; production değiştirilmedi.
- Yeni recovery e-postası staging `/admin` görünümüne ulaştı, kullanıcı yeni
  parolayı kendisi belirledi ve sonraki parola girişi genel bakış yerine TOTP
  istedi. Hiçbir parola veya bearer değeri kaydedilmedi.
- İlk metin anahtarı sohbete yazıldığı için kullanılmadı. Sayfa yenileme ve
  sonraki giriş, yalnız o tek `unverified` TOTP faktörünü kaldırıp yeni kurulum
  başlattı. Yeni anahtar ve altı haneli kod kullanıcıda kaldı; doğrulama geçti.
- `aal2` oturumu allowlist üyeliği yokken tek `forbidden` sonucu gördü. Açık
  kullanıcı onayıyla backend-only bootstrap RPC'si `enabled` döndürdü; aynı
  oturumun salt-okunur yenilemesi tek staging klinik satırını gösterdi.
- Sonraki çıkış/parola girişi yeni altı haneli challenge istedi ve ancak doğru
  koddan sonra genel bakışı açtı. Supabase Auth token-verification sınırı IP
  başına beş dakikada 30 istek olarak kaydedildi. Eski geçersiz e-posta test
  hesabının platform yetkisi onayla kaldırıldı; salt-okunur sayım allowlist ve
  doğrulanmış-MFA sayısını `1 / 1` gösterdi. §16.6'nın canlı bozuk/süresi-geçmiş
  bağlantı denemeleri yapılmadı; fail-closed dallar birim testleriyle kapsandı.

## 17. Platform-admin klinik yaşam döngüsü smoke (Task 047)

Bu bölüm Task 047'nin `/admin` provision/suspend/resume yüzeyini staging'de
doğrulamak için Codex/Opus incelemesinden **sonra** izlenecek sırayı tarif
eder. Uygulayan (implementer) hiçbir veritabanı adımı çalıştırmadı. Codex
migration'ı yalnız disposable `vetai-test` üzerinde CLI query yoluyla
uyguladı; bu yol migration-history kaydı oluşturmadı. Düzeltilmiş rollback-only
fixture geçti ve ayrı sorguda sıfır fixture artığı doğrulandı. Staging
aktivasyonu ve kanıt durumu aşağıdaki kutularda ve §17.1'de kaydedilir;
production değişmemiştir. Sıra §1 (yetki kapısı) ve §3 (Supabase) sonrasını,
ve §15'in (TOTP MFA) tamamlanmış olmasını varsayar — aal2 olmadan bu bölümdeki
hiçbir staging adımı anlamlı değildir.

1. **Migration.** Önce disposable `vetai-test` üzerinde Codex tarafından
   migration ve rollback-only fixture doğrulanır (§3'teki "staging'e karşı
   çalıştırma" kuralı burada da geçerlidir). Ancak bu geçtikten ve Opus
   incelemesi tamamlandıktan sonra migration `vetai-staging`'e uygulanır.
   - [x] Disposable migration + fixture + sıfır-artık kanıtı doğrulandı.
   - [x] Opus PASS sonrasında migration `vetai-staging`'e uygulandı (2026-09-02; kanıt ve sınırları §17.1).
2. **Katalog/fixture denetimi.** Migration sonrası salt-okunur katalog
   kontrolü: `platform_admin_clinic_action_events` tablosunda RLS açık ve
   `service_role` dahil hiçbir grant yok; üç yeni RPC (`platform_provision_
   clinic_v1`, `platform_suspend_clinic_v1`, `platform_resume_clinic_v1`)
   yalnız `authenticated`'a grantlı, `anon`/`service_role`'e değil.
   - [x] Doğrulandı — canlı katalog denetimi geçti; ayrıntılar §17.1'de.
3. **Worker deploy.** Task 047'nin `/admin` değişikliğiyle `vetai-staging`
   yeniden deploy edilir. Migration'dan **önce** deploy edilmez (§12.1'deki
   sabit sıra: önce migration, sonra Worker).
   - [x] Doğrulandı — Worker sürümü `3fe0ecd8-52ff-448f-b078-e7bb5f935936`; §17.1.
4. **aal1 reddi.** TOTP kurulu ama henüz aal2'ye ulaşmamış (veya
   `platform_admins` üyesi olmayan) bir oturumla yaşam döngüsü formlarından
   biri gönderilir; authenticated çağrının HTTP 200 içindeki kapalı
   `result = 'forbidden'` sonucuyla reddedildiği, istemcinin sabit yetki
   hatasını gösterdiği ve hiçbir audit satırı yazılmadığı doğrulanır. Ayrı
   anon/`service_role` katalog-fixture denetimi `insufficient_privilege`
   sonucunu kapsar — istemci tarafı kontrolün tek başına yeterli olmadığının
   kanıtı veritabanından dönen `forbidden` sonucudur.
   - [x] Doğrulandı — rollback-safe authenticated çağrı aal1 için `forbidden`
     döndürdü ve audit sayısını değiştirmedi; ayrıntılar §17.1'de.
5. **aal2 provision (askıya alınmış).** Geçerli aal2 oturumuyla sentetik,
   adında açıkça "STAGING TEST" ibaresi taşıyan yeni bir klinik provision
   edilir. Yeni klinik satırının `operational_status = 'suspended'` ile
   başladığı (asla `active` değil) ve tek bir audit satırının aynı
   transaction'da yazıldığı doğrulanır.
   - [x] Doğrulandı — sentetik klinik `suspended` başladı ve tek `provisioned`
     audit satırı doğrulandı; klinik yeniden askıya alındı.
6. **Dış kimlik bilgisi / hazırlık kontrolleri.** Provision edilen klinik
   hâlâ askıdayken, WhatsApp hesabı için gerçek `phone_number_id` ve
   Cloudflare `WHATSAPP_ACCOUNT_CREDENTIALS_JSON` kaydı §4'teki gibi ayrıca
   girilir; `GET /ready` ve Meta webhook abonelik durumu bu klinik askıdayken
   kontrol edilir. `/admin` bu adımların hiçbirini kendisi yapmaz veya
   doğrulamaz — bu, resume'den önceki manuel bir insan sorumluluğudur.
   - [ ] Gerçek yeni klinik onboarding kapısı — sentetik kliniğe bilerek gerçek
     Meta/Cloudflare kimlik bilgisi verilmedi; klinik `suspended` bırakıldı.
7. **Açık resume.** Yukarıdaki kontroller tamamlandıktan sonra, operatör
   `/admin`'de fresh `window.confirm()` iletişim kutusunu görüp onaylayarak
   kliniği devam ettirir. Confirm metninin dış ön koşulları (WhatsApp,
   Cloudflare, `/ready`, Meta webhook) sıraladığını ama bunları makine
   olarak doğrulamadığını açıkça belirttiği; onaydan sonra
   `operational_status = 'active'` olduğu ve ikinci bir audit satırı
   yazıldığı doğrulanır.
   - [ ] Gerçek yeni klinik onboarding kapısı — dış kontroller tamamlanmadığı
     için sentetik klinik kasıtlı olarak aktif bırakılmadı. Confirm metni birim
     testlerinde sabittir; gerçek onboarding'de operatör tarafından ayrıca
     okunacaktır.
8. **Suspend/resume smoke.** Aynı sentetik klinik tekrar askıya alınır, genel
   bakışta işlem sütununun yalnız "Devam ettir" gösterdiği ve "Askıya al"
   butonunun kaybolduğu; ardından tekrar resume edilerek ters durumun
   doğrulandığı; her iki mutasyonun da kendi `request_id`'siyle bir kez daha
   (aynı UUID'yle) tekrar gönderilmesinin ikinci kez hiçbir yeni audit satırı
   yazmadan aynı sonucu döndürdüğü (replay idempotency) doğrulanır. Ardından
   aynı aksiyon/aktör ve **aynı `request_id`**, fakat farklı bir sentetik
   `p_clinic_id` ile doğrudan authenticated RPC çağrısında yeniden kullanılır.
   Suspend/resume fingerprint'i yalnız klinik kimliğinden türediği için bu,
   ulaşılabilir gerçek uyuşmazlık senaryosudur. RPC'nin `request_id ... reused
   with a different ... clinic or input` exception'ıyla kapalı biçimde
   başarısız olduğu ve yeni audit satırı veya yaşam-döngüsü mutasyonu
   oluşturmadığı doğrulanır. Bu exception kapalı bir `request_id_conflict`
   sonuç kodu değildir.
   - [x] Doğrulandı — canlı UI'da suspend/resume görüldü; rollback-safe doğrudan
     RPC kontrolü exact replay'i, farklı klinikle uyuşmazlık exception'ını ve
     sıfır kalıcı mutasyonu kanıtladı.

Bu smoke sırasında hiçbir gerçek klinik, sahip veya hayvan verisi
oluşturulmaz; yalnız §5'teki gibi adında "STAGING TEST" geçen sentetik
kayıtlar kullanılır ve oturum sonunda temizlenmez (§12 kapsamı dışında ayrı
bir kayıt tutulur). Adım 1–5 ve 8, Task 047 lifecycle-control yüzeyinin staging
kanıtıdır. Adım 6–7 ise her gerçek yeni klinik için ayrıca tamamlanması gereken
onboarding/production kapısıdır.

### 17.1 Staging doğrulama kaydı — 2026-09-02/03

- Task 047 migration'ı `vetai-staging`'e uygulandı; yönetilen migration geçmişi
  Tasks 044, 045 ve 047 dahil yerel dosyalarla hizalıdır.
- Canlı katalog denetimi audit tablosunda RLS açık/no-direct-grant durumunu,
  üç authenticated-only `SECURITY DEFINER` wrapper'ı, exact empty
  `search_path` ayarını ve validated action/result coherence constraint'ini
  doğruladı.
- Worker `3fe0ecd8-52ff-448f-b078-e7bb5f935936` migration'dan sonra deploy
  edildi; `/health` ve `/ready` 200 döndü.
- `/admin` sentetik `STAGING TEST TASK 047` kliniğini `suspended` başlattı ve
  canlı suspend/resume eylemleri çalıştı. Son kontrol pilot kliniği `active`,
  sentetik kliniği `suspended`, beklenen provision/suspend/resume audit
  sayılarını ve iki klinikte de sıfır aktif outbox satırını gösterdi.
- Rollback-safe authenticated transaction aal1 çağrısının `forbidden`
  döndüğünü, exact replay'in kayıtlı sonucu döndürdüğünü ve aynı
  actor/action/request ID'nin farklı sentetik clinic ID ile kullanımının audit
  veya lifecycle mutasyonundan önce exception verdiğini kanıtladı. Kalıcı
  değişiklik oluşmadı.

Task 047'nin sınırlı lifecycle-control yüzeyi staging'de doğrulanmıştır. Ancak
sentetik kliniğe bilerek gerçek Meta/Cloudflare kimlik bilgisi verilmedi ve
klinik `suspended` bırakıldı. Adım 6–7, gerçek yeni klinik onboarding'inde dış
hazırlık kontrolleri yapılıp operatör confirm metnini okuyarak resume edene
kadar açık production kapılarıdır; production değişmemiştir.

## 18. Personel yanıt composer smoke (Task 048)

Bu bölüm Task 048'in `/staff` yanıt composer'ını (`queue_staff_reply_v1`)
staging'de doğrulamak için Codex/Opus incelemesinden **sonra** izlenecek
sırayı tarif eder. Uygulayan (implementer) hiçbir veritabanı adımı
çalıştırmadı. Codex migration'ı yalnız disposable `vetai-test` üzerinde
uyguladı; düzeltilmiş rollback-only fixture PASS verdi ve ayrı sorgu altı veri
kümesinde sıfır fixture artığı ile altı validated CHECK doğruladı. İlk Opus
incelemesinin düzeltmeleri tamamlandı; dar kapanış kontrolü PASS vermeden
staging adımları çalıştırılamaz.
Sıra §1 (yetki kapısı) ve §3 (Supabase) sonrasını varsayar. `/staff` bugün
Supabase Auth ile doğrulanmış klinik-personel oturumu kullanır; Task 045'in
TOTP/`aal2` sınırı yalnız `/admin` içindir ve personel MFA'sı bu görevde
uygulanmış sayılmaz. Bu smoke sırasında hiçbir gerçek klinik, hasta sahibi veya hayvan
verisi oluşturulmaz; yalnız içeriğinde "STAGING TEST" geçen sentetik
work item/konuşma kayıtları kullanılır.

1. **Migration.** Önce disposable `vetai-test` üzerinde Codex tarafından
   migration ve rollback-only fixture (`supabase/tests/048_staff_reply_composer.sql`)
   doğrulanır (§3'teki "staging'e karşı çalıştırma" kuralı burada da
   geçerlidir). Ancak bu geçtikten ve Opus incelemesi tamamlandıktan sonra
   migration `vetai-staging`'e uygulanır.
   - [x] Disposable migration + fixture + sıfır-artık kanıtı doğrulandı
         (2026-09-03; CLI query yolu, migration-history kaydı yok).
   - [ ] Opus PASS sonrasında migration `vetai-staging`'e uygulandı.
2. **Katalog/fixture denetimi.** Migration sonrası salt-okunur katalog
   kontrolü: `queue_staff_reply_v1` yalnız `authenticated`'a grantlı,
   `anon`/`service_role`'e değil; `outbound_message_outbox.message_origin`/
   `staff_window_expires_at` ve `messages.outbound_origin`/
   `staff_actor_user_id` kolonları beklenen check constraint'lerle mevcut.
   - [ ] Doğrulandı.
3. **Worker deploy.** Task 048'in `/staff` composer değişikliğiyle
   `vetai-staging` yeniden deploy edilir. Migration'dan **önce** deploy
   edilmez (§12.1'deki sabit sıra: önce migration, sonra Worker).
   - [ ] Doğrulandı.
4. **Erişim/atama reddi.** Doğrulanmış klinik-personel oturumuyla sırasıyla: kliniğin
   üyesi olmayan bir hesap, askıya alınmış bir klinik, atanmamış/başka
   personele atanmış bir work item, çözülmüş (`resolved`) bir work item ve
   `kind = 'delivery_failure'` bir work item üzerinden composer denenir; her
   birinin authenticated çağrının kapalı `result` değeriyle reddedildiği,
   hiçbir outbox satırı yazılmadığı ve istemcinin sabit genel hata metnini
   gösterdiği doğrulanır.
   - [ ] Doğrulandı.
5. **Süresi dolmuş pencere reddi.** Son gelen mesajı 24 saatten eski bir
   konuşmada composer denenir; sunucu tarafı reddin veritabanı saatinden
   türetildiği (istemci saatinden değil) ve hiçbir outbox satırı
   yazılmadığı doğrulanır.
   - [ ] Doğrulandı.
6. **Mutlu yol — bir gerçek kabul.** Geçerli klinik-personel oturumuyla,
   penceresi açık ve kendisine atanmış gerçek bir `human_handoff` work
   item'ında composer kullanılarak tek bir personel yanıtı kuyruğa alınır;
   `staff` origin ile `pending` outbox satırı oluştuğu, gönderici Worker'ın
   bunu mevcut pipeline ile Meta'ya kabul ettirdiği ve gelen status callback
   sonrası `messages.outbound_origin = 'staff'` olarak kaydedildiği (ama
   personel `staff_actor_user_id` değerinin hiçbir UI sorgusunda
   döndürülmediği) doğrulanır.
   - [ ] Doğrulandı.
7. **Idempotent replay + uyuşmazlık reddi.** Adım 6'nın aynı `request_id`
   değeriyle tekrar gönderilmesinin ikinci bir outbox satırı yazmadan aynı
   `outbox_id`'yi döndürdüğü; aynı `request_id`'nin farklı içerik/work item
   ile yeniden kullanılmasının ise kapalı biçimde başarısız olduğu ve yeni
   satır yazmadığı doğrulanır.
   - [ ] Doğrulandı.
8. **Rota değişikliği personel yanıtını silmiyor.** Adım 6'daki gibi
   `pending` durumda bekleyen bir personel yanıtı varken aynı kişinin
   `whatsapp_contact_routes` modu değiştirilir; personel satırının
   silinmediği, yalnız aynı kişi için varsa bekleyen otomasyon satırlarının
   silindiği doğrulanır.
   - [ ] Doğrulandı.
9. **Sınırların kanıtı.** Composer akışının hiçbir adımında OpenAI çağrısı
   yapılmadığı (network/log kanıtı) ve work item'ın composer tarafından
   otomatik `resolved`/`open` durumuna geçirilmediği (yalnız mevcut manuel
   çözümleme akışının bunu yaptığı) doğrulanır.
   - [ ] Doğrulandı.
10. **Kanıt ve temizlik.** Yukarıdaki adımların sanitize edilmiş kanıtı
    (PII, telefon numarası, mesaj içeriği veya token içermeyen) bu bölümün
    tarihli bir alt bölümüne kaydedilir; sentetik work item/konuşma kayıtları
    temizlenir veya içeriğinde "STAGING TEST" geçtiği için ayrı kayıt
    tutulur.
    - [ ] Doğrulandı.

Adım 1–3 ve 9–10 Task 048'in kendi altyapı/sınır kanıtıdır. Adım 4–8 ise
acceptance kriterlerinin (tenant izolasyonu, 24 saatlik pencere, idempotency,
rota değişikliğinin personel mesajını silmemesi, kuyruk-vs-teslimat ayrımı)
doğrudan staging kanıtıdır. Bu bölümdeki hiçbir adım tamamlanana kadar Task
048 production'a alınamaz; production bu görev boyunca değişmemiştir.

## 19. Zorunlu kapanış adımı — canlı gelen mesaj testi (her aktivasyon)

Bu bölüm 2026-09-04 olayından sonra eklendi
([`olaylar/2026-09-04-route-resolver-405.md`](olaylar/2026-09-04-route-resolver-405.md)).
Yukarıdaki §15–§18 görev-özel smoke'larının yerine geçmez; onlardan sonra
çalıştırılan, göreve bağlı olmayan tek bir zincir kontrolüdür.

**Her staging aktivasyonundan sonra, o aktivasyon kapanmış sayılmadan önce**,
whitelist'li test numarasından bir gerçek WhatsApp mesajı gönderilir ve bot
cevabının geldiği doğrulanır.

Gerekçesi kayda geçmiş bir arızadır: 2026-08-31 ile 09-04 arasında beş görev
(044–048) staging'e alındı ve hepsinin doğrulaması panel (`/admin`, `/staff`)
ve SQL üzerinden yürüdü. Bu süre boyunca **gelen mesaj yolu tamamen
çalışmıyordu**; `/health` ve `/ready` 200 döndüğü ve Cloudflare hata oranı %0
gösterdiği için arıza dört gün fark edilmedi. Panel ve SQL doğrulaması gelen
mesaj yolunu kapsamaz; `/ready` ise tasarımı gereği Supabase'e hiç dokunmaz.

Adımlar:

1. Aktivasyon (migration → Worker deploy) tamamlanır.
2. Whitelist'li test numarasından tek bir mesaj gönderilir (ör. `Merhaba`).
3. Bot cevabının WhatsApp'a ulaştığı **cihazdan** doğrulanır. Cevabın içeriği
   bu adımın konusu değildir; **bir cevabın gelmesi** yeterlidir.
4. Cevap gelmezse aktivasyon **başarısız** sayılır, §11 şablonuna sanitize FAIL
   kaydı yazılır ve sonraki göreve geçilmez.
   - [x] Doğrulandı (2026-09-04 Task 049 aktivasyonu; cihazda yanıt görüldü).

Teşhis sırası, cevap gelmezse: Cloudflare Worker log'unda
`whatsapp webhook event received` satırının basılıp `... persisted` satırının
basılmadığı görülürse hata rota çözümlemesindedir; ardından **Supabase edge
log'unda fonksiyon bazında HTTP durum kodlarına** bakılır. 2026-09-04 olayında
sebebi bulan şey buydu — Cloudflare tarafı yalnız "503 döndü" diyor, hangi
çağrının neden başarısız olduğunu göstermiyor.

## 20. Task 049 aktivasyonu — route-resolver volatility düzeltmesi

Bu bölüm, `docs/olaylar/2026-09-04-route-resolver-405.md` olayının kalıcı
migration'ını (`supabase/migrations/20260904000100_route_resolver_volatility.sql`)
staging'e uygularken izlenecek sırayı sabitler. §19'daki zorunlu canlı gelen
mesaj testinin **yerine geçmez**; ondan önce gelen, bu göreve özel adımlardır.

Sıra:

1. Migration uygulanır (`resolve_whatsapp_contact_automation` `volatile`
   olur).
   - [x] Uygulandı.
2. `pg_proc`/grant/sonuç kataloğu `supabase/tests/049_route_resolver_volatility.sql`
   ile disposable'da doğrulanmış olmalı; burada yalnız staging üzerinde exact
   `pg_proc.provolatile = 'v'`, `SECURITY INVOKER`, exact boş `search_path`,
   `TABLE(result text)` sonuç şekli ve mevcut grantlar (`service_role` evet,
   `PUBLIC`/`anon`/`authenticated` hayır) tekrar kontrol edilir.
   - [x] Doğrulandı.
3. Gerçek bir service-role PostgREST POST'u
   (`/rest/v1/rpc/resolve_whatsapp_contact_automation`) çalıştırılır ve
   yanıtın artık **405 değil** olduğu doğrulanır. Bir SQL Editor çağrısı bu
   adımın yerine geçmez — 2026-09-04 olayının kök nedeni tam olarak SQL
   Editor'ün READ WRITE çalışması ve PostgREST'in READ ONLY çalışmasıydı.
   - [x] Doğrulandı.
4. Worker konfigürasyonu/`/health` kontrol edilir.
   - [x] Doğrulandı.
5. Onaylı staging test kontağı yalnızca bu adımda `manual`'dan `ai`'a geri
   döndürülür (olay sırasında geçici olarak `manual`'a alınmıştı).
   - [x] Doğrulandı.
6. §19'daki zorunlu canlı gelen mesaj/cevap testi çalıştırılır.
   - [x] Doğrulandı.

Bu adımların tamamı yalnız Codex tarafından, ayrı sahip onayından sonra
çalıştırılır; hiçbiri bu görevin implementasyon aşamasında çalıştırılmamıştır.

### 2026-09-04 sanitize aktivasyon kaydı

- Sahip aktivasyonu açıkça onayladı. CLI hedefi `vetai-staging` olarak
  doğrulandı; push öncesi tek bekleyen dosya Task 049 migration'ıydı.
- Managed push yalnız `20260904000100_route_resolver_volatility.sql` dosyasını
  uyguladı. Son migration listesinde local/remote sürümleri 049 dahil birebir
  eşleşti.
- Staging katalog sorgusunda exact fonksiyon sayısı, `provolatile = 'v'`,
  SECURITY INVOKER, boş `search_path`, `TABLE(result text)`, service-role
  EXECUTE izni ve `PUBLIC`/`anon`/`authenticated` retlerinin tamamı `true`
  döndü.
- Gerçek service-role Data API POST'u sentetik ve listelenmemiş bir test
  kontağıyla çalıştı: HTTP `200`, kapalı sonuç `personal`; telefon, hesap
  kimliği veya anahtar çıktıya basılmadı.
- Etkin staging Worker kaydı görüldü; `/health` ve `/ready` HTTP `200` döndü.
  `wrangler.staging.toml` içinde kalıcı observability bloğu bulunmaması Task
  050'nin açık kapsamıdır ve bu aktivasyon sırasında gizlenmedi.
- Yalnız onaylı staging test kontağı `/staff` üzerinden `manual` → `ai`
  yapıldı; ayrı sentetik `manual` rota değiştirilmedi.
- Canlı smoke son on dakikada tam bir webhook, bir inbound mesaj ve bir
  outbound satır üretti; outbox `accepted` oldu ve sahibi yanıtı WhatsApp
  cihazında gördüğünü doğruladı. Mesaj içeriği, telefon numarası, token veya
  imza bu kayda alınmadı.
- Production değiştirilmedi.

## 21. Task 050 aktivasyon kontrol listesi — dependency-aware `/ready` ve Workers Observability

Bu bölüm, Task 050'nin (`docs/olaylar/2026-09-04-route-resolver-405.md` İş 2)
staging'e aktive edilmesi için izlenecek, sınırlı bir kontrol listesidir. Task
050 şu an yalnız yerel olarak implemente edilmiş ve yerel testlerle
doğrulanmıştır; aşağıdaki hiçbir kutu bu görevin implementasyon aşamasında
işaretlenmemiştir ve yalnız ayrı sahip onayı sonrası, gerçek bir staging
deploy sırasında işaretlenebilir. §19'daki zorunlu canlı gelen mesaj/cevap
testinin **yerine geçmez**. Ön koşul: Task 049 zaten staging'e aktive edilmiş
olmalıdır (§20).

Sıra:

1. Worker, güncel `src/index.ts`/`src/readiness.ts`/`src/whatsappCredentials.ts`
   ile `wrangler.staging.toml` kullanılarak deploy edilir.
   - [x] Yapıldı — 2026-09-04, yalnız `vetai-staging`.
2. `GET /health` `200 { "status": "ok" }` döner ve hâlâ hiçbir dış servise
   bağımlı değildir.
   - [x] Doğrulandı — HTTP 200, `status = ok`.
3. `GET /ready` `200 { "status": "ready" }` döner; bu artık yalnız yerel
   konfigürasyon şeklini değil, gerçek `resolve_whatsapp_contact_automation`
   Data API çağrısının da başarılı olduğunu kanıtlar — sabit sentetik kontak
   (`+10000000000`) ve kayıtlı bir `phone_number_id` ile, gerçek müşteri
   verisi kullanılmadan.
   `503` dönerse registry'nin ilk hesabının `whatsapp_accounts` tablosunda
   mevcut olduğu ve bağlı kliniğin yaşam döngüsü durumunun beklendiği gibi
   olduğu kontrol edilir; neden bulunmadan sonraki adıma geçilmez.
   - [x] Doğrulandı — HTTP 200, `status = ready`.
4. Cloudflare panelinde bu Worker için Workers Observability'nin etkin olduğu
   ve bunun panelden elle değil `wrangler.staging.toml`'daki
   `[observability]` bloğundan (`enabled = true`, `head_sampling_rate = 1`,
   `redact_query_string = true`) ve `[observability.logs]` bloğundaki tam
   invocation örneklemesinden
   geldiği doğrulanır — panelden elle açılmış, deploy'dan gelmeyen bir ayar bu
   maddeyi karşılamaz; bu tam olarak olayın kök nedenlerinden biriydi.
   - [x] Doğrulandı — deploy sonrası yeni invocation kayıtları görüldü.
5. Observability'de normal bir invocation ve webhook doğrulama isteği
   spot-check edilir. İstek URL'sinde query string bulunmadığı ve kaydın ham
   istek gövdesi, telefon numarası, mesaj içeriği, token, challenge veya imza
   içermediği doğrulanır.
   Bunlardan biri görünürse aktivasyon durdurulur, §19 canlı smoke yapılmaz ve
   ayrı bir güvenlik düzeltme görevi açılır.
   - [x] Doğrulandı — sentetik doğrulama isteğinin query değerleri kayıtta
     yoktu; yalnız yöntem ve temiz yol görünüyordu.

Bu adımların tamamı yalnız Codex tarafından, ayrı sahip onayından sonra
çalıştırılır; hiçbiri bu görevin implementasyon aşamasında çalıştırılmamıştır.

### Task 050 staging yürütme kaydı — 2026-09-04

Sahibin ayrı onayından sonra yalnız staging Worker deploy edildi. `/health`
200/`ok`, `/ready` 200/`ready` döndü. Cloudflare Observability'de tam invocation
kaydı görüldü; gerçek sır içermeyen sentetik bir webhook doğrulama isteğinde
query string, token ve challenge tutulmadı. Kontrol edilen kayıtlarda ham gövde,
telefon numarası, mesaj içeriği, Auth tokenı veya imza yoktu.

Ardından onaylı test kontağından gerçek bir WhatsApp mesajı gönderildi. Canlı
kayıtlar inbound webhook'u, olayın kalıcılaştırılmasını,
`vetai-intake-staging` Queue çalışmasını ve durum callback'lerini gösterdi;
sahip yanıtın cihazda geldiğini doğruladı. İçerik veya kimlik belirleyici bu
kayda alınmadı. Production değiştirilmedi.
