# VetAI SaaS ürünleştirme ve ticari yol haritası

Son doğrulama: 2026-08-30.

Bu belge, Task 039 sonrasındaki doğrulanmış ürün durumunu, Claude Opus'un
çok-kiracılı mimari incelemesini ve VetAI'nin ticari hedeflerini tek bir
uygulanabilir plana dönüştürür. Bir üretim onayı, veteriner hekim onayı veya
hukuk görüşü değildir. Aktif uygulama sözleşmesi her zaman kökteki
`CURRENT_TASK.md` dosyasıdır.

## 1. Kısa karar özeti

VetAI ayrı ayrı kopyalanan bir yazılım değil, ortak altyapıda çalışan
çok-kiracılı bir SaaS olacaktır:

- Cloudflare, Supabase ve OpenAI hesapları VetAI tarafından ortak işletilir.
- Her klinik kendi Meta Business portföyünün, WABA'sının, WhatsApp numarasının
  ve Meta ödeme yönteminin sahibi olur.
- VetAI tek bir Meta geliştirici uygulaması ve tek kod tabanı işletir.
- Klinik verileri `clinic_id`, bileşik yabancı anahtarlar ve RLS ile veritabanı
  seviyesinde ayrılır; prompt'a veya arayüze güvenilmez.
- Her klinik/WhatsApp hesabı için ayrı Meta gönderim kimlik bilgisi kullanılır.
  Tek global `WHATSAPP_ACCESS_TOKEN` çok-klinikli kullanım için kabul edilmez.
- Klinik personeli ortak `/staff` uygulamasını kendi kliniğinin markası ve RLS
  kapsamı ile kullanır. Klinik başına ayrı Worker veya ayrı panel kopyası
  kurulmaz.
- VetAI sahibinin `/admin` yüzeyi varsayılan olarak yalnız operasyonel metadata
  görür; mesaj, sahip, hayvan veya telefon içeriğini normal yoldan göremez.
- İlk ücretli pilotta otomatik tahsilat kurulmaz. Kullanım önce ölçülür, fatura
  elle doğrulanır, tarife gerçek veriye göre kesinleştirilir.

Bu model ilk 5–20 klinik için en az operasyonla en güçlü izolasyonu sağlar.
Ayrı altyapı ancak sözleşmesel veri yerleşimi, bağımsız denetim veya tek bir
kurumsal müşterinin toplam hacmin büyük bölümünü oluşturması gibi somut bir
gereksinim çıktığında değerlendirilir.

## 2. Bugünkü doğrulanmış durum

| Alan | Durum |
| --- | --- |
| WhatsApp inbound/outbound/status | Gerçek staging zincirinde doğrulandı. |
| AI çıkarımı ve güvenlik | Luna, sıkı yapılandırılmış çıktı ve deterministik güvenlik kapısıyla çalışıyor. |
| Pet ve randevu akışı | Kayıt, düzeltme, randevu oluşturma, mevcut randevuyu bildirme ve iptal staging'de doğrulandı. |
| Hızlı ardışık mesajlar | Task 039 ile tek sınırlı burst olarak işleniyor. |
| Seçmeli otomasyon | Strict AI allowlist, manual/personal yollar ve grup dışlama mevcut. |
| Personel yüzeyi | İş kuyruğu, görme/sahiplenme/çözme ve temel rota yönetimi var; ticari ürün için composer ve gerçek bildirim eksik. |
| İnsan onay paketleri | Veteriner ve KVKK taslakları üretildi; dış uzman onayı hâlâ üretim kapısıdır. |
| Production | Kurulmadı ve hiçbir Task 039 değişikliği production'a uygulanmadı. |
| Çok-klinik Meta gönderimi | Eksik: outbound bugün tek global Meta tokenı kullanıyor. |
| Kullanım/faturalama | Ölçüm ve fatura doğruluk kaynağı henüz yok. |
| Provizyon/offboarding | Genel, güvenli bir yönetim yüzeyi yok; mevcut kurulum kontrollü ve elle. |

Önceki bir incelemedeki “tanınmayan WhatsApp hesabı 503 üretir” bulgusu güncel
değildir. Worker tanınmayan hesabı artık başarılı biçimde kabul edip hiçbir iş
başlatmadan düşürür. Eski runbook satırları ileride temizlenecektir.

## 3. Değişmez ürün ve güvenlik sınırları

Ticari baskı altında dahi aşağıdakiler gevşetilmez:

1. AI tanı koymaz, olası hastalık listesi vermez, ilaç/doz veya tedavi önermez.
2. Güvenlik sinyalleri ve öncelik sırası model tarafından değil, doğrulanmış
   deterministik kurallar tarafından belirlenir.
3. Güvenlik, açık insan talebi ve acil yönlendirme randevudan önce gelir.
4. Randevu ve iptal yalnız açık kullanıcı onayıyla, tenant-safe RPC içinde
   atomik olarak değişir.
5. Strict allowlist varsayılandır. Listelenmemiş/personal içerik OpenAI'a veya
   Supabase'e gönderilmez.
6. Meta tokenları kaynak kodda, Git'te, Supabase tablolarında, loglarda veya
   hata gövdelerinde tutulmaz.
7. `service_role` tarayıcıya inmez. Klinik personeli yalnız kendi kliniğini RLS
   üzerinden görür.
8. Platform yöneticisi rolü içerik tablolarına genel erişim veren bir RLS
   istisnasına dönüşmez.
9. Kota veya ödeme durumu güvenlik mesajını sessizce düşüremez.
10. Veteriner onayı olmayan klinik metni ve hukuk/KVKK kararı kapanmamış veri
    politikası production'a çıkmaz.

## 4. Meta hesap ve numara modeli

Hedef sahiplik:

| Varlık | Sahip/işleten |
| --- | --- |
| Meta geliştirici uygulaması ve yazılım | VetAI |
| Klinik Business portföyü, WABA, numara ve görünen ad | Klinik |
| Meta ödeme yöntemi ve Meta mesaj faturası | Klinik |
| Cloudflare, Supabase ve OpenAI hesapları | VetAI |
| Klinik kapsamlı Meta gönderim tokenı | Klinik iptal edebilir; VetAI şifreli olarak işletir |

Klinik ayrıldığında numarasını ve WABA'sını götürür; VetAI erişimini kaldırır.
Bu ayrım sözleşmede açıkça yazılmalıdır.

Numara seçenekleri:

- **Yeni Cloud API numarası:** Pilot için en temiz ve en düşük riskli yol.
- **Mevcut numaranın Cloud API'ye taşınması:** WhatsApp Business App insan
  kanalı kaybolabilir; bu durumda `/staff` üzerinden personel mesaj yazma
  özelliği ticari olarak zorunludur.
- **Coexistence:** Klinik başına uygunluk testi gerektiren koşullu seçenek;
  satış vaadi değildir. Grup sohbetleri ürün kapsamı dışındadır.

Embedded Signup, erişim izinleri, Coexistence sınırları, Meta API sürümleri ve
ücretler değişebildiği için her production onboarding'inden önce resmî Meta
belgeleri yeniden doğrulanır.

## 5. Klinik-başına Meta kimlik bilgisi kararı

Cloudflare Secrets Store sırları Worker'a isim verilmiş **statik binding**
olarak bağlar. Veritabanındaki bir `credential_ref` değerini kullanıp çalışma
anında keyfi bir secret adına dinamik erişim sağladığı varsayılmayacaktır.

İlk pilot ölçeğinde seçilen en küçük güvenli çözüm:

- Tek şifreli Worker secret'ı, kapalı bir JSON dizisi olarak en fazla on aktif
  pilot WhatsApp hesap eşleşmesini taşır. Ham değer Cloudflare'ın güncel 5 KB
  Worker-variable sınırını aşamaz.
- Her kayıt internal `whatsapp_account_id`, Meta `phone_number_id` ve o hesaba
  ait access token üçlüsüdür.
- Outbox claim RPC'si internal hesap kimliğini ve phone number ID'yi tenant-safe
  bileşik join'den birlikte döndürür.
- Worker yalnız iki kimlik de aynı secret kaydıyla birebir eşleşirse gönderir.
- Bozuk JSON, fazla/eksik alan, tekrar eden hesap/telefon, eşleşmeyen çift veya
  boş token tüm ilgili yolu fail-closed yapar; başka klinik tokenına fallback
  edilmez.
- Global token fallback'i yeni Worker'da kullanılmaz.

Bu çözüm az sayıda pilot kliniği için basit ve denetlenebilirdir. On birinci
hesap eklenmeden önce, statik Secrets Store binding'leri veya ayrı bir secret
broker yeni bir tehdit modeli ve ölçümle değerlendirilir; mevcut sınır sessizce
yükseltilmez.

## 6. Panel stratejisi

### 6.1 Klinik personeli `/staff`

Tek ortak uygulama, klinik bağlamına göre isim/logo/renk gösterir. Ticari MVP
için gerekli sıra:

1. Acil ve normal iş kuyruğu; sahiplenme, çözme ve denetim bilgisi.
2. Personelin Cloud API üzerinden yanıt yazabileceği güvenli composer.
3. PII içermeyen gerçek bildirim (örneğin “kliniğinizde acil iş var” + link).
4. AI/manual/personal rota yönetimi ve strict allowlist görünümü.
5. Randevu takvimi ve slot yönetimi.
6. Aylık kullanım göstergesi.

Composer, AI tarafından yazılan metni sessizce personel mesajı gibi gönderemez;
personel kaynaklı mesaj ayrıca işaretlenir ve yeniden AI turu başlatmaz.

### 6.2 VetAI sahibi `/admin`

İlk sürümde yalnız şunları gösterir:

- Klinik adı, durum, son başarılı inbound/outbound zamanı.
- WABA/telefon bağlantısının sağlıklı/geçersiz durumu; token değeri asla değil.
- Açık iş, DLQ, exhausted outbound ve hata oranı gibi sağlık sayaçları.
- Aylık kullanım toplamları, plan ve özel fiyat metadata'sı.
- Kontrollü provizyon, askıya alma ve offboarding adımları.

Mesaj içeriği, sahip/hayvan adı, telefon numarası, ham SQL, klinik adına mesaj
gönderme ve toplu içerik dışa aktarma admin panelinde bulunmaz.

Destek için içerik erişimi gerçekten gerekirse ayrı bir “break-glass” görevi
açılır: klinik onayı, süre, amaç ve append-only denetim kaydı olmadan erişim
verilmez. Normal `SELECT` politikalarına basitçe `OR is_platform_admin()`
eklenmez; bu yaklaşım her okumayı güvenilir biçimde loglamaz ve izolasyonu
gereksiz yere genişletir.

**Durum (Task 043):** Bu listenin yalnız salt-okunur alt kümesi teslim edildi
— klinik adı/durumu, WABA/telefon hesap sayısı, açık/acil iş sayaçları,
outbound teslim durumu sayaçları, son inbound/outbound zamanı ve aylık
kullanım toplamları
([`platform-admin-overview.md`](platform-admin-overview.md)). Plan/özel
fiyat metadata'sı ile provizyon, askıya alma ve offboarding adımları bu
panele henüz eklenmedi; klinik yaşam döngüsü mutasyonları hâlâ ayrı bir
operatör akışından yürütülüyor ([`clinic-lifecycle.md`](clinic-lifecycle.md)).
Migration ve rollback kanıtı önce yalnız disposable `vetai-test` üzerinde geçti;
zorunlu Opus incelemesi dar düzeltmelerden sonra `PASS` verdi. 2026-08-31'de
Task 041–043 migration'ları sırayla `vetai-staging`'e uygulandı, mevcut tek
staging personel Auth kullanıcısı ilk staging platform-yöneticisi olarak
etkinleştirildi ve ilgili Worker sürümü deploy edildi; `/admin` ve
`/admin/config.json` doğrulandı. Production hâlâ değişmedi.

**Durum (Task 045):** Task 043'ün parola-yalnız erişim sınırı kapatıldı — panel
artık `platform_admins` üyeliğine ek, veritabanı düzeyinde zorunlu bağımsız bir
TOTP `aal2` denetimi gerektiriyor (bkz.
[`platform-admin-overview.md`](platform-admin-overview.md#totp-mfa-sınırı-görev-045)).
Uygulayan migration ve rollback-only fixture'ı hiçbir veritabanında
çalıştırmadı. Codex daha sonra ikisini yalnız disposable `vetai-test` üzerinde
başarıyla doğruladı; sıfır fixture kalıntısı ve zorunlu Opus `PASS` kaydedildi.
Staging'e henüz uygulanmadı. Planlanan gerçek staging TOTP/rate-limit smoke'u
(`docs/staging-runbook.md` §15) tamamlanmadan bu panel production'da onaylı
ayrıcalıklı erişim olarak kabul edilemez.

## 7. Kullanım, tarife ve faturalama

### 7.1 Ölçüm birimleri

- **İç maliyet birimi:** bir model turuna karşılık gelen burst.
- **Müşteriye anlatılan birim:** bir konuşma.
- Ham webhook, token veya WhatsApp mesajı fatura birimi değildir.

Önce append-only, clinic-scoped ve tekrar teslimatta çift yazmayan bir kullanım
kaydı kurulacaktır. İlk pilotta bu kayıt yalnız ölçüm içindir; otomatik ücret
veya akış engeli üretmez. Faturalama tanımı, gerçek bir aylık pilot verisiyle
mutabakat yapılmadan kesinleştirilmez.

Güvenlik/handoff, personal/manual trafik, grup/callback, sistem hatası, DLQ ve
başarısız outbound müşteri aleyhine faturalanmaz. Kota bitmesi acil mesajı veya
insan devrini susturmaz.

### 7.2 Ticari hipotez

30.000 TL başlangıç kurulumu makul olabilir; ancak şu teslimleri gerçekten
içermelidir:

- Meta/WABA/numara onboarding refakati ve uygunluk testi.
- Klinik/personel/saat/slot/allowlist kurulumu.
- Veteriner metin onay oturumu ve KVKK teknik paket desteği.
- Personel eğitimi, kontrollü smoke ve iki haftalık gözetimli pilot.

Başlangıç hipotezi, KDV hariç:

| Paket | Aylık hipotez | Konumlandırma |
| --- | ---: | --- |
| Klinik | 4.900 TL | Tek şube, sınırlı destek |
| Klinik+ | 8.900 TL | Daha yüksek hacim ve destek |
| Çok Şube | Teklife bağlı | Gerçek destek yükü ölçülmeden liste fiyatı yok |

Bu fiyatlar sözleşme teklifi değildir. Eski 990/2.490 TL seviyeleri destek
maliyetini karşılamadığı için ticari referans olarak kullanılmamalıdır.
Konuşma kotaları önce koruyucu sınır ve şeffaf kullanım göstergesi olur; paket
farkını asıl belirleyen destek seviyesi, operasyon kapsamı ve yanıt taahhüdüdür.

Meta'nın işletme-başlatmalı mesaj ücretleri klinik hesabına doğrudan ait olmalı;
VetAI bu kaleme marj eklememeli veya kur/tahsilat riski taşımamalıdır. OpenAI,
Cloudflare ve Supabase maliyetleri aylık pakete gömülür. Tüm fiyatlar ilk üç
pilotun gerçek kullanım ve destek saatiyle yeniden hesaplanır.

## 8. Hukuk, KVKK ve veteriner kapıları

İlk ücretli production müşterisinden önce dış uzman kararı gerekenler:

1. Klinik/VetAI veri sorumlusu–veri işleyen rol dağılımı.
2. Meta, Cloudflare, Supabase ve OpenAI yurt dışı aktarım mekanizması.
3. Mesajlar, conversation/intake verisi, accepted outbox, webhook olayları,
   randevu iptal denetimi ve rota numaraları için ayrı saklama süreleri.
4. İlgili kişi başvurusunda arama, dışa aktarma, düzeltme ve silme akışı.
5. Personel/owner/pet/klinik silmelerinin kapsamı ve hukukî kayıt istisnaları.
6. Sabit güvenlik, acil yönlendirme ve randevu metinlerinin klinik hekim onayı.

Veteriner güvenlik sinyalleri ve öncelikleri klinik başına kapatılamaz. Klinik
adı, telefon, çalışma saatleri, randevu politikası ve hekim onaylı iletişim tonu
özelleştirilebilir. Her metin revizyonu kim/tarih/revizyon ile yeniden onaya
girer.

## 9. Aşamalı teslim planı

Görev sayısı yapay biçimde artırılmayacaktır. Aşağıdaki iş paketleri bağımsız
güvenlik ve geri alma sınırlarıdır; yalnız bu sınırlar gerektirirse ayrı task
olarak uygulanırlar.

| Faz | Teslim | Çıkış kapısı |
| --- | --- | --- |
| 1. Çok-kiracılı gönderim temeli | Klinik-başına Meta credential, tenant-bound claim, iki-klinik izolasyon kanıtı | İki sentetik hesap yanlış token kullanamıyor; secret DB/log/test artefact'ında yok |
| 2. Güvenli provizyon/offboarding | Klinik, personel, WhatsApp hesabı, saat/slot ve credential yaşam döngüsü | Elle serbest SQL olmadan tekrarlanabilir açma, askıya alma, kapatma ve rollback |
| 3. Ölçüm | Append-only usage olayları ve aylık mutabakat raporu | At-least-once çift saymıyor; bir pilot faturası elle yeniden üretilebiliyor |
| 4. Operasyon yüzeyleri | Metadata-only `/admin`; markalı `/staff`, composer, bildirim, rota ve randevu ekranı | Personel devralma uçtan uca; admin içerik göremiyor; RLS negatif testleri geçiyor |
| 5. Uyum kapanışı | Saklama/imha, ilgili kişi aracı, sözleşme/KVKK ve veteriner onayları | Hukukçu ve sorumlu klinik hekimi yazılı onaylıyor; dry-run imha raporu inceleniyor |
| 6. Production canary ve ücretli pilot | Ayrı production kaynakları, sentetik canary, 1–3 klinik kontrollü onboarding | En az bir klinik bir ay boyunca SLO, destek ve fatura mutabakatını sağlıyor |
| 7. Tarife ve ölçek | Paket/kampanya/özel fiyat, otomatik fatura ancak doğrulanmış ölçüm üstünde | Üç pilotun maliyet ve destek verisiyle marj yeniden hesaplanmış |
| 8. Sonraki sürüm | Embedded Signup self-servis, hatırlatma/şablon, ödeme otomasyonu, çok şube/PMS | Meta, hukuk ve operasyon ön koşulları ayrı ayrı kapanmış |

İlk ücretli pilot için Faz 1–6 gerekir. Faz 7'nin otomasyonu ve Faz 8 ilk satış
için zorunlu değildir.

## 10. Task 040 (uygulandı)

Task 040 yalnız Faz 1'i uygular:

- global Meta token bağımlılığını kaldırır;
- tenant-safe outbox claim'e internal WhatsApp hesap kimliğini ekler;
- şifreli hesap-token haritasını sıkı ve fail-closed doğrular;
- iki klinik/iki hesap için yanlış token kullanımını negatif testle engeller;
- production veya gerçek Meta hesabına dokunmaz.

Admin paneli, provizyon, faturalama, UI tasarımı ve hatırlatma aynı göreve
eklenmez. Task 040 tamamlandıktan sonra sıradaki iş paketi güvenli
provizyon/offboarding olacaktır.

## 10a. Task 041 (uygulandı, staging'e uygulandı, production'a henüz uygulanmadı)

Task 041, Faz 2'yi ("Güvenli provizyon/offboarding") uygular:

- `clinics.operational_status` (`suspended | active | offboarding`) ve beş
  service-role-only RPC (`provision_clinic_v1`, `suspend_clinic_v1`,
  `resume_clinic_v1`, `prepare_clinic_offboarding_v1`,
  `finalize_clinic_offboarding_v1`) — elle serbest SQL olmadan tekrarlanabilir
  açma, askıya alma ve geri dönüşü olmayan kapatma;
- askıya alınmış/kapatılan bir klinik için çalışma zamanı otomasyon
  çözümleyicisi ve `claim_outbound_message_v2()` `personal`/aktif-değil
  sınırını uygular; kabul edilmiş kayıtların durum takibi kesintisiz kalır;
- offboarding tek yönlü token hash'i içeren, PII taşımayan bir
  makbuz yazar; ham token hiçbir yerde saklanmaz;
- implementer tarafından hiçbir veritabanına uygulanmadı; Codex daha sonra
  önce yalnız disposable `vetai-test` üzerinde migration + rollback fixture
  kanıtını tamamladı, sonra 2026-08-31'de bu migration'ı Task 042/043 ile
  birlikte sırayla `vetai-staging`'e uyguladı (mevcut tek staging klinik
  `active`'e backfill edildi). Production ve gerçek Meta hesabı hâlâ değişmedi
  — bkz. [`docs/clinic-lifecycle.md`](clinic-lifecycle.md).

Admin paneli (Faz 4), faturalama (Faz 3/7) ve UI aynı göreve eklenmez;
`src/clinicLifecycle.ts` hiçbir public route'a bağlanmaz.

## 10b. Task 042 (uygulandı, disposable veritabanında doğrulandı, staging'e uygulandı)

Task 042, Faz 3'ü ("Ölçüm") uygular:

- klinik başına append-only bir AI kullanım defteri
  (`clinic_ai_usage_events`) ve iki `SECURITY DEFINER` RPC
  (`record_intake_ai_usage_v1`, `get_clinic_monthly_usage_v1`) — at-least-once
  Queue teslimatını çift saymadan, ham mesaj/doğrudan iletişim alanı taşımadan
  (UUID hash'leri yine korunan pseudonymous veridir);
- `Europe/Istanbul` takvim ayına göre klinik başına aylık tur/token
  mutabakat raporu;
- faturalama, tarife, kota veya admin/personel arayüzü eklemez — sadece
  ölçüm ve manuel pilot mutabakatı için kanıt üretir;
- implementer tarafından migration ve fixture hiçbir veritabanında
  çalıştırılmadı; Codex daha sonra önce yalnız disposable `vetai-test` üzerinde
  migration'ı uyguladı, rollback fixture'ı PASS verdi ve sıfır artık
  doğrulandı; zorunlu salt-okunur Opus incelemesi PASS verdi. 2026-08-31'de bu
  migration bağımlı Worker deploy'undan önce `vetai-staging`'e uygulandı ve her
  iki kullanım RPC'sinin varlığı doğrulandı. Production değişmedi — bkz.
  [`docs/usage-metering.md`](usage-metering.md).

Admin paneli (Faz 4), gerçek faturalama (Faz 3/7'nin geri kalanı) ve kota
aynı göreve eklenmez; `src/usageMetering.ts` hiçbir public route'a bağlanmaz.

## 10c. Task 044 (uygulandı, disposable veritabanında doğrulandı)

Task 044, Faz 4'ün ("Operasyon yüzeyleri") tek dar dilimini uygular: `/staff`
üzerinde klinik kendi haftalık saatlerini, tam gün kapanışlarını ve gelecekteki
randevu slot envanterini kendi kendine yönetir
([`docs/clinic-operations.md`](clinic-operations.md#task-044-self-service-hours-closures-and-slot-inventory-staff)).

- beş yeni `SECURITY DEFINER` RPC (`list_clinic_appointment_slots_v1` ve dört
  mutasyon) — tenant/rol yetkilendirmesi tamamen veritabanında, tarayıcı-taraflı
  kontrole bırakılmadan; yalnız klinik `admin`'i saat/kapanış/slot değiştirebilir,
  diğer roller salt-okunur ([`docs/database-schema.md`](database-schema.md#clinic-schedule-and-appointment-slot-self-service-task-044));
- askıda/offboarding klinik mutasyonları kapalı-başarısız olur; `held`/`confirmed`
  hiçbir randevu hiçbir saat/kapanış değişikliğiyle silinmez, taşınmaz ya da
  düzenlenmez — yalnız korunan aktif slot sayısı döner;
  ([`docs/appointment-booking-engine.md`](appointment-booking-engine.md#staff-side-generation-and-deletion-task-044));
- `/admin`, ikinci bir klinik paneli, faturalama, hatırlatma veya dış takvim
  senkronu eklemez; `/staff` aynı sayfa, aynı Supabase Auth oturumu kalır;
- implementer tarafından migration ve `supabase/tests/044_clinic_schedule_management.sql`
  hiçbir veritabanına uygulanmadı/çalıştırılmadı. Codex daha sonra migration'ı
  yalnız disposable `vetai-test` üzerinde uyguladı, rollback fixture'ı PASS
  verdi ve sıfır artık doğrulandı. Zorunlu salt-okunur Opus incelemesi henüz
  yapılmadı; staging/production değişmedi.

## 11. Kaynak ve yeniden doğrulama notu

- Cloudflare Worker secret'ları: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare Worker sınırları: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Secrets Store Worker entegrasyonu: https://developers.cloudflare.com/secrets-store/integrations/workers/
- Meta Embedded Signup: https://developers.facebook.com/docs/whatsapp/embedded-signup/
- Meta WhatsApp fiyatlandırması: https://developers.facebook.com/docs/whatsapp/pricing/
- KVKK yurt dışına aktarım: https://www.kvkk.gov.tr/Icerik/2053/Yurtdisina-Aktarim

Dış servis özellikleri ve fiyatları değişebilir. Satış sözleşmesine veya
production runbook'una sayı/özellik yazılmadan hemen önce resmî kaynaklar yeniden
kontrol edilmelidir.
