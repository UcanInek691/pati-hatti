# Task 052 — Gecikme incelemesi ve teknik pilot kararı

Tarih: 2026-09-05. İnceleyen: Codex, kullanıcı tarafından seçilen Astra high.
Kapsam: yalnız staging üzerinde salt-okunur sorgular, mevcut Cloudflare
kayıtları ve kaynak kodu. Veri, servis ayarı, migration veya Worker değişmedi.
Telefon, içerik, kişi adı, token ve kalıcı müşteri kimliği bu rapora alınmadı.

## Sonuç

- **PROVEN:** İncelenen üç gecikmiş yanıt zincirinde uzun fark, sağlayıcının
  mesaj zamanı ile ilk başarılı veritabanı kaydı arasındadır: 61–74 dakika.
  Başarılı kayıttan Meta kabulüne kadar yalnız 18–23 saniye geçmiştir.
- **DISPROVEN:** Bu üç zincirin Queue/OpenAI/outbox içinde yaklaşık 50 dakika
  beklediği açıklaması zaman damgalarıyla uyuşmaz. Bu sonuç diğer tarihsel
  mesajların tamamına veya her sağlayıcı çağrısına genellenemez.
- **INCONCLUSIVE:** Her eski mesajın hangi başarısız webhook denemelerinden
  sonra tekrar geldiği tek tek kanıtlanamadı. Önceden kanıtlanmış resolver
  405 → webhook 503 arızasından sonraki yeniden teslimlerle güçlü biçimde
  uyumludur; kesin mesaj-bazlı retry kök nedeni olarak sunulmaz.

Yeni bir çalışma-zamanı yaması önerilmedi. Task 049/050 düzeltmeleri zaten
staging'dedir; aşağıdaki canlı kontrol bu sınırın hâlâ çalıştığını doğruladı.

## Saatler ve eşleştirme yöntemi

Tüm zamanlar UTC'dir. Örnek numaraları yalnız tablo içi sıra numarasıdır.
`messages.created_at`, bu inbound yolunda sağlayıcının saniye hassasiyetli
zamanından gelir; sunucunun ilk teslim alma zamanı değildir.
`webhook_events.received_at` veritabanı işlem zamanıdır. Duplicate yolu bunu
yenilemez. PostgreSQL `now()` işlem başlangıcını gösterir; tam HTTP varış
veya commit anı değildir.

Inbound mesaj ↔ webhook eşleştirmesi aynı klinik ve provider event kimliği;
outbox eşleştirmesi aynı klinik ve source-provider-event kimliği üzerinden
yapıldı. Kimlikler sorgu sonucuna çıkarılmadı. Kullanım kaydı aynı klinik ve
olay UUID'sinin mevcut SHA-256 özetiyle eşleştirildi. Konuşma düzeyindeki iş
kaydı tek bir mesaja aitmiş gibi kullanılmadı.

## Tarihsel veritabanı zinciri

Sorgu penceresi: 2026-09-03 20:00–2026-09-04 04:00 UTC. Bu, hâlâ veritabanında
bulunan eşleşmiş satırların örneklemidir; geçmişte silinen test satırlarını
ve kayda hiç ulaşmayan başarısız istekleri kapsamaz. Milisaniyeye yuvarlandı.

| Örnek | Sağlayıcı zamanı | Başarılı kayıt | Intake tamamlanması / outbox oluşması | Meta kabulü | Kayıt öncesi fark (sn) | Kayıt → kabul (sn) |
| --- | --- | --- | --- | --- | ---: | ---: |
| 1 | 09-04 00:50:27 | 09-04 00:50:29.202 | 00:50:51.409 | 00:50:52.971 | 2.202 | 23.769 |
| 2 | 09-03 23:57:24 | 09-04 00:59:02.554 | 00:59:24.067 | 00:59:25.293 | 3698.554 | 22.738 |
| 3 | 09-03 23:52:01 | 09-04 01:06:30.275 | 01:06:49.328 | 01:06:50.758 | 4469.275 | 20.483 |
| 4 | 09-04 00:08:57 | 09-04 01:21:27.676 | 01:21:44.889 | 01:21:45.977 | 4350.676 | 18.301 |
| 5 | 09-04 00:26:53 | 09-04 01:40:55.661 | Intake tamamlandı; outbox yok | Yok | 4442.661 | Ölçülemez |

Örnek 1–4'ün hepsi `accepted`, outbound deneme sayısı **1**; outbox oluşumu
ile kabul arasında 1.088–1.562 saniye vardır. Bu sayaç inbound/Queue retry
sayısı değildir. Örnek 5 yanıt süresi hesabına katılmadı; mevcut durumdan
tarihsel rota veya yanıtsızlığın nedeni çıkarılmadı.

Kullanım kaydı örnek 1 için 00:50:50.857, örnek 2 için 00:59:23.070 UTC'dir.
Diğer üçünde eşleşen kullanım satırı yoktur. Defter her gerçek AI denemesini
kaydetmediğinden yokluk tek başına "AI çağrılmadı" kanıtı değildir.
İlk dört örneğin konuşmasına ait ilk handoff işi 00:59:24.067'de oluşmuştur;
aynı iş zamanını dört ayrı cevabın başlangıcı saymak hatalı korelasyondur.
Son sağlayıcı durumları `read`; zamanları sırasıyla 00:51:00, 00:59:49,
01:07:00, 01:22:33 UTC'dir. Bunlar ilk teslim veya callback'in sunucuya varış
anı değil, son saklanan sağlayıcı durum zamanlarıdır.

## Bağımsız Cloudflare karşılaştırması

Dashboard GMT+3 gösteriyordu; aşağıdaki değerler üç saat çıkarılarak UTC'ye
çevrildi. Kayıtları zaman yakınlığıyla eşleştirmek destekleyici kanıttır;
aynı provider kimliğine dayalı başarısız-deneme eşleştirmesi değildir.

| Zincir | Worker `event received` | DB başarılı kayıt | Worker `event persisted` | Queue invocation kayıt zamanı |
| --- | --- | --- | --- | --- |
| Örnek 2 çevresi | 00:59:01.780 | 00:59:02.554 | 00:59:03.364 | 00:59:25.545 |
| Örnek 3 çevresi | 01:06:29.585 | 01:06:30.275 | 01:06:31.497 | 01:06:50.996 |
| Örnek 4 çevresi | 01:21:26.845 | 01:21:27.676 | 01:21:28.469 | 01:21:46.229 |

Queue invocation kayıt zamanı, Queue'ya giriş veya claim başlangıcı diye
yorumlanmadı. Bu üç başarılı istekte Worker receipt ile DB zamanı arasındaki
fark bir saniyeden azdır; uzun fark bunların öncesindedir.

2026-09-04 00:44:31.751'de alınan ayrı bir webhook, 00:44:32.206 civarında
**HTTP 503**, `outcome = ok`, `wallTimeMs = 457`, `cpuTimeMs = 2` ile bitti.
00:26–00:44 arasında başka başarısız webhook kayıtları da görüldü; 00:50:28.671
sonrasında başarılı receipt/persistence/Queue zinciri görüldü. HTTP 503 ile
`outcome=ok` birlikte olabilir: yalnız exception/başarı grafiği güvenilir
ulaşılabilirlik kanıtı değildir. Ham invocation gövdeleri rapora kopyalanmadı.

## Kaynak koduyla karşılaştırma ve kanıt sınırı

- `src/whatsappIngest.ts`: rota çözümü kalıcı kayıttan öncedir; başarısızlık
  `route_failed`, `src/index.ts` tarafında HTTP 503 olur. Bu istek için
  kalıcı inbound satırı ve ona bağlı Queue işi henüz oluşmamıştır.
- `20260829000200_inbound_message_bursts.sql`: inbound sağlayıcı zamanı ve
  ilk webhook kayıt zamanı farklı alanlarda tutulur. Tekrar gelen başarılı
  duplicate, ilk kayıt zamanını ileri taşımaz.
- `wrangler.staging.toml`: primary batch size 1, batch timeout 1 saniye,
  `max_retries = 3`, retry delay 120 saniye; DLQ retry delay 300 saniye;
  Cron dakikada bir. `max_retries` toplam deneme sayısı değil yeniden deneme
  sayısıdır. Bkz. [Cloudflare retry sözleşmesi](https://developers.cloudflare.com/queues/configuration/batching-retries/).
- `src/outboundSender.ts`: bir drain en fazla 10 satır, outbound deneme
  sınırı 3, lease 5 dakika, yeniden deneme aralığı 2 dakika. İncelenen dört
  kabul ilk outbound denemede olmuş; bir saatlik outbound retry yoktur.
- Tam intake/Queue claim başlangıçları ve tüm geçmiş retry sayıları kalıcı
  zincirde yoktur. Kabul sonrasında outbox lease alanları temizlenir.
  Kullanım zamanı AI çağrısının başlangıcı değildir. Dolayısıyla 18–23 saniye
  Queue bekleme / model / SQL diye kesin parçalara bölünemez.
- Örnekler arasındaki değişken 2 saniye / 61–74 dakika farkları tek sabit
  saat dilimi kaymasıyla açıklanamaz. Sağlayıcı saat doğruluğu bağımsız
  ölçülmedi; ilk başarısız teslimin aynı mesaja ait olduğunu kanıtlayacak
  gizlilik-korumalı korelasyon eksiktir. Retry açıklaması bu nedenle çıkarımdır.

## Güncel durum — 2026-09-05

Salt-okunur katalog kontrolü public resolver için `provolatile = v` buldu.
Gerçek staging HTTP `/ready` kontrolü 200 / `ready` döndü: en çok 30 saniyelik
Worker-isolate cache sınırı içinde gerçek PostgREST yolunun olumlu kanıtı;
Meta/OpenAI uçtan uca garantisi veya hata-enjeksiyon testi değildir.

2026-09-04 04:00 UTC sonrası sorgu anına kadar eşleşen dört yeni yanıtın
tamamı ilk outbound denemede kabul edildi. Başarılı kayıt → kabul ortalaması
21.782 saniye, maksimumu 23.951 saniye; sağlayıcı zamanı → kayıt maksimumu
4.327 saniyedir. Küçük staging örneklemi SLA veya yük testi değildir.

2026-09-05 12:04:49 UTC anlık kontrolünde pending/processing outbox **0**,
süresi geçmiş processing intake lease **0**, on dakikadan eski pending intake
**0** bulundu. Outbox toplamı 47 accepted ve 1 eski failed; eski failure'ın
oluşumu 2026-08-23 15:16:12 UTC. Bu kayıt değiştirilmedi ve son olaya mal
edilmedi. Bu DB sayıları Cloudflare'ın üç kuyruğunun backlog ölçümü değildir.

## Teknik pilot ve satış kararı

**GO — yalnız mevcut gözetimli, allowlist'li staging testlerine devam.**
Bu incelemede yeni bir runtime düzeltmesi gerektiren gecikme kanıtı yok.

**NO-GO — gözetimsiz gerçek-klinik/ücretli üretim açılışı.** Mevcut açık
teknik-operasyonel kapılar: HTTP 5xx ve `/ready` alarmı (exception sayacı tek
başına yetmez), üç Queue/DLQ backlog takibi, başarısız gönderim ve açık/acil
personel işine gerçekten bakacak sorumlu/uyarı yolu, staff-send hız sınırı
doğrulaması ve hedef üretim kurulumu/rollback/canary kanıtları. Bunların
tamamlandığı bu görevde gösterilmedi; yeni altyapı seçimi yapılmadı.

Veteriner metin onayı, KVKK/hukuk kararları, sözleşme/fiyatlandırma, Meta
hesap-numara kurulumu ve kimlik bilgisi yaşam döngüsü ayrıca satış kapılarıdır.
Özel alan adı gecikme düzeltmesinin teknik ön koşulu değildir. Task 052'nin
kapanması bu kapıları otomatik olarak kapatmaz.

## Tekrarında en küçük ölçüm

Yeni bir staging tekrarında, bilinen tek sentetik mesaj için UTC gönderim
anını not et; aynı klinik/event eşitliğiyle yalnız sunucu zamanlarını ve
durumları oku; Worker HTTP durumunu ve receipt/persistence/Queue zamanlarını
yan yana getir. Provider kimliğini, içeriği veya numarayı rapora çıkarma.
İlk başarısız denemelerin kimliği hâlâ ayrılamıyorsa sonucu INCONCLUSIVE bırak.
Sürekli mesaj-bazlı retry telemetrisi gerekirse ayrı görevde, kısa saklama ve
gizlilik incelemesiyle tasarlansın; bu inceleme bunu kurmadı.

Doğrulama: salt-okunur DB/HTTP/log kontrolleri ve kaynak yolu incelemesi.
Yalnız Markdown değiştiğinden tam test suite, migration ve deploy çalışmadı;
gerekli yerel kapanış kontrolü `git diff --check`tir.
