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

## Bu bir yönetim paneli değil, salt-okunur bir özet ekranıdır

`/admin` şu anda **hiçbir mutasyon** içermez: klinik askıya alma/kapatma,
fiyat, paket, fatura, kota, CSV dışa aktarma, grafik veya mesaj gönderme
yeteneği yoktur ve bu görevin kapsamı bunları eklemez. Sayfa yalnızca
klinikler arası, salt-okunur operasyonel metadata ile seçilen ayın kullanım
özetini gösterir. Klinik yaşam döngüsü mutasyonları hâlâ ayrı bir operatör
akışından yürütülür (bkz. [`docs/clinic-lifecycle.md`](clinic-lifecycle.md)).

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

## MFA henüz yok — bu üretimde onaylı bir ayrıcalıklı erişim değildir

`/admin` şu anda yalnız Supabase Auth e-posta/parola girişine dayanır; bu
sayfanın kendi içindeki Türkçe uyarı da bunu açıkça belirtir. Sızmış veya
tekrar kullanılan bir parola, tüm kliniklerin operasyonel metadata'sını ve
aylık AI kullanım özetini okumaya yeten tek engeldir. Bu nedenle
[`docs/production-readiness.md`](production-readiness.md) 1. bölümüne, MFA
(veya eşdeğer bir üst-seviye kontrol) doğrulanana kadar işaretlenemeyecek
ayrı bir madde eklendi; bu madde işaretlenmeden `/admin` gerçek klinik
verisine karşı kullanılmamalıdır.
