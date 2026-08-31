# AI kullanım ölçümü (Görev 042)

Bu belge, `record_intake_ai_usage_v1` ve `get_clinic_monthly_usage_v1`
fonksiyonlarının ne işe yaradığını sade dilde anlatır. Hedef okuyucu: pilot
klinik operasyonunu takip eden ekip, muhasebe mutabakatı yapan kişi ve
klinik kapatma (offboarding) işlemini yürüten operatör.

> Uygulayan (implementer) bu görevde migration'ı ve doğrulama fixture'ını
> hiçbir veritabanına karşı çalıştırmadı. Codex daha sonra yalnız disposable
> `vetai-test` üzerinde migration'ı uyguladı; rollback fixture'ı PASS verdi ve
> sıfır fixture artığı doğrulandı. Staging/production değişmedi. Zorunlu
> salt-okunur Opus incelemesi de PASS verdi.

## Bu bir faturalama sistemi değil

Bu ölçüm katmanı sadece **kayıt tutar**. Hiçbir yerde TL tutarı, plan, kota,
aşım (overage), fatura veya ödeme üretmez, hiçbir isteği engellemez. Çıktısı,
pilot dönemde manuel mutabakat için kullanılacak bir kanıttır — otomatik
faturalama bu görevin kapsamı dışındadır ve ayrı bir insan kararı/görevi
gerektirir.

## Aktivasyon sırası zorunludur

Staging veya production'da önce
`20260831000200_usage_metering.sql` migration'ı uygulanmalı, ancak iki RPC'nin
varlığı doğrulandıktan sonra yeni Worker deploy edilmelidir. Worker önce
deploy edilirse ölçüm çağrısı kapalı biçimde başarısız olur: aynı tur en fazla
üç Queue denemesinde yeniden OpenAI'a gidebilir ve sonunda insan devri/DLQ
yoluna düşebilir. Ölçüm katmanı bu nedenle çalışma zamanında isteğe bağlı
değildir; doğru migration-önce/Worker-sonra sırası operasyonel önkoşuldur.

## "Mantıksal tur" ne demek, gerçek sağlayıcı çağrısı ne demek

Ölçülen birim, bir **mantıksal başarılı intake-AI turu**dur: aynı temsilci
(representative) gelen WhatsApp olayı, incelenen OpenAI çıkarım (extraction)
adımına ulaşmış ve şema açısından geçerli bir sonuç dönmüştür. Dört mesaja
kadar birikmiş bir patlama (burst) tek turdur, dört ayrı tur değildir.

Bu, gerçek OpenAI sağlayıcı çağrısı sayısıyla **birebir aynı olmayabilir**:
model çağrısından sonra bir çökme/yeniden deneme (retry) olursa, sağlayıcıya
ikinci bir gerçek çağrı gidebilir, ama defter (ledger) yine de aynı mantıksal
turu tek satır olarak tutar ve ilk elde edilen token örneğini saklar. OpenAI
proje faturası toplam sağlayıcı harcamasının doğrusudur; bu defter ise
klinikler arası dağıtım/mutabakat doğrusudur. İkisi kasıtlı olarak farklı
şeyler ölçer ve iki sayı birebir eşleşmeyebilir.

## Konuşma (conversation) ile mesaj (message) farkı

Bir konuşma, aynı sahibe ait birden çok mesaj turu içerebilir. Rapor,
"kaç mesaj geldi" değil "kaç mantıksal AI turu işlendi" ve "kaç farklı
konuşma en az bir kez AI ile temas etti" sayısını verir
(`ai_turn_count`, `ai_touched_conversation_count`). Bir konuşma birden çok
tur ürettiyse tur sayısı konuşma sayısından yüksek olabilir; bu bir hata
değildir.

## Token sayıları neden bazen boş (null) olabilir

Sağlayıcı yanıtı token kullanımını içermeyebilir veya beklenmedik biçimde
gelebilir. Bu durumda üç token sütunu da (`input_tokens`, `output_tokens`,
`total_tokens`) birlikte boş bırakılır — asla kısmi/tutarsız bir üçlü
saklanmaz. Mantıksal tur yine de sayılır; aylık rapor ayrıca
`missing_token_usage_count` ile "token bilgisi eksik olan tur sayısını" ayrı
gösterir, böylece toplamlar sessizce eksik görünmez.

## Ay sınırı: Europe/Istanbul

Aylık rapor `Europe/Istanbul` yerel saatine göre hesaplanır: istenen ayın ilk
gününün yerel gece yarısı dahil, bir sonraki ayın ilk gününün yerel gece
yarısı hariçtir. Sunucu tüm zaman damgalarını UTC tutar; sınır hesaplaması
bu iki nokta arasına düşen olayları toplar.

## Ham içerik ve doğrudan kimlik alanı yok; hashler yine korunur

Defterde ham veya türetilmiş mesaj metni, telefon numarası, sahip adı/ID'si,
hayvan adı/ID'si, şikayet metni, güvenlik sinyali, sağlayıcı mesaj ID'si,
Meta veya OpenAI kimlik bilgisi, sağlayıcı yanıt gövdesi, fiyat veya fatura
**yer almaz**. Saklanan tek şeyler: klinik UUID'si, iç rastgele
kaynak-olay/konuşma UUID'lerinin tek yönlü SHA-256 özetleri (hash), sabit
olay/model/prompt sürüm bilgisi, token sayıları ve sunucu zamanı. Bu özetler
orijinal UUID'yi kendi başına göstermez; ancak UUID'yi zaten bilen yetkili bir
taraf aynı hash'i yeniden hesaplayıp eşleştirebilir. Bu nedenle hukuk/KVKK
değerlendirmesinde anonim veri gibi değil, **takma adlı (pseudonymous) ve
korunması gereken veri** gibi ele alınmalıdır.

## İç maliyet yarışı (race) uyarısı

Defter satırı, planlama ve sonuçlandırmadan (finalize) **önce**, geçerli bir
OpenAI sonucu alınır alınmaz yazılır. Bu yüzden nadir bir durumda — durum/rota
yarışı giden yanıtı bastırırsa — model işi gerçekten yapılmış olsa da müşteriye
görünen bir yanıt gitmeyebilir. Bu, otomatik olarak "müşteriye faturalanacak
bir iş" anlamına gelmez; bir iç maliyet olayıdır ve manuel mutabakat
sırasında bu şekilde değerlendirilmelidir.

Ters yönde eksik sayım da mümkündür: model çağrısından sonra claim eskiyse
(`stale_claim`) veya kaynak kayıt artık bulunamıyorsa (`not_found`), ücretli
çağrı gerçekleşmiş olsa bile deftere satır yazılmaz ve yanıt gönderilmez.
Dolayısıyla bu defter gerçek sağlayıcı harcamasından eksik kalabilir ve ayrıca
müşteriye teslim edilmeyen bir işi sayabilir; tek başına otomatik müşteri
faturasının kaynağı değildir.

## Otomatik faturalama veya kota yok

Bu görev hiçbir isteği geciktirmez, engellemez veya reddetmez. Kota, aşım
uyarısı, plan sınırı gibi hiçbir uygulama mantığı eklenmez. Böyle bir ihtiyaç
doğarsa bu, ayrı ve açıkça kapsamlı bir sonraki görev olmalıdır.

## Klinik kapatmadan (offboarding) önce raporu dışa aktarın

Defter satırlarının `webhook_events`/`messages` tablolarına bağı yoktur, bu
yüzden onların saklama süresinden bağımsız yaşar — ama klinik silindiğinde
(`on delete cascade`) **birlikte silinir** ve geri getirilemez.
`finalize_clinic_offboarding_v1` çağrılmadan önce, o klinik için gerekiyorsa
`get_clinic_monthly_usage_v1` ile aylık rapor(lar) dışa aktarılmalıdır (bkz.
[`docs/clinic-lifecycle.md`](clinic-lifecycle.md)).

Dışa aktarılan raporun silme sonrasında ne kadar süre saklanması gerektiği
(mali/hukuki saklama süresi) bu görev tarafından belirlenmemiştir — bu, ayrı
bir insan hukuk/finans kararıdır ve halen çözülmemiştir.

## Görünürlük

Bu iki fonksiyon yalnızca sunucu/operatör tarafı işlemleridir; hiçbir yeni
personel veya herkese açık RLS görünürlüğü eklenmez. İleride
metadata-only bir `/admin` yüzeyi bu raporu tüketebilir, ama o ayrı bir
görevdir ve bu görevin kapsamında değildir.
