# Staging kurulum ve gerçek kanıt runbook'u (Görev 034)

Son güncelleme: 2026-08-15, Codex canlı staging yürütmesi (kısmi; Meta
yayın uygunluğu engeli nedeniyle tamamlanmadı).

Bu belge yürütülebilir bir kontrol listesidir; bir üretim onayı veya tam
uçtan uca kanıt değildir. `[x]` yalnızca Codex'in gerçekten yürüttüğü,
sanitize edilmiş sonucu kaydettiği adımı gösterir. Meta uygulaması
yayımlanmamış olduğu için inbound, durum callback'i ve bunlara bağlı AI/
randevu/personel akışları `NOT RUN` durumundadır.

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
      `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
      `OPENAI_API_KEY`.
      Meta erişim token'ı geçicidir; kalıcı staging/pilot için süreli
      sistem-kullanıcısı token'ı ayrı bir üretim öncesi gereksinimdir.
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
- [x] Klinik için `whatsapp_accounts` satırı, seçilen Meta test işletme
      numarasının `phone_number_id`'siyle.
- [ ] Bir sentetik personel Supabase Auth kullanıcısı (örn.
      `staging-tester@example.invalid`) ve klinik personel üyeliği satırı.
- [ ] Bir sentetik sahip ve hayvan.
- [ ] En az bir gelecekteki randevu slotu, UTC yarım saatlik hizada
      (`docs/appointment-booking-engine.md`).
- [ ] Bölüm 6-9 boyunca tutarlı kullanılacak tek bir belirlenmiş test
      gönderici E.164 numarası.

Gerçek bir hasta veya arkadaş konuşması bu ortama asla girmez.

## 6. Meta

- [x] Webhook challenge: staging Worker'a `GET /webhooks/whatsapp?hub.mode=
      subscribe&hub.verify_token=<staging WHATSAPP_VERIFY_TOKEN>&hub.
      challenge=<rastgele>` isteği tam `hub.challenge` değerini `200` ile
      döner.
- [x] Meta panelinde `messages` alanı staging Worker URL'sine abone edilir.
- [ ] §5'teki belirlenmiş göndericiden bir gerçek imzalı inbound WhatsApp
      metin mesajı gönder.
- [ ] Mesajın işlenip persist edildiğini doğrula
      (`docs/inbound-queue.md`, `docs/database-schema.md`).
- [ ] Outbound gönderim ve teslim/okundu durum callback'inin
      (`docs/outbound-status.md`) alındığını doğrula.
- [ ] Sanitize kanıt alanlarını §11 formatında kaydet.

Canlı Meta sonucu: ücretsiz test WABA numarasından doğrulanmış bir test
alıcısına Meta'nın sabit örnek şablon mesajı ulaştı (`PASS`). Bu mesaj
VetAI Worker/outbox tarafından üretilmediği için tam outbound kanıtı sayılmaz.
Uygulama yayımlanmamışken Meta paneli durum olaylarını kendi test tablosunda
gösterdi, ancak Worker tail'e webhook gelmedi. Gerçek inbound, status callback
ve AI zinciri bu nedenle `NOT RUN` kaldı.

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

## 13. Karar tablosu

| Coexistence sonucu | Pilot kararı |
|---|---|
| `VERIFIED` — Business App gelen kutusu inbound+API yanıtlarını gösteriyor, echo döngüsü yok, istenmeyen persist yok | Aynı numarayla pilot, `docs/production-readiness.md` §1 insan onayları da kapandığında ilerleyebilir. Personelin bileşik yanıt arayüzü yoktur — insan kanalı Business App'in kendisidir. |
| `UNAVAILABLE` — herhangi bir engelleyici | `CURRENT_TASK.md`'ye göre incelenmiş bir personel Cloud API composer'ı kontrollü pilot öncesi yeni bir bloklayıcı görev olur; bu görevde composer inşa edilmez, yeni bir görev olarak eskale edilir. |
