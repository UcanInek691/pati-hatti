# VetAI — Türk Hukuku ve KVKK üretim öncesi inceleme dosyası

Durum: **ONAYLANMAMIŞ HUKUK TASLAĞI.** Bu belge bir hukuk görüşü, KVKK
uygunluk beyanı, aydınlatma metni, açık rıza metni, kişisel veri işleme
envanteri veya saklama ve imha politikası değildir. Hukuk/KVKK uzmanının
ürünü anlayıp eksik kararları tamamlaması için hazırlanmış inceleme çalışma
kâğıdıdır.

Belge tarihi: 30 Ağustos 2026<br>
Teknik kapsam: Task 039 dâhil mevcut VetAI staging sürümü<br>
Canlı durum: Tek kullanımlık test veritabanı ve sentetik staging doğrulaması
tamamlandı; **production ortamına dağıtılmadı.**<br>
Mevzuat kontrol tarihi: 30 Ağustos 2026; resmî KVKK Kurumu ve Ticaret
Bakanlığı kaynakları esas alınmıştır.

## 1. Yönetici özeti — hukukçunun önce bilmesi gerekenler

VetAI, bir veteriner kliniğinin WhatsApp hattına gelen **yalnız açıkça AI
listesine alınmış bireysel numaraları** işler. Sistem mesajdan hayvan adı,
şikâyet, güvenlik cevapları ve randevu/iptal niyeti çıkarır; güvenlik ve işlem
kararlarını kapalı kurallarla verir. Bot teşhis, tedavi veya ilaç önermez.

Kullanılan dış hizmetler: **Meta/WhatsApp, Cloudflare, Supabase ve OpenAI.**
Mesaj metni ve telefon numarası dâhil kişisel veriler farklı aşamalarda bu
hizmetlerden geçebilir. Üretim hesabındaki sözleşme, veri bölgesi, alt işleyen
ve yurt dışı aktarım mekanizmaları henüz hukukçu tarafından doğrulanmamıştır.

### Üretimi engelleyen açık hukuk kararları

- [ ] Veri sorumlusu, varsa ortak veri sorumlusu ve veri işleyen rolleri
      gerçek sözleşme ve fiilî işleyişe göre belirlendi.
- [ ] Her işleme faaliyeti için KVKK m.5/m.6 kapsamındaki **somut hukuki
      sebep** ayrı ayrı belirlendi.
- [ ] WhatsApp ilk temasında gösterilecek katmanlı aydınlatma metni ve ispat
      yöntemi onaylandı. Mevcut kısa “mesajlar kayıt altına alınmaktadır”
      cümlesinin tek başına KVKK m.10 aydınlatması olmadığı kabul edildi.
- [ ] Meta, Cloudflare, Supabase ve OpenAI için yurt dışı aktarım şartı ve
      uygun güvence belirlendi; gerekiyorsa Kurum standart sözleşmesi doğru
      taraf tipleriyle imzalanıp **beş iş günü** içinde bildirilecek süreç
      kuruldu.
- [ ] Kayıt grubu bazında azami saklama süresi, başlangıç anı, periyodik imha,
      yedek ve sağlayıcı kopyası yöntemi belirlendi.
- [ ] İlgili kişi başvurularını kimlik doğrulayarak en geç 30 günde
      sonuçlandıracak süreç ve araç tanımlandı.
- [ ] Veri ihlali müdahale planı; Kurula en geç 72 saat ve ilgili kişiye makul
      en kısa sürede bildirim akışıyla yazılı hale getirildi.
- [ ] Çocuk kullanıcı, mesaj içinde üçüncü kişi veya insana ait sağlık verisi,
      çalışan verisi ve ticari elektronik ileti senaryoları karara bağlandı.
- [ ] Sağlayıcı sözleşmeleri, alt işleyenler, veri bölgeleri, log/yedek
      süreleri, silme taahhütleri ve güvenlik önlemleri belgelendi.
- [ ] Üretim aydınlatma metni, saklama-imha politikası, veri işleme envanteri,
      başvuru formu ve gerekli sözleşmeler ayrıca hazırlandı.

Bu maddeler tamamlanmadan teknik güvenlik kontrollerinin bulunması tek başına
“KVKK'ya uygunluk” sonucu doğurmaz.

## 2. Hukukçu için sade sistem akışı

| Adım | Ne olur? | Veri nereden geçer? | Kalıcı kayıt |
|---|---|---|---|
| 1 | Kişi kliniğin WhatsApp numarasına yazar | Kişi → Meta | Meta koşullarına bağlı |
| 2 | Meta imzalı webhook'u Worker'a yollar | Meta → Cloudflare Worker | Worker belleğinde geçici ham webhook; altyapı logları ayrıca doğrulanmalı |
| 3A | Tanınan grup mesajıysa daha içerik okunmadan kapsam dışı bırakılır | Cloudflare | VetAI veritabanı, Queue, OpenAI ve yanıt yok |
| 3B | Bireysel numara AI listesinde değilse yalnız yönlendirme zarfı değerlendirilir | Cloudflare → Supabase rota çözümü | Mesaj içeriği VetAI'de kaydedilmez; açık kişisel rota varsa numara saklanabilir |
| 3C | Numara AI listesinde ise mesaj alınır | Cloudflare → Supabase | Sahip, konuşma, mesaj ve teknik olay kayıtları |
| 4 | Queue işi oluşturulur | Cloudflare Queue | Yalnız konuşma ve sağlayıcı mesaj kimliği; ham mesaj yok |
| 5 | Güncel mesaj(lar) ve sınırlı bağlam yapılandırılır | Supabase → Worker → OpenAI | OpenAI hesabı/sözleşmesine bağlı; istek `store:false` |
| 6 | Sabit güvenlik ve iş akışı kuralları sonucu belirler | Worker ve Supabase | Konuşma özeti, aşama, randevu veya personel işi |
| 7 | Sabit/dinamik şablon yanıt outbox'a yazılır | Supabase | Alıcı telefon, yanıt metni ve teslimat bilgisi |
| 8 | Yanıt WhatsApp'a gönderilir | Cloudflare → Meta | Meta ve Supabase teslimat kaydı |
| 9 | Yetkili personel işi açar | Personel tarayıcısı → Supabase | Son 20 mesaj, sahip adı/telefonu ve hayvan bilgisi görüntülenebilir |

### Kesin veri-minimizasyonu sınırları

- Cloudflare Queue gövdesine ham mesaj metni konmaz.
- OpenAI'a tam konuşma geçmişi verilmez. Güncel turdaki en fazla dört kısa
  mesaj tek metinde birleştirilebilir; ayrıca en fazla bir önceki uygun klinik
  sorusu verilebilir.
- Önceki klinik sorusu bir doğrulama özeti ise hayvan adı, tür ve şikâyet
  içerebilir. Kullanıcı kendi mesajında başka kişisel veriler yazarsa bunlar da
  güncel metnin parçası olarak OpenAI'a ulaşabilir.
- OpenAI isteğinde telefon, sahip adı veya ham veritabanı UUID'si ayrıca alan
  olarak gönderilmez. Bunun yerine aynı sahip için kalıcı, SHA-256 türevi
  takma adlı bir güvenlik tanımlayıcısı gönderilir; bu değer sağlayıcı tarafında
  aynı kullanıcıya ait isteklerin ilişkilendirilebilmesine elverişlidir.
- `store:false`, sağlayıcının tüm güvenlik/yasal kayıtlarını kendiliğinden
  sıfırladığı anlamına gelmez. Hesap ayarları ve sözleşme ayrıca incelenmelidir.
- Beş veya daha fazla mesaj ya da 65.536 karakter üstü taşma OpenAI'a
  gönderilmeden insan desteğine yönlendirilir.
- Görsel, ses, video, belge, konum ve kişi kartı içeriği analiz edilmez.

## 3. Taraflar ve ilgili kişi grupları

Roller sözleşmedeki unvana göre değil, işleme amaç ve araçlarını gerçekte
kimin belirlediğine göre doldurulmalıdır.

| Konu | Hukukçunun kararı |
|---|---|
| Veri sorumlusu: klinik mi, VetAI/WEOSA mı, her ikisi mi? | |
| Ortak veri sorumluluğu varsa görev ve başvuru paylaşımı | |
| Meta/WhatsApp'ın rolü | |
| Cloudflare'ın rolü | |
| Supabase ve altyapı sağlayıcısının rolü | |
| OpenAI'ın rolü | |
| Klinik personelinin yetkisi ve gizlilik yükümlülüğü | |
| Alt işleyen kullanımı ve değişiklik bildirim yöntemi | |
| Veri sorumlusu iletişim ve KVKK başvuru kanalı | |
| VERBİS kayıt yükümlülüğü veya istisnası | |

İlgili kişi grupları en az şunlardır:

- WhatsApp'tan yazan hayvan sahibi veya iletişim kuran kişi;
- mesajda adı/iletişim veya sağlık bilgisi geçen üçüncü kişiler;
- reşit olmayan kullanıcılar;
- klinik personeli ve Supabase Auth kullanıcıları;
- kişisel rota listesine eklenen telefon numarası sahipleri.

Evcil hayvanın kendisi gerçek kişi değildir; ancak hayvan adı, şikâyet,
randevu ve konuşma bilgisi bir gerçek kişiyle ilişkilendirildiğinde bütün kayıt
kişisel veri değerlendirmesine girebilir. Mesaj içinde insana ait sağlık veya
başka özel nitelikli veri yazılması ihtimali ayrıca ele alınmalıdır.

## 4. Eksiksiz teknik veri envanteri

### 4.1 Supabase'de kalıcı olabilen kayıtlar

| Kayıt grubu | Alan örnekleri | Amaç | Kim görebilir? | Mevcut silme/saklama durumu |
|---|---|---|---|---|
| Klinik | Klinik adı ve tenant kimliği | Yetki ve veri ayrımı | Yetkili personel/backend | Klinik silme zinciri; otomatik süre yok |
| Klinik çalışma bilgisi | Haftalık saat, kapanış günü, genel telefon/adres | Açık/kapalı insan yönlendirmesi | Aynı klinik personeli/backend | Klinikle silinir; otomatik süre yok |
| Personel üyeliği | Auth kullanıcı UUID'si, klinik, rol | Giriş ve yetki | Aynı klinik/yönetim | Auth yaşam döngüsü ayrıca yönetilmeli |
| WhatsApp hesabı | Meta `phone_number_id`, görünen ad, klinik | Mesajı doğru kliniğe bağlama | Yetkili personel/backend | Hesap/klinik silme zinciri |
| Kişi yönlendirme rotası | E.164 telefon, `ai/manual/personal`, güncelleme zamanı | AI'ın hangi numaraları işleyeceği | Aynı klinikteki tüm yetkili personel | Owner silme zincirinden bağımsız; `inherit` satırı siler; otomatik süre yok |
| Hayvan sahibi | Ad-soyad, E.164 telefon, klinik | İletişim ve sahip eşleştirme | Aynı klinik personeli/backend | Owner/klinik silme zinciri; otomatik süre yok |
| Evcil hayvan | Ad, tür, sahip, klinik | Konuşma ve randevu eşleştirme | Aynı klinik personeli/backend | Sahiple silinir; tek hayvan silme bağlı konuşma nedeniyle engellenebilir |
| Konuşma | Sahip/hayvan, durum, aşama, sürüm | Akış ve optimistic concurrency | Aynı klinik personeli/backend | Sahip/klinikle silinir; otomatik süre yok |
| Yapılandırılmış intake | Şikâyet, belirtiler, sekiz güvenlik cevabı, niyet, eksik alanlar | Güvenlik ve resepsiyon akışı | Aynı klinik personeli/backend | Konuşmayla silinir; otomatik süre yok |
| Mesaj | Yön, ham metin, WhatsApp kimliği, zaman | Geçmiş, personel incelemesi, tekrar önleme | Personel detayında son 20 mesaj; backend | Konuşmayla silinir; otomatik süre yok |
| Webhook olayı | Provider event ID, hash, hesap, durum, claim/lease, burst uygunluğu, sınırlı hata | İdempotency ve işleme | Backend | Otomatik genel süre yok; outbox bağı dikkate alınmalı |
| Giden outbox | Alıcı E.164, yanıt metni/kategorisi, deneme, gönderim/teslim durumu, provider ID | Güvenilir gönderim | Backend; personel listesinde doğrudan yok | Pending/processing silme gönderimi düşürebilir; accepted satırlar telefon/metni süresiz tutuyor |
| Personel iş kaydı | Konuşma/outbox UUID'leri, neden, öncelik, durum, atanan/gören/çözen kullanıcı ve zamanlar | İnsan takibi | Aynı klinik personeli | Kaynakla cascade; otomatik süre yok |
| Randevu slotu | Zaman, durum, sahip/hayvan/konuşma, hold token/süresi | Ayırma ve onay | Backend; klinik verileriyle ilişkili | İlişkili kayıtlarla cascade; otomatik süre yok |
| Randevu iptal denetimi | Klinik, slot, sahip, hayvan, konuşma UUID'leri; slot zamanları; iptal zamanı | İptal izi | Yalnız backend/service role; personel ekranında yok | Bağlı kayıtlarla cascade; bağımsız süre yok |
| Teslimat durumu | `sent/failed/delivered/read`, zaman | WhatsApp teslimat takibi | Backend | Outbox yaşam döngüsüne bağlı |

Randevu zamanları veritabanında UTC zaman damgası olarak tutulur; kullanıcıya
gösterilen randevu saatleri `Europe/Istanbul` zaman dilimine çevrilir. Hukukçu,
saklanan zaman ile kullanıcıya gösterilen zaman arasındaki bu sınırın aydınlatma
ve uyuşmazlık kayıtlarında yeterince açık olup olmadığını değerlendirmelidir.

### 4.2 Supabase dışında işlenen veya geçici veriler

| Ortam/sağlayıcı | İşlenen veri | VetAI'nin mevcut sınırı | Hukukçunun doğrulaması gereken |
|---|---|---|---|
| Meta/WhatsApp | Telefon, profil adı, gelen ham içerik, outbound yanıt, provider kimlikleri | İmzalı webhook; grup veya liste-dışı olma Meta'nın ilk iletimini engellemez | Rol, amaç, bölge, saklama, alt işleyen, sözleşme ve aktarım |
| Cloudflare Worker | İmzalı ham webhook, kısa süreli işleme verisi, API sırları | Ham mesaj/secret uygulama loguna yazılmaz | Platform logları, gözlemlenebilirlik, bölge, alt işleyen, silme |
| Cloudflare Queue/DLQ | Konuşma ve provider mesaj UUID'si | Ham mesaj Queue gövdesinde yok; yeniden deneme sınırlı | Queue/DLQ retention, yedek, destek erişimi, aktarım |
| OpenAI | Güncel mesaj/burst, en fazla bir önceki klinik sorusu, kalıcı takma güvenlik ID'si, şema/prompt | `store:false`; tam geçmiş, telefon/isim ayrı alan olarak yok | Hesap veri kontrolleri, varsayılan/abuse logları, ZDR uygunluğu, bölge, alt işleyen, aktarım |
| Supabase/Auth altyapısı | Tablolardaki tüm kayıtlar, personel hesabı/oturum | RLS, tenant FK, service-role ayrımı | Proje bölgesi, yedek, log, destek erişimi, alt işleyen, aktarım |
| Personel tarayıcısı | İş listesi; detayda sahip adı/telefon, hayvan ve son 20 mesaj | Supabase Auth ve aynı-klinik RLS | Yönetilen cihaz, oturum, ekran görüntüsü/indirme, erişim ayrılışı |

### 4.3 Strict AI listesi ve kişisel konuşma sınırı

- Varsayılan mod `personal`dır; yalnız açık `ai` rota satırı otomasyona girer.
- Listede olmayan bireysel numaranın içerik alanı yönlendirme kararı için
  okunmaz, hashlenmez, VetAI veritabanına yazılmaz, Queue/OpenAI'a gönderilmez
  ve yanıt oluşturulmaz. Meta'nın webhook'u Worker'a getirmesi engellenemez.
- Açık `personal` veya `manual` rota satırı E.164 numarayı saklar. Listede hiç
  olmayan numara için VetAI rota satırı tutmaz.
- Rota satırları owner kaydından bağımsızdır; owner silmek rotayı otomatik
  silmez. `inherit` seçimi exact override satırını siler.
- Aynı klinikte yetkili tüm personel rota satırlarını görebilir; satır onu
  oluşturan personele özel değildir.
- Tanınan grup mesajları route çözümünden önce elenir; VetAI kaydı, Queue,
  OpenAI veya yanıt oluşmaz. Bu, Meta'nın grup içeriğini kendi hizmetinde
  işlemediği anlamına gelmez.
- AI'dan personal/manual moda geçmek geçmişte saklanmış kayıtları kendiliğinden
  silmez. Pending outbox temizlenebilir; Meta'ya verilmiş istek geri alınamaz.

## 5. İşleme faaliyetleri ve hukuki sebep karar tablosu

Bu tabloyu hukukçu, KVKK m.5 ve gerekiyorsa m.6'daki somut işleme şartını
yazarak tamamlamalıdır. “Hizmet için gerekli”, “KVKK kapsamı” veya bütün
faaliyetler için tek bir “açık rıza” yazılması yeterli kabul edilmemelidir.

| Faaliyet | Veri/ilgili kişi | Amaç | Alıcı | Hukuki sebep | Saklama bağlantısı | Uzman notu |
|---|---|---|---|---|---|---|
| WhatsApp mesajını alma | Gönderen; telefon, profil adı, metin | İletişim talebini alma | Meta, Cloudflare, Supabase | | | |
| AI listesi yönlendirmesi | Telefon numarası ve hesap | Kişisel/iş konuşmasını ayırma | Supabase, Cloudflare | | | |
| Mesaj geçmişi | Ham gelen/giden metin | Personelin olayı görmesi ve süreklilik | Supabase, yetkili personel | | | |
| AI yapılandırma | Güncel mesaj/burst, önceki soru, takma ID | Ad/şikâyet/güvenlik/niyet çıkarımı | OpenAI | | | |
| Güvenlik kapısı | Güvenlik cevapları | Acil/human/soru akışı | Supabase, personel | | | |
| Hayvan kaydı | Hayvan adı/türü, sahip bağlantısı | Hasta eşleştirme | Supabase, personel | | | |
| Randevu ayırma/onay | Sahip-hayvan, slot zamanı | Randevu işlemi | Supabase, Meta | | | |
| Randevu iptali | Sahip-hayvan-slot, iptal zamanı | İptal ve denetim izi | Supabase | | | |
| Personel iş akışı | Konuşma, neden, atama/işlem kullanıcıları | İnsan müdahalesi | Yetkili klinik personeli | | | |
| Yanıt gönderimi | Telefon ve yanıt metni | WhatsApp cevabı | Meta, Cloudflare, Supabase | | | |
| Teslimat/tekrar önleme | Provider ID, hash, durum, hata özeti | Güvenilirlik ve güvenlik | Meta, Cloudflare, Supabase | | | |
| Personel kimlik doğrulama | Personel hesabı/oturum | Yetkili erişim | Supabase Auth | | | |
| Teknik log/yedek | Altyapı metadata'sı; sağlayıcıya göre içerik ihtimali | Güvenlik/iş sürekliliği | İlgili sağlayıcı | | | |

## 6. Aydınlatma, açık rıza ve kullanıcıya gösterilecek metin

Mevcut ilk WhatsApp cevabındaki cümle şöyledir:

> Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu görüşmedeki
> mesajlar kayıt altına alınmaktadır.

Bu cümle kayıt gerçeğini söyler; ancak veri sorumlusunun kimliği, amaçlar,
alıcı grupları, toplama yöntemi, hukuki sebep, yurt dışı aktarım ve KVKK m.11
hakları bulunmadığından **tek başına m.10 aydınlatma metni değildir.** Staging
`/privacy` sayfası da veri sorumlusu ve hukuki sebepler kesinleşmediğini açıkça
söyleyen pilot bildirimidir; production aydınlatmasının yerine geçmez.

Kurumun 18.02.2026 tarihli 2026/347 sayılı İlke Kararı doğrultusunda:

- aydınlatma ve açık rıza ayrı metin/işlem olmalıdır;
- açık rıza dışı bir işleme şartı varsa gereksiz açık rıza istenmemelidir;
- “okudum/bilgi edindim” geri bildirimi rıza gibi sunulmamalıdır;
- başka kuruluşun metni kopyalanmamalı, gerçek işleyişe özgülenmelidir;
- dil kısa, açık ve faaliyet bazlı olmalıdır.

### Hukukçunun tasarlaması gereken katmanlı yapı

| Katman | Önerilen işlev | Hukukçunun kararı |
|---|---|---|
| İlk WhatsApp mesajı | Kısa bildirim + production tam metnine doğrudan bağlantı | |
| Tam aydınlatma sayfası | m.10 asgari unsurları ve yurt dışı akışı | |
| Gerekli ise ayrı açık rıza | Belirli konu, süre/kapsam, özgür irade, geri alma | |
| AI açıklaması | Modelin yalnız çıkarım yaptığı, kesin güvenlik/işlem yetkisi olmadığı | |
| Saklama özeti | Kayıt grubu bazında gerçek süreler | |
| Başvuru kanalı | Kimlik doğrulamalı erişim/düzeltme/silme yolu | |

Aydınlatmanın gösterildiğini ispat yöntemi: _______________________________<br>
Production tam metin URL'si: _____________________________________________<br>
Metin sürüm/değişiklik yönetimi: _________________________________________

## 7. Yurt dışına aktarım ve sağlayıcı incelemesi

KVKK m.9 rejimi faaliyet/rol bazında değerlendirilmelidir. Yeterlilik kararı,
uygun güvence veya arızi aktarım seçeneklerinden hangisinin gerçekten
uygulanabildiğini hukukçu belirlemelidir. “Sağlayıcı büyük bir şirkettir” veya
“store:false kullanılıyor” uygun güvence yerine geçmez.

Standart sözleşme seçilecekse Kurumun ilan ettiği doğru taraf tipi kullanılmalı,
metin seçimlik alanlar dışında değiştirilmemeli ve imzadan itibaren **beş iş
günü içinde Kuruma bildirim** süreci kurulmalıdır.

| Sağlayıcı | Aktarım zinciri | Gerçek sözleşmede doğrulanacak | Seçilen m.9 mekanizması | İmza/bildirim/yenileme sahibi |
|---|---|---|---|---|
| Meta/WhatsApp | Gönderen ↔ Meta ↔ Worker | Rol, ülke/bölge, alt işleyen, mesaj/metadata retention, destek erişimi | | |
| Cloudflare | Webhook, Worker, Queue/DLQ | Data localization, log, Queue retention, yedek, alt işleyen | | |
| OpenAI | Mesaj/burst, önceki soru, takma ID | API veri kontrolleri, abuse logları, ZDR, bölge, alt işleyen | | |
| Supabase/altyapı | Veritabanı, Auth, API, yedek | Proje bölgesi, backup/log, destek erişimi, alt işleyen | | |

Aktarım haritası ve sözleşme eklerinin saklandığı yer: ____________________<br>
Standart sözleşme bildirim takibi: _______________________________________

## 8. Saklama ve imha karar tablosu

Projede genel amaçlı otomatik saklama/imha işi yoktur. Cascade silme
kısıtları, hukuki saklama süresinin belirlendiği; yedek, log veya sağlayıcı
kopyasının silindiği anlamına gelmez.

| Kayıt grubu | Bugünkü teknik durum/risk | Azami süre | Süre başlangıcı | İmha yöntemi/periyot | Hukuki gerekçe ve sorumlu |
|---|---|---|---|---|---|
| Sahip/hayvan | Owner silme zinciri var; tek hayvan silme bağlı konuşmada engellenebilir | | | | |
| Konuşma/intake | Ham şikâyet ve güvenlik özeti; otomatik süre yok | | | | |
| Mesajlar | Ham gelen/giden metin; otomatik süre yok | | | | |
| Webhook/hash | Outbox bağıyla birlikte ele alınmalı; otomatik süre yok | | | | |
| Pending/processing outbox | Silme gönderilmemiş yanıtı düşürebilir | | | | |
| Accepted/delivered outbox | Telefon ve yanıt metnini süresiz tutuyor | | | | |
| Personel iş kayıtları | Kaynakla cascade; atama/işlem personel UUID'leri | | | | |
| Randevu slotları | Sahip/hayvan/konuşma bağlantısı | | | | |
| İptal denetimi | Cascade var; bağımsız süre ve personel görüntüleme yok | | | | |
| Kişi rota listesi | Owner'dan bağımsız telefon; explicit personal/manual/ai | | | | |
| Supabase Auth | Ayrı kullanıcı/oturum yaşam döngüsü | | | | |
| Queue/DLQ | Sağlayıcı retention ve kurtarma penceresi | | | | |
| Uygulama/altyapı logları | Uygulama ham metin loglamaz; platform ayarı doğrulanmalı | | | | |
| Yedekler | Production backup politikası/silme yöntemi belirlenmedi | | | | |
| Meta/Cloudflare/OpenAI/Supabase kopyaları | Sözleşme ve hesap ayarına bağlı | | | | |

Politikanın uygulanmasından sorumlu unvan: _______________________________<br>
Periyodik imha aralığı: __________________________________________________<br>
İmha işlem kayıtlarının saklama süresi: __________________________________

## 9. İlgili kişi başvuruları ve veri yaşam döngüsü

Kurum bilgisinde, başvurular en kısa sürede ve en geç **30 gün içinde**
sonuçlandırılmalıdır. Bugün production için tamamlanmış self-service erişim,
dışa aktarma veya silme aracı yoktur; işlem genel SQL'e veya yapay zekâya
bırakılmamalıdır.

| Süreç | Hukuk/operasyon kararı |
|---|---|
| Başvuru adresi ve kabul edilen yöntemler | |
| Başvuranın kimliğini ölçülü biçimde doğrulama | |
| 30 günlük süre ve sorumlu ekip | |
| Telefonla clinic-tenant kayıt arama yöntemi | |
| İhracata girecek tablolar ve provider kopyaları | |
| Yanlış veriyi düzeltme ve alıcılara bildirme | |
| Aktif randevu/pending mesaj ile silme talebi çatışması | |
| Tek hayvan silerken conversation bağlantısını güvenle çözme | |
| Owner silinse de bağımsız rota numarasını bulup silme | |
| Auth, backup, log ve dört sağlayıcıdaki kopyaları ele alma | |
| Başvuru sonucu ve yapılan işlemin ispat kaydı | |

Bot tarafından oluşturulan pet kaydı ile personel tarafından oluşturulan pet
kaydı bugün tabloda ayrı provenance alanıyla ayırt edilemez. Sahip onay mesajı
normal mesaj olarak kalır; ayrı bir onay denetim tablosu yoktur. Hukukçu bu
ispat/provenance ihtiyacını ayrıca karara bağlamalıdır.

## 10. Yapay zekâ, otomatik değerlendirme ve insan müdahalesi

- OpenAI yalnız kapalı JSON şemasında bilgi çıkarır; yanıt metni, tanı, ilaç,
  veritabanı kaydı veya SQL üretemez.
- Acil güvenlik kararı sekiz sinyal üzerinde deterministik kuralla verilir.
- Pet kaydı, randevu onayı ve randevu iptali ayrı tam `EVET` onayı gerektirir.
- Belirsiz, çelişkili, taşan veya modelce işlenemeyen yol insan desteğine gider.
- İnsan desteği kaydı personel ekranında görünür; telefon/SMS/e-posta/push
  bildirimi göndermez. Bu operasyonel sınır aydınlatmada ve personel
  prosedüründe yanlış anlatılmamalıdır.
- Personel, sahip adı/telefonu, hayvan ve son 20 mesaja erişebilir; görme,
  sahiplenme ve çözme durumları kaydedilir.

Hukukçu KVKK m.11 kapsamında münhasıran otomatik analiz sonucu kişinin aleyhine
bir sonucun ortaya çıkmasına itiraz hakkını; randevu sunmama, human handoff ve
AI listesi kararları bakımından değerlendirmeli, uygun insan inceleme ve itiraz
kanalını belirlemelidir.

Otomatik karar/insan inceleme prosedürü: __________________________________<br>
Kullanıcıya açıklanacak AI rolü: __________________________________________

## 11. Özel durumlar

### 11.1 Reşit olmayan kullanıcı

WhatsApp gönderenin yaşı doğrulanmaz. Çocuğa uygun dil, veli/vasinin rolü,
başvuru ve varsa açık rıza süreci hukukçu tarafından belirlenmelidir. Acil
veteriner yönlendirmesi çocuğu botta bekletmemelidir.

### 11.2 Mesajda üçüncü kişi veya insana ait sağlık bilgisi

Serbest metin kullanıcıyı aşan kişisel veri içerebilir. Veri minimizasyonu,
personel erişimi, OpenAI aktarımı, özel nitelikli veri ihtimali ve silme
prosedürü için talimat hazırlanmalıdır. Sistem bu alanları otomatik ayıklamaz.

### 11.3 Grup konuşmaları

VetAI tanınan grup mesajını içerik, kalıcı kayıt ve AI öncesinde eler. Buna
rağmen Meta'nın webhook iletimi ve Meta tarafındaki işleme ayrı sözleşmesel
konudur. Tanınmayan yeni provider biçimleri için regression ve olay prosedürü
korunmalıdır.

### 11.4 Ticari elektronik ileti

Mevcut akış kullanıcının başlattığı resepsiyon/randevu yanıtları içindir.
Pazarlama, kampanya, hatırlatma veya yeniden etkileşim mesajları bugün kapsam
dışıdır. Gelecekte eklenirse 6563 sayılı Kanun, Ticari İletişim ve Ticari
Elektronik İletiler Hakkında Yönetmelik ve gerekiyorsa İYS/onay-ret kuralları
ayrı incelenmelidir; mevcut WhatsApp konuşması pazarlama izni sayılmamalıdır.

### 11.5 Klinik çalışanları

Personel hesabı, atama/görme/çözme kayıtları ve erişim logları çalışan kişisel
verisi olabilir. Yetki matrisi, gizlilik taahhüdü, eğitim, işten ayrılma erişim
iptali ve çalışan aydınlatması hazırlanmalıdır.

## 12. Teknik ve idari güvenlik — mevcut kontroller ve açık işler

### Mevcut teknik kontroller

- Meta webhook imzası ham gövde üzerinden doğrulanır; boyut ve içerik türü
  sınırı vardır.
- Tenant ayrımı `clinic_id`, bileşik yabancı anahtarlar ve RLS ile veritabanı
  seviyesinde uygulanır.
- Service-role anahtarı tarayıcıya verilmez; personel Supabase Auth ve anonim
  anahtarla, aynı-klinik RLS kapsamında çalışır.
- Ham mesaj, token, imza ve service-role secret'ı uygulama loglarına yazılmaz.
- Queue gövdesinde ham mesaj yoktur; claim/lease ve idempotency kontrolleri
  vardır.
- Appointment/pet/iptal mutasyonları açık kullanıcı kararı ve atomik RPC ile
  yapılır.
- Owner/clinic için birçok ilişkisel cascade silme yolu vardır.

### Üretimden önce belge/operasyon gerektirenler

- [ ] Erişim yetki matrisi ve düzenli yetki gözden geçirme
- [ ] MFA/oturum politikası ve işten ayrılma prosedürü
- [ ] Anahtar rotasyonu ve secret olay prosedürü
- [ ] Yama, zafiyet, bağımlılık ve sızma testi programı
- [ ] Şifreleme, backup restore ve silme testi kanıtı
- [ ] Sağlayıcı alt işleyen/değişiklik takibi
- [ ] Personel eğitimi, gizlilik taahhüdü ve disiplin süreci
- [ ] Log erişimi, alarm ve olay müdahale sorumluları
- [ ] İş sürekliliği, Queue/DLQ ve yanlış gönderim kurtarma prosedürü
- [ ] Düzenli KVKK envanter/politika denetimi

## 13. Veri ihlali müdahale çalışma kâğıdı

KVKK Kurulunun 24.01.2019 tarihli 2019/10 sayılı kararı uyarınca “en kısa
sürede” ifadesi Kurula bildirim için en geç **72 saat** olarak yorumlanır.
Etkilenen kişilere de belirlendikten sonra makul olan en kısa sürede uygun
yöntemle bildirim gerekir.

| Karar | Doldurulacak alan |
|---|---|
| 7/24 ihlal bildirim kanalı | |
| Olay sorumlusu ve yedek kişi | |
| 72 saat sayacını başlatan öğrenme anı | |
| Meta/Cloudflare/OpenAI/Supabase koordinasyonu | |
| Etkilenen kişi ve veri tespit yöntemi | |
| Kurul bildirimini hazırlayan/onaylayan | |
| İlgili kişi bildirim kanalı ve metni | |
| Kanıt, zaman çizelgesi ve iyileştirme kaydı | |

## 14. Sağlayıcı ve klinik sözleşme kontrol listesi

- [ ] Veri sorumlusu–veri işleyen veya veri sorumlusu–veri sorumlusu rolü
      sözleşmede gerçek işleyişle uyumlu.
- [ ] Talimatla işleme, gizlilik, güvenlik, alt işleyen, denetim ve ihlal
      bildirim süreleri yazılı.
- [ ] Veri kategorileri, ilgili kişi grupları, amaç, süre ve coğrafya açık.
- [ ] Sözleşme bitiminde silme/iade ve yedek yöntemi belirli.
- [ ] Destek personeli ve kamu otoritesi talepleri prosedürü incelendi.
- [ ] Uluslararası aktarım eki ile ana hizmet sözleşmesi tutarlı.
- [ ] Klinik–VetAI sorumlulukları; aydınlatma, başvuru, silme, personel yetkisi
      ve veri ihlali bakımından paylaştırıldı.

Sözleşme eksikleri/notlar:<br>
__________________________________________________________________________<br>
__________________________________________________________________________

## 15. Production “go / no-go” hukuk kontrolü

| Kapı | Durum | Kanıt/belge |
|---|---|---|
| Roller ve VERBİS kararı | [ ] Tamam [ ] Eksik | |
| Faaliyet bazlı hukuki sebep | [ ] Tamam [ ] Eksik | |
| Production aydınlatma metni | [ ] Tamam [ ] Eksik | |
| Gerekli ise ayrı açık rıza | [ ] Tamam [ ] Gerekmez | |
| Yurt dışı aktarım mekanizmaları | [ ] Tamam [ ] Eksik | |
| Sağlayıcı/klinik sözleşmeleri | [ ] Tamam [ ] Eksik | |
| Saklama ve imha politikası | [ ] Tamam [ ] Eksik | |
| Başvuru/düzeltme/silme prosedürü | [ ] Tamam [ ] Eksik | |
| Veri ihlali planı | [ ] Tamam [ ] Eksik | |
| Çocuk/üçüncü kişi/çalışan politikası | [ ] Tamam [ ] Eksik | |
| Ticari ileti sınırı | [ ] Tamam [ ] Eksik | |
| Veteriner hekim metin onayı | [ ] Tamam [ ] Eksik | |

Hukukçu nihai kararı: [ ] Production hukuk kapıları tamam<br>
[ ] Aşağıdaki düzeltmelerden sonra yeniden inceleme gerekli<br>
[ ] Production'a alınmamalı

Zorunlu düzeltmeler:<br>
__________________________________________________________________________<br>
__________________________________________________________________________<br>
__________________________________________________________________________

## 16. Resmî kaynaklar — 30 Ağustos 2026 kontrolü

1. [6698 sayılı Kanun kapsamında Aydınlatma Yükümlülüğü Tebliği — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/4132/aydinlatma-yukumlulugunun-yerine-getirilmesinde-uyulacak-usul-ve-esaslar-hakkinda-teblig)
2. [18.02.2026 tarihli 2026/347 sayılı açık rıza ve aydınlatmanın ayrılması İlke Kararı — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/8710/veri-sorumlulari-tarafindan-acik-riza-ve-aydinlatma-metinlerinin-ayri-ayri-duzenlenmesi-gerektigi-hakkinda-kisisel-verileri-koruma-kurulunun-18-02-2026-tarihli-ve-2026-347-sayili-ilke-kararina-iliskin-kamuoyu-duyurusu)
3. [Yurt Dışına Aktarım — güncel m.9 rejimi ve resmî dokümanlar — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/2053/Yurtdisina-Aktarim)
4. [Standart sözleşmelerde dikkat edilecek hususlar ve beş iş günü bildirimi — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/8170/Yurt-Disina-Kisisel-Veri-Aktariminda-Kullanilacak-Standart-Sozlesmelerde-Dikkat-Edilmesi-Gereken-Hususlara-Iliskin-Kamuoyu-Duyurusu)
5. [Kişisel Verilerin Silinmesi, Yok Edilmesi veya Anonim Hale Getirilmesi Yönetmeliği — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/5441/KISISEL-VERILERIN-SILINMESI-YOK-EDILMESI-VEYA-ANONIM-HALE-GETIRILMESI-HAKKINDA-YONETMELIK)
6. [İlgili kişi başvurularının en geç 30 günde cevaplanması — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/2046/Ilgili-Kisiler-Tarafindan-Yapilan-Basvurularin-Cevaplanmasi-Yukumlulugu)
7. [Veri güvenliğine ilişkin yükümlülükler ve KVKK m.12 — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/2040/Veri-Guvenligine-Iliskin-Yukumlulukler)
8. [Veri ihlali bildirimi ve 72 saat açıklaması — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/8595/kamuoyu-duyurusu)
9. [Üretken Yapay Zekâ ve Kişisel Verilerin Korunması Rehberi — KVKK Kurumu](https://www.kvkk.gov.tr/Icerik/8547/uretken-yapay-zeka-ve-kisisel-verilerin-korunmasi-rehberi-15-soruda)
10. [Elektronik ticaret ve ticari elektronik ileti mevzuatı — Ticaret Bakanlığı](https://www.ticaret.gov.tr/ic-ticaret/mevzuat/elektronik-ticaret)

Bu liste başlangıç noktasıdır. Uzman inceleme tarihinde Kanun, ikincil
mevzuat, Kurul kararları, sağlayıcı şartları ve klinik sektörü için geçerli
diğer düzenlemelerin güncel hâlini ayrıca doğrulamalıdır.

## 17. Hukuk/KVKK onay kaydı

Bu alanlar yalnız yetkili hukuk/KVKK uzmanı tarafından doldurulduğunda belge
“incelendi” sayılır.

Veri sorumlusu/klinik: ___________________________________________________<br>
İnceleyen hukuk/KVKK uzmanı: _____________________________________________<br>
Unvan/yetki bilgisi: _____________________________________________________<br>
İnceleme tarihi: _________________________________________________________<br>
İncelenen belge: VetAI Türk Hukuku ve KVKK üretim öncesi inceleme dosyası — 30.08.2026<br>
Karar: [ ] Production hukuk kapıları tamam  [ ] Düzeltme gerekli  [ ] Onaylanmadı

Koşullar/eksik belgeler:<br>
__________________________________________________________________________<br>
__________________________________________________________________________<br>
__________________________________________________________________________

İmza/kurum içi onay kaydı: ______________________________________________

İmzalı, iletişim bilgili veya hukuki görüş içeren tamamlanmış kopyayı kaynak
kod deposuna koymayın. Veri sorumlusunun yetkili ve erişimi sınırlı kayıt
ortamında saklayın.
