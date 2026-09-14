# VetAI SaaS ürünleştirme ve ticari yol haritası

İlk doğrulama: 2026-08-30. Son dar durum güncellemesi: Task 052, 2026-09-05.

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
| Personel yüzeyi | İş kuyruğu, görme/sahiplenme/çözme, rota yönetimi ve composer (Task 048) staging'de mevcut. Task 051 ile çözüm sonrası yeni konuşmaya dönüş staging'de doğrulandı. Task 057, personel opt-in ve platform klinik rollout kontrollerini staging'de doğruladı; platform e-postası geçti, klinik e-postası Resend test-alıcısı sınırında `BLOCKED` kaldı. Ticari ürün için doğrulanmış gönderici alan adı, gerçek klinik alıcısı ve sorumlu takip yolu hâlâ açıktır ([`docs/operational-alerting.md`](operational-alerting.md) §12). |
| İnsan onay paketleri | Veteriner ve KVKK taslakları üretildi; dış uzman onayı hâlâ üretim kapısıdır. |
| Production | Kurulmadı ve hiçbir Task 039 değişikliği production'a uygulanmadı. |
| Çok-klinik Meta gönderimi | Task 040 ile hesap başına kimlik bilgisi izolasyonu var; kayıt en fazla 10 hesaplı manuel pilot secret'ı olarak sınırlı. |
| Kullanım/faturalama | Task 042 ile tenant-kapsamlı kullanım defteri var; tarife, kota, tahsilat ve fatura doğruluk kaynağı henüz yok. |
| Provizyon/offboarding | `/admin` yalnız provision/suspend/resume sunuyor; Auth/Meta kurulumu ve yıkıcı offboarding kontrollü, elle yürütülüyor. |
| Worker `/ready` ve gözlemlenebilirlik | Task 050 ile `/ready` gerçek PostgREST rota çözümleme çağrısını kontrol ediyor. Task 054 doğrulanmış Workers Observability yolunu ve Better Stack `/ready` takibini kurdu. Task 057, Task 055'in `$workers.outcome` sorgu şeklini gerçek staging hesabında, heartbeat'i canlı pencerede ve platform e-postası ile allowlist WhatsApp kanaryasını uçtan uca doğruladı. Final bayrak tekrar kapatıldı. Kalan alarm matrisi, klinik gönderici alan adı ve production değişiklikleri hâlâ açık; bkz. [`docs/staging-runbook.md`](staging-runbook.md) §29. |

Task 052 gecikme araştırması tamamlandı: eşleşen üç eski yanıtın 61–74
dakikalık farkı başarılı kayıttan önce; kayıt sonrası kabul 18–23 saniyedir.
Önceki 405/503 kesintisinden sonraki yeniden teslim açıklaması güçlü bir
çıkarımdır; her mesajın eski retry zinciri kanıtlanamadı. Dört yeni yanıtın
kayıt sonrası maksimumu 23.951 saniyedir; bu küçük örneklem SLA değildir.
Bkz. [salt-okunur rapor](olaylar/2026-09-05-delivery-latency.md).

Sonraki öncelik yeni bir gecikme yaması değil, mevcut satışa çıkış kapılarıdır:
HTTP 5xx/readiness failure kanıtı ve Queue/DLQ alarmı, personel işlerinin gerçek takibi,
gönderim hız sınırı doğrulaması, üretim hedefinin kurulum/canary/rollback
kanıtı. İlk maddenin (alarm/bildirim) Faz A planı onaylandı ve Faz B depo
uygulaması (migration + Worker kodu) yalnız disposable `vetai-test` kanıtını
geçti ([`docs/operational-alerting.md`](operational-alerting.md), Task 053);
gerçek
aktivasyon ayrı sahip onayı ve Codex/Opus incelemesi gerektirir. Veteriner/KVKK
onayı ve ticari sözleşme/tarife ayrıca tamamlanır.
Mevcut gözetimli staging testlerine devam edilebilir; Task 052'nin bitmesi
gerçek klinik veya ücretli üretim açılışı onayı değildir. Özel alan adı bu
gecikme incelemesinin teknik ön koşulu değildir.

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
   Faz A planı: [`docs/operational-alerting.md`](operational-alerting.md) §4
   (Task 053, 2026-09-05) — e-posta kanalı seçildi, Faz B depo uygulaması
   disposable `vetai-test` üzerinde kanıtlandı; staging/gerçek e-posta
   aktivasyonu henüz yapılmadı.
4. AI/manual/personal rota yönetimi ve strict allowlist görünümü.
5. Randevu takvimi ve slot yönetimi.
6. Aylık kullanım göstergesi.

Composer, AI tarafından yazılan metni sessizce personel mesajı gibi gönderemez;
personel kaynaklı mesaj ayrıca işaretlenir ve yeniden AI turu başlatmaz.

**Durum (Task 048):** Madde 2'deki composer (`queue_staff_reply_v1`) yazıldı
ve yerel olarak doğrulandı — tipcheck, tam test paketi ve dry-run deploy
geçti. Codex migration'ı yalnız disposable `vetai-test` üzerinde uyguladı;
düzeltilmiş rollback fixture'ı PASS verdi ve ayrı sorguda sıfır artık
doğrulandı. Staging'de doğrulanmadı, commit/push/deploy edilmedi. İlk zorunlu
Opus incelemesinin düzeltmeleri tamamlandı; dar salt-okunur kapanış kontrolü
bekleniyor (bkz.
`docs/staging-runbook.md` §18). Composer yalnız doğrulanmış
klinik-personel oturumu ile, kendisine atanmış ve `in_progress` olan tek bir `human_handoff`
work item'ı için, gelen mesaj zamanı ile güvenilir sunucu alış zamanının erken
olanından veritabanında türetilen WhatsApp
24 saatlik pencere içinde çalışır; bu, ticari MVP'de "ücretsiz" bir
mesajlaşma penceresi vaadi olarak değil, yalnız Meta'nın mevcut
customer-service-window kuralının teknik bir yansıması olarak anlaşılmalıdır
— fiyatlandırma/paket iletişiminde bu pencereye dayalı bir "ücretsiz mesaj"
iddiası kurulmamalıdır.

Task 045'in TOTP/`aal2` koruması yalnız VetAI sahibi `/admin` panelini kapsar.
Veteriner müşterilerin kullandığı `/staff` için MFA ayrı bir üretim erişim
kapısıdır; Task 048 bunu uygulanmış gibi göstermez.

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
Migration ve Worker daha sonra yalnız `vetai-staging`'e uygulandı; gerçek
password-recovery, yarım TOTP kurulumundan güvenli toparlanma, fresh-session
TOTP challenge, allowlist ve Auth rate-limit smoke'u geçti
(`docs/staging-runbook.md` §15). Production hâlâ değişmedi; kayıp cihaz
kurtarma ve dış insan onayları tamamlanmadan panel production'da onaylı
ayrıcalıklı erişim değildir.

**Durum (Task 047):** Yukarıdaki hedef listedeki "provizyon, askıya alma"
kısmı — **offboarding hariç** — bu panele eklendi: `/admin` artık her aal2
mutasyonunu Task 041'in değişmemiş beş RPC'sinden yalnız üçünü (provision,
suspend, resume) çağıran ince sarmalayıcı RPC'ler üzerinden yürütür; her
mutasyon aynı transaction'da minimize edilmiş bir denetim satırına yazılır ve
istemci `request_id`'si tekrar/uyuşmazlık için sunucu tarafında kontrol edilir
(bkz. [`platform-admin-overview.md`](platform-admin-overview.md#klinik-yaşam-döngüsü-kontrolleri-görev-047)).
Offboarding, Auth kullanıcı oluşturma/davet, e-posta, parola, Meta kimlik
bilgisi ve fiyatlandırma bu panelde hâlâ yok ve bilinçli olarak eklenmedi —
offboarding hâlâ yalnız [`clinic-lifecycle.md`](clinic-lifecycle.md)'deki elle
operatör akışından yürütülür. Uygulayan migration ve rollback-only fixture'ı
hiçbir veritabanında çalıştırmadı. Codex daha sonra migration'ı yalnız
disposable `vetai-test` üzerinde CLI query yoluyla uyguladı; düzeltilmiş
rollback fixture'ı PASS verdi ve sıfır fixture artığı doğrulandı. Zorunlu Opus
incelemesi PASS verdi. 2026-09-02/03'te migration `vetai-staging`'e uygulandı,
ilgili Worker deploy edildi ve yönetilen migration geçmişinin Tasks 044, 045 ve
047 ile hizalı olduğu doğrulandı. Katalog/grant sınırı, aal1 reddi, provision
audit'i, canlı suspend/resume, exact replay ve farklı klinikle request-ID
uyuşmazlığının mutasyondan önce kapanması staging'de kanıtlandı — bkz.
[`staging-runbook.md`](staging-runbook.md) §17.1. Sentetik klinik gerçek
Meta/Cloudflare kimlik bilgisi olmadan `suspended` bırakıldı. Bu yüzden gerçek
yeni klinik onboarding'inin dış hazırlık ve açık resume adımları hâlâ ayrı bir
production kapısıdır; production değişmedi.

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
  verdi ve sıfır artık doğrulandı. Zorunlu salt-okunur Opus incelemesi dar
  düzeltmelerden sonra PASS verdi; migration daha sonra `vetai-staging`'e
  uygulandı ve `/staff` yüzeyi staging'de açıldı. Production değişmedi; gerçek
  klinik saatlerinin kurulması ayrı onboarding kapısıdır.

## 10d. Task 051 (yerel/Codex/disposable/Opus/staging tamamlandı)

Task 051, `docs/olaylar/2026-09-04-route-resolver-405.md`'de bulunan ayrı bir
üründeki boşluğu kapatır: bir konuşma `human_handoff`'a düştüğünde, personel
iş kaydını çözse bile sahip kalıcı olarak AI hizmetinden kopuyordu — hiçbir
desteklenen geri dönüş yolu yoktu.

- `public.resolve_staff_work_item`, aynı imza/sonuç şekli, `SECURITY DEFINER`
  ve `authenticated`-only grant korunarak yeniden yazıldı: artık iş kaydını
  çözerken, hâlâ `handoff`/`human_handoff` durumundaysa aynı işlemde
  konuşmayı da `completed` yapıyor (kilit sırası: klinik → çağıranın tam
  üyelik satırı → konuşma → iş kaydı; bu sıra bilinen ters-kilit çevrimini
  önler);
  ([`docs/database-schema.md`](database-schema.md#safe-terminal-handoff-recovery-task-051));
- `completed` durumu `conversations_one_open_per_owner_idx`'in kapsamı
  dışında kaldığından, aynı sahipten gelen sonraki mesaj artık yeni bir
  konuşma başlatıyor ve safety-first intake en baştan çalışıyor — hiçbir
  güvenlik sinyali, aşama ya da veri eski konuşmadan miras kalmıyor
  ([`docs/inbound-queue.md`](inbound-queue.md#fresh-conversation-after-a-resolved-handoff-task-051),
  [`docs/ai-behavior-and-safety.md`](ai-behavior-and-safety.md#safe-terminal-handoff-recovery-task-051));
- `/staff` çözüm butonu artık doğrulanmış `kind`/`reason` çiftine göre farklı,
  doğru onay metni gösteriyor: `emergency_handoff` için iki ayrı onay,
  `human_handoff` için tek onay; iptalin ikisinde de hiçbir RPC çağrısı
  yapmadığı test edildi;
- Task 049 örneğindeki gibi tek seferlik, dar kapsamlı bir tarihsel onarım
  UPDATE'i migration'a eklendi — yalnız iş kaydı zaten `resolved` olup
  konuşması hâlâ tam eşleşen `handoff`/`human_handoff` çiftinde takılı kalan
  satırları düzeltir; başka hiçbir tabloya, sütuna ya da index'e dokunulmadı;
- `emergency_handoff` ile devredilmiş bir konuşmayı AI'a geri döndürecek ayrı
  bir "AI'a geri ver" eylemi (olay kaydındaki seçenek 2) bu görevin kapsamında
  değil — yalnız personelin bilinçli çözüm eylemi konuşmayı kapatıyor;
- implementer (Claude Sonnet) tarafından migration
  (`supabase/migrations/20260904000200_handoff_conversation_recovery.sql`) ve
  rollback fixture (`supabase/tests/051_handoff_conversation_recovery.sql`)
  hiçbir veritabanına uygulanmadı/çalıştırılmadı; hiçbir gerçek Supabase,
  Cloudflare, Meta, OpenAI ya da WhatsApp çağrısı yapılmadı; hiçbir commit,
  push ya da deploy yapılmadı. Codex daha sonra migration'ı 2026-09-05'te
  yalnız disposable `vetai-test` üzerinde direct-query yoluyla uyguladı;
  düzeltilmiş rollback fixture 13 sıfır kalıntı sayacıyla PASS verdi ve
  bağımsız artık sorgusu 0 döndü. Migration history'ye kayıt eklenmedi,
  staging/production değişmedi. Claude Opus'un kilit sırası, tenant izolasyonu
  ve tarihsel onarım incelemesi 2026-09-05'te PASS verdi. Ardından ayrı sahip
  onayıyla migration yalnız `vetai-staging`'e uygulandı; katalog/deploy,
  sentetik `/staff` çözümü, farklı yeni konuşma, sıfır sentetik artık ve gerçek
  allowlist'li handoff → çözüm → yeniden güvenlik soruları smoke'u geçti.
  Production değişmedi
  ([`docs/staging-runbook.md`](staging-runbook.md) §22,
  [`docs/production-readiness.md`](production-readiness.md)).

## 10e. Task 056 (disposable kanıt geçti, Opus/staging bekliyor)

Task 056, çoklu-kiracı ürünleşme yolunda önemli bir SaaS önkoşulunu kapatır:
klinik e-posta alarmlarının tek bir platform genelindeki anahtara bağlı
olması, her klinik personelinin ya hepsinin ya da hiçbirinin alarm alması
anlamına geliyordu — çoklu klinik pilotu büyüdükçe sürdürülemez bir model.
Artık üç bağımsız katman var: personelin kendi aboneliği, platform admin'in
klinik başına rollout anahtarı, ve mevcut global Worker aktivasyonu (bkz.
[`docs/operational-alerting.md`](operational-alerting.md#11-task-056--klinik-e-posta-uyarı-tercihleri-üç-bağımsız-katman-2026-09-07-aktivasyon-yok)
§11). `/staff` ve `/admin` arayüzlerine karşılık gelen kontroller eklendi;
implementer (Claude Sonnet) migration ve rollback fixture'ı yalnız yazdı.
Codex'in dar düzeltmelerinden sonra migration önce disposable `vetai-test`
üzerinde direct-query olarak uygulandı; rollback fixture ve bağımsız katalog/
grant/sıfır-artık kanıtı geçti. Claude Opus'un zorunlu bağımsız incelemesi de
PASS verdi. Task 057 daha sonra migration'ı staging history'ye uyguladı ve iki
panel kontrolünü canlı doğruladı; production'a hiçbir etkisi olmadı.

## 10f. Task 057 (staging entegrasyonu geçti, klinik e-postası sağlayıcıda bloklu)

Task 055/056 migration'ları 2026-09-08'de yalnız `vetai-staging` history'sine
uygulandı. `/staff` kişisel opt-in ve `/admin` klinik rollout kontrolü gerçek
oturumlarla çalıştı; Cloudflare outcome şekli gerçek hesapta doğrulandı,
heartbeat tazelendi, platform e-postası kabul edildi ve canlı allowlist
WhatsApp kanaryası iki dakikalık PASS sınırını karşıladı. Klinik kapsamlı acil
e-posta adayı doğru tenant'a üretildi fakat Resend test göndericisi Auth-owned
klinik adresine gönderimi üç denemede kabul etmedi; sonuç `BLOCKED` kaldı ve
adres değiştirilmedi. Final staging bayrağı ve klinik anahtarı kapalıdır;
production değişmedi. Satış/pilot öncesi doğrulanmış gönderici alan adı,
gerçek klinik alıcısı kanıtı, operasyon sahipliği ve veteriner/KVKK kapıları
hâlâ gereklidir (bkz. [`docs/staging-runbook.md`](staging-runbook.md) §29).

## 10g. Task 058 (native panel kabuğu + erişilebilirlik, staging/production'a uygulanmadı)

`/staff` ve `/admin`, paylaşılan native bir CSS modülü (`src/panelStyles.ts`)
ve tutarlı bir operasyonel hiyerarşi altında birleştirildi: personel
tarafında 4 sekmeli klavye-erişilebilir bölüm navigasyonu (İşler / WhatsApp
otomasyonu / Takvim / E-posta uyarıları), admin tarafında ay filtresi →
klinik özeti → provizyon/askıya-alma/devam-ettirme → alert-rollout sıralaması
ve "Askıya al" için görsel olarak baskın olmayan açık bir tehlike rengi.
Hiçbir yeni framework, paket, dış font veya CDN eklenmedi; auth/MFA/session/
RPC/tenant/RLS davranışı değişmedi. Özel alan adına geçiş, bu bölümdeki
panel stratejisinin bir sonraki adımı olarak
[`docs/production-readiness.md`](production-readiness.md) §8'de tek kaynak
halinde belgelendi ve tamamen `NOT RUN` kaldı. Yerel typecheck, tüm test
suite'i (`test/staffPage.test.ts`, `test/adminPage.test.ts`,
`test/panelStyles.test.ts` dahil) ve hem production hem staging
(`wrangler.staging.toml`) `wrangler deploy --dry-run` geçti. Codex daha sonra
iki giriş yüzeyini yerel Worker + headless Chrome ile 1440/768/375 pikselde
doğruladı ve ilk görsel kontrolde bulunan gizli navigasyon/mobil taşma
sorunlarını kapattı. Kimlik doğrulamalı staging görünümü ile özel alan adı
aktivasyonu hâlâ `NOT RUN` durumundadır. Deploy veya gerçek servis/veritabanı/
domain değişikliği yapılmadı.

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


## 10n. Task 059 (uygulandı: staging; production NOT RUN)

Task 059, ürünün müşteriye görünen adını `Pati Hattı` yaptı ve sahibin satın
aldığı `patihatti.com` alan adının **yalnız staging** tarafını devreye aldı:

- `staging.patihatti.com` -> `vetai-staging` Worker'ına Cloudflare custom
  domain olarak bağlandı; `workers.dev` adresi yedek olarak korundu.
- Supabase Auth Site URL ve tam dönüş adresleri staging staff/admin için
  eklendi; wildcard eklenmedi.
- `mail.patihatti.com` Resend gönderici alt alan adı oluşturuldu; üç DNS
  kaydı yayında ve sağlayıcı durumu **Verified**.
- Better Stack readiness monitörü yeni origin'e taşındı
  (`Pati Hattı staging readiness`, `Up`).
- Panel/gizlilik/bildirim/uyarı metinlerinde müşteriye görünen ad değişti;
  **dahili `vetai` adları, veritabanı nesneleri ve tarihsel kanıtlar
  değişmedi.**
- Özel origin üzerinde staff girişi, admin AAL2, parola-kurtarma dönüşü,
  yapılandırma uçları ve canlı CSP başlıkları doğrulandı; hiçbir parola,
  recovery fragment'i veya token kanıta alınmadı.

Production uygulama origin'i `app.patihatti.com` **rezerve** edildi ve
yönlendirilmedi. Bu, ticari çıkış için Faz 6'nın kapandığı anlamına
**gelmez**: production Worker deploy'u, gerçek klinik e-posta teslimi,
veteriner ve hukuk/KVKK onayları ile operasyon sorumluları hâlâ açık.
Adım bazlı kanıt ayrımı
[`production-readiness.md`](production-readiness.md) §8.1 ve
[`staging-runbook.md`](staging-runbook.md) §31'de.

Marka notu: `Pati Hattı` adı pilot satış için seçildi; TÜRKPATENT'te 9, 35,
42 ve 44. sınıflarda profesyonel benzerlik araştırması yapılmadan resmî marka
tescili kesinleştirilmemelidir. Ürün veterinerlik hizmeti veya teşhis
vermediği için iletişimde "acil veteriner hattı" izlenimi oluşturulmamalıdır.

## 10o. Task 061 (yalnızca yerel, NOT RUN)

Task 061, `public/**` altında bağımlılıksız bir statik tanıtım anasayfası
ekledi: tek bir 16:9 oyun sahnesinde Golden Retriever, kulübe, ürün metni,
`home -> hopping-right -> right -> approaching -> network -> returning -> home`
durum makinesi ve üç açıkça yer tutucu klinik kartı. Tam-kare üretilmiş video,
arka plan nesnelerini değiştirdiği için çıkarıldı; tek değişmez WebP bahçe ile
aynı maskotun dört şeffaf pozunu taşıyan WebP sayfası bağlandı. Sağa ve sola
ileri zıplama ile kamera-yaklaşma hissi deterministik CSS'tir; geri sarma yoktur.
Göz takibi yalnız küçük koyu göz bebeklerinde kalır.

1280×720 ve 375×812 gerçek yerel tarayıcı kontrollerinde iki yönlü oynatma,
klavye aktivasyonu, odak dönüşü ve sıfır yatay/iç panel taşması doğrulandı.
`wrangler.toml`/`wrangler.staging.toml`'daki binding'siz `[assets]` bloğu mevcut
Worker yollarını değiştirmez; yeni bağımlılık yoktur. Doğrulama tamamen yerel
kaldı; staging veya production'a **hiçbir deploy yapılmadı**.

Sabit bahçe ile poz sayfası, sahibin onayladığı temiz sahne kareleri referans
alınarak yerleşik ImageGen akışında üretildi. Ticari kullanım izni ve köken kaydı
hâlâ doğrulanmadı. İlk yayından önce bu kayıt ve izin tamamlanmalı; izin yetersizse
iki varlık lisanslı veya sipariş edilmiş eşdeğerlerle yenilenmelidir. Bu kapı
logo/kalıcı maskot kararından da ayrıdır.
Ayrıntılar
[`docs/marketing-homepage.md`](marketing-homepage.md)'de; ilerideki gerçek
klinik profil kartı kullanımı için üretim kapısı
[`production-readiness.md`](production-readiness.md) §1'e eklendi.

## 10p. Task 063 (yalnızca yerel)

Task 063, Task 061'in sahne/köpek etkileşimini ve reduced-motion davranışını
aynen koruyarak tanıtım anasayfasını eksiksiz bir ürün sitesine dönüştürdü:
üstte gezinme çubuğu ve atla bağlantısı, sahnenin içinde artık sahte klinik/kişi
kartı yerine dürüst bir pilot durumu paneli (`#pilot`, eski `#network`), ardından
`#nasil-calisir` (dört adım), `#klinikler-icin` (klinik kontrolleri),
`#guvenlik` (görsel Yapar/Yapmaz ve bekleyen veteriner onayı uyarısı), `#sss`
(altı native `<details>/<summary>` sorusu) ve personel girişine bağlanan bir
kapanış/alt bilgi bölümü. Durum makinesinin sabit `network` durum adı
değişmedi; yalnızca panonun DOM id/sınıfı yeniden adlandırıldı. JavaScript
kapalıyken panonun sahne üzerine bindiği önceden var olan bir masaüstü düzeni
hatası, mobil medya sorgusunun zaten kullandığı flex-column statik akış
düzeni `html:not(.js)` seçicisiyle yeniden kullanılarak düzeltildi.

Yeni metnin tamamı `PROJECT_CONTEXT.md`'de doğrulanmış davranışa dayanır
(10 dakikalık tutma ile 30 dakikalık slotlar, "EVET" onayı, Europe/Istanbul
saati, ai/manual/personal otomasyon modları, öncelikli personel kuyruğu,
klinik çalışma saatleri/kapanışları, e-posta/tarayıcı uyarı tercihleri,
Red-öncelik otomasyon durdurma); doğrulanmamış fiyat, müşteri, SLA, 7/24
hizmet, teslim garantisi veya satış iletişimi eklenmedi. Yeni AI görseli,
video, font, ikon paketi, npm bağımlılığı, form backend'i veya analytics
eklenmedi; `wrangler.toml`/`wrangler.staging.toml`'a dokunulmadı.

`pnpm typecheck`, `pnpm exec vitest run test/homePageAssets.test.ts
test/index.test.ts`, `pnpm test`, her iki `wrangler deploy --dry-run` ve
`graphify update .` yerel olarak çalıştırıldı ve geçti. Codex gerçek yerel
Worker'ı 1440×900/768×1024/375×812 tarayıcı görünümlerinde doğruladı; bulunan
768 px breakpoint ve dar-ekran `#pilot` konumlandırma hatalarını düzelttikten
sonra tablet/telefon görünümlerini yeniden kontrol etti. JavaScript kapalı
768×1024 render da sıfır çakışmayla geçti. Tarayıcı reduced-motion medya
emülasyonu sunmadığı için yalnız render edilmiş `prefers-reduced-motion` modu
**NOT RUN** kaldı. Doğrulama tamamen yerel kaldı; staging veya production'a
hiçbir deploy yapılmadı.
Ayrıntılar [`docs/marketing-homepage.md`](marketing-homepage.md)'de; üretim
kapısı [`production-readiness.md`](production-readiness.md) §1 değişmeden
kalır (gerçek klinik kimliği/onayı hâlâ gerekiyor).
