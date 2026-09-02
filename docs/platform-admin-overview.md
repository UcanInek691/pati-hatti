# Platform-admin metadata paneli (Görev 043)

Bu belge, `/admin` sayfasının ve `get_platform_admin_overview_v1` /
`set_platform_admin_v1` fonksiyonlarının ne işe yaradığını, neyi
göstermediğini ve hangi yetki sınırlarına dayandığını sade dilde anlatır.
Hedef okuyucu: platform operasyonunu takip eden ekip ve KVKK/güvenlik
incelemesi yapan kişi.

> Uygulayan (implementer) bu görevde migration'ı ve doğrulama fixture'ını
> hiçbir veritabanına karşı çalıştırmadı. Codex daha sonra migration'ı yalnız
> disposable `vetai-test` projesine uyguladı; rollback fixture'ı geçti ve
> fixture kayıtlarının tamamı sıfır artıkla geri alındı. Staging ve production
> değiştirilmedi. Zorunlu salt-okunur Opus incelemesi, iki dar düzeltmenin
> ardından `PASS` verdi; gerçek üyelik ve üretim etkinleştirmesi yapılmadı.

## Bu bir yönetim paneli değil, sınırlı bir salt-okunur özet + yaşam döngüsü ekranıdır

`/admin`, Görev 047'den itibaren yalnızca üç sınırlı mutasyona sahiptir:
klinik oluşturma (her zaman askıya alınmış durumda başlar), askıya alma ve
devam ettirme (bkz. [Klinik yaşam döngüsü kontrolleri](#klinik-yaşam-döngüsü-kontrolleri-görev-047)
aşağıda). Kapanış (offboarding), Auth kullanıcı oluşturma/davet, e-posta,
parola, Meta token, fiyat, paket, fatura, kota, CSV dışa aktarma, grafik veya
mesaj gönderme yeteneği yoktur ve bu görevin kapsamı bunları eklemez. Sayfa
ayrıca klinikler arası, salt-okunur operasyonel metadata ile seçilen ayın
kullanım özetini gösterir.

Bu MVP sayfalama yapmadan tüm klinikleri tek yanıtta ve tek tabloda gösterir.
Bu sınır yalnız mevcut yaklaşık 5–20 klinik ölçeği için kabul edilmiştir;
klinik sayısı birkaç düzineyi aşmadan önce ölçüm yapılıp sayfalama eklenmelidir.

## Yetkilendirme aynı SQL fonksiyonunun içinde olur

Tarayıcı önce "ben yönetici miyim?" diye ayrı bir sorgu atıp sonra geniş bir
tabloyu okumaz. `get_platform_admin_overview_v1(p_month_start)`, çağıranı
`auth.uid()` ile bu fonksiyonun **kendi içinde** çözer ve `platform_admins`
üyeliğini yine burada kontrol eder:

- Üye değilse (klinik personeli, klinik `admin` rolü dahil — bu rol platform
  yöneticisi **değildir**), tek bir `forbidden` satırı döner; tüm klinik ve
  toplam alanları `null`dır.
- Üyeyse ve `public.clinics` boşsa, tek bir `empty` satırı döner.
- Üyeyse ve en az bir klinik varsa, her klinik için bir `reported` satırı
  döner.

Normal kiracı (tenant) RLS politikaları bu görevde **değiştirilmedi**: hiçbir
politikaya `OR is_platform_admin()` eklenmedi. `platform_admins` tablosunun
kendisi de RLS açık + politika yok + `service_role` dahil tüm yetkiler geri
alınmış biçimde korunur (Görev 042'deki `clinic_ai_usage_events` ile aynı
desen); tek erişim yolu bu iki `SECURITY DEFINER`,
`set search_path = ''` fonksiyonudur:

- `set_platform_admin_v1(p_user_id, p_enabled)` — yalnız `service_role`'e
  açık, backend/operatör-only bir bootstrap RPC'dir; `/admin` sayfasından
  hiçbir zaman çağrılmaz. `p_user_id` `auth.users`'ta yoksa hiçbir satır
  eklemeden `user_not_found` döner.
- `get_platform_admin_overview_v1(p_month_start)` — yalnız `authenticated`
  rolüne açıktır.

Üyelik ekleme/silme işlemlerinin aktörünü ve gerekçesini tutan ayrı bir
denetim izi henüz yoktur. Bu MVP için kabul edilen sınır, dış KVKK paketinde de
açıkça kayıtlıdır; gerçek üretim üyeliği oluşturulmadan önce operasyonel kayıt
gereksinimi ayrıca kararlaştırılmalıdır.

## `reported` satırı ne içerir, ne içermez

Her klinik satırı şunları taşır: klinik id/ad/`operational_status`; WhatsApp
hesap sayısı; açık ve acil `staff_work_items` sayısı (`status <> 'resolved'`
olanlar "açık" sayılır); `outbound_message_outbox`'ta bekleyen/işlenmekte/
başarısız sayısı; son gelen ve son giden mesaj zaman damgası; ve
[`docs/usage-metering.md`](usage-metering.md)'de anlatılan aylık kullanım
toplamları (`get_clinic_monthly_usage_v1`'in aynı `Europe/Istanbul` ay
mantığı, yeniden yazılmadan `left join lateral` ile çağrılır).

Satırda **yer almaz**: mesaj metni, telefon numarası, sahip/hayvan kimliği
veya adı, konuşma/mesaj/webhook-olay/hesap UUID'si, WhatsApp/Meta hesap
kimliği, iş öğesi (work item) kimliği, kullanım defterinin hash'leri, veya
herhangi bir sır/kimlik bilgisi (credential). Yalnızca sayaçlar, durumlar ve
zaman damgaları döner.

## `/admin` sayfası

`src/adminPage.ts`, `/staff` (`src/staffPage.ts`) ile birebir aynı deseni
izler: yeni bir bağımlılık veya Wrangler binding'i olmadan statik bir HTML
kabuğu, bağımsız bir `app.js` ve yalnız genel Supabase URL'sini ve anon
anahtarını döndüren bir `config.json`. Oturum, `/staff`'tan ayrı bir
`sessionStorage` anahtarı (`vetai_admin_access_token`) altında tutulur.
Tarayıcı tarafı, RPC'den dönen her satırı sabit 20 alanlık kapalı bir şemaya
karşı doğrular ve bozuk/beklenmeyen bir yanıtta önceki durumu temizleyip
sabit bir Türkçe hata gösterir (fail-closed); tüm değerler yalnızca
`textContent` ile yazılır, hiçbir zaman `innerHTML` ile değil.

## TOTP MFA sınırı (Görev 045)

> Bu bölümdeki migration ve rollback-only fixture uygulayan tarafından hiçbir
> veritabanına karşı çalıştırılmadı. Codex daha sonra migration'ı yalnız
> disposable `vetai-test` üzerinde uyguladı; düzeltilmiş fixture geçti ve
> Auth kullanıcısı/klinik/platform-admin kalıntısı `0 / 0 / 0` doğrulandı.
> Zorunlu Opus incelemesi de `PASS` verdi. Migration ve Worker daha sonra
> yalnız `vetai-staging` üzerinde etkinleştirildi; production değişmedi. Gerçek
> staging parola-kurtarma, yarım kurulum yenileme, TOTP doğrulama ve yetkili
> genel-bakış akışı 2026-09-02'de geçti. Üretim kapısı diğer açık kontroller
> nedeniyle hâlâ kapalıdır.

Parola girişi tek başına artık yeterli değildir. `get_platform_admin_overview_v1`
içinde, `platform_admins` üyelik kontrolüne ek olarak **ikinci ve bağımsız**
bir yetkilendirme koşulu vardır: çağıranın JWT'sindeki `aal` (assurance
level) iddiası tam olarak `aal2` olmalıdır (`auth.jwt() ->> 'aal' is not
distinct from 'aal2'`). İki koşuldan biri eksikse fonksiyon yine tek bir
`forbidden` satırı döner; yanıt şekli Görev 043'teki ile birebir aynıdır,
üyelik veya MFA durumunu ayırt eden yeni bir bilgi sızdırmaz.

`aal2`'ye ulaşmanın tek yolu Supabase Auth'un kendi TOTP faktör akışıdır;
`/admin` bunu veritabanına dokunmadan, yalnızca Supabase Auth uç noktalarını
çağırarak yürütür:

- **Kurulum (hesapta hiç MFA faktörü yok):** `/auth/v1/factors` ile yeni bir
  `totp` faktörü açılır. Ham REST yanıtındaki sınırlı boyutlu SVG, aktif
  içerik/harici kaynak kalıpları reddedildikten sonra istemci tarafından
  yüzde-kodlanmış sabit bir `data:image/svg+xml;charset=utf-8,` adresine
  çevrilebilirse gösterilir; QR biçimi kabul edilmezse kurulum kapanmaz.
  Supabase'in doğrulanmış Base32 metin anahtarı bağımsız kurulum yolu olarak
  gösterilir. Kullanıcı bunu doğrulayıcı uygulamaya elle girip uygulamadan
  aldığı 6 haneli kodu yazar.
- **Doğrulama (tam olarak bir doğrulanmış TOTP faktörü):** doğrudan
  `/auth/v1/factors/{id}/challenge` + `/auth/v1/factors/{id}/verify` ile 6
  haneli kod istenir.
- **Yarım kalmış kurulum (tam olarak bir doğrulanmamış TOTP faktörü):** parola
  oturumuna ait o tek ve UUID-doğrulanmış faktör
  `DELETE /auth/v1/factors/{id}` ile kaldırılır ve hemen tek bir yeni kurulum
  başlatılır. Doğrulanmış faktörler bu yoldan asla silinmez.
- **Desteklenmeyen durum** (birden fazla faktör, TOTP-olmayan faktör, ya da
  bozuk/beklenmeyen bir yanıt):
  sayfa erişim jetonunu ve geçici oturum/MFA ekran durumunu temizleyip sabit
  bir "operatörle iletişime geçin" ekranında kilitli kalır.

Faktör/challenge/verify sırrı (QR, metin anahtarı, kod, faktör/challenge
kimliği) yalnızca bellekte tutulur, hiçbir zaman `sessionStorage`'a veya
başka bir kalıcı depoya yazılmaz. Yanlış kodda aynı kurulum ekranı korunur
ve her denemede yeni bir challenge üretilir; başarılı doğrulamada, oturum
süresi dolduğunda veya çıkışta hassas ekran durumu temizlenir. Kurulum
sırasında sayfa yeniden yüklenip Supabase Auth'ta tam bir `unverified` TOTP
faktörü kalırsa, sonraki parola girişi yalnız o yarım kaydı temizleyip yeni
kurulum üretir; güvenli QR gösterilemezse doğrulanmış metin anahtarı kullanılır.
Çoklu, doğrulanmış, TOTP-olmayan veya bozuk durumlar tahmin edilmez.
`sessionStorage`'daki
`vetai_admin_access_token` yalnızca başarılı bir MFA doğrulamasından **sonra**
yazılır — parola girişinin döndürdüğü `aal1` erişim jetonu hiçbir zaman
kalıcı depoya yazılmaz. Sayfa her yeniden yüklendiğinde, saklı jeton varsa
bile genel bakış verisi göstermeden önce aynı faktör/AAL akışından tekrar
geçirilir; yani kayıtlı bir `aal1` jetonu asla önbelleğe alınmış veriyi
kısaca bile göstermez.

TOTP faktörünün kendisi (sır dahil) tamamen Supabase Auth'un sorumluluğunda
kalır; `platform_admins` üyeliği ile faktör kaydı birbirinden bağımsızdır —
MFA kurmak tek başına platform yöneticiliği **vermez**, yalnızca zaten üye
olan bir hesabın ikinci faktörünü doğrular. Cihaz kaybı/manuel kurtarma bu
görevin kapsamında değildir; operatör bunu Supabase Auth panelinden elle
çözer.

Bu denetimin gerçek staging kurulumu/doğrulaması 2026-09-02'de geçti. Ancak
[`docs/production-readiness.md`](production-readiness.md) 1. bölümündeki madde,
tüm allowlist hesapları ve sunucu tarafı MFA deneme sınırı dahil kalan şartlar
tamamlanmadan işaretlenemez; bkz. [`docs/staging-runbook.md`](staging-runbook.md).

## Güvenli parola kurtarma (Görev 046)

Supabase parola-kurtarma e-postası `/admin` sayfasına döner. Tarayıcı,
`#type=recovery&access_token=...` parçasını belleğe alıp adres çubuğundan
hemen kaldırır; yalnız tam `recovery` türünü ve mevcut sınırlı erişim-jetonu
doğrulamasından geçen değeri kabul eder. Fragmentteki diğer değerler okunmaz,
adlandırılmaz veya saklanmaz. Kurtarma jetonu `sessionStorage`, `localStorage`,
log, DOM metni, Worker isteği, veritabanı ya da outbox'a yazılmaz.

Yeni parola iki kez girilir, 12–128 Unicode kod noktası sınırı ve eşleşme
istemcide doğrulanır; Supabase'in kendi parola politikası ayrıca yetkilidir.
Güncelleme yalnız mevcut, kimliği doğrulanmış `PUT /auth/v1/user` çağrısıyla
yapılır. Başarılı işlem tüm geçici kurtarma/parola durumunu temizleyip normal
giriş ekranına döner; kullanıcı hâlâ yeni parolasıyla giriş yapmalı ve Görev
045 TOTP akışını tamamlamalıdır. Kurtarma bağlantısı platform-admin üyeliği
veya `aal2` vermez, genel bakış RPC'sini çağırmaz.

## Klinik yaşam döngüsü kontrolleri (Görev 047)

> Bu bölümdeki migration (`supabase/migrations/20260902000100_platform_admin_clinic_controls.sql`)
> ve rollback-only fixture (`supabase/tests/047_platform_admin_clinic_controls.sql`)
> uygulayan tarafından hiçbir veritabanına karşı çalıştırılmadı. Codex daha
> sonra migration'ı yalnız disposable `vetai-test` üzerinde CLI query yoluyla
> uyguladı (migration-history kaydı oluşturulmadı); düzeltilmiş rollback
> fixture'ı geçti ve Auth kullanıcısı/klinik/WhatsApp hesabı/platform-admin/
> audit kalıntısı `0 / 0 / 0 / 0 / 0` doğrulandı. Staging ve production
> değiştirilmedi. Zorunlu Opus mimari incelemesi tamamlanmadan bu bölüm
> staging'e alınamaz — bkz.
> [`docs/staging-runbook.md`](staging-runbook.md).

`/admin`, `platform_admins` üyeliği ve `aal2` doğrulanmış oturumlar için üç
yeni `authenticated`-only RPC ekler: `platform_provision_clinic_v1`,
`platform_suspend_clinic_v1`, `platform_resume_clinic_v1`. Her biri, Görev
041'in mevcut `service_role`-only `provision_clinic_v1` / `suspend_clinic_v1`
/ `resume_clinic_v1` fonksiyonlarını **değiştirmeden**, sahip-baypas (owner
bypass) ACL deseniyle çağıran ince bir `SECURITY DEFINER` sarmalayıcıdır —
Görev 041'in migration dosyası bu görevde dokunulmadan kalır. Kapanış
(`prepare_clinic_offboarding_v1` / `finalize_clinic_offboarding_v1`) hâlâ
yalnız mevcut operatör akışından erişilebilir; `/admin`'e yeni bir grant
verilmez.

Provizyon formu yalnız Görev 047'nin 5. kararındaki sınırlı alanları alır:
klinik adı, ilk personelin Auth UUID'i ve rolü, dahili WhatsApp-hesap UUID'i,
Meta `phone_number_id`, opsiyonel görünen ad. İletişim telefonu ve açık adres
her zaman `null`'a sabitlenir; access token, app secret, webhook secret, WABA
token, müşteri telefonu, sahip/hayvan/mesaj/klinik içeriği hiçbir zaman
alınmaz. Yeni klinik her zaman askıya alınmış durumda oluşturulur ve otomatik
etkinleştirilmez.

İstek kimliği (request id) ve klinik UUID'i tarayıcıda
`crypto.randomUUID()` ile üretilir; Web Crypto yoksa veya biçim geçersizse
işlem fail-closed durur. WhatsApp-hesap UUID'i, Cloudflare registry hazırlığıyla
aynı olması için operatörün girdiği kanonik UUID'dir ve ayrıca doğrulanır. Bu
kimlikler hiçbir zaman URL'e veya kalıcı depoya yazılmaz. Yanıtın kaybolduğu
yeniden denemede form girdileri değişmediyse aynı request/clinic UUID'leri
bellekten tekrar kullanılır; girdiler değiştiyse yeni bir girişim başlar. Aynı istek
kimliğiyle aynı aktör/işlem/klinik/girdi tekrar gönderilirse (`platform_admin_check_replay_v1`
üzerinden, işlem-kapsamlı bir advisory lock ile serileştirilir), veritabanı
mutasyonu tekrarlanmadan kayıtlı sonucu döner; aynı istek kimliği farklı bir
girdiyle geldiğinde ise hiçbir mutasyon yapılmadan hata fırlatılır.

Denetim izi (`public.platform_admin_clinic_action_events`), Görev 047'nin
8. kararındaki minimize alan setiyle sınırlıdır: yalnızca istek kimliği,
aktörün Auth UUID'i, hedef klinik UUID'i, kapalı bir eylem/sonuç değeri ve
girdinin tek yönlü SHA-256 parmak izi — klinik adı, telefon, adres, token,
mesaj veya e-posta hiçbir zaman yazılmaz. Yasaklı (forbidden) istekler
hiçbir denetim satırı bırakmaz. Tablo RLS açık, hiçbir role (tarayıcı dahil,
`service_role` dahil) doğrudan grant yoktur; tek yazma yolu bu üç RPC'nin
kendisidir.

Askıya alma ve devam ettirme, genel bakış tablosundaki uygun satırların
yanında ayrı bir düğmeyle sunulur; klinik UUID'i hiçbir zaman görünür metin
veya DOM özniteliği olarak yazılmaz, yalnızca JS kapanışında (closure) tutulur.
Her iki işlem de tazelenmiş bir açık onay gerektirir; devam ettirme onay
metni, Görev 047'nin 6. kararındaki dış ön koşulları (doğru kimlik bilgisi
girişi, Cloudflare gizli anahtarı güncellemesi, `/ready` kontrolü, Meta
webhook/yapılandırma kontrolleri, klinik çalışma saatleri, rota izin listesi,
insan onayı) sayar ama bunların makine tarafından doğrulandığını **iddia
etmez**.

2026-09-01 staging denemesinde eski Supabase Site URL'inin
`http://localhost:3000` olduğu görüldü. Bağlantı içeriği yanlışlıkla bir sohbet
mesajına yapıştırıldığı için ilgili staging Auth hesabının tüm oturumları
operatör onayıyla iptal edildi ve kalan oturum sayısı `0` doğrulandı. Hiçbir
bearer değeri bu depoya veya kanıt kaydına alınmadı. Doğru staging
yönlendirmesi, yeni parola, TOTP zorunluluğu, yarım kurulum yenilemesi ve
allowlist sonrası salt-okunur genel bakış 2026-09-02'de canlı doğrulandı.
Production değiştirilmedi ve ayrı üretim kapıları tamamlanmadan onaylı değildir.
