# Pati Hattı — proje durumu, açıklar ve ekip devam planı

Son doğrulama: **2026-09-14**  
Kaynak sürüm: `bc21507` ve Task 070 denetim değişiklikleri  
Karar: **Pazarlama sitesi yayında; ürün pilotu ve üretim uygulaması NO-GO**

Bu belge ekibin ilk okuma noktasıdır. Ayrıntılı teknik sözleşmelerin yerine
geçmez; mevcut durumu, eksikleri ve doğru ilerleme sırasını tek yerde özetler.
Bir madde burada “uygulandı” diye görünüyorsa bu yalnız kodun var olduğu
anlamına gelebilir. Veritabanı, staging, production ve insan onayı kanıtları
ayrı ayrı belirtilir.

## 1. Kısa sonuç

- `https://patihatti.com/` canlıdır ve yalnız statik pazarlama içeriği sunar.
- `https://staging.patihatti.com/` gerçek Worker, Supabase, WhatsApp, Queue,
  personel ve yönetici yüzeylerinin kanıt ortamıdır; bugün erişilebilir.
- `https://app.patihatti.com/` bağlı değildir ve erişilemez. Production
  `vetai` Worker'ı da Cloudflare hesabında oluşturulmamıştır.
- Ürün çekirdeği geniş ölçüde uygulanmış ve staging'de önemli uçtan uca
  akışları geçmiştir; ancak son klinik güvenlik sıralaması (Task 062) staging'e
  henüz yayımlanmamıştır.
- Veteriner hekim onayı, hukuk/KVKK kararları, production altyapısı ve sürekli
  operasyon sahipliği tamamlanmadan gerçek klinik pilotu açılamaz.
- Klinik e-posta alarm yolu kodda vardır ama nihai durumda kapalıdır. Keyfi
  klinik alıcısına doğrulanmış alan adından gerçek teslim kanıtı henüz yoktur.
- Yerel kalite kapıları yeşildir: 40 test dosyası, **2.187 geçen / 2 bilinçli
  atlanan** test; typecheck ve üç Wrangler kuru paketi başarılıdır.
- Takipli dosyalarda ve Git geçmişinde yaygın gerçek secret/JWT/private-key
  biçimleri bulunmadı. Gerçek yerel secret dosyaları Git tarafından yok sayılır.
- GitHub remote'u yoktur ve yerel `gh` oturumu geçersizdir. Güvenli varsayılan
  özel (`private`) bir `pati-hatti` deposudur.

## 2. Ortamların gerçek durumu

| Ortam | Durum | Kanıt | Ne değildir |
|---|---|---|---|
| Pazarlama production | **CANLI** | `patihatti.com`, robots ve sitemap 200; ürün yolları 404 | Ürün uygulaması, login, form, webhook veya privacy notice değildir |
| Staging ürün | **CANLI / SINIRLI** | `/health`, `/ready`, `/staff`, `/admin` 200; WhatsApp ve randevu smokes geçmiş | Production değildir; alerting sürekli açık değildir; son Task 062 kodu yayımlı değildir |
| Production ürün | **YOK** | `app.patihatti.com` erişilemez; production Worker oluşturulmamış | “Hazır ama DNS bekliyor” diye yorumlanmamalı; DB, Queue, secret, Auth ve monitor kurulumu da gerekir |
| Disposable DB | **KANIT ORTAMI** | Migration/rollback fixture'larının çoğu `vetai-test` üzerinde geçti | Staging/production migration history kanıtı değildir |
| Yerel geliştirme | **SAĞLIKLI** | typecheck, testler ve üç dry-run yeşil | Gerçek sağlayıcı teslimi veya insan onayı değildir |

2026-09-14 salt-okunur HTTP kontrolü:

| Adres | Sonuç |
|---|---|
| `https://patihatti.com/` | 200 |
| `https://patihatti.com/robots.txt` | 200 |
| `https://patihatti.com/sitemap.xml` | 200 |
| `https://patihatti.com/staff` | 404 — bilinçli izolasyon |
| `https://staging.patihatti.com/health` | 200 |
| `https://staging.patihatti.com/ready` | 200 |
| `https://staging.patihatti.com/staff` | 200 |
| `https://staging.patihatti.com/admin` | 200 |
| `https://app.patihatti.com/` | erişilemez — henüz bağlanmadı |

## 3. Özellik matrisi

Durumlar: **Production canlı**, **staging kanıtlı**, **kod/DB kanıtlı**,
**kapalı** ve **eksik** birbirinden ayrılır.

| Alan | Uygulama durumu | En güçlü kanıt | Açık sınır |
|---|---|---|---|
| Pazarlama anasayfası, SEO, sitemap | **Production canlı** | Tasks 063–069 ve canlı apex kontrolleri | Görsel kaynak/ticari kullanım kaydı ve nihai marka/trademark kararı açık |
| İmzalı WhatsApp webhook ingest | **Staging kanıtlı** | Gerçek inbound, persist, Queue ve cevap smokes | Production Meta app/numara/secret kurulumu yok |
| Numara/kişi bazlı `ai/manual/personal` rota | **Staging kanıtlı, matris kısmi** | Tasks 034, 049, 050 | Runbook §7'nin tam seçmeli otomasyon matrisi işaretsiz |
| Luna ile yapılandırılmış çıkarım | **Staging kanıtlı** | Canlı eval ve WhatsApp smokes | İki live-eval testi varsayılan suite'te bilinçli skip; production bütçe/anahtar yok |
| Deterministik sekiz-sinyalli güvenlik kapısı | **Kod kanıtlı; eski staging sürümü** | Task 062 test/eval/Opus PASS | Yenilenmiş veteriner onayı ve üç-sonuç staging WhatsApp kanaryası yok |
| Sabit, teşhis/ilaç/doz içermeyen yanıtlar | **Staging kanıtlı; Task 062 sırası bekliyor** | Reply planner ve geçmiş smokes | Metinlerin güncel veteriner imzası yok |
| Hayvan kaydı ve intake onayı | **Staging kanıtlı** | Tasks 035–038 | Aydınlatma anı ve kayıt provenance kararı hukuk/KVKK'ya bağlı |
| Randevu bulma, hold, kesin `EVET`, `HAYIR` | **Staging kısmen kanıtlı** | Tasks 022–023 ve sonraki smokes | Tam production seed yok; eski runbook'ta `HAYIR`/matris kutuları açık |
| Randevu iptali | **Staging kanıtlı** | Task 039 canlı iptal/yeniden rezervasyon | Yeniden planlama, hatırlatma ve dış takvim yok |
| Burst birleştirme | **Staging kanıtlı** | Task 039 canlı iki-mesaj smoke | At-least-once/retry sınırları devam eder |
| İnsan devri ve acil öncelik | **Staging kanıtlı** | Staff work items ve gerçek handoff smokes | Açık insan isteğinde aciliyet “değerlendirilmemiş” olarak ayrı modelle temsil edilmiyor |
| Devir çözümü sonrası yeni konuşma | **Staging kanıtlı** | Task 051 gerçek handoff→resolve→new-message | Yetkili personelin işi zamanında ele alması operasyon sürecine bağlı |
| Personel paneli | **Staging kanıtlı** | Login, iş listesi, cevap, takvim, alarm tercihi | Production origin/Auth yok; kullanıcı daveti/onboarding otomatik değil |
| Personel WhatsApp yanıtı | **Staging kanıtlı** | Task 048 outbox ve provider status | Staff-send rate limit kararı ve mesaj-yazma grant hardening açık |
| Klinik çalışma saatleri/kapanışlar | **Staging kısmen kanıtlı** | Task 044 UI/endpoint canlı | Authenticated gerçek schedule mutation smoke hâlâ açık |
| Platform admin paneli + TOTP AAL2 | **Staging kanıtlı** | Password, TOTP ve recovery smokes | Production Auth yok; platform-admin üyelik grant/revoke audit'i yok |
| Klinik provision/suspend/resume | **Staging kanıtlı** | Task 047 | Auth daveti, Meta credential kurulumu ve offboarding panelde yok |
| Kullanım ölçümü | **Staging kod/DB kanıtlı** | Task 042 ledger ve admin özet | Faturalama/kota değildir; fiyatlandırma/billing yok |
| Bağımlılık-aware `/ready` | **Staging kanıtlı** | Gerçek PostgREST resolver + Better Stack failure/recovery | Production monitor yok; hazır olmak uçtan uca Meta/OpenAI kanıtı değildir |
| Queue/webhook/Worker/outbox alarm kodu | **Staging kısmen kanıtlı, kapalı** | Tasks 053–057 bounded flag-on | Tam 9-satır aktivasyon matrisi ve sürekli sahiplik yok |
| Klinik e-posta uyarı tercihi/rollout | **Staging UI kanıtlı, teslim blocked** | Task 057 | Keyfi klinik alıcısına gerçek domain sender teslimi kanıtlanmadı; global ve clinic gate kapalı |
| Tarayıcı bildirimi | **Staging UI davranışı** | Staff panel | Sekme kapalıyken güvenilir kanal değildir; e-posta yolu henüz sürekli aktif değil |
| Privacy/KVKK public yüzeyi | **Kapalı** | Apex `/privacy` 404, kırık link kaldırıldı | Onaylı production notice, veri sorumlusu ve başvuru kanalı yok |
| Satış/pilot başvuru formu | **Kapalı** | Apex'te form/link yok | Ticari onboarding süreci ve iletişim kanalı belirlenmedi |

## 4. Şu anda gerçekten çalışmayan veya kullanılamayanlar

### 4.1 `app.patihatti.com` ve production ürün

Bu adres bugün açılmaz. Bu bir DNS hatası değil, bilinçli olarak henüz
kurulmamış production uygulamasıdır. Production için Worker, üç Queue, Cron,
Supabase migration history, Auth, Meta numara/webhook, secret'lar, monitor ve
gerçek klinik seed'i yoktur.

### 4.2 Staging, Task 062'nin yeni triyaj sırasını henüz çalıştırmıyor

Repo, “medical advice” etiketinden önce bilinmeyen güvenlik sinyallerini
sormaya düzeltilmiştir. Ancak Task 062 kapanışında deploy ve canlı WhatsApp
kanaryası yapılmadı. Bu nedenle staging'de test edilen Worker sürümü eski
davranışı taşıyor olabilir. “Kurt hasta, ne yapmalıyım?” benzeri yardım
ifadelerinde erken normal handoff riski staging deploy/canary ile kapanmalıdır.

### 4.3 Klinik e-posta alarmı etkin değil

- `OPERATIONAL_ALERTS_ENABLED="false"` güvenli son durumdur.
- Staging'de clinic rollout anahtarları kapalıdır; kişisel opt-in tek başına etkisizdir.
- Platform sahibine test teslimi geçti; klinik adresi üç denemede `send_failed` oldu.
- `mail.patihatti.com` doğrulandı, fakat gerçek sender-domain + keyfi klinik
  alıcısı kanıtı ve tam aktivasyon matrisi tamamlanmadı.

### 4.4 Onaylı gizlilik/KVKK sayfası yok

Staging `/privacy` teknik taslaktır. Production için veri sorumlusu, amaç ve
hukuki sebepler, gösterim zamanı, başvuru kanalı, saklama/yedek/imha, veri
öznesi operasyonları, yurt dışı aktarım, processor sözleşmeleri, VERBİS ve
yetkili hukuk/KVKK onayı eksiktir.

### 4.5 Gerçek pilot onboarding tek düğmeyle yapılamıyor

Auth daveti/personel üyeliği, Meta credential kurulumu, gerçek schedule/slot,
contact allowlist, platform-admin üyeliği, offboarding, sözleşme, fiyat,
fatura ve destek SLA'sı kontrollü manuel süreçtir.

## 5. Pilot öncesi bloklayıcılar — P0

| # | Bloklayıcı | Sahip | Tamamlanma kanıtı | Durma/geri alma koşulu |
|---|---|---|---|---|
| P0.1 | Task 062 veteriner onayı | Lisanslı veteriner + ürün sahibi | 2026-09-14 PDF sürüm/commit ile imzalı; imzalı kopya Git dışında | Red/çekince varsa yeni görev, eval ve review |
| P0.2 | Task 062 staging deploy ve 3 sonuçlu kanarya | Engineering + owner | unknown→8 soru, positive→urgent, all-false advice→normal handoff | Yanlış öncelik/yanıt/devirde rollout durur |
| P0.3 | Hukuk/KVKK kararları | Yetkili hukuk/KVKK sorumlusu | §4.4 kararları ve notice onaylı, revizyon Git dışında kayıtlı | Onaysız notice uydurulmaz, privacy linki açılmaz |
| P0.4 | Operasyon sahipliği | Ürün sahibi + pilot klinik | İsim/rol, iletişim yolu, çalışma saati ve eskalasyon SLA'sı | Sahipsiz alarm/iş kuyruğuyla pilot açılmaz |
| P0.5 | Klinik e-posta gerçek teslimi | Engineering + pilot klinik | Doğrulanmış sender ile yetkili klinik alıcısında accept+inbox+rollback | Failure, yanlış alıcı veya PII'de gates kapatılır |
| P0.6 | Production altyapı ve migration-first aktivasyon | Engineering/DB owner | Resource inventory, backup, migration/catalog, health/ready, Auth, canary | History/catalog sapması veya 405/503'te Worker açılmaz |
| P0.7 | Gerçek klinik sözleşmesi ve kapsam | Ürün sahibi + klinik | Hizmet sınırı, fiyat, destek ve acil durum anlatısı yazılı | Desteklenmeyen teşhis/7×24 vaadinde launch yok |
| P0.8 | Görsel/marka kullanım kararı | Ürün sahibi + gerekirse hukuk/tasarım | Garden/mascot provenance ve ticari kullanım kaydı; marka araştırması | Hak belirsizse asset/logo değiştirilir |

## 6. Production öncesi mühendislik kanıtları — P1

1. Runbook §7 seçmeli otomasyon matrisini tamamla.
2. Runbook §8 manual/AI devralma yarışını gerçek davranışla kanıtla.
3. Runbook §9 randevu `EVET`/`HAYIR`, safety ve personel görünürlüğünü güncel
   Task 062 Worker'ıyla tekrar çalıştır.
4. Task 044 authenticated schedule mutation smoke'unu tamamla.
5. Meta token revocation ve Graph API sürüm hizasını yeniden doğrula; tokenı yazma.
6. Alarm matrisinde üç Queue, webhook 5xx/401, OpenAI failure, Worker exception,
   outbox, dead-letter, cross-tenant, dedup/retry/recovery yollarını tamamla.
7. Production backup/restore sahibini ve rollback adımlarını kaydet.
8. Production Auth redirect'lerini exact URL ile aç; wildcard kullanma.
9. `app.patihatti.com` bağını ancak DB/secrets/canary hazırken ekle; apex'e
   product fallback ekleme.
10. Pilot SLA ölçümlerini tanımla: webhook→persist, persist→reply, urgent item
    yaşı, Queue oldest message ve provider delivery.

## 7. Bilinen, bloklayıcı olmayan teknik sınırlar — P2 / borç

- Gönderim at-least-once'tur; Meta kabul edip DB commit'i kaybolursa duplicate olabilir.
- 2026-09-04/05 tarihsel gecikmenin mesaj-bazlı retry kök nedeni `INCONCLUSIVE`.
- Alert `occurrence_count` kesin olay değil, örtüşen pencere gözlem sayısıdır.
- Queue trend geçmişi isolate-yereldir; oldest-message yaşı daha güvenilir kapıdır.
- Offboarding cascade ile alert claim arasında nadir, retry ile iyileşen teorik deadlock vardır.
- Çözülmüş work item'a bağlı bazı pending alert satırları birikebilir.
- `alert_recipient_audit.reason` serbest metnine kişi/sağlık verisi yazılmamalıdır.
- Admin listesi birkaç düzine klinik için sayfalamasızdır.
- Platform-admin üyelik grant/revoke için ayrı audit yoktur.
- Staff-send rate limit ve aynı-tenant message-write attribution hardening açıktır.
- Randevu motorunda reschedule, reminder, serbest tarih arama ve dış takvim yoktur.
- Medya klinik teşhisine çevrilmez; teşhis/ilaç/doz/tedavi bilinçli kapsam dışıdır.
- Task 062 generalization, legacy `missing_information` ve complaint normalization
  sonraki eval-kalitesi işidir.
- Reduced-motion modu gerçek render emülasyonuyla görülmedi; kaynak/test kanıtı var.
- `www.patihatti.com`, Search Console/index kanıtı ve analitik yoktur.
- Kamuya açık satış/pilot formu yoktur; bu bilinçli ticari karardır.

## 8. Depo ve belge sağlığı

### 8.1 Doğrulanan kalite kapıları

- Frozen install güncel.
- Typecheck geçti.
- Testler: 40/40 dosya, 2.187 geçti, 2 atlandı, 0 hata.
- Production/staging Worker ve marketing-only Worker dry-run'ları geçti.
- Marketing dry-run `No bindings found` dedi.

İki skip, opt-in ücretli/gerçek OpenAI eval kapısıdır; hata değildir. Prompt
veya model değişikliğinde açık maliyet onayıyla ayrıca çalıştırılır.

### 8.2 Belge drift'i

Task 070'te iki bayat ifade düzeltilir:

- `README.md` Task 050 öncesi gibi `/ready` dış servis çağırmaz diyordu; bugün
  gerçek Supabase/PostgREST resolver RPC'sini çağırır.
- `docs/marketing-homepage.md` Task 069'un kaldırdığı `/staff` ve `/privacy`
  linklerini ilk bölümde varmış gibi anlatıyordu.

Eski runbook bölümlerindeki her işaretsiz kutu bugünkü bug değildir. Güncel
durum için `PROJECT_CONTEXT.md`, aktif iş için `CURRENT_TASK.md`, production
kapısı için `docs/production-readiness.md`, staging adımı için
`docs/staging-runbook.md` ve öncelik özeti için bu belge kullanılır.

### 8.3 Açıklanması gereken yerel çalışma ağacı

Task 070 öncesinden kalan iki ilgisiz değişiklik vardır:

- `.gitignore` içinde commit edilmemiş `tmp/` eklemesi;
- untracked `docs/043-opus-inceleme.md`. Bu dosya Task 043'ün eski
  `CHANGES_REQUIRED` raporudur; ana bulguları sonraki Task 043 düzeltmelerinde
  kapanmıştır ve güncel karar olarak kullanılmamalıdır.

İkisi de Task 070 commit/push'una eklenmez. Sahibi daha sonra ayrı kararla
arşivler, siler veya güncel bağlamla commit eder.

## 9. GitHub paylaşım güvenliği

### 9.1 Bu denetimde geçenler

- 233 takipli dosya incelendi.
- Takipli dosya ve Git patch history'sinde yaygın OpenAI, Cloudflare, GitHub,
  Meta, Resend, JWT ve private-key biçimleri: **0 eşleşme**.
- Yalnız placeholder `.dev.vars.example` ve `.dev.vars.live-ai.example` takip edilir.
- Gerçek `.dev.vars.live-ai` yerelde olabilir; ignore edilir ve takipli değildir.
- Telefon eşleşmeleri sentetik test fixture'larındadır.
- Repo ayrıntılı güvenlik/mimari bilgi içerdiği için ilk paylaşım private olmalıdır.

Bu yüksek-sinyal tarama matematiksel garanti değildir; her staged diff ayrıca okunur.

### 9.2 Git'e kesinlikle konmayacaklar

- Yerel env dosyası, Wrangler secret/probe/browser çıktısı;
- Meta/OpenAI/Supabase/Cloudflare/Resend credential'ı;
- parola, TOTP secret/QR/kodu veya recovery fragment'i;
- gerçek hasta/sahip mesajı, telefon, e-posta veya ham webhook;
- imzalı veteriner/KVKK PDF'i ve kişisel imza bilgisi;
- sağlayıcı ham hata gövdesi.

### 9.3 GitHub mevcut engeli

- Remote tanımlı değil.
- `gh` istemcisinde `UcanInek691` seçili fakat token geçersiz.
- Kullanıcı önce `gh auth login -h github.com` ile giriş yapmalıdır.
- Önerilen hedef: `UcanInek691/pati-hatti`, visibility `private`.
- Takım kullanıcı adları ve kabul edilmiş davet kanıtı olmadan erişim verilmiş sayılmaz.

## 10. Ekip çalışma sözleşmesi

1. Önce `AGENTS.md`, sonra `PROJECT_CONTEXT.md`, en üst `CURRENT_TASK.md` ve bu belgeyi oku.
2. `git status`, son commit, ilgili source/caller/test/migration kanıtını doğrula.
3. Aktif görev `READY` veya `IN_REVIEW` iken ikinci iş başlatma.
4. Sonnet uygular; Codex sözleşme/review/fix/commit yapar; kritik güvenlik,
   RLS/tenant, concurrency, klinik ve KVKK kararında Opus bağımsız reviewer'dır.
5. Görev izin vermedikçe gerçek deploy/migration/servis/ücretli API çağrısı yapma.
6. Disposable DB'yi staging/production kanıtı diye sunma.
7. Secret, imzalı belge veya gerçek kişi verisini issue, PR, log ya da chat'e koyma.

Önerilen Git akışı: `main` → `codex/task-071-...` → küçük sözleşmeli diff →
ilgili testler → gerekli tam gate → review → merge. İlk push'tan sonra `main`
için PR ve en az bir reviewer kuralı önerilir.

## 11. Önerilen görev sırası

### Task 071 — Task 062 klinik aktivasyonu

Ön koşul gerçek veteriner sonucudur. Staging deploy, üç-sonuç WhatsApp
kanaryası ve rollback yapılır. Metin değişirse prompt/eval/Opus kapısı yenilenir.

### Task 072 — Hukuk/KVKK karar ve uygulama paketi

Veri sorumlusu, notice, gösterim zamanı, başvuru/export/delete, retention/imha,
processor aktarımı ve onay kaydı tamamlanır. Hukuki içerik uydurulmaz.

### Task 073 — Production kapalı-devre altyapı preflight

Production Supabase, migration history, Queue/Cron/secret inventory, exact Auth
redirects, app origin Worker ve monitor trafiğe açılmadan doğrulanır. Migration önce.

### Task 074 — Tek klinik controlled canary

Bir klinik/numara/allowlist, AI kapalı başlayan rollout, klinik e-posta ve tam
ingress/triage/appointment/staff/recovery matrisi rollback ile kanıtlanır.

### Task 075 — Pilot açılışı ve ilk hafta işletimi

Sınırlı kullanıcı listesi, named on-call owner, günlük kanarya, incident
şablonu, latency/backlog/urgent-age ölçümü ve net stop kuralları uygulanır.

Task 071'den önce yeni kozmetik homepage işi veya yeni entegrasyon önerilmez;
en yüksek değer klinik, hukuki ve production kanıt boşluklarını kapatmaktır.

## 12. Tek kaynak haritası

| Konu | Kaynak |
|---|---|
| Roller, güvenlik ve doğrulama | `AGENTS.md` |
| Son durable durum | `PROJECT_CONTEXT.md` |
| Tek aktif görev | `CURRENT_TASK.md` |
| Production kapıları | `docs/production-readiness.md` |
| Staging adım/kanıtları | `docs/staging-runbook.md` |
| Alarm tasarımı/kanıtı | `docs/operational-alerting.md` |
| Klinik onay içeriği | `docs/veteriner-hekim-onay-paketi.md` ve 2026-09-14 PDF |
| Hukuk/KVKK paketi | `docs/kvkk-inceleme-paketi.md` |
| Task 062 olay raporu | `docs/olaylar/2026-09-13-triyaj-oncesi-devir.md` |
| Resolver olayı | `docs/olaylar/2026-09-04-route-resolver-405.md` |
| Gecikme olayı | `docs/olaylar/2026-09-05-delivery-latency.md` |
| Pazarlama/SEO | `docs/marketing-homepage.md` |

## 13. Karar

Kod tabanı bozuk bir prototip değildir; staging'de çok sayıda gerçek akışı
geçmiş, tenant ve güvenlik sınırları ciddi biçimde ele alınmış pilot ürünüdür.
Fakat production hazır demek de doğru değildir.

**GO:** private GitHub deposunda ekip içi inceleme ve Task 071 hazırlığı.  
**GO:** mevcut sınırlı `patihatti.com` pazarlama sayfası.  
**NO-GO:** `app.patihatti.com`, gerçek klinik, sürekli alarm veya
“veteriner/KVKK onaylı” iddiası.
