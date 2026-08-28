# VetAI ürün, doğrulama ve ticarileştirme yol haritası

Son karar tarihi: 2026-08-13.

Bu belge ürün geliştirme sırasını, gerçek servis doğrulamalarını, personel
operasyonu kararını, model seçim kapısını, maliyet varsayımlarını ve ilk fiyat
hipotezini tek yerde tutar. Bir üretim onayı veya hukuk/veteriner onayı değildir.
Aktif uygulama sözleşmesi her zaman kökteki `CURRENT_TASK.md` dosyasıdır.

## 1. Hedef ürün

VetAI, veteriner kliniği için WhatsApp tabanlı dijital resepsiyondur. Sahibi ve
hayvanı tanır, açıkça bildirilen bilgileri yapılandırır, veteriner tarafından
onaylanmış deterministik kurallarla güvenlik önceliği verir, sınırlı randevu
akışını yürütür ve otomasyonun durduğu işi personele görünür kılar.

VetAI veteriner değildir. Tanı, olası hastalık listesi, ilaç/doz, tedavi planı
ve bakımın geciktirilmesine yol açabilecek tıbbi tavsiye üretmez. Yapay zeka
yalnız yapılandırılmış bilgi çıkarır; güvenlik ve veri mutasyonları doğrulanmış
kod ve veritabanı işlemlerinin yetkisindedir.

## 2. Bugünkü doğrulanmış durum

Mevcut kod tabanı şunları içerir:

- imzalı WhatsApp webhook alma ve tekrar teslim güvenliği;
- çok kiracılı Supabase şeması, composite tenant ilişkileri ve RLS;
- OpenAI Structured Outputs tabanlı tek-mesaj bilgi çıkarımı;
- deterministik güvenlik kapısı ve Türkçe sabit yanıtlar;
- Queue, lease, retry, DLQ ve atomik intake finalizasyonu;
- WhatsApp outbox gönderimi ve teslim durum takibi;
- insan devri/teslim hatası için personel iş kuyruğu;
- giriş, iş listesi, sahip/hayvan/son mesaj detayı ve çözme işlemi sunan minimal
  `/staff` ekranı;
- tek saatlik geçici ayırma ve kesin `EVET`/`HAYIR` randevu akışı;
- dış servissiz deterministik yerel ürün demosu.

Henüz yoktur veya üretimde çalışmıyordur:

- gerçek üretim deployment ve gerçek servis yapılandırması;
- gerçek OpenAI/Meta/Queue/Supabase uçtan uca staging kanıtı;
- gerçek klinik personel hesapları ve canlı personel ekranı;
- personelin işi zamanında gördüğünü kanıtlayan bildirim;
- çok turlu kısa cevapları önceki soruyla birlikte yorumlama;
- yeni hayvan kayıt akışı;
- görsel/sesli mesajlarda kullanıcıya verilen güvenli desteklenmiyor yanıtı;
- klinik çalışma saati, adres, telefon ve mesai dışı davranış kaydı;
- randevu iptal/değiştirme/hatırlatma ve birden fazla saat seçimi;
- hukuk/KVKK ve klinik veterineri üretim onayı.

## 3. Ürün kararları

### 3.1 Personel/hekim arayüzü

Tam kapsamlı bir hekim veya klinik yönetim paneli pilot için gerekli değildir.
Ancak otomasyon insan devri ve acil iş üretiyorsa minimal bir personel operasyon
ekranı gereklidir. Mevcut `/staff` ekranı yeniden yazılmayacak; pilot için şu
dar geliştirmelerle kullanılacaktır:

- otomatik yenileme ve görünür/sesli yeni iş uyarısı;
- `open -> seen -> in_progress -> resolved` iş durumu;
- işi alan ve çözen personel ile zaman kaydı;
- acil işlerin her zaman önce gösterilmesi;
- mesai dışı durumun bot yanıtında ve operasyon prosedüründe açık olması.

Pilot sırasında tek bir isimlendirilmiş sorumlu ekranı çalışma saatlerinde açık
tutabilir. Genel satış öncesinde ekran kapalıyken de çalışan, PII içermeyen bir
e-posta/push/CRM bildirimi gerekir. Bildirim yalnız "yeni acil iş var" ve güvenli
bir panel bağlantısı taşır; sahip, telefon, hayvan adı veya mesaj içeriği taşımaz.

Sadece e-posta/Slack bildirimi ekranın yerine geçmez; iş detayı, RLS erişimi ve
çözme kaydı yine `/staff` içinde kalır. Supabase Studio personele verilmeyecek,
pilot öncesi büyük bir yönetim paneli veya UI framework'ü eklenmeyecektir.

### 3.2 Model seçimi

Başlangıç birincil modeli `gpt-5.6-luna`, `reasoning: none`, Structured Outputs
ve `store: false` olarak kalır. Gerekçe: görev serbest tıbbi muhakeme değil,
kapalı JSON şemasına yapılandırılmış çıkarımdır; güvenlik kararı modele ait
değildir. OpenAI'nin güncel konumlandırmasına göre Luna maliyet duyarlı yüksek
hacimli işler, Terra ise zeka/maliyet dengesi içindir.

Bu seçim koşulludur. Luna ve `gpt-5.6-terra` aynı veteriner-onaylı Türkçe eval
korpusunda ölçülmeden üretim modeli onaylanmaz. Luna bütün zorunlu eşikleri
karşılarsa daha pahalı model seçilmez; karşılamazsa bütün trafik Terra'ya alınır.
Modelin kendi güven beyanına göre dinamik yönlendirme veya geçerli görünen bir
çıktıyı ikinci modele kontrol ettirme ilk pilotta kullanılmaz.

Güncel resmi kaynaklar:

- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://platform.openai.com/docs/models/default-usage-policies-by-endpoint

`store: false`, varsayılan kötüye kullanım izleme saklamasını tek başına sıfıra
indirmez. Varsayılan saklama ve olası Zero Data Retention başvurusu KVKK karar
paketinin açık maddesidir.

### 3.3 Medya

Pilot öncesi hedef görüntü veya ses üzerinden klinik yorum üretmek değildir.
Metin dışı bir mesaj sessizce kaybolmayacak; kullanıcıya bu içeriğin bot
tarafından değerlendirilemediği, metinle açıklama yapması veya kliniği araması
gerektiği dürüstçe söylenecektir. Görüntü/ses analizi ancak ayrı veteriner ve
KVKK değerlendirmesinden sonra pilot-sonrası adaydır.

### 3.4 Klinik bilgisi

Saat, telefon, adres ve temel hizmet bilgisi için ilk çözüm RAG/embedding
değildir. Tenant'a bağlı doğrulanmış yapılandırılmış klinik alanları kullanılır.
Geniş klinik bilgi tabanı ve doküman araması gerçek kullanım ihtiyacı ölçülürse
pilot sonrasına alınır.

## 4. Aşamalı teslim planı

### Aşama 0 - doğrulanmış temeli kapat

Durum: tamamlandı.

- Task 027 deterministik yerel demo doğrulandı ve commit edildi.
- Bu demo regresyon ve ürün davranışı açıklama aracı olarak korunur.

### Aşama 1 - gerçek AI staging ve model değerlendirmesi

Amaç: WhatsApp, Supabase ve Queue olmadan sentetik serbest Türkçe mesajı gerçek
OpenAI API'ye gönderip aynı extraction/planner/reply zincirini gözlemlemek.

Teslimler:

- ayrı, local-only gerçek AI demo entry/config'i;
- gerçek anahtarın yalnız yerel secret olarak kullanılması;
- açık "mesaj OpenAI'ye gönderilir, gerçek veri girmeyin" uyarısı;
- istek sayısı ve mesaj uzunluğu tavanı;
- OpenAI timeout ve genel hata yanıtı;
- Luna/Terra karşılaştırmalı, sentetik JSON eval çalıştırıcısı;
- şema başarısı, semantik eşleşme, güvenlik sinyali recall, latency ve token
  maliyeti raporu;
- model/prompt/eval sürüm kaydı.

Çıkış kapısı:

- şema geçerliliği >= %99,5;
- açık kırmızı sinyal recall = %100;
- belirtilmeyen güvenlik bilgisini `false` saymama >= %99,5;
- tanı/ilaç/tedavi üretimi = 0;
- insan ve tıbbi tavsiye isteği recall >= %99;
- P95 hedefi <= 5 saniye;
- sağlayıcı/bozuk çıktı <= %0,5.

İlk teknik korpus sentetik olur. Gerçek veya gerçekçi klinik mesajların
etiketlenmesi ancak KVKK kararı ve veteriner gözetimiyle yapılır.

### Aşama 2 - konuşma bütünlüğü ve güvenli fallback

Teslimler:

- önceki bot sorusunu veya küçük güvenilir state özetini taşıyan çok turlu
  çıkarım; tüm konuşma geçmişini modele körlemesine göndermeme;
- "ilkine evet, diğerlerine hayır" gibi kısa cevap eval'leri;
- art arda anlaşılamayan mesaj sayacı ve bounded insan devri;
- yeni hayvan için açık kullanıcı onaylı kayıt ya da güvenli personel devri;
- metin dışı mesajlarda sessiz ignore yerine sabit desteklenmiyor yanıtı;
- ilk temas bot kimliği ve tıbbi sınır açıklaması;
- OpenAI çağrı oranı, aylık harcama ve timeout korumaları.

Çıkış kapısı: bütün fallback yolları sonlu, dürüst ve kullanıcıyı acil bakım
beklemeye yönlendirmeyen davranış üretir.

### Aşama 3 - klinik ve personel operasyonu

Teslimler:

- tenant-scoped klinik telefon/adres/saat yapılandırması;
- Europe/Istanbul mesai içi/dışı deterministik davranış;
- minimal `/staff` durum/sahiplenme/audit iyileştirmesi;
- pilot için otomatik yenileme ve tarayıcı uyarısı;
- genel satış öncesi PII'siz dış bildirim;
- personel ve veteriner sorumluluk prosedürü.

Çıkış kapısı: her insan devri ve teslim hatasının isimlendirilmiş bir operasyon
sahibi, görünür durumu ve ölçülen tepki süresi vardır.

### Aşama 4 - gerçek entegrasyon staging'i

Üretimden ayrı sentetik ortamda:

- migration-history üzerinden staging Supabase kurulumu ve katalog/RLS kontrolü;
- gerçek Cloudflare Worker, üç Queue, iki consumer, DLQ ve Cron;
- gerçek OpenAI çağrısı ve harcama limiti;
- Meta test işletme numarasıyla gerçek imzalı webhook;
- outbound gönderim ve teslim/read callback'i;
- randevu teklif -> `EVET` ve teklif -> `HAYIR` akışı;
- gerçek Supabase Auth personel hesabı ve iki tenant erişim deneyi;
- OpenAI timeout, Supabase 5xx, Meta 429/5xx ve DLQ hata enjeksiyonu;
- appointment için gerçek iki-oturum lock/concurrency testi;
- beklenen ani yükün 10 katı kısa yük testi.

Çıkış kapısı: `docs/production-readiness.md` kontrollü smoke journey'si sentetik
veriyle eksiksiz geçer; başarısız iş kaybolmaz ve hiçbir hata gerçek kullanıcıya
yanlış başarı iddiası üretmez.

### Aşama 5 - insan onayları ve kontrollü pilot

Teknik geliştirmeyle paralel tamamlanır:

- klinik veterinerinin safety copy/decision tablosu onayı;
- KVKK aydınlatma, hukuki sebep, rol/yetki, saklama, silme/ihracat ve veri
  işleyen sözleşmeleri;
- OpenAI/Meta/Cloudflare/Supabase veri akışı kararı;
- backup/rollback ve incident sahipleri;
- bir klinik, bir numara, sentetik smoke ve sonra sınırlı gerçek pilot;
- iki-dört haftalık ölçüm ve go/no-go toplantısı.

Pilot metrikleri:

- kırmızı sinyal ve insan talebi kaçırma sayısı;
- model parse/retry/DLQ oranı;
- personel ilk görme ve çözme süresi;
- botta tamamlanan intake oranı;
- randevu teklif/teyit/ret oranı;
- kullanıcı başına mesaj ve model maliyeti;
- yanlış veya yanıltıcı yanıt bildirimi;
- kullanıcıdan gelen "insan istiyorum" oranı.

### Aşama 6 - pilot sonrası ürün

Yalnız pilot verisi ihtiyaç gösterirse:

- randevu iptal ve yeniden planlama;
- birden fazla saat ve WhatsApp interactive list/button;
- pencere dışı utility-template hatırlatma;
- veteriner/oda/hizmet ve harici takvim;
- klinik bilgi tabanı;
- analitik ve raporlama;
- çok şube ve kurumsal rol yönetimi;
- mevcut helpdesk/CRM entegrasyonları;
- veteriner-onaylı görüntü/ses intake yardımcıları.

## 5. Gerçek API test sırası

1. OpenAI: yalnız sentetik mesaj, düşük proje bütçesi, Luna/Terra eval.
2. Supabase staging: migration apply, RLS, grants, rollback dışı read-only katalog.
3. Cloudflare staging: Worker, Queue/DLQ/Cron ve `/ready`.
4. Meta test numarası: webhook challenge, imza, inbound, outbound, status.
5. Staff: gerçek Auth, aynı klinik erişimi ve çapraz klinik reddi.
6. Appointment: iki oturum yarış testi ve gerçek EVET/HAYIR journey.
7. Failure injection: provider timeout/429/5xx, Queue retry ve terminal DLQ.
8. Canary: tüm zincir sentetik veriyle; sonra insan onaylarıyla kontrollü pilot.

Gerçek hasta/sahip verisi Aşama 5 kapıları kapanmadan hiçbir eval, staging veya
log sistemine girmez.

## 6. Ortalama teknik maliyet tabanı

Araştırma tarihi 2026-08-13. Fiyatlar değişebilir; satın alma öncesi resmi
sayfalar yeniden kontrol edilir.

Varsayım:

- görüşme başına 6 inbound/model çağrısı;
- çağrı başına yaklaşık 1.800 input + 250 output token;
- Luna $0,20 input / $1,20 output, milyon token başına;
- planlama kuru 1 USD = 48 TL;
- KDV, banka kur farkı, destek, hukuk/veteriner hizmeti dahil değil.

Sabit taban:

- Supabase Pro: $25/ay;
- Cloudflare Workers Paid: $5/ay;
- mevcut ölçeklerde Workers ve Queue aşım: $0;
- kullanıcı başlatmalı 24 saatlik servis penceresindeki mevcut WhatsApp
  cevapları: $0; gelecekteki template/reminder mesajları maliyetine yansıtılır.

| Aylık kullanım | AI çağrısı | Luna | Toplam teknik | 48 TL/USD |
|---|---:|---:|---:|---:|
| 300 görüşme | 1.800 | $1,19 | $31,19 | yaklaşık 1.500 TL |
| 1.000 görüşme | 6.000 | $3,96 | $33,96 | yaklaşık 1.630 TL |
| 3.000 görüşme | 18.000 | $11,88 | $41,88 | yaklaşık 2.010 TL |

Kur/vergi/beklenmeyen kullanım için %20 teknik tamponla planlama değerleri
yaklaşık 1.800 TL, 1.950 TL ve 2.400 TL/aydır. Bu çok kiracılı platformun
toplamıdır; klinik sayısı arttıkça $30 sabit taban kliniklere bölünür. Destek,
satış, onboarding, hukuk, veteriner değerlendirmesi ve dış bildirim sağlayıcısı
ayrıca fiyatlanır.

Resmi fiyat kaynakları:

- https://supabase.com/pricing
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/queues/platform/pricing/
- https://whatsappbusiness.com/products/platform-pricing/

## 7. Tarife fiyat hipotezi

Müşteriye token satılmaz. Şeffaf paket birimi aylık görüşme, WhatsApp numarası,
şube, personel hesabı ve özellik/destek seviyesidir. Kullanılabilir olmayan
özellik paket adı altında satılmaz.

| Paket | Aylık, KDV hariç | Dahil kullanım | Satış koşulu |
|---|---:|---|---|
| Kurucu pilot | 990 TL | 300 görüşme, 1 numara, 3 personel | en fazla 2 ay, sübvansiyonlu, SLA yok |
| Başlangıç | 2.490 TL | 500 görüşme, 1 numara, 5 personel | Aşama 5 pilotu geçince |
| Klinik+ | 4.490 TL | 1.500 görüşme, 1 numara, 15 personel | dış bildirim ve gelişmiş randevu hazırsa |
| Çok şube | 7.990 TL'den başlayan | 4.000 görüşme, 3 şubeye kadar | çok şube gerçekten tamamlanınca |

İlk ticari varsayımlar:

- ek 500 görüşme: 750 TL;
- Meta template/hatırlatma bedeli: maliyetine pass-through;
- kurulum: Başlangıç 3.500 TL, Klinik+ 5.000 TL, çok şube teklif;
- yıllık peşin ödeme: 10 aylık bedelle 12 ay;
- yıllık sözleşme süresince fiyat sabit, yenilemede yeni TL tarife;
- ilk 5-10 klinikten sonra gerçek destek süresi, dönüşüm ve willingness-to-pay
  verisiyle fiyatlar yeniden değerlendirilir.

990 TL kalıcı Starter fiyatı değildir. Tek klinikte teknik tabanın altında
kalabilir; yalnız sınırlı kurucu pilot ve öğrenme yatırımı olarak kullanılır.

## 8. Görev haritası ve sabit kapsam

Kontrollü pilot öncesi planlanan teknik görevler:

1. Task 028 - gerçek OpenAI local staging ve Luna/Terra eval temeli.
2. Task 029 - çok turlu bağlam, timeout/rate/spend/fallback sertleştirmesi.
3. Task 030 - yeni hayvan ve desteklenmeyen medya güvenli davranışı.
4. Task 031 - klinik profil/saat/mesai dışı kararları.
5. Task 032 - minimal staff durum/sahiplenme/bildirim operasyonu.
6. Task 033 - hesap/kişi bazlı `AI açık | sadece insan | kişisel` yönlendirmesi
   ve yarışa dayanıklı manuel devralma.
7. Task 034 - gerçek staging kaynakları, aynı numarada WhatsApp Business
   uygulaması/Cloud API birlikte kullanım uygunluğu ve uçtan uca kanıt.
8. Task 035 - canary, failure injection, observability ve kontrollü pilot kapısı.

Task 033 için ürün kararı: sistem arkadaş/müşteri ayrımını mesaj metninden veya
AI tahmininden yapmaz. Task 034 strict allowlist ile karışık kullanılan bir
WhatsApp hesabı varsayılan olarak kişisel kalır; operatör yalnız seçtiği kişi
için AI'yı açabilir, belirli bir müşteriyi yalnız insana bırakabilir ve açık
kişisel rota tanımlayabilir.
Meta webhook'u teknik olarak imzalı ham mesajı Worker'a ulaştırır; kişisel modda
VetAI yalnız yönlendirme zarfını değerlendirip içeriği okumadan, hashlemeden,
loglamadan, Supabase/OpenAI'a göndermeden bırakır. Kişisel mesaj baytlarının
VetAI altyapısına hiç ulaşmaması isteniyorsa güvenilir sınır ayrı numaradır.
Bu kontrol kendi başına insan mesajı göndermez. Aynı numaradan WhatsApp Business
uygulamasıyla yanıt verme olanağı Task 034 gerçek staging'inde doğrulanamazsa,
personel ekranından manuel Cloud API mesajı gönderme kontrollü pilot öncesi yeni
bir bloklayıcı görev olur.

Task 033 tamamlandı ve doğrulandı: migrasyon, RPC'ler, envelope-first
yönlendirme, `/staff` "WhatsApp otomasyonu" bölümü ve kapsamdaki tüm testler
disposable `vetai-test` üzerinde sıfır kalıntıyla geçti; 1.336 test geçti,
2 ücretli eval atlandı; typecheck, frozen install, Worker dry-run, Codex
incelemesi ve Opus'un mimari/RLS/KVKK incelemesi tamamlandı (bkz.
[`docs/selective-automation.md`](selective-automation.md)). Hiçbir production
migration, deploy veya gerçek Meta/OpenAI çağrısı yapılmadı.

Task 034 kısmi canlı staging aşamasında: ayrık ücretsiz Supabase staging,
üç Cloudflare Queue, staging Worker/Cron/binding'ler, yedi şifreli secret,
migration history, `/health`, `/ready`, Meta callback challenge ve
`messages` aboneliği kuruldu. Meta'nın ücretsiz test şablonu doğrulanmış bir
alıcıya ulaştı; bu VetAI outbox kanıtı değildir. Uygulama yayımlanmadığı için
gerçek inbound/status callback'i Worker'a gelmiyor; kullanıcıda WhatsApp
Business App hesabı/pilot numarası olmadığı için Coexistence `UNAVAILABLE`.
Tam zincir, seçmeli otomasyon, güvenlik/personel ve randevu smoke'ları
`NOT RUN`; Görev 034 `IN_REVIEW` kalıyor (bkz.
[`docs/staging-runbook.md`](staging-runbook.md)).

Task 034'ün kullanıcı onaylı son pilot sertleştirmesi strict AI allowlist'tir:
hesap düzeyi varsayılan `personal`, yalnız `/staff` ekranında açıkça `AI açık`
yapılan exact numaralar otomasyona girer. Migration, 033/034 rollback testleri,
Codex incelemesi ve Opus gizlilik/RLS incelemesi disposable `vetai-test`
üzerinde sıfır kalıntıyla geçti; ardından migration yönetilen CLI akışıyla
staging'e uygulandı ve altı katalog kontrolü ile 18/18 migration geçmişi geçti.
Production'a uygulanmadı.
Aktivasyon, açık AI rotası olmayan gönderilmemiş `pending | processing`
yanıtları kaldırır; Meta'ya zaten verilmiş tek bir ağ isteğini geri çağırma
garantisi vermez. Sıradaki kapı, uygun pilot numarayla gerçek uçtan uca
kanıttır.

Task 029 tamamlandı: düzeltmeli yerel inceleme ve Opus'un salt-okunur güvenlik
incelemesi geçti; kullanıcı onaylı 30 × 2 canlı karşılaştırmada Luna tüm
zorunlu güvenlik/şema/sağlayıcı/gecikme kapılarını geçti ve 51/52 beklenen alanı
eşledi, Terra 52/52 eşledi ancak yaklaşık on kat pahalıydı. Üretim modeli Luna
olarak kaldı.

Task 030 uygulandı ve Codex/Opus incelemesini bekliyor: yeni/kayıtsız hayvan
kaydı istekleri mevcut `human_handoff` niyetine yönlendirildi (prompt sürümü
`2026-08-14.1`), ve kapalı kümedeki desteklenmeyen medya türleri artık sessizce
yok sayılmak yerine mevcut dayanıklı yola sabit bir dahili işaretle girip tek
bir sabit Türkçe yanıt alıyor. İç medya alanları incelenmiyor veya
çıkarılmıyor; içerik özetlenmiyor, modele gönderilmiyor ya da saklanmıyor ve bu yol ücretli model
çağrısı yapmıyor. Hiçbir hayvan oluşturma özelliği, medya analizi, şema, RPC,
migration veya dağıtım değişikliği eklenmedi. Canlı model evali çalıştırılmadı;
klinik veterineri ve KVKK onayları hâlâ gereklidir.

Task 031 tamamlandı: klinik telefon/adres, haftalık mesai saatleri ve tam gün
kapanış tarihleri tenant-güvenli veritabanı yapılandırmasına alındı. Mevcut
`human_handoff` yanıtı yalnız doğrulanmış klinik adı/telefonuyla, PostgreSQL'in
`Europe/Istanbul` açık/kapalı kararı üzerinden kişiselleştiriliyor; hata veya
eksik yapılandırmada mevcut genel metin korunuyor. Migration ve güçlendirilmiş
rollback fixture disposable `vetai-test` üzerinde sıfır kalıntıyla geçti;
1.267 test, Worker dry-run, Codex ve Opus incelemeleri tamamlandı. Prompt,
model, çıkarım şeması ve güvenlik önceliği değişmedi; ücretli eval gerekmedi.
Klinik veterineri ve KVKK onayları yeni Türkçe metin için hâlâ zorunludur.

Task 032 tamamlandı; Codex incelemesi, disposable `vetai-test` doğrulaması ve
Opus'un salt-okunur güvenlik/KVKK incelemesi geçti:
`staff_work_items` artık dört durumlu
`open -> seen -> in_progress -> resolved` akışını ve ilk görülme/atama/çözen
kimliğini ve zaman damgasını (auth kullanıcısı silinirse yalnız kimlik `on
delete set null` ile temizlenir, zaman damgası kalır) izliyor; üç kapalı
`authenticated`-only RPC (`mark_staff_work_item_seen`,
`claim_staff_work_item`, genişletilmiş `resolve_staff_work_item`) bu geçişleri
yönetiyor. Personel sayfası artık kapalı-olmayan tüm işleri ve sahiplenme
etiketini ("Sahipsiz" / "Sizde" / "Başka personelde") gösteriyor, 30 saniyede
bir otomatik olarak yeniliyor ve yalnız açık kullanıcı izniyle, kimlik/telefon/
neden/sayı içermeyen tek bir sabit tarayıcı bildirimi verebiliyor — bu yalnız
sayfa açıkken çalışan bir pilot yardımcısıdır, personelin gördüğünü veya
yanıt vereceğini kanıtlamaz ve müşteriye böyle bir vaat eklenmedi. Prompt,
model, çıkarım şeması ve güvenlik önceliği değişmedi; ücretli eval gerekmedi.
`pnpm typecheck`, tam `pnpm test` (1.283 test geçti, 2 atlandı) ve Worker
dry-run yerelde geçti; migration disposable `vetai-test` üzerinde uygulandı
ve güçlendirilmiş rollback fixture `PASS 0/0/0/0` döndürdü. Opus'un bulduğu
tek bloklayıcı regresyon da kapandı: dedup indeksleri ve trigger yüklemleri
artık yalnız `open` yerine bütün kapanmamış durumları kapsıyor; böylece
`seen/in_progress` işler yinelenmiyor ve `provider_failed` işi daha sonra
`delivered/read` olduğunda otomatik kapanıyor. Personel kimlik/zaman damgası
verileri için Türk hukuk/KVKK incelemesi hâlâ ayrı ve zorunludur.

Task 038 mühendislik/eval kapısını geçti: kapalı Structured Outputs şeması korunarak
Türkçe yazım hatası, günlük dil, olumsuzlama, kısa bağlamsal yanıt ve toplu
güvenlik cevabı yorumlama talimatları anlam odaklı hale getirildi; üretime bir
cümle/regex tablosu eklenmedi. Güvenli intake onayından sonra sabit
`Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun. Randevu oluşturmak ister misiniz?` sorusu gönderiliyor ve
doğal olumlu yanıt mevcut tenant-güvenli randevu motoruna girebiliyor. Slotu
yalnız veritabanı seçiyor; gösterilmiş hold için kesin işlem hâlâ yalnız tam
`EVET | HAYIR` ile yapılıyor. Başarılı model çağrısı yalnız model adı ve token
sayılarını içeren içeriksiz kullanım telemetrisi üretebiliyor. Prompt
`2026-08-28.1` için Opus güvenlik/gizlilik incelemesi geçti. 77 tek turlu ve
46 çok turlu senaryo iki modelle toplam 246 sentetik çağrıda çalıştırıldı;
sıfır sağlayıcı/şema hatası ve tüm zorunlu güvenlik/randevu kapılarında %100
sonuç alındı. Toplam tahmini model maliyeti 0,6902256 USD oldu; Luna üretim
modeli olarak kaldı. Düzeltilmiş staging Worker'ında gerçek WhatsApp smoke da
proaktif davet → doğal olumlu yanıt → veritabanı saat teklifi → kesin `EVET`
ile randevu oluşturma zincirini geçti. Veteriner ve hukuk/KVKK insan onayları
hâlâ açıktır.

Task 039 `READY`: tek görev içinde iki bağımsız açık kapatılacak. Birincisi,
hayvan başına konuşmalar-arası tek yaklaşan aktif randevu ve tarih/saat tekrar
gösterildikten sonra kesin `EVET | HAYIR` ile atomik iptal; ikincisi, üç
saniyelik/en fazla dört doğrudan-AI metin mesajını tek kullanıcı turu olarak
yorumlayıp en fazla bir model çağrısı ve yanıt üretme. Aynı görev sonunda yeni
Türkçe veteriner senaryo/onay dosyası ile yeni KVKK veri-saklama dosyası
oluşturulacak. Yeniden planlama, serbest tarih tercihi, hatırlatma ve harici
takvim bu kapsamda değildir. Prompt değişeceği için yalnız seçili Luna üzerinde
tek ücretli regresyon kapısı, ardından Opus ve staging smoke gerekir.

Buna paralel iki insan kapısı vardır: klinik veterineri onayı ve Türk
hukuk/KVKK onayı. Yeni bulgular ancak pilot güvenliği veya doğruluğu için
zorunluysa bu yedi göreve eklenir; nice-to-have talepler Aşama 6 backlog'una
gider. Böylece görev sayısı sürekli genişlemez.

## 9. Değişiklik yönetimi

- Her aktif görev yalnız `CURRENT_TASK.md` sözleşmesini uygular.
- Kritik RLS, tenant, safety veya KVKK değişikliği Opus salt-okunur kapısından
  geçer; sıradan UI/test/doküman görevinde üçlü review tekrarlanmaz.
- Model/prompt değişimi aynı eval sürümünde yeniden ölçülmeden üretime çıkmaz.
- Fiyatlar teknik maliyet kadar destek/satış verisiyle de üç ayda bir gözden
  geçirilir; mevcut yıllık sözleşme yenilemeye kadar korunur.
- Yol haritası gerçek pilot verisiyle güncellenir; uygulama sözleşmesi değildir.
