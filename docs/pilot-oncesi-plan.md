# Pilot öncesi tamamlama planı

Hazırlayan: Claude (uygulayıcı), 2026-08-23. Kaynak: 2026-08-23 canlı staging
oturumunda gözlenen davranış, kod okuması ve mevcut proje belgeleri.

## Bu belge ne, ne değil

Bu bir **plan**dır: hangi işin neden ve hangi sırayla yapılacağını söyler.
Görev sözleşmesi **değildir**. `AGENTS.md` gereği her iş, yürütülmeden önce
`CURRENT_TASK.md` içinde kendi kapsamı, izin verilen dosya listesi, kabul
kriterleri ve inceleme kapılarıyla tanımlanır. Buradaki hiçbir madde tek
başına uygulama yetkisi vermez.

Sıralama tartışmaya açıktır; kusur envanteri değildir — o gözleme dayanır.

## Bugün nerede duruyoruz

**Kanıtlanan:** gerçek inbound → imzalı webhook → kalıcılık → `ai` rotası →
Queue → OpenAI → atomik finalize → outbox → gerçek outbound → Meta teslim
durumu callback'i. Taşıma katmanının tamamı uçtan uca çalışıyor.

**Kanıtlanmayan:** ürünün kendisi. Konuşma `pet_identification` aşamasında
kilitlendi; `docs/staging-runbook.md` §7 seçmeli otomasyon matrisi, §8 manuel
devralma yarışı ve §9 güvenlik/randevu smoke'u hâlâ `NOT RUN`.

Bu ayrım planın omurgasıdır: **boru hattı çalışıyor, akış çalışmıyor.**

## Kusur ve eksik envanteri

| # | Ne | Nasıl bilindi | Etki | Kapı |
|---|---|---|---|---|
| 1 | Kayıtlı hayvanı olmayan sahip sonsuz döngüde | Canlı gözlem | İlk yazan her müşteri takılır | Sözleşme + Opus/KVKK |
| 2 | Sınırsız netleştirme denemesi | Aynı gözlem | Kullanıcı hiç insana ulaşamaz | Sözleşme + migration |
| 3 | Kısa yanıt önceki soruyla birleştirilmiyor | Roadmap §2'de zaten eksik | "pampık" tek başına anlamsız kalıyor | Prompt/model sözleşmesi |
| 4 | Çalışma saati / kapalı gün ekranı yok | Kod okuması | Klinik SQL olmadan saat değiştiremez | Ürün kararı (roadmap §3.1) |
| 5 | Randevu slotu oluşturan kod yok | Kod okuması | Randevu akışı elle beslenmeli | Ürün kararı |
| 6 | Personel hesabı açma akışı yok | Devir sorusu | Yeni kişi ekrana giremez | Ürün kararı |
| 7 | `unknown_account` → `503` | Meta test düğmesi | Meta teslimatı kısabilir | **Düzeltildi, deploy bekliyor** |
| 8 | Üç kopya "weosa" WABA'sı | WhatsApp Yöneticisi | Teşhisi saatlerce yavaşlattı | Temizlik |
| 9 | İşletme-başlatmalı mesaj kapalı | Meta paneli | Hatırlatma akışı imkânsız | Ödeme yöntemi |
| 10 | Erişim token'ı sohbete yapıştırıldı | Oturum kaydı | Kimlik bilgisi ifşa | Rotasyon |
| 11 | Devir belgesi yok | Devir sorusu | Proje devredilemez | Belge |

## Sıralama

Sıralamanın mantığı: **önce ucuz ve geri alınamaz riski azaltanlar, sonra
akışı çalışır hâle getirenler, sonra kanıt, en sonda ekranlar.** Ekranlar
sona bırakıldı çünkü hangi ekranın gerektiği ancak akış çalışınca netleşir.

### Aşama 0 — Bugün, dakikalar içinde

- Token rotasyonu (#10). İfşa edilmiş kimlik bilgisi en kısa sürede
  geçersiz kılınır.
- `unknown_account` düzeltmesinin deploy'u (#7). Kod hazır ve test edilmiş;
  canlıda değil.

### Aşama 1 — Akışı çalışır hâle getirme

Bu üçü birlikte ele alınmalı, çünkü aynı turda buluşuyorlar.

- **#1 hayvan kaydı.** Sözleşme taslağı `CURRENT_TASK.md` içinde hazır.
  Kapatılması gereken sorular: kaydı kim açar (çıkarım tek başına mı, açık
  onay turu mu), yinelenen ad nasıl ayrılır, tür ne zaman yazılır, silme
  kaskadı korunur mu.
- **#2 sınırlı deneme.** Hayvan kaydı gelse bile kullanılabilir ad
  veremeyen kullanıcı bir yerde insana devredilmeli.
  `PersistedIntakeData` beklenmedik anahtarlarda fail-closed olduğu için
  sayaç `schema_version` artışı ve kendi migration'ını gerektirir.
- **#3 çok turlu kısa yanıt.** Ölçüm olmadan yapılmamalı: `pnpm eval:openai`
  (73 tek turlu vaka) ve `pnpm eval:openai-multiturn` (30 çok turlu vaka)
  ile önce mevcut skor ölçülür, bugünkü gerçek konuşma sanitize edilip
  korpusa eklenir, değişiklik sonrası yeniden ölçülür.

Aşama 1'in kabul kriteri davranışsaldır: yeni bir sahip, kayıtlı hayvanı
olmadan, tek bir turda ilerleyebilmeli; ilerleyemiyorsa sınırlı sayıda
denemeden sonra insana devredilmeli.

### Aşama 2 — Kanıt matrisi

Runbook §7 (`personal` / `manual` / `ai` / whitelist'ten çıkarma), §8 manuel
devralma yarışı, §9 güvenlik devri ve randevu `EVET`/`HAYIR`.

§9'un ön koşulları eksik: klinik haftalık çalışma saati ve gelecekteki
randevu slotu satırları şu an 0. Aşama 3 gelene kadar bunlar elle SQL ile
eklenir ve bu durum kayda geçirilir.

§7 ve §8 `/staff` ekranına giriş gerektirir; ekran bugüne kadar hiç
açılmadı.

### Aşama 3 — Operasyon ekranları

Burada bilinçli bir karar değişikliği var. Roadmap §3.1 "pilot öncesi büyük
bir yönetim paneli eklenmeyecektir" diyor ve bu karar teknik olarak
savunulabilir. Ancak gerçek bir klinikle pilot yapılacaksa **#4 ve #6
sürdürülemez**: kimse çalışma saatini değiştirmek için geliştiriciye SQL
yazdırmaz, ve yeni personel hesabı açmak için Supabase paneline girilmez.

Önerilen minimum, panel değil **dar ekranlar**:

- Klinik saatleri ve kapalı günler (#4) — mevcut `/staff` içinde bir bölüm.
- Personel daveti veya hesap açma (#6) — en azından belgelenmiş, tekrar
  edilebilir bir prosedür; tercihen ekran.
- Randevu slotu üretimi (#5) — haftalık saatlerden otomatik türetme, elle
  slot girme değil.

Bunların hepsi RLS ve tenant sınırı taşıdığı için kendi sözleşmelerini
gerektirir.

### Aşama 4 — Devir belgesi (#11)

Erişim adresleri, personel hesabı açma adımları, saat/slot girme yöntemi,
bilinen kusurlar, ilk gün kontrol listesi. Aşama 3'ten sonra yazılmalı ki
belge doğduğu anda eskimesin.

### Paralel — Dış kapılar

Mühendislikle sıralı değil, ama pilotu ayrıca bloklar: veteriner hekim kopya
onayı, Türk hukuku/KVKK onay paketi, hukukçu onaylı üretim gizlilik yüzeyi
(`/privacy` bunun yerine geçmez). #8 WABA temizliği ve #9 ödeme yöntemi de
buraya girer.

## Bilinçli olarak yapılmayacaklar

- Hayvan kaydını inceleme kapısı olmadan uygulamak.
- Prompt veya model değişikliğini ölçmeden yapmak.
- `/staff` ekranını sıfırdan yazmak veya bir UI framework'ü eklemek
  (roadmap §3.1).
- Numara bağlıyken WABA silmek.

## Açık karar

Aşama 3'ün kapsamı. Roadmap "panel yok" diyor; bu plan "panel değil ama dar
ekranlar şart" diyor. Bu bir ürün kararıdır ve sizin vermeniz gerekir:
pilot kliniği saat değişikliği için size mi arayacak, yoksa kendi mi
yapacak?
