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

## 22. Task 051 aktivasyon kontrol listesi — güvenli terminal-handoff kurtarma

Bu bölüm, Task 051'in (`public.resolve_staff_work_item`, bkz.
`docs/database-schema.md` ve `docs/staff-workflow.md`) staging'e aktive
edilmesi için izlenecek, sınırlı bir kontrol listesidir. Task 051 yerel olarak
implemente edilmiş ve disposable veritabanı kapısını geçmiştir; migration
(`supabase/migrations/20260904000200_handoff_conversation_recovery.sql`) ve
rollback-only fixture (`supabase/tests/051_handoff_conversation_recovery.sql`)
implementasyon sırasında (Claude Sonnet tarafından) hiçbir veritabanına karşı
çalıştırılmamıştır. Codex bunları 2026-09-05'te yalnız disposable `vetai-test`
üzerinde direct-query yoluyla doğrulamıştır; staging ve production değişmemiştir.

Ön koşullar (ikisi de sağlanmadan §22'nin geri kalanı çalıştırılmaz):

- [x] Fixture (`supabase/tests/051_handoff_conversation_recovery.sql`),
      disposable `vetai-test` üzerinde Codex tarafından çalıştırılmış ve tüm
      senaryolar dahil sıfır kalıntıyla (`rollback;` sonrası tüm
      13 `select count(*)` sonucu 0) geçmiştir (2026-09-05). Bağımsız artık
      sorgusu da 0 dönmüş; migration direct-query ile uygulanmış ve migration
      history'ye kayıt eklenmemiştir.
- [x] Claude Opus'un salt-okunur incelemesi, en az kilit sırası (clinic →
      exact clinic_staff membership → conversation (yalnız human_handoff) →
      work item), tenant izolasyonu
      (cross-clinic/non-member/anon reddi) ve tarihsel-onarım backfill'inin
      tam olarak §"Decision 10" koşullarıyla eşleştiği konularında PASS
      sonucu vermiştir (2026-09-05; bloklayıcı bulgu yok).

Sıra (yalnız Codex tarafından, ayrı sahip onayından sonra):

1. [x] Migration, güncel `wrangler.staging.toml` hedefiyle yalnız `vetai-staging`
   üzerinde ve aynı konuşma için eşzamanlı intake trafiği olmayan kısa bir
   bakım penceresinde uygulanır. Uygulama sonrası, `status = 'handoff'` ve
   `intake_stage = 'human_handoff'` olduğu halde açık bir `human_handoff` işi
   bulunan konuşmalar salt-okunur sorguyla kontrol edilir; bulunan satırlar
   otomatik olarak değiştirilmez ve ayrı incelemeye alınır.
2. [x] Katalog kontrolü: `public.resolve_staff_work_item`'ın kimliği, `VOLATILE`,
   `SECURITY DEFINER`, boş `search_path`, ve grant durumu (`authenticated`
   izinli; `PUBLIC`/`anon`/`service_role` reddedilir) staging'de salt-okunur
   sorgularla doğrulanır — fixture'daki Section 1/2 kontrollerinin aynısı,
   gerçek veri değiştirmeden.
3. [x] Staging'de gerçek klinik/sahip verisi kullanılmadan, sabit sentetik bir
   `human_handoff` iş kaydı üretilir (ör. mevcut bir test kliniğinde sentetik
   bir konuşma el ile `handoff` durumuna alınarak). Mevcut bir staff hesabı bu
   kaydı `/staff` sayfasından üstlenir ve çözer; konuşmanın `completed`/
   `completed` durumuna, iş kaydının `resolved` durumuna geçtiği ve
   `state_version`'ın tam olarak bir artışla değiştiği doğrulanır.
4. [x] Aynı sentetik sahipten (gerçek WhatsApp mesajı göndermeden, doğrudan
   `ingest_whatsapp_text_message` ile) ikinci bir mesaj işlenir; bunun yeni ve
   ayrı bir konuşma satırı oluşturduğu, önceki `completed` satırın
   değişmeden kaldığı doğrulanır (bkz.
   [`docs/inbound-queue.md`](inbound-queue.md#fresh-conversation-after-a-resolved-handoff-task-051)).
5. [x] `/staff` sayfasında `emergency_handoff` ve normal `human_handoff`
   nedenleri için çözüm butonunun sırasıyla iki ve tek onay metnini
   gösterdiği, iptalin hiçbir RPC çağrısı yapmadığı elle spot-check edilir.
6. [x] Whitelist'li gerçek staging test numarasıyla normal (acil olmayan) bir
   `human_handoff` oluşturulur, iş `/staff` üzerinden üstlenilip çözülür ve aynı
   numaradan yeni bir WhatsApp mesajı gönderilir. Yeni mesajın eski terminal
   konuşmaya eklenmediği, farklı bir konuşma kimliği oluşturduğu ve müşteriye
   güvenlik sorularının yeniden ulaştığı doğrulanır. Bu canlı kanıtın içeriği,
   telefon numarası veya mesaj metni runbook'a/loga kopyalanmaz. Bu adım §19'u
   da karşılar; doğrudan SQL/RPC ile yapılan 4. adım onun yerine geçmez.

Bu adımların tamamı yalnız Codex tarafından, ayrı sahip onayından sonra
çalıştırılır; hiçbiri bu görevin implementasyon aşamasında çalıştırılmamıştır.

Aktivasyon kaydı (2026-09-05): ayrı sahip onayıyla migration yalnız staging'e
uygulandı ve Worker migration-sonra sırasıyla deploy edildi. Katalog ve açık
handoff kontrolleri geçti. Sentetik `/staff` çözümü ile farklı yeni konuşma
kanıtlandı; sentetik veriler sıfır artıkla temizlendi. Son canlı, acil olmayan
handoff → personel çözümü → yeni mesaj akışında güvenlik soruları cihaza ulaştı;
salt-okunur veritabanı kanıtı eski konuşmanın kapalı, yeni konuşmanın farklı ve
aktif olduğunu doğruladı. Hassas içerik veya kimlik kaydedilmedi. Production
değişmedi.

## 23. Task 052 — salt-okunur gecikme ayrıştırması ve kapanış

2026-09-05 araştırması tamamlandı; ayrıntılı, kimliksiz kanıt
[olay raporundadır](olaylar/2026-09-05-delivery-latency.md). Bu görev migration,
deploy, rota değişimi veya yeni bir canlı mesaj gönderimi yapmadı. §22'nin
önceki kabul kayıtları yeni test yapılmış gibi yeniden işaretlenmedi.

Tekrarlanabilir inceleme sırası:

1. Önce doğru staging hedefini salt-okunur doğrula. Yalnız olayın sınırlı
   zaman penceresini oku; telefon/içerik/provider kimliğini sonuçlara çıkarma.
2. Mesaj, webhook ve outbox'ı aynı klinik + aynı provider-event ilişkisiyle
   bağla. Çıktıya yalnız örnek sırası, zamanlar, durum ve deneme sayısı koy.
   Konuşmaya ait ilk personel işini her mesaja aitmiş gibi eşleştirme.
3. Sağlayıcı zamanını (`messages.created_at`), DB işlem zamanını
   (`webhook_events.received_at`) ve Worker `event received` zamanını ayır.
   Dashboard GMT+3 ise UTC'ye çevir. Duplicate kayıt zamanı yenilenmez.
4. Intake tamamlanması, varsa kullanım kaydı, outbox oluşumu/Meta kabulünü
   karşılaştır. Kabul edilen outbox'ın temizlenmiş lease'inden claim zamanı
   çıkarma. Son sağlayıcı durum zamanı ilk teslim/callback receipt değildir.
5. HTTP yanıt kodunu incele: `outcome=ok` veya sıfır exception, 503'ü dışlamaz.
   Batch/retry/Cron ayarını kaynakla karşılaştır; Queue invocation log zamanı
   Queue'ya giriş zamanı veya her denemenin başlangıcı diye sunulmaz.
6. Resolver katalog etiketi ve gerçek HTTP `/ready` yolunu birlikte kontrol
   et. Olumlu sonuç en çok 30 saniyelik isolate cache'i içerir; Meta/OpenAI
   canlı smoke'un veya olumsuz durum testinin yerine geçmez.
7. Kimliksiz pending/processing/expired sayımlarıyla anlık durumu kontrol et;
   DB sayaçlarını Cloudflare Queue/DLQ backlog değeri olarak sunma. Neden
   belirsizse INCONCLUSIVE yaz; spekülatif düzeltme veya veri temizliği yapma.

Kapanış kanıtı: üç tarihsel gecikmiş zincirin uzun farkı başarılı kayıttan
önce, kayıt → kabul 18.301–22.738 sn; yeni dört yanıt maksimum 23.951 sn.
HTTP 503 ile `outcome=ok` birlikte görüldü (457 ms). Resolver `v`, `/ready`
200/ready; 12:04:49 UTC anında in-flight outbox, süresi geçmiş processing
intake lease ve 10 dakikadan eski pending intake sayıları sıfırdı. Eski failed
outbox silinmedi. Tam tarihsel retry korelasyonu yok; rapor bunu çıkarım olarak
bırakır. Yeni mesaj-bazlı telemetri gerekirse ayrı, gizlilik-incelemeli görev
gerekir.

Karar: gözetimli allowlist staging testlerine **GO**; gözetimsiz gerçek-klinik
üretimine **NO-GO**. Sonraki kapı `production-readiness.md` §6'daki gerçek
alarm/sorumlu takip yolları, staff-send hız sınırı ve üretim hedefi kanıtıdır;
veteriner/KVKK ve ticari onaylar ayrıca gereklidir.

## 24. Task 053 Faz A — işletimsel alarm ve personel bildirim planı

Bu bölüm, Task 053'ün 2026-09-05'te tamamlanan Faz A'sının kaydıdır. Faz A
salt belge üretimidir; bu görev migration, deploy, gerçek e-posta gönderimi
veya rota/konfigürasyon değişikliği yapmadı. Sonuç
[`docs/operational-alerting.md`](operational-alerting.md)'dedir: sinyal-eylem
matrisi, en küçük desteklenen yol araştırması (güncel Cloudflare Notifications/
Observability/Health Checks/Queues-metrik belgeleri, kontrol 2026-09-05),
bağımsızlık gereksinimi, e-posta + sorumlu-takip personel bildirim sınırı,
doğru teslim/eskalasyon kuralları, tamamı NOT RUN aktivasyon kanıt matrisi ve
açık sahip kararları listesi.

Bu bölümde işaretlenecek hiçbir staging adımı yoktur — Faz A'nın kendisi bir
staging aktivasyonu değildir. §19'daki zorunlu canlı gelen mesaj testi bu
görevle tetiklenmedi ve tetiklenmesi gerekmiyor. Faz B (`Queues Read` kapsamlı
Cloudflare API token'ının oluşturulması, e-posta sağlayıcı entegrasyonu,
Health Checks kurulumu gibi implementasyon adımları) yalnız Codex'in Faz A'yı
inceleyip sözleşmeyi ayrıca genişletmesinden sonra, ayrı bir aktivasyon
kaydıyla buraya eklenir. Production ve staging bu görevle değişmedi.

## 25. Task 053 Faz B — depo uygulaması (2026-09-05/06, disposable PASS, deploy yok)

Codex'in genişlettiği Faz B sözleşmesi kapsamında migration
(`supabase/migrations/20260905000100_operational_alerting.sql`), Worker kodu
(`src/operationalAlerts.ts` ve `src/index.ts`/`src/intakeConsumer.ts`
entegrasyonu) ve testler yazıldı; ayrıntılar `CURRENT_TASK.md`'deki Task 053
teslim kaydında. Implementer migration/fixture'ı çalıştırmadı. Codex 2026-09-06
tarihinde ikisini yalnız disposable `vetai-test` üzerinde doğrudan sorgu
yoluyla doğruladı; düzeltilmiş rollback fixture'ı ve bağımsız sıfır-artık/
katalog kontrolü geçti. Bu işlem migration history'yi güncellemedi ve staging
veya production'a uygulanmadı. Gerçek Resend/Cloudflare çağrısı, secret
ekleme/değiştirme ve deploy/commit/push yapılmadı — iki config yalnız `wrangler
deploy --dry-run` ile derlendi. `wrangler.toml`
ve `wrangler.staging.toml`'a eklenen `[vars]` (`OPERATIONAL_ALERTS_ENABLED =
"false"` dahil) ve `.dev.vars.example`'a eklenen iki secret placeholder'ı bu
oturumda deploy edilmedi; bir sonraki gerçek `wrangler deploy` çalıştığında
devreye girer. §19'daki gibi bir aktivasyon kaydı, alarm gerçekten
`OPERATIONAL_ALERTS_ENABLED = "true"` ile etkinleştirilip
[`docs/operational-alerting.md`](operational-alerting.md) §6'daki kanıt
matrisi tamamlanınca buraya eklenir.

## 26. Task 054 Faz A — webhook telemetri sözleşmesi (2026-09-06–07, aktivasyon yok)

Sahip onaylı salt-okunur Cloudflare preflight'ında staging Worker'ın gerçek
aggregate yanıt şekli, `$workers.event.response.status` alanı ve örneklenmemiş
401 tanığı sanitize edilerek doğrulandı. Task 054 Faz A bu sözleşmeyi
`src/operationalAlerts.ts` içinde fail-closed uyguladı ve mock testlerle
doğruladı. Token değeri depoya alınmadı; Worker secret kurulmadı, deploy/flag/
Cron/e-posta çalıştırılmadı. [`docs/operational-alerting.md`](operational-alerting.md)
§6'daki dokuz aktivasyon satırı bu nedenle hâlâ tamamen NOT RUN'dır. Bir
sonraki adım ancak Task 054 Faz A Codex ve zorunlu Opus incelemesi geçtikten
sonra, ayrı sahip onaylı Faz B sırasıdır.

Faz B'de durum alanı bulunan dönen 5xx ile runtime'ın yakalanmamış exception
olayı aynı kanıt sayılmaz. Kontrollü exception tanığı güvenle üretilemiyorsa
ayrı Cloudflare Worker-exception alarmı seçilip gerçek teslimi görülmeden
§24/§6 aktivasyon matrisi kapatılmaz. Aynı kapıda Observability etkinliği,
günlük plan/kota tüketimi ve alım-örneklemesi Cron'dan bağımsız olarak
doğrulanır; sorgu yanıtındaki `abr_level = 1` tek başına bu kanıt değildir.
İlk canlı Cron kanıtı boş aggregate ile geçilmez: güvenli, dolu bir 401 veya
dönen 5xx tanığında `interval`, `sampleInterval` ve `series[].data` biçimi
yeniden okunur. Doğrulanmış şekilden saparsa heartbeat'in `unavailable` kalması
beklenir ve aktivasyon durdurulur; ayrıştırıcı canlı veriye uyacak diye
gevşetilmez.

2026-09-07 Faz B ön kontrolünde bu kapı beklendiği gibi aktivasyonu durdurdu:
Cloudflare arayüzünde saklanmış webhook kayıtları görünürken açık
`workers_trace_events` veri-kümesi seçimi başarılı fakat boş aggregate
döndürüyordu. Run-a-query sözleşmesinde tüm kullanılabilir veri kümelerini
seçtiği belirtilen boş `datasets` listesi aynı salt-okunur sorguda iki imzasız
webhook isteğini `401` grubunda doğru saydı ve
`interval = sampleInterval = 1` biçimini yeniden doğruladı. Yanıtın
`run.query.parameters.datasets` alanı da boş listeyi açıkça yankıladı; depo
ayrıştırıcısı bu alanın varlığını ve boşluğunu artık fail-closed doğrular. Depo
düzeltmesi inceleme ve deploy edilmeden alarm bayrağı açılmaz. Üç staging
kuyruğunun bu kontrolde doğrulanan retention değeri 86.400 saniyedir (24 saat).

Opus kod için `PASS` verdikten ve üç kanıt metni düzeltildikten sonra, sahibin
açık onayıyla hesap kimliği repo değişkeninden staging Worker secret'ına
taşındı ve düzeltme alarm bayrağı hâlâ `false` iken deploy edildi. Son sürüm
`86d08e72-ab35-4262-abd4-d78a3fa6b635`; secret listesi yalnız ad/tür okuyarak
hem monitoring tokenını hem hesap kimliğini `secret_text` olarak doğruladı.
Son smoke: `/health`, `/ready`, `/staff`, `/admin` 200; imzasız webhook POST'u
401. Bu bir alarm aktivasyonu değildir: alıcı/Resend/e-posta/heartbeat ve §6
matrisinin kalan canlı kanıtları hâlâ açık ve işaretsizdir.

### 26.1 Bağımsız `/ready` monitörü — 2026-09-07

Cloudflare Free planda Standalone Health Checks bulunmadığı doğrulandığı için
bağımsız sağlayıcı olarak Better Stack Free seçildi. `VetAI staging readiness`
monitörü `https://vetai-staging.mehmetsait7072.workers.dev/ready` adresine
gövdesiz/kimlik bilgisiz `GET`, TLS doğrulaması ve üç dakikalık kontrol aralığı
ile oluşturuldu. E-posta bildirimi primary responder'a açıktır.

- [x] İlk dış kontrol `Up`; olay sayısı `0`, kullanılabilirlik `%100`.
- [x] Better Stack `Send test alert` e-postası sahibine ulaştı.
- [x] Gerçek `/ready` 503 olayı ve kesinti bildirimi.
- [x] Endpoint düzeldikten sonra otomatik recovery bildirimi.
- [x] Güvenli rollback ve yeniden `Up` kanıtı.

Bu kutular yalnız bağımsız erişim, gerçek readiness failure/recovery ve
sağlayıcı e-posta kanalını kanıtlar; VetAI alarm sinyallerinin geri kalanını
kanıtlamaz. Test sonunda `OPERATIONAL_ALERTS_ENABLED` yeniden `false` yapıldı;
production ve müşteri trafiği değiştirilmedi.

### 26.2 Sınırlı Resend ve Worker-Cron smoke'u — 2026-09-07

Sahibin ayrı onayıyla yalnız staging'de aşağıdaki sınırlı yol çalıştırıldı:

- [x] Gönderim yetkili ayrı Resend anahtarı yalnız Worker secret'ına yazıldı;
      değer okunmadı veya depoya kaydedilmedi.
- [x] Özel alan adı olmadan Resend test göndericisi yalnız hesap sahibinin
      adresine kullanıldı; gerçek klinik/pilot adresi eklenmedi.
- [x] Denetimli RPC'lerle 1 platform ve 1 aktif test-kliniği alıcısı kuruldu.
- [x] Başlangıçta teslimat sayısı 0 ve heartbeat boştu.
- [x] Kontrollü `true` penceresinde 4 genel teslimatın tamamı `accepted` oldu;
      `pending=0`, `claimed=0`, `failed=0`; heartbeat ilerledi ve `/ready` 200.
- [x] Sahip dört e-postanın tamamını gelen kutusunda gördü.
- [x] Bayrak hemen yeniden `false` deploy edildi; `/ready` tekrar 200.

Bu kayıt yalnız §6 satır 4'ün mevcut staging tanığıyla platform + klinik
teslimini ve geri kapatma yolunu kanıtlar. Yanlış-kiracı, tekrar/retry,
recovery, gerçek readiness failure, diğer sinyal satırları, özel alan adı ve
production aktivasyonu hâlâ `NOT RUN`dır.

### 26.3 Kontrollü dış readiness failure/recovery — 2026-09-07

Sahip onayıyla yalnız `/ready`yi fail-closed düşüren geçici `.invalid`
personel URL'i ve `OPERATIONAL_ALERTS_ENABLED="true"` deploy edildi. `/ready`
503, `/health` ve `/staff` 200 kaldı; eksik yapılandırma kapısı nedeniyle Cron
teslimat claim etmedi. Better Stack gerçek `Down` / devam eden olay açtı.

Geçerli URL ve `OPERATIONAL_ALERTS_ENABLED="false"` hemen geri deploy edildi.
Üç uç 200'e döndü; Better Stack `Validating recovery` sonrasında `Up` oldu ve
olayı kapattı. Sahip hem kesinti hem recovery e-postasını doğruladı. Bu test
satır 2'yi kapatır; diğer sinyal satırlarının kanıtı değildir.

## 27. Task 055 — pilot dönemi gelen kanarya tanımı (2026-09-07, NOT RUN)

§19'daki zorunlu kapanış adımı yalnız **her aktivasyondan sonra bir kez**
çalışır. Gerçek pilot trafiği gün içinde uzun süre sessiz kalabileceği için bu
tek seferlik kontrol, Meta → webhook → Queue → yanıt zincirinin aktivasyonlar
arasında canlı kaldığını kanıtlamaz — zincir aktivasyondan saatler sonra
sessizce kopsa bile `/health` ve `/ready` bunu göstermez (bkz. §19'un
2026-09-04 gerekçesi). Task 055 bu boşluğu kapatmak için, ilk pilot dönemi
boyunca tekrarlanacak, sahibin kendi kontrolündeki ayrı bir kanarya tanımlar.
Bu bölüm yalnız tanımdır; aşağıdaki adımların hiçbiri bu görevde çalıştırılmadı.

**Kapsam:** Backdoor yok, sentetik imza atlaması yok, kalıcı sahte müşteri
kaydı yok. Kanarya yalnız §19'da zaten kullanılan whitelist'li test
numarasından (`staging-test-sender`/`ai` whitelist rotası) gerçek bir Meta
mesajı gönderip gerçek bot cevabını bekler — yeni bir uç, sağlayıcı veya
secret eklenmez.

**Adımlar:**

1. Whitelist'li test numarasından tek bir zararsız mesaj gönderilir (ör.
   `Merhaba`).
2. **Beklenen mutlu-yol süresi: 2 dakika; kesin başarısızlık sınırı: 5
   dakika.** İlk 2 dakika içinde cevap yoksa sonuç `LATE` olarak kaydedilir ve
   beklemeye devam edilir. Mevcut Queue consumer'ın 120 saniyelik ilk yeniden
   deneme gecikmesi ile 60 saniyelik operasyon payı nedeniyle ancak 5 dakika
   sonunda hâlâ cevap yoksa sonuç `FAIL` olur.
3. Operatör yalnız §11 kanıt şablonuna uyan bir satır kaydeder: UTC + TRT
   zaman damgası, adım adı, `PASS`/`LATE`/`FAIL` sonucu, varsa gözlemlenen HTTP/RPC
   durum kodu ve redakte edilmiş takma ad. Mesaj içeriği, telefon numarası,
   sağlayıcı mesaj kimliği veya ekran görüntüsü dışındaki hiçbir şey
   kaydedilmez — §11'in "asla kaydedilmeyenler" listesiyle aynı sınır.
4. **Durdurma kuralı:** 2 dakikadaki `LATE` sonucu tek başına pilotu durdurmaz;
   5 dakika sonunda cevap yoksa `FAIL` yazılır ve §19'daki aynı teşhis sırası
   (Cloudflare Worker log → Supabase edge log) izlenir. İki ardışık `FAIL`
   pilot dönemini durdurur; bir sonraki gerçek
   mesaj denemesi yalnız kök neden bulunup düzeltildikten sonra yapılır — arka
   arkaya kör tekrar denemesi yoktur.
5. **Önerilen sıklık (ilk pilot dönemi):** günde bir kez, mesai saatleri
   içinde sabit bir pencerede (ör. 10:00 TRT). Bu, gerçek pilot trafiğinin
   günlük olarak zaten zincire dokunmasını bekleyen düşük-gürültülü bir alt
   sınırdır; gerçek trafik hacmi arttıkça sıklık azaltılabilir, fakat bu karar
   ayrı bir sahip onayı gerektirir ve bu görevin kapsamı dışındadır.

Bu kanarya `worker_exception`/webhook telemetri monitörünün (§10,
[`docs/operational-alerting.md`](operational-alerting.md) §10) yerine geçmez —
o yol sunucu tarafı hata oranını izler, bu kanarya ise uçtan uca gerçek
kullanıcı yolunun kendisini. İkisi birbirini tamamlar: telemetri monitörü
alarm bayrağı açıldığında otomatik çalışır, bu kanarya ise bayraktan bağımsız,
insan tetiklemeli ve mesaj içeriğinden habersiz kalır. Bu tanımın kendisi
üretime hazırlık kanıtı değildir; gerçek çalıştırma, [`docs/production-readiness.md`](production-readiness.md)
ve KVKK/veteriner/sahip onay kapıları hâlâ ayrı ve açıktır.

**Task 055 aktivasyon ön koşulu (`NOT RUN`):**
`OPERATIONAL_ALERTS_ENABLED="true"` yapılmadan önce
`vetai-worker-exception-monitor` sorgusu gerçek staging hesabında sanitize
edilmiş biçimde bir kez çalıştırılır; en az bir dolu aggregate üzerinde
`groups[0].value`, `groupKey`, `interval` ve `sampleInterval` alanlarının
depodaki katı sözleşmeyle uyuştuğu doğrulanır.
Bayrak açıldıktan sonraki ilk üç dakika içinde `/ready` yanıtında
`alertMonitorHeartbeat: "fresh"` görülmezse bayrak hemen tekrar kapatılır ve
staging aktivasyonu ilerletilmez.

## 28. Task 056 — klinik e-posta uyarı tercihleri (2026-09-07, staging `NOT RUN`)

Task 056, personel kendi kendine yönetilen abonelik tercihini ve platform
admin'in klinik başına rollout anahtarını ekler (ayrıntılar
[`docs/operational-alerting.md`](operational-alerting.md) §11). Bu görevde
Codex migration'ı disposable `vetai-test` üzerinde doğrudan sorgu olarak
uyguladı; rollback fixture ve bağımsız katalog/grant/sıfır-artık sorgusu
geçti. Bu bir migration-history kaydı veya staging kanıtı değildir. Aşağıdaki
aktivasyon adımlarının **hiçbiri** çalıştırılmadı:

- Bu migration'ın staging veya production'a uygulanması.
- `pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run` dışında
  gerçek bir staging deploy'u.
- Yeni RPC'lerin (`get_my_clinic_alert_preferences`,
  `set_my_clinic_alert_preference`, `get_platform_clinic_alert_gates`,
  `set_platform_clinic_alert_gate`) staging hesabına karşı gerçek bir
  çağrısı.
- Gerçek bir e-posta gönderimi — bu görev yalnız hangi personelin/kliniğin
  mevcut alarm teslimat yoluna dahil olacağını daraltır, §3/§7'deki teslimat
  mekanizmasının kendisini değiştirmez.

Yerel olarak çalıştırılan ve geçen: `pnpm typecheck`, `pnpm test` (tüm suite,
Codex/staging kanıtı hariç), ilgili dry-run deploy komutları. Bunların hiçbiri
staging/production kanıtı yerine geçmez.

## 29. Task 057 — staging alarm kontrolleri aktivasyon kaydı (2026-09-08, tamamlandı ve kapatıldı)

Bu bölüm yalnız `vetai-staging` üzerinde, sahip onayıyla yürütülen sınırlı
entegrasyon penceresinin sanitize edilmiş kaydıdır. Production değiştirilmedi.

- `20260907000100_worker_exception_alert` ve
  `20260907000200_clinic_alert_preferences` yönetilen migration history'ye bu
  sırayla uygulandı. Dokuz sinyal değeri, RLS/no-policy, grant, volatility,
  `search_path`, trigger/epoch ve varsayılan-kapalı klinik anahtarı katalogdan
  doğrulandı.
- Bayrak kapalı Worker önce yayımlandı. `/health`, `/ready`, `/staff` ve
  `/admin` 200 verdi. `/staff` yalnız çağıranın kendi tercihini, `/admin`
  yalnız klinik rollout anahtarını değiştirdi; hiçbir arayüz e-posta veya
  alıcı kimliği göstermedi. Gerçek durum geçişleri audit'e yazıldı,
  idempotent durumlar yeni audit üretmedi.
- Gerçek Cloudflare hesabında tam `vetai-worker-exception-monitor` sorgusu
  sanitize edilmiş biçimde çalıştırıldı. Dolu `ok` aggregate'ı; beklenen
  outcome/group anahtarını, `interval=1`, `sampleInterval=1`, tamamlanmış/dry
  run, doğru hesap/script echo'su ve boş raw-series yüzeyini doğruladı. Token,
  ham olay, header, mesaj veya sağlayıcı kimliği saklanmadı.
- İlk kontrollü `true` penceresinde heartbeat üç dakika içinde `fresh` oldu.
  Geçiş sırasında Better Stack kısa bir readiness olayı gördü ve sonra `Up`
  durumuna döndü. Platform kapsamlı sentetik `worker_exception` teslimatı
  `accepted` oldu ve sahip e-postayı gördüğünü doğruladı. Aynı penceredeki
  zararsız allowlist WhatsApp kanaryası iki dakikadan kısa sürede yanıtlandı;
  sahip yanıtı cihazında doğruladı.
- İkinci kısa pencerede açıkça test olduğu belirtilen acil-devir mesajı bir
  `human_handoff_urgent` adayı üretti. Sanitized DB kanıtı bir inbound ve bir
  outbound mesaj, outbox'ta `accepted:read` ve doğru klinik kapsamını gösterdi.
  Klinik e-postası üç sınırlı denemenin ardından sabit `send_failed` nedeniyle
  `BLOCKED` kaldı; bu, Resend test göndericisinin keyfi klinik alıcısını
  kanıtlayamama sınırıyla tutarlıdır. Auth-owned alıcı adresi değiştirilmedi,
  sağlayıcı hatası veya kişisel veri kaydedilmedi.
- Kapanışta klinik rollout anahtarı denetimli RPC ile kapatıldı ve Worker
  `OPERATIONAL_ALERTS_ENABLED="false"` olarak yeniden yayımlandı. Son kanıt:
  etkin klinik anahtarı `0`, claimed teslimat `0`, platform accepted `1`,
  klinik accepted `0`, açıklanmış urgent `send_failed` `1`, gate audit `6`,
  recipient audit `6`; kişisel opt-in etkisiz biçimde saklı kaldı. `/health`,
  `/ready`, `/staff`, `/admin` tekrar 200 ve Better Stack `Up` idi. Açıkça
  sentetik olan urgent work item, personel oturumu sona erdiği için `open`
  bırakıldı; WhatsApp cevabı zaten `accepted:read` ve iki e-posta kapısı da
  kapalıdır. Sonraki yetkili personel oturumunda normal çözüm akışıyla
  kapatılmalıdır.

Bu kanıt özel gönderici alan adı, keyfi klinik alıcısı, sürekli alarm
aktivasyonu, production, veteriner onayı veya KVKK/hukuk onayı değildir.

## 30. Task 058 — özel alan adı aktivasyon kontrol listesi (yalnızca belge, NOT RUN)

Tek kaynak [`docs/production-readiness.md`](production-readiness.md) §8'dedir;
burada tekrar edilmiyor. Bu görevde tüm adımlar `NOT RUN` kaldı: hiçbir alan
adı bağlanmadı, Supabase Auth ayarı değişmedi, Better Stack monitor
güncellenmedi. Görev yalnızca `/staff` ve `/admin`'i ortak native bir kabukla
(paylaşılan `src/panelStyles.ts`, 4 sekmeli personel navigasyonu, admin'de
açık tehlike/uyarı ayrımı) yeniden düzenledi; staging'in `workers.dev` hedefi
ve bu runbook'taki mevcut kanıtlar değişmeden kaldı.


## 31. Task 059 — Pati Hattı markası ve staging özel alan adı (2026-09-10)

Task 059, sahibin satın aldığı `patihatti.com` alan adı üzerinde **yalnız
staging** tarafını devreye aldı. Production uygulama origin'i
`app.patihatti.com` bilinçli olarak **rezerve** edildi ve hiçbir yere
yönlendirilmedi. Adım bazlı PASS / PENDING / NOT RUN ayrımının tek kaynağı
[`production-readiness.md`](production-readiness.md) §8.1'dir; burada
tekrarlanmaz.

Dış servis tarafında yapılanlar (sahip oturumda, sırasıyla):

1. `patihatti.com` Cloudflare Registrar üzerinden satın alındı. Yenileme
   maliyeti ve kayıt verileri depoya yazılmadı.
2. `staging.patihatti.com`, `vetai-staging` Worker'ına Cloudflare custom
   domain olarak bağlandı (`wrangler.staging.toml` içindeki `routes` girdisi).
   Eski `workers.dev` adresi **kaldırılmadı**; doğrulama boyunca yedek kalıyor.
3. Supabase Auth: Site URL ve tam izinli dönüş adresleri staging staff/admin
   yolları için eklendi. Wildcard eklenmedi; eski staging girdileri korundu.
4. Resend'de `mail.patihatti.com` gönderici alt alan adı oluşturuldu, üç DNS
   kaydı Cloudflare'e girildi ve internetten doğru cevap verdiği görüldü.
   İlk DNS yayılımında `Pending` görüldü; 2026-09-11 kapanış kontrolünde
   Resend'in kendi durumu `Verified` olarak doğrulandı.
5. Better Stack readiness monitörü yeni origin'e taşındı, adı
   `Pati Hattı staging readiness` oldu ve `Up` durumu görüldü.

Depo tarafında yapılanlar: müşteriye görünen `VetAI` metinleri `/staff`,
`/admin`, gizlilik sayfası, tarayıcı bildirimi ve operasyonel uyarı e-posta
konularında `Pati Hattı` olarak değiştirildi. **Dahili adlar değişmedi** —
`vetai` Worker/Queue adları, veritabanı nesneleri, migration dosyaları ve
ortam anahtarları aynı kaldı. Tarihsel kanıtların (olay raporları, geçmiş
görev kayıtları) içindeki eski adlar bilinçle korundu; onları yeniden
adlandırmak kanıtı tahrif etmek olurdu.

### 31.1 Bağımsız doğrulama (inceleme oturumu, 2026-09-10)

Aşağıdakiler rapordan alınmadı; yeni origin'e doğrudan istek atılarak
görüldü:

- `GET /health` -> `200`, `status: ok`
- `GET /ready` -> `200`, `status: ready`
- `GET /staff/config.json` -> `200`, **staging** Supabase projesi
- `GET /admin/config.json` -> `200`, **staging** Supabase projesi
- `GET /staff` -> Task 058 panel kabuğu render ediliyor, sekme başlığı
  `Pati Hattı Personel Paneli`, personel sekmeleri girişten önce görünmüyor

Yerel kapı, çalışma ağacının birebir kopyası üzerinde ayrıca yeniden
üretildi: `pnpm install --frozen-lockfile`, `pnpm typecheck` (0 hata),
hedefli dört test dosyası (**447 geçti**), tam paket (**2.132 geçti /
2 atlandı / 0 başarısız**), production ve staging `wrangler deploy --dry-run`
(ikisi de **312.61 KiB / gzip 65.94 KiB**) ve whitespace kontrolü. 2.132/2
sayısı Task 058 taban çizgisiyle birebir aynı; markalama değişikliği hiçbir
regresyon getirmedi.

### 31.1a Kimlik doğrulama akışlarının kanıtı (aynı gün, yeni origin)

- `/admin`: parola girişi + TOTP AAL2 doğrulaması geçildi ve klinik genel
  bakış tablosu render edildi. Bu yalnız sayfa açılması değildir: genel bakış
  RPC'si JWT `aal` iddiası tam olarak `aal2` olmayan her çağıranı reddediyor,
  dolayısıyla tablonun dolu gelmesi ikinci faktörün ve Supabase dönüş
  adreslerinin bu origin üzerinden çalıştığını kanıtlar.
- `/staff`: parola girişi geçildi ve personel iş kuyruğu render edildi.
  Kuyrukta o an dört açık iş görüldü (biri `[ACIL]`, Task 057'nin bilinçli
  açık bırakılmış sentetik acil kaydı; en eskisi 23.08 tarihli teslimat
  hatası). Hepsi sentetik ve sahipsiz.
- 2026-09-11'de Supabase'den tek parola-kurtarma e-postası gönderildi. Sahip,
  bağlantıyı veya fragment/token değerini paylaşmadan bağlantının
  `https://staging.patihatti.com/admin` üzerindeki `Yeni parola belirle`
  görünümünü açtığını doğruladı.
- Aynı Codex incelemesinde `/staff` ve `/admin` canlı yanıtlarının CSP
  başlıkları okundu; ikisi de yeşil route testlerinin sabitlediği tam değerle
  eşleşti ve browser güven sınırı gevşemedi.

### 31.2 Bu bölümün kapatmadığı şeyler

- Yeni origin'den WhatsApp kanaryası ve sınırlı alarm kanıtı **çalıştırılmadı**.
- Resend alan doğrulaması **tamamlandı** (`Verified`), fakat bu alandan
  **hiç e-posta gönderilmedi**. Gerçek klinik e-posta teslimi hâlâ
  kanıtlanmamış ve alarmlar kapalı.
- Apex `patihatti.com` üzerinde tanıtım sitesi **yok** ve bu görevin kapsamı
  dışında.
- `workers.dev` staging adresi güvenli geri dönüş yolu olarak korunuyor.

Operasyonel alarmlar boyunca kapalı kaldı
(`OPERATIONAL_ALERTS_ENABLED = "false"`); Task 059 hiçbir uyarı e-postası
göndermedi ve production'a dokunulmadı.

## 32. Task 061 — tanıtım anasayfası, statik varlıklar (2026-09-11, yalnızca yerel, NOT RUN)

- `public/index.html`, `public/styles.css`, `public/app.js`, `public/_headers`
  eklendi: bağımlılıksız statik tanıtım anasayfası; aynı sahnede çalışan
  `home -> hopping-right -> right -> approaching -> network -> returning -> home`
  durum makinesi, Golden Retriever tetikleyicisi ve kaydırmasız
  klinik ağı önizlemesi. Ayrıntılar için
  [`docs/marketing-homepage.md`](marketing-homepage.md).
- `wrangler.toml` ve `wrangler.staging.toml`'a **kimlik doğrulama binding'i
  olmayan** aynı `[assets] directory = "./public"` bloğu eklendi; eşleşmeyen
  istekler hâlâ `src/index.ts`'e düşüyor.
- Tam-kare üretilmiş video denemesi, arka plandaki nesne ve ışık değişimleri
  nedeniyle reddedildi. Yerine tek ve değişmez boş bahçe ile aynı maskotun dört
  şeffaf pozu bağlandı. Sağa zıplama, köpek aynı görünür boyutta kalırken
  arka planın kontrollü uzaklaşması ve sola dönük ileri zıplayarak eve dönüş
  yalnız CSS ile belirlenir; geri sarma yoktur. 1280×720 yerel tarayıcıda üç
  tıklamalı tam döngü ve kaydırmasız ağ görünümü doğrulandı.
- İki varlığın toplamı 400 KiB altındadır; çalışma zamanında uzak kaynak,
  analitik veya depolama yoktur. Nihai otomatik kontrollerin kesin sonuçları
  `CURRENT_TASK.md` teslim kaydındadır.
- **Üretim kapısı:** Sabit bahçe ve şeffaf poz sayfası, sahibin onayladığı temiz
  sahne kareleri referans alınarak yerleşik ImageGen akışında üretildi. Bu,
  ticari kullanım iznini tek başına kanıtlamaz. Kaynak/köken kaydı ve ticari izin
  doğrulanmadan staging veya production'a yayın yapılmayacaktır; izin yetersizse
  iki varlık lisanslı ya da sipariş edilmiş eşdeğerlerle değiştirilip kontroller
  yeniden çalıştırılacaktır.
- **Staging'e veya production'a hiçbir deploy yapılmadı.** Bu görev commit,
  push veya deploy içermiyor; tüm değişiklikler işlenmemiş çalışma dizini
  durumunda bırakıldı.
