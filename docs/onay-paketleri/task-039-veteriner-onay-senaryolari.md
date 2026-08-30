# VetAI Task 039 — veteriner hekim onay senaryoları

Durum: **ONAYLANMAMIŞ TASLAK.** Bu belgedeki metinler ve klinik akışlar bir
veteriner hekim tarafından onaylanmadan üretim için onaylanmış sayılmaz.
Konuşmaların tamamı sentetiktir; gerçek hayvan, sahip veya randevu verisi
içermez.

Taslak tarihi: 30 Ağustos 2026<br>
Teknik doğrulama: Tek kullanımlık test veritabanı ve sentetik staging ortamı.<br>
Production durumu: **DAĞITILMADI.**

## Hekimden istenen değerlendirme

Bu paket kod veya SQL incelemesi istemez. Her senaryoda, sahibin baştan sona
gördüğü örnek WhatsApp konuşması sunulur. Köşeli parantez içindeki tarih ve
saatler dinamik örnek alanlardır; diğer bot metinleri üründeki sabit Türkçe
metinlerdir.

Hekimin her senaryo için şu dört noktayı değerlendirmesi beklenir:

1. Acil olabilecek durumda beklememe yönlendirmesi yeterli mi?
2. Botun dili teşhis, tedavi veya yanlış güvence içeriyor mu?
3. Randevu ve iptal adımları açık, dürüst ve yanlış işleme dirençli mi?
4. Mesajların birleştirilmesi veya insana devir klinik gecikme yaratır mı?

Bot teşhis koymaz, olası hastalık adı saymaz, ilaç/doz veya tedavi önermez.
İlk kalıcı bot yanıtının başında kayıt bilgilendirmesi yalnızca bir kez
gösterilir:

> **Bot:** Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu
> görüşmedeki mesajlar kayıt altına alınmaktadır.

## Kısa sözlük

- **Toplu mesaj penceresi:** Art arda gelen kısa mesajlar yaklaşık 3 saniye
  beklenerek tek turda değerlendirilir; bot her parçaya ayrı cevap yazmaz.
- **İkinci randevu koruması:** Aynı hayvanın gelecekte onaylanmış randevusu
  varsa ikinci randevu oluşturulmaz.
- **İptal onayı:** Randevu ancak sahibin ayrı bir mesajda tam `EVET` yazmasıyla
  iptal edilir. `HAYIR` randevuyu korur.
- **Taşma:** Çok sayıda veya aşırı uzun mesaj otomatik yorumlanmaz; insan
  desteğine yönlendirilir.

## Sistemin bilinmesi gereken sınırları

- Acil veya belirsiz güvenlik durumları normal randevu akışından önce gelir.
- İnsan desteği kaydı personel ekranında bir iş oluşturur; personele otomatik
  telefon, SMS, e-posta veya anlık bildirim gönderildiği anlamına gelmez.
- Bu nedenle insan desteği gereken metinler kullanıcıya kliniği telefonla
  aramasını söyler.
- Randevu teklifi **10 dakika süreli geçici bir ayırmadır**. Kullanıcı tam
  `EVET` yazıp veritabanı onayı alınana kadar kesin randevu değildir.
- Randevu onayı ve iptali yalnızca ayrı mesajdaki tam `EVET` ile yapılır. Tam
  `HAYIR` veya `HAYİR` işlemi reddeder; diğer cevaplar soruyu tekrar ettirir.
- Tarih ve saatler kullanıcıya **Europe/Istanbul** saat diliminde gösterilir.
- Aynı hayvan için ikinci bir gelecekteki onaylı randevu oluşturulmaz.
- Bot görsel, ses, video, belge, konum veya kişi kartının içeriğini analiz
  etmez; kullanıcıdan yazılı açıklama veya telefonla iletişim ister.
- Botun “klinik kapalı” bilgisi, klinik tarafından girilen çalışma saati
  yapılandırmasına dayanır. Bu verilerin güncel tutulması klinik
  sorumluluğundadır.

## İncelenecek sabit kullanıcı metinleri

Her metin için ayrı karar işaretlenmelidir. Değişiklik istenirse önerilen
Türkçe metin yazılmalıdır. Bir metin değiştiğinde kod ve testler güncellenip
değişen metin yeniden veteriner hekim onayına sunulur.

### V-01 — Acil durum yönlendirmesi

> Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık
> veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-02 — İnsan desteği / botun yanıtlayamayacağı talep

> Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın.
> Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık
> veteriner kliniğine başvurun.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-03 — Yapılandırılmış açık klinik yönlendirmesi

`[KLİNİK ADI]` ve `[TELEFON]` yalnız klinik yapılandırmasından gelir.

> Bu talebi bot üzerinden yanıtlayamam. [KLİNİK ADI] ile [TELEFON]
> numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını
> beklemeden en yakın açık veteriner kliniğine başvurun.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-04 — Yapılandırılmış kapalı klinik yönlendirmesi

> Bu talebi bot üzerinden yanıtlayamam. [KLİNİK ADI] şu anda kapalı. Acil
> olmayan konular için çalışma saatleri içinde [TELEFON] numarasından
> iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en
> yakın açık veteriner kliniğine başvurun.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-05 — Güvenlik soruları

> Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye
> yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını
> beklemeden en yakın açık veteriner kliniğine başvurun:
>
> - Nefes almakta güçlük var mı?
> - Bilinç kaybı var mı?
> - Şu anda devam eden nöbet var mı?
> - Şiddetli veya durmayan kanama var mı?
> - Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?
> - Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?
> - Yabancı bir cisim yutmuş olabilir mi?
> - İdrar yapamıyor mu?

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Eksik/fazla soru veya öneri: _____________________________________________

### V-06 — Hayvan kimliği belirsiz

> Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-07 — Şikâyet veya belirti eksik

> Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz
> belirtileri kısaca yazar mısınız?

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-08 — Bilgiler alındı

> Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse
> kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine
> başvurun.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-09 — Özet doğrulama şablonu

`[AD]`, `[TÜR]` ve `[ŞİKÂYET]` sahibin kendi mesajından çıkarılan ve uzunluğu
sınırlandırılmış bilgilerdir. Bulunmayan alan gösterilmez.

> Anladığım kadarıyla — Ad: "[AD]", Tür: [TÜR], Şikayet: [ŞİKÂYET]. Doğru
> mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-10 — Özet düzeltme istemi

> Hangi bilgiyi düzeltmemi istersiniz? Doğru adı, türü veya şikayeti yazmanız
> yeterli.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-11 — Bilgiler tamamlandıktan sonra randevu daveti

Bu soru randevu oluşturulduğu, uygun saat bulunduğu veya personelin
bilgilendirildiği iddiasında bulunmaz.

> Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse
> kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine
> başvurun. Randevu oluşturmak ister misiniz?

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-12 — Uygun randevu bulunamadı

> Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen
> kliniğimizi telefonla arayın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-13 — Geçici randevu teklifi

`[TARİH VE SAAT]` Europe/Istanbul saatinde gösterilir.

> En erken uygun randevu saati: [TARİH VE SAAT]. Bu saat geçici olarak
> ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET,
> vazgeçmek için HAYIR yazın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-14 — Randevu onaylandı

> Randevunuz [TARİH VE SAAT] için oluşturuldu.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-15 — Randevu reddedildi

> Randevu oluşturulmadı.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-16 — Geçici ayrılan saat artık kullanılamıyor

> Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla
> arayın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-17 — Aynı hayvanın mevcut randevusu

> [HAYVAN ADI] için zaten [TARİH VE SAAT] tarihinde onaylanmış bir randevu
> bulunuyor.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-18 — Randevu başka görüşmede işleniyor

> Bu randevu şu anda başka bir görüşmede işleme alınıyor. Lütfen kliniğimizi
> telefonla arayın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-19 — Randevu iptal onayı

> Randevunuz: [TARİH VE SAAT]. Bu randevuyu iptal etmek istediğinize emin
> misiniz? Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-20 — Randevu iptal edildi

> Randevunuz [TARİH VE SAAT] iptal edildi.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-21 — İptalden vazgeçildi

> Randevunuz iptal edilmedi, mevcut haliyle geçerliliğini koruyor.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-22 — İptal edilebilecek randevu bulunamadı

> Kaydınızda iptal edilebilecek onaylanmış bir randevu bulamadım. Lütfen
> kliniğimizi telefonla arayın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-23 — Randevu iptal onayı sırasında geçersizleşti

> Bu randevu artık mevcut değil ya da daha önce iptal edilmiş görünüyor.
> Lütfen kliniğimizi telefonla arayın.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-24 — Desteklenmeyen medya

> Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini
> değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi
> telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık
> veteriner kliniğine başvurun.

Karar: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Önerilen metin/not: ______________________________________________________

### V-25 — Mesajların kaydedildiği bilgilendirmesi

Bu metin klinik onayının yanında ayrıca Türk hukuk/KVKK uzmanı tarafından
incelenmelidir.

> Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu görüşmedeki
> mesajlar kayıt altına alınmaktadır.

Klinik dil kararı: [ ] Onaylı [ ] Değişiklik gerekli [ ] Kullanılmamalı<br>
Hukuk/KVKK kararı: [ ] Ayrı pakette incelendi [ ] İnceleme bekliyor<br>
Önerilen metin/not: ______________________________________________________

## Baştan sona örnek WhatsApp konuşmaları

### S-01 — Olağan belirti bildirimi ve randevunun kesinleştirilmesi

> **Sahip:** Pamuk dün geceden beri kusuyor.
>
> **Bot:** Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu
> görüşmedeki mesajlar kayıt altına alınmaktadır.
>
> Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye
> yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını
> beklemeden en yakın açık veteriner kliniğine başvurun:
>
> - Nefes almakta güçlük var mı?
> - Bilinç kaybı var mı?
> - Şu anda devam eden nöbet var mı?
> - Şiddetli veya durmayan kanama var mı?
> - Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?
> - Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?
> - Yabancı bir cisim yutmuş olabilir mi?
> - İdrar yapamıyor mu?
>
> **Sahip:** Bunların hiçbiri yok. Kusması devam ediyor.
>
> **Bot:** Anladığım kadarıyla — Ad: "Pamuk", Tür: kedi, Şikayet: Pamuk'un
> kusması devam ediyor. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR
> yazın.
>
> **Sahip:** EVET
>
> **Bot:** Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum
> kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner
> kliniğine başvurun. Randevu oluşturmak ister misiniz?
>
> **Sahip:** Evet.
>
> **Bot:** En erken uygun randevu saati: **[ÖRNEK TARİH VE SAAT]**. Bu saat
> geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca
> EVET, vazgeçmek için HAYIR yazın.
>
> **Sahip:** EVET
>
> **Bot:** Randevunuz **[ÖRNEK TARİH VE SAAT]** için oluşturuldu.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Gecikme/güvenlik riski: [ ] Yok  [ ] Var — ______________________________<br>
Not: ____________________________________________________________________

### S-02 — İki ayrı mesajın tek turda anlaşılması

> **Sahip (0. saniye):** Merhaba
>
> **Sahip (1. saniye):** Pamuk kusuyor.
>
> *(Bot ilk mesaja ayrı yanıt yazmaz; iki mesajı aynı turda değerlendirir.)*
>
> **Bot (yaklaşık 3 saniyelik pencereden sonra):** Bilgilendirme: Güvenlik ve
> yasal yükümlülükler gereği bu görüşmedeki mesajlar kayıt altına
> alınmaktadır.
>
> Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye
> yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını
> beklemeden en yakın açık veteriner kliniğine başvurun:
>
> - Nefes almakta güçlük var mı?
> - Bilinç kaybı var mı?
> - Şu anda devam eden nöbet var mı?
> - Şiddetli veya durmayan kanama var mı?
> - Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?
> - Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?
> - Yabancı bir cisim yutmuş olabilir mi?
> - İdrar yapamıyor mu?
>
> **Sahip:** Hiçbiri yok.
>
> **Bot:** Anladığım kadarıyla — Ad: "Pamuk", Tür: kedi, Şikayet: kusma.
> Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.
>
> **Sahip:** EVET
>
> **Bot:** Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum
> kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner
> kliniğine başvurun. Randevu oluşturmak ister misiniz?
>
> **Sahip:** Evet.
>
> **Bot:** En erken uygun randevu saati: **[ÖRNEK TARİH VE SAAT]**. Bu saat
> geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca
> EVET, vazgeçmek için HAYIR yazın.
>
> **Sahip:** HAYIR
>
> **Bot:** Randevu oluşturulmadı.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Yaklaşık 3 saniyelik birleştirme penceresi klinik açıdan: [ ] Uygun [ ] Uygun değil<br>
Not: ____________________________________________________________________

### S-03 — Güvenlik sorularının topluca ve kısmen yanıtlanması

> **Sahip:** Mırmır iki gündür iştahsız.
>
> **Bot:** Güvenlik için lütfen aşağıdaki soruları her biri için evet veya
> hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot
> yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:
>
> - Nefes almakta güçlük var mı?
> - Bilinç kaybı var mı?
> - Şu anda devam eden nöbet var mı?
> - Şiddetli veya durmayan kanama var mı?
> - Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?
> - Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?
> - Yabancı bir cisim yutmuş olabilir mi?
> - İdrar yapamıyor mu?
>
> **Sahip:** Nefes sorunu, bayılma, nöbet, kanama ve travma yok. Diğerlerinden
> emin değilim.
>
> **Bot:** Güvenlik için lütfen aşağıdaki soruları her biri için evet veya
> hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot
> yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:
>
> - Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?
> - Yabancı bir cisim yutmuş olabilir mi?
> - İdrar yapamıyor mu?
>
> **Sahip:** Zehir ve yabancı cisim yok, idrarını normal yapıyor.
>
> **Bot:** Anladığım kadarıyla — Ad: "Mırmır", Tür: kedi, Şikayet: iki gündür
> iştahsız. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.
>
> **Sahip:** EVET
>
> **Bot:** Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum
> kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner
> kliniğine başvurun. Randevu oluşturmak ister misiniz?

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Yalnız kalan soruların tekrar edilmesi yeterince açık mı? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-04 — Açık acil güvenlik sinyali

> **Sahip:** Boncuk nefes almakta çok zorlanıyor.
>
> **Bot:** Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın
> açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.

Bu terminal yanıtta randevu, güvenlik anketi veya bekleme önerisi verilmez.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Acil yönlendirmenin tonu ve eylemi yeterli mi? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-05 — Toplu mesaj içindeki acil sinyal

> **Sahip (0. saniye):** Köpeğim Tarçın bugün çok halsiz.
>
> **Sahip (1. saniye):** Bir de şu an nefes alamıyor gibi.
>
> *(Bot iki mesajı birlikte değerlendirir.)*
>
> **Bot:** Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın
> açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Yaklaşık 3 saniyelik teknik pencere bu örnekte kabul edilebilir mi? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-06 — Aynı hayvan için ikinci randevu isteği

Pamuk için gelecekte onaylanmış bir randevu zaten vardır.

> **Sahip:** Pamuk için tekrar randevu almak istiyorum.
>
> **Bot:** Pamuk için zaten **[MEVCUT RANDEVU TARİHİ VE SAATİ]** tarihinde
> onaylanmış bir randevu bulunuyor.

İkinci bir slot ayrılmaz; mevcut randevunun saati kullanıcıya gösterilir.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Mevcut randevu bilgisi yeterince açık mı? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-07 — Aynı hayvanın randevusu başka görüşmede işleniyor

> **Sahip:** Pamuk için randevu almak istiyorum.
>
> **Bot:** Bu randevu şu anda başka bir görüşmede işleme alınıyor. Lütfen
> kliniğimizi telefonla arayın.

Bot bu durumda ikinci bir saat söylemez ve kesinleşmemiş işlemi kesin
randevu gibi göstermez.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
“Başka bir görüşmede işleme alınıyor” ifadesi anlaşılır mı? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-08 — İlk mesajda ad verilerek randevu iptali

> **Sahip:** Pamuk'un randevusunu iptal etmek istiyorum.
>
> **Bot:** Randevunuz: **[ÖRNEK TARİH VE SAAT]**. Bu randevuyu iptal etmek
> istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için
> HAYIR yazın.
>
> **Sahip:** EVET
>
> **Bot:** Randevunuz **[ÖRNEK TARİH VE SAAT]** iptal edildi.

Randevu, ilk iptal cümlesiyle değil, ayrı `EVET` mesajıyla iptal edilir.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Yanlışlıkla iptal riskine karşı onay metni yeterli mi? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-09 — Birden fazla hayvan varken adı belirtilmeyen iptal

Sahibin Pamuk ve Tarçın adında iki kayıtlı hayvanı vardır.

> **Sahip:** Randevumu iptal etmek istiyorum.
>
> **Bot:** Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.
>
> **Sahip:** Tarçın.
>
> **Bot:** Randevunuz: **[ÖRNEK TARİH VE SAAT]**. Bu randevuyu iptal etmek
> istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için
> HAYIR yazın.
>
> **Sahip:** HAYIR
>
> **Bot:** Randevunuz iptal edilmedi, mevcut haliyle geçerliliğini koruyor.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Hayvan kimliği ve vazgeçme sonucu yeterince açık mı? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-10 — İptal edilebilecek randevu bulunmaması

> **Sahip:** Mırmır'ın randevusunu iptal etmek istiyorum.
>
> **Bot:** Kaydınızda iptal edilebilecek onaylanmış bir randevu bulamadım.
> Lütfen kliniğimizi telefonla arayın.

Bot randevu olduğunu veya iptal yaptığını iddia etmez.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Yanlış güvence veya belirsizlik var mı? [ ] Yok [ ] Var<br>
Not: ____________________________________________________________________

### S-11 — İptal onayında belirsiz cevap ve sonradan kesin karar

> **Sahip:** Boncuk'un randevusunu iptal edin.
>
> **Bot:** Randevunuz: **[ÖRNEK TARİH VE SAAT]**. Bu randevuyu iptal etmek
> istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için
> HAYIR yazın.
>
> **Sahip:** Sanırım evet olabilir.
>
> **Bot:** Randevunuz: **[ÖRNEK TARİH VE SAAT]**. Bu randevuyu iptal etmek
> istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için
> HAYIR yazın.
>
> **Sahip:** EVET
>
> **Bot:** Randevunuz **[ÖRNEK TARİH VE SAAT]** iptal edildi.

Belirsiz cevap mutasyon yapmaz; soru aynı biçimde tekrar edilir.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Yalnız tam EVET/HAYIR şartı kullanıcı için anlaşılır mı? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-12 — Sahip özet bilgisini düzeltiyor

> **Sahip:** Tekir kedim Köpük iki gündür yemek yemiyor.
>
> *(Güvenlik soruları yanıtlanır; açık güvenlik sinyali yoktur.)*
>
> **Bot:** Anladığım kadarıyla — Ad: "Köpük", Tür: kedi, Şikayet: iki gündür
> yemek yemiyor. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.
>
> **Sahip:** HAYIR
>
> **Bot:** Hangi bilgiyi düzeltmemi istersiniz? Doğru adı, türü veya şikayeti
> yazmanız yeterli.
>
> **Sahip:** Adı Köpük değil Köpüş; şikayeti de bugün başladı.
>
> **Bot:** Anladığım kadarıyla — Ad: "Köpüş", Tür: kedi, Şikayet: bugün yemek
> yemiyor. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.
>
> **Sahip:** EVET
>
> **Bot:** Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum
> kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner
> kliniğine başvurun. Randevu oluşturmak ister misiniz?
>
> **Sahip:** Evet.
>
> **Bot:** Şu anda bot üzerinden sunabileceğim uygun randevu saati yok.
> Lütfen kliniğimizi telefonla arayın.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
Düzeltme ve uygun saat bulunamaması metinleri açık mı? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

### S-13 — Çok sayıda/uzun mesajda otomatik yorumlama yerine insan desteği

> **Sahip (birkaç saniye içinde):** Kedim dün...
>
> **Sahip:** Aslında geçen hafta da...
>
> **Sahip:** Bir de kullandığı...
>
> **Sahip:** [çok uzun anlatım]
>
> **Sahip:** Ne yapmam gerektiğini tek tek anlatır mısınız?
>
> *(Bot bu taşan mesaj grubunu yapay zekâ ile yorumlamaz.)*
>
> **Bot:** Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla
> arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın
> açık veteriner kliniğine başvurun.

Hekim kararı: [ ] Uygun  [ ] Değişiklik gerekli<br>
İnsana yönlendirme ve acil çıkış yeterli mi? [ ] Evet [ ] Hayır<br>
Not: ____________________________________________________________________

## Genel değerlendirme

- [ ] Acil yönlendirme kullanıcıyı botta bekletmiyor.
- [ ] Belirsiz durumda bot dışı güvenli çıkış yeterince açık.
- [ ] Sekiz güvenlik sorusu klinik açıdan doğru, gözlemlenebilir ve anlaşılır.
- [ ] Hiçbir metin teşhis, olası hastalık, ilaç, doz veya tedavi önermiyor.
- [ ] “Kliniği arayın” ve “en yakın açık veteriner kliniğine başvurun”
      ifadeleri kliniğin çalışma biçimine uygundur.
- [ ] İnsan desteği kaydı personele bildirim gönderilmiş gibi sunulmuyor.
- [ ] Klinik adı, telefon ve açık/kapalı bilgisiyle oluşturulan metinler
      klinik uygulamasına uygundur.
- [ ] Uygun randevu teklifi ile kesin randevu arasındaki fark açıktır.
- [ ] 10 dakikalık geçici ayırma süresi klinik açıdan kabul edilebilir.
- [ ] Tarih ve saatlerin Europe/Istanbul olarak gösterilmesi uygundur.
- [ ] Randevu ve iptal akışları acil güvenlik yönlendirmesinin önüne geçmiyor.
- [ ] 13 örnek konuşmanın tamamındaki bot metinleri klinik uygulamaya
      uygundur.
- [ ] Acil veya belirsiz güvenlik durumlarında kullanıcıya bekleme önerilmez.
- [ ] Güvenlik sorularının topluca yanıtlanabilmesi klinik açıdan uygundur.
- [ ] Yaklaşık 3 saniyelik mesaj birleştirme penceresi kabul edilebilir.
- [ ] Randevu teklifinin “geçici ayırma” olduğu açıkça anlaşılmaktadır.
- [ ] Aynı hayvan için ikinci randevu engeli doğru ve anlaşılırdır.
- [ ] İptal yalnız açık onayla yapılır; vazgeçme ve randevu-yok durumları
      yeterince ayrıdır.
- [ ] Düzeltme ve insan desteğine yönlendirme metinleri yanlış güvence
      içermemektedir.

Hekimin zorunlu değişiklik önerileri:<br>
__________________________________________________________________________<br>
__________________________________________________________________________<br>
__________________________________________________________________________

## Onay kaydı

Bu alanlar yalnız yetkili veteriner hekim tarafından doldurulduğunda belge
“incelendi” sayılır.

Klinik/kurum: _____________________________________________________________<br>
Veteriner hekim adı soyadı: ______________________________________________<br>
Unvan/yetki bilgisi: _____________________________________________________<br>
Diploma/sicil no: ________________________________________________________<br>
Tarih: __________________________________________________________________<br>
İncelenen belge: VetAI Task 039 veteriner hekim onay senaryoları — 30.08.2026<br>
Genel karar: [ ] Tümü onaylandı  [ ] Kısmi onay  [ ] Onaylanmadı

Koşullar/notlar:<br>
__________________________________________________________________________<br>
__________________________________________________________________________

İmza/kurum içi onay kaydı: ______________________________________________

İmzalı veya kişisel bilgi içeren kopyayı kaynak kod deposuna koymayın.
Klinik tarafından belirlenen, erişimi sınırlı ve güvenli kayıt ortamında
saklayın.
