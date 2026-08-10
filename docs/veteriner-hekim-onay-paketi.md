# VetAI veteriner hekim inceleme ve onay paketi

Sürüm tarihi: 10 Ağustos 2026<br>
İncelenecek ürün metni sürümü: `0a3e13d`

## Bu belge ne için kullanılır?

Bu belge, VetAI WhatsApp botunun hayvan sahibine gönderebildiği güvenlik ve
randevu metinlerini tek yerde gösterir. İnceleyen veteriner hekim, metinlerin
klinik uygulamasına uygun, açık ve gecikmeye yol açmayacak nitelikte olup
olmadığına karar verir.

Bu bir tıbbi protokol değildir. Bot teşhis koymaz, hastalık olasılığı saymaz,
ilaç/doz veya tedavi önermez. Bu belgeyi hazırlayan yazılım ekibinin ya da bir
yapay zekânın değerlendirmesi veteriner hekim onayının yerine geçmez.

## Kısa sözlük

- **İnsan desteği kaydı (`human_handoff`)**: Bot konuşmayı kendi başına
  sürdürmez; konu personel ekranındaki iş listesine girer. Bu kayıt personele
  otomatik telefon, SMS veya bildirim göndermez.
- **Güvenlik sinyali**: Sahibin açıkça bildirdiği nefes güçlüğü, bilinç kaybı,
  nöbet, ağır kanama, ciddi travma, olası zehirlenme, yabancı cisim veya idrar
  yapamama durumlarından biri.
- **Geçici randevu ayırma**: Saat kısa süreli tutulur; kullanıcı `EVET` yazıp
  sistem onaylayana kadar kesin randevu değildir.
- **Ürün metni sürümü**: İncelenen cümlelerin hangi yazılım sürümüne ait
  olduğunu gösteren kayıt kodudur. Veterinerin kodu incelemesi gerekmez.

## Sistemin bilinmesi gereken sınırları

- Acil veya belirsiz güvenlik durumları normal randevu akışını durdurur.
- İnsan desteği kaydı oluşması personelin ekranında iş kaydı oluşturur; personele
  telefon, SMS, e-posta veya anlık bildirim gönderildiği anlamına gelmez.
- Bu nedenle insan desteği gereken metinler kullanıcıya kliniği telefonla
  aramasını söyler.
- Randevu teklifi on dakika süreli geçici bir ayırmadır; `EVET` yanıtından ve
  veritabanı onayından önce kesin randevu değildir.
- Kullanıcı yalnızca tam `EVET` ile randevuyu onaylar; tam `HAYIR` veya
  `HAYİR` yazımı reddeder. Diğer cevaplar teklifi tekrarlar.
- Tarih ve saatler kullanıcıya `Europe/Istanbul` saat diliminde gösterilir.

## İncelenecek kullanıcı metinleri

Her madde için bir karar işaretleyin. Değişiklik isteniyorsa önerilen yeni
metni yazın. Bir metin değişirse kaynak kod ve testler güncellenmeli, ardından
değişen metin yeniden veteriner hekim onayına sunulmalıdır.

### V-01 — Acil durum yönlendirmesi

Ne zaman gösterilir: Kullanıcı sekiz güvenlik sinyalinden en az birini açıkça
bildirdiğinde.

> Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-02 — Botun yanıtlayamayacağı veya insan desteği gereken talep

Ne zaman gösterilir: Kullanıcı insan istediğinde, tıbbi tavsiye istediğinde,
otomasyon güvenle devam edemediğinde veya teknik hata insan müdahalesi
gerektirdiğinde.

> Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-03 — Güvenlik soruları

Ne zaman gösterilir: Acil durum olup olmadığına ilişkin bilgilerden biri veya
birkaçı bilinmiyorsa. Yalnız bilinmeyen sorular gösterilir.

> Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:

- Nefes almakta güçlük var mı?
- Bilinç kaybı var mı?
- Şu anda devam eden nöbet var mı?
- Şiddetli veya durmayan kanama var mı?
- Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?
- Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?
- Yabancı bir cisim yutmuş olabilir mi?
- İdrar yapamıyor mu?

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Eksik/fazla soru veya önerilen metin: _________________________________

### V-04 — Evcil hayvan kimliği belirsiz

> Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-05 — Şikâyet veya belirti eksik

> Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-06 — Bilgiler alındı

> Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-07 — Uygun randevu bulunamadı

> Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen kliniğimizi telefonla arayın.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-08 — Geçici randevu teklifi

`[TARİH VE SAAT]` alanı sistem tarafından İstanbul saatinde doldurulur.

> En erken uygun randevu saati: [TARİH VE SAAT]. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-09 — Randevu onaylandı

> Randevunuz [TARİH VE SAAT] için oluşturuldu.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-10 — Randevu reddedildi

> Randevu oluşturulmadı.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

### V-11 — Ayrılan randevu artık kullanılamıyor

> Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.

Karar: [ ] Onaylı  [ ] Değişiklik gerekli  [ ] Kullanılmamalı<br>
Önerilen metin / not: ________________________________________________

## Veteriner hekim kontrol listesi

- [ ] Acil yönlendirme kullanıcıyı botta bekletmiyor.
- [ ] Belirsiz durumda güvenli kaçış yolu yeterince açık.
- [ ] Sekiz güvenlik sorusu klinik açıdan doğru, anlaşılır ve gözlemlenebilir.
- [ ] Hiçbir metin teşhis, hastalık ihtimali, ilaç, doz veya tedavi önermiyor.
- [ ] “Kliniği arayın” ve “en yakın açık veteriner kliniğine başvurun”
      ifadeleri kliniğin çalışma biçimine uygun.
- [ ] Randevu teklifi ile kesin randevu arasındaki fark açık.
- [ ] Randevu süreci acil güvenlik yönlendirmesinin önüne geçmiyor.
- [ ] Personel bildirimi yapılmadığı hâlde yapılmış gibi bir ifade yok.
- [ ] Klinik adı, telefon numarası veya çalışma saati eklenmesi gerekiyorsa
      bunun hangi metinlere ve hangi kaynaktan ekleneceği belirtildi.

## Onay kaydı

Klinik: ______________________________________________________________<br>
İnceleyen veteriner hekim: ___________________________________________<br>
Unvan / yetki bilgisi: _______________________________________________<br>
İnceleme tarihi: _____________________________________________________<br>
İncelenen sürüm: `0a3e13d`<br>
Karar: [ ] Olduğu gibi onaylandı  [ ] Değişikliklerle onaylanabilir  [ ] Onaylanmadı<br>
Koşullar / notlar: ___________________________________________________<br>
İmza / kurum içi onay kaydı: _________________________________________

İmzalı veya kişisel bilgi içeren kopyayı bu herkese açık olabilecek kod
deposuna koymayın. Klinik tarafından yetkili ve erişimi sınırlı bir kayıt
ortamında saklayın.
