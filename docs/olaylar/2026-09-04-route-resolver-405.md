# Olay kaydı — Gelen mesaj yolu dört gün boyunca sessizce çalışmadı (405 → 503)

Hazırlayan: koordinatör Opus, 2026-09-04.
Ortam: yalnız `vetai-staging`. **Production etkilenmedi** (production hâlâ kurulmadı).
Durum: **kök neden bulundu, staging'de elle düzeltildi, kalıcı repository
düzeltmesi (Task 049 migration + fixture) disposable `vetai-test` üzerinde
kanıtlandı ve staging migration history'sine uygulandı; gerçek PostgREST ve
canlı WhatsApp smoke geçti. Production'a uygulanmadı.**

Bu bir olay kaydıdır; görev sözleşmesi değildir. Aktif sözleşme her zaman
kökteki `CURRENT_TASK.md`'dir. §11'deki iş önerileri uygulama yetkisi vermez.

---

## 1. Özet

`public.resolve_whatsapp_contact_automation` fonksiyonu `STABLE` olarak
işaretliydi. PostgREST, `STABLE` bir fonksiyona gelen POST isteğini **READ ONLY**
transaction'da çalıştırır. Task 041 bu fonksiyonun çağırdığı yardımcıya bir
**satır kilidi** (`for key share of cl`) ekledi. READ ONLY transaction'da satır
kilidi almak PostgreSQL'de yasaktır; PostgREST bu hatayı **HTTP 405**'e çevirir.
Worker 405'i `route_failed` sayıp Meta'ya **503** döndü, Meta retry etti, mesaj
hiç kaydedilmedi.

Kod, SQL mantığı, secret'lar, Meta yapılandırması ve deploy'lar **doğruydu**.
Yanlış olan tek şey bir fonksiyonun volatility etiketiydi.

Düzeltme tek satır:

```sql
alter function public.resolve_whatsapp_contact_automation(text, text) volatile;
```

## 2. Etki

- 2026-08-31 03:13 (son başarılı gelen mesaj) ile 2026-09-04 03:50 arasında
  `vetai-staging`'e gelen **hiçbir WhatsApp mesajı işlenmedi**: veritabanına
  yazılmadı, kuyruğa girmedi, AI turu üretilmedi, cevap gönderilmedi.
- Eylül ayı kullanım defterinde klinik başına **0 AI turu** kayıtlı.
- Meta her mesaj için 4 kez retry etti ve dördünde de 503 aldı.
- Bu süre boyunca `/health` ve `/ready` **200** döndü ve Cloudflare hata oranı
  **%0** gösterdi. Arıza hiçbir gösterge tarafından raporlanmadı.
- Üretimdeki karşılığı: bir kliniğin acil mesajı sessizce kaybolur, sistem
  sağlıklı görünmeye devam eder. Sabit güvenlik kararlarının dayandığı
  "acil durum insana devredilir" garantisi bu arıza altında geçersizdir.

## 3. Zaman çizelgesi

| Tarih | Olay |
| --- | --- |
| 2026-08-14 | `20260814000300_selective_automation.sql:121-128` fonksiyonu `stable` olarak oluşturur. O tarihte gövde satır kilidi almadığı için zararsız. |
| 2026-08-31 | Task 041 (`20260831000100_clinic_lifecycle.sql`) staging'e uygulanır. `:82` yardımcıyı düşürür, `:84-92` `volatile` olarak yeniden yaratır, **`:102` `for key share of cl` satır kilidini ekler**. Dış fonksiyonun `stable` etiketi dokunulmadan kalır. |
| 2026-08-31 03:13 | Son başarılı gelen/giden mesaj. Bu andan sonra staging'e canlı WhatsApp testi yapılmaz. |
| 2026-09-01 → 09-03 | Task 044, 045, 046, 047, 048 staging'e alınır. Hepsinin doğrulaması panel (`/admin`, `/staff`) ve SQL üzerinden yürür; **hiçbiri gelen mesaj yolundan geçmez**. Arıza görünmez kalır. |
| 2026-09-04 03:26 | Kullanıcı WhatsApp'tan mesaj atar, cevap gelmez. Teşhis başlar. |
| 2026-09-04 03:44 | Son 405 kaydı. |
| 2026-09-04 ~03:47 | `alter function ... volatile` staging'de elle çalıştırılır. |
| 2026-09-04 03:50:28 | `resolve_whatsapp_contact_automation` **200**, `ingest_whatsapp_text_message` **200**. WhatsApp'ta bot cevabı alınır. Zincir uçtan uca kapanır. |

## 4. Kök neden

PostgREST, transaction erişim modunu **HTTP metodu + fonksiyonun volatility
etiketi** ile belirler ([PostgREST — Transactions / Access Mode](https://docs.postgrest.org/en/v12/references/transactions.html)):

| HTTP | VOLATILE | STABLE | IMMUTABLE |
| --- | --- | --- | --- |
| GET, HEAD | READ ONLY | READ ONLY | READ ONLY |
| **POST** | **READ WRITE** | **READ ONLY** | **READ ONLY** |

Zincir:

1. `src/index.ts:75` → `extractInboundMessages(body, env)`
2. `src/whatsappIngest.ts:126` → `resolveWhatsAppContactAutomation(...)`
3. `src/contactAutomation.ts` → `POST /rest/v1/rpc/resolve_whatsapp_contact_automation`
4. Fonksiyon `stable` → PostgREST **READ ONLY** transaction açar
5. Gövde `vetai_private.effective_contact_automation_mode`'u çağırır; o da
   `for key share of cl` ile **satır kilidi** almaya çalışır
6. PostgreSQL READ ONLY transaction'da satır kilidini reddeder
7. PostgREST hatayı **405 Method Not Allowed**'a çevirir
8. `src/contactAutomation.ts` → `if (!response.ok) return null` → `FAILED_RESOLVE`
9. `src/whatsappIngest.ts:127` → `{ ok: false, reason: "route_failed" }`
10. `src/index.ts:77-78` → **503 Service Unavailable**
11. Meta retry eder; her denemede aynı sonuç. Mesaj asla kaydedilmez.

PostgreSQL, `STABLE` bir fonksiyonun `VOLATILE` bir fonksiyonu çağırmasına izin
verir — volatility bir **söz**, zorlanan bir kısıt değil. Bu yüzden hata ne
migration uygulanırken ne de fonksiyon SQL editöründen çağrılırken görünür;
yalnızca PostgREST'in READ ONLY transaction'ı altında ortaya çıkar.

## 5. Kanıtlar

### 5.1 Cloudflare Worker invocation log'u (2026-09-04 03:26)

```
POST https://<staging-worker>/webhooks/whatsapp
  response.status : 503
  outcome         : ok          ← exception değil, dönen yanıt
  wallTimeMs      : 347         ← timeout değil
  asOrganization  : "Meta Platforms Ireland Limited"
  user-agent      : facebookexternalua
  x-hub-signature-256 : (mevcut)
  scriptVersion   : 819b9435-…
```

Aynı istekte basılan tek uygulama log satırı: `whatsapp webhook event received`
(`src/index.ts:69`). `whatsapp webhook event persisted` (`src/index.ts:139`)
**hiç basılmadı**. Bu, çıkışın `:77-79` erken dönüşü olduğunu kesinleştirir —
`route_failed` dışında bu satırı atlayan başka yol yok.

Meta'nın gönderdiği ve imzanın geçerli olduğu bu kayıtla kanıtlanmıştır:
`received` satırı imza doğrulamasından (`:54-55`) **sonra** basılır.

### 5.2 Supabase edge log'u — belirleyici kanıt

```
03:39:34  405  POST /rest/v1/rpc/resolve_whatsapp_contact_automation
03:39:35  405  POST /rest/v1/rpc/resolve_whatsapp_contact_automation
03:39:36  405  POST /rest/v1/rpc/resolve_whatsapp_contact_automation
03:39:56  405  POST /rest/v1/rpc/resolve_whatsapp_contact_automation
03:39:54  200  POST /rest/v1/rpc/claim_outbound_message_v2      ← kontrol grubu
```

`claim_outbound_message_v2` (VOLATILE) aynı service-role anahtarıyla, aynı
projede, her dakika **200** dönüyordu. Bu yan yana duruş service-role
anahtarını, ağ erişimini ve proje sağlığını tek hamlede eledi: sorun
fonksiyona özeldi.

### 5.3 SQL doğrulamaları

Fonksiyonların varlığı — hepsi mevcut:

```
public         | ingest_whatsapp_text_message
public         | queue_staff_reply_v1
public         | resolve_whatsapp_contact_automation
vetai_private  | effective_contact_automation_mode
```

Migration geçmişi — eksiksiz ve sıralı (Task 044 kaydı dahil, Task 048 uygulanmış):

```
20260903000100, 20260902000100, 20260901000200, 20260901000100,
20260831000300, 20260831000200, 20260831000100, 20260830000100, …
```

Fonksiyonun SQL editöründen çağrılması — **doğru çalışıyor**:

```
clinic                       | stored_mode | resolved
VetAI Staging Test Kliniği   | manual      | manual
VetAI Staging Test Kliniği   | ai          | ai
```

Tek satır, çiftlenme yok, doğru değerler. SQL editörü READ WRITE çalıştığı için
kilit sorunsuz alınıyor — arıza yalnız PostgREST yolunda.

### 5.4 Düzeltme sonrası

```
03:50:28  200  POST /rest/v1/rpc/resolve_whatsapp_contact_automation
03:50:28  200  POST /rest/v1/rpc/ingest_whatsapp_text_message
```

WhatsApp'ta bot cevabı alındı ve zincirin tamamı — Meta → Worker → Supabase →
Queue → OpenAI → outbox → Meta — uçtan uca doğrulandı. Kullanım defterinde iki
AI turu kaydedildi, yani OpenAI çağrıları gerçekten başarılı oldu.

Netlik için: alınan cevap intake sorusu değil, **insana devir metni**ydi. Bu
405 arızasının kalıntısı değildir; AI çalışmış ve devretmeye karar vermiştir.
Sebebi ve neden bağımsız bir sorun olduğu bu belgenin sonundaki
"Ek bulgu" bölümünde incelenmiştir.

## 6. Uygulanan düzeltme ve kayıt durumu

Staging'de elle çalıştırıldı:

```sql
alter function public.resolve_whatsapp_contact_automation(text, text) volatile;
```

> **KAPANDI — Task 049 (2026-09-04).** Bu elle çalıştırılan
> değişiklik başlangıçta **migration dosyasız** kalmıştı; Task 049
> `supabase/migrations/20260904000100_route_resolver_volatility.sql` ve
> `supabase/tests/049_route_resolver_volatility.sql` ile kalıcı repository
> düzeltmesini ve katalog kanıtını ekledi. **Repository düzeltmesi ile o
> düzeltmenin herhangi bir veritabanına migration olarak uygulanması ayrı
> şeylerdir** — implementer migration'ı hiçbir veritabanında çalıştırmadı;
> Codex daha sonra yalnız disposable `vetai-test` üzerinde migration ile
> 049/034/033 fixture'larını sıfır artıkla doğruladı. Ayrı sahip onayıyla
> migration daha sonra managed push yoluyla staging history'sine eklendi;
> exact katalog kontrolü, gerçek service-role PostgREST POST'u ve cihazdan
> doğrulanan canlı WhatsApp yanıtı geçti. Repository ve staging history artık
> 049 dahil örtüşür (bkz. `docs/staging-runbook.md` §20). Production değişmedi.

## 7. Neden dört gün görünmedi

Üç bağımsız faktör aynı anda gizledi:

1. **Cloudflare hata oranı %0 gösterdi.** 503 *dönen bir yanıttır*, atılan bir
   exception değil; `outcome: ok`. Cloudflare'in hata metriği bunu saymaz. Bu
   metriğe "sistem sağlıklı" olarak güvenmek yanıltıcıdır.
2. **`/ready` sürekli 200 döndü.** `src/readiness.ts`'in kendi docstring'i:
   *"Pure configuration-shape check: never calls Supabase, Meta, OpenAI, or the
   Queue."* Yani `/ready` tasarımı gereği bu arıza sınıfını göremez. Yalnızca
   `SUPABASE_SERVICE_ROLE_KEY`'in boş/placeholder olmadığını doğrular; geçerli
   olduğunu veya veritabanı yolunun çalıştığını değil.
3. **Hiç canlı gelen mesaj testi yapılmadı.** 31 Ağustos'tan sonraki beş görev
   (044–048) staging'de yalnız panel ve SQL üzerinden doğrulandı. Task 047'nin
   §17 smoke'u bile `/admin` üzerinden yürüdü ve mesaj yoluna hiç dokunmadı.

## 8. İncelemenin neyi kaçırdığı

Task 041'in zorunlu Opus incelemesi tam olarak bu fonksiyonu inceledi ve
madde #3'te şunu yazdı:

> "Resolver VOLATILE + FOR KEY SHARE OF cl — ✅ migration:89,100. Tüm çağrı
> yerleri plpgsql skaler atama (…) — hiçbiri index/CHECK/WHERE değil, VOLATILE
> güvenli."

İnceleme doğruydu ama **yanlış sınırı** doğruladı: iç yardımcının volatility'si
ve plpgsql çağrı yerleri kontrol edildi; **PostgREST'e açık dış fonksiyonun**
volatility'si kontrol edilmedi. Transaction erişim modunu belirleyen şey ise
tam olarak o dış fonksiyondur.

Çıkarılacak kural: bir migration bir çağrı zincirine satır kilidi veya yazma
eklediğinde, o zinciri **PostgREST üzerinden çağıran en dış fonksiyonun**
`VOLATILE` olduğu ayrıca doğrulanmalıdır.

## 9. Teşhis yolu (yanlış hipotezler dahil)

Kayda geçirilmesinin sebebi: bu yol tekrar edilebilir ve iki yanlış dönüş
gelecekte zaman kaybettirebilir.

1. **Yanlış:** Meta webhook aboneliği düşmüş. — Log'daki
   `asOrganization: Meta Platforms Ireland Limited` bunu çürüttü.
2. **Yanlış:** Task 044 migration-history sapması nedeniyle `db push` Task
   044'ü ikinci kez çalıştırdı ve `effective_contact_automation_mode` drop
   edilmiş halde kaldı. — Fonksiyon mevcuttu ve geçmiş eksiksizdi.
3. **Yanlış:** `SUPABASE_SERVICE_ROLE_KEY` geçersiz/döndürülmüş. — Aynı
   anahtarla `claim_outbound_message_v2`'nin 200 dönmesi çürüttü.
4. **Doğru:** Fonksiyon bazında durum kodu farkı (405 vs 200) sorunu fonksiyona
   özel bir niteliğe indirdi; PostgREST Access Mode tablosu ve migration
   kaynağındaki `stable` etiketi mekanizmayı kesinleştirdi.

Belirleyici araç **Supabase edge log'ları** oldu: Cloudflare tarafı yalnız
"503 döndü" diyordu, hangi çağrının neden başarısız olduğunu göstermiyordu.

## 10. Doğrulanmayanlar / kanıt sınırları

- Düzeltme öncesi canlı `pg_proc.provolatile` değeri **doğrudan gözlenmedi**;
  `alter` sorgudan önce çalıştırıldı. Ancak fonksiyonu tanımlayan **tek**
  migration (`20260814000300_selective_automation.sql:128`) onu açıkça `stable`
  ilan ediyor ve sonraki hiçbir migration bu fonksiyonu yeniden yaratmıyor —
  dolayısıyla dağıtılmış durumun `stable` olduğu kaynak üzerinden kesindir.
- PostgreSQL'in ürettiği asıl hata metni (`cannot execute … in a read-only
  transaction`) log'da görünmedi; Supabase edge log'u yalnız HTTP durum kodunu
  ve boş `x_sb_error_code` alanını verdi. Mekanizma PostgREST dokümantasyonu ve
  405 ↔ `volatile` değişiminin nedensel eşleşmesiyle kuruldu.
- Task 049 incelemesinde migration yalnız disposable `vetai-test` üzerinde
  uygulandı; `pg_proc.provolatile = 'v'` ve ilgili 049/034/033 rollback
  fixture'ları sıfır artıkla doğrulandı. Bu doğrudan SQL kanıtı PostgREST'in
  HTTP transaction-routing davranışını tek başına kanıtlamaz; o canlı kontrol
  Task 049 staging aktivasyonunda ve Task 052'nin regresyon kapısında kalır.
- 2026-08-31 ile 09-04 arasında Meta'nın retry'ları tükendikten sonra kaç
  mesajın kalıcı olarak düştüğü sayılmadı. Sentetik test trafiği dışında gerçek
  müşteri mesajı beklenmiyor (staging, whitelist'li tek test numarası).

## 11. Gereken işler

Öneri sırası; her biri kendi sözleşmesini gerektirir.

**İş 1 — Kalıcı migration (acil, staging şeması repo ile örtüşmüyor).**
İleri yönlü bir migration `resolve_whatsapp_contact_automation`'ın volatility
metadata'sını `volatile` yapmalı. Task 049 migration/fixture'ı hazırlandı;
disposable DB ve Opus kapıları ile staging aktivasyonu tamamlandı. Production
aktivasyonu ayrı bir hazır-olma ve sahip onayı kapısıdır.

*Repo geneli denetim yapıldı (2026-09-04, koordinatör Opus).* 53 fonksiyon
tanımının tamamı `supabase/migrations/` üzerinden tarandı; volatility etiketi
ve **geçişli çağrı grafiği** (bir fonksiyonun çağırdığı fonksiyonların kilit/
yazma davranışı) birlikte değerlendirildi. Sonuç:

| Denetim | Sonuç |
| --- | --- |
| `stable`/`immutable` işaretli fonksiyon | 10 / 53 |
| Bunlardan kilit veya yazmaya **geçişli olarak** ulaşan | **1** |

Tek riskli yol, bu olayın kendisi:

```
public.resolve_whatsapp_contact_automation (stable)
  └─> vetai_private.effective_contact_automation_mode  [for key share of cl]
```

Diğer dokuz fonksiyon (`get_clinic_monthly_usage_v1`,
`get_conversation_clinic_operational_context`, `get_conversation_intake_context`,
`get_platform_admin_overview_v1`, `list_available_appointment_slots`,
`list_clinic_appointment_slots_v1`, `has_true_safety_signal`,
`is_clinic_staff`, `platform_admin_authorized_caller_v1`) temiz: hiçbiri
doğrudan ya da dolaylı olarak yazma/kilit içermiyor. **Yani bilinen başka bir
zaman bombası yok** — düzeltme tek fonksiyonla sınırlı kalabilir.

Denetimin sınırı: statik metin analizi. Bir fonksiyon dinamik SQL ile yazsa
veya bir trigger üzerinden dolaylı yazma tetiklese bu tarama yakalayamaz. Bu
projede fonksiyonlarda dinamik SQL yasak olduğu için risk düşüktür, ancak
fixture'daki katalog iddiası bu taramanın yerine geçmelidir, tersi değil.

**İş 2 — `/ready` dürüstleştirme (bence en yüksek değerli).**
`/ready` şu an konfigürasyon şekli dışında hiçbir şey doğrulamıyor ve bu arızayı
dört gün boyunca gizledi. Gerçek bir uçtan uca kontrol eklenmeli: sentetik,
PII içermeyen bir rota çözümleme çağrısı (veya eşdeğeri) PostgREST üzerinden
yapılıp sonucu kontrol edilmeli. Dikkat edilmesi gerekenler: her `/ready`
çağrısında ücretli/yazan bir işlem tetiklenmemeli, gerçek müşteri verisine
dokunulmamalı, ve kontrolün kendisi yeni bir arıza kaynağı olmamalı.

> **YEREL OLARAK UYGULANDI — Task 050 (2026-09-04).** `/ready` artık
> konfigürasyon şekli kontrolünden sonra, sentetik sabit kontak
> (`+10000000000`) ve zaten doğrulanmış kayıttan alınan gerçek bir
> `phone_number_id` ile `resolveWhatsAppContactAutomation` üzerinden gerçek
> `resolve_whatsapp_contact_automation` Data API çağrısını yapar; yalnız
> `ai`/`manual`/`personal` sonuçlarını ready sayar, `unknown_account` dahil her
> non-2xx (405 dahil), timeout/abort, malformed/eksik/fazla alanlı yanıt veya
> fetch hatasını unavailable'a çevirir. Çağrı Worker isolate başına 30
> saniyelik bir cache ve tek eşzamanlı probe birleştirme ile sınırlıdır; hiçbir
> Meta/OpenAI/Queue
> çağrısı yapılmaz, mesaj gönderilmez, veritabanına yazılmaz. Workers
> invocation logları tam örneklemeyle etkinleştirilirken Meta webhook
> doğrulama URL'sindeki token/challenge'ın tutulmaması için query-string
> redaction zorunlu kılınmıştır. Bu yalnız
> repository ve yerel test kanıtı olarak başladı. **Staging aktivasyonu ayrı
> sahip onayıyla 2026-09-04'te tamamlandı** (bkz. `docs/staging-runbook.md`
> §21): `/health` ve dependency-aware `/ready` 200 döndü, invocation log
> redaksiyonu sentetik query değerleriyle doğrulandı ve İş 3'teki gerçek gelen
> mesaj/cevap smoke'u geçti. Production değişmedi.

**İş 3 — Runbook adımı.**
`docs/staging-runbook.md`'ye zorunlu bir kapanış adımı: **her staging
aktivasyonundan sonra whitelist'li test numarasından bir gerçek gelen mesaj
gönderilip cevabın alındığı doğrulanmalı.** Bu adım var olsaydı arıza 31
Ağustos'ta yakalanırdı. Panel/SQL doğrulaması gelen mesaj yolunu kapsamaz.

**İş 4 — İnceleme kuralı.**
`AGENTS.md` veya `docs/database-schema.md`'ye: bir migration bir çağrı zincirine
satır kilidi ya da yazma eklediğinde, o zinciri PostgREST üzerinden çağıran en
dış fonksiyonun `VOLATILE` olduğu ayrıca doğrulanacak (§8).

**İş 5 — `vetai-test` denetimi.**
Disposable veritabanında aynı etiketin durumu kontrol edilmeli; fixture'lar
READ WRITE çalıştığı için bu arıza orada hiçbir zaman yakalanamaz — bu, fixture
kanıtının yapısal bir kör noktası olarak kayda geçmeli.

---

Bu kayıt hukuk veya veteriner hekim onayının yerine geçmez ve hiçbir üretim
kapısını kapatmaz.

---

# Ek bulgu — devredilen konuşma kalıcı olarak AI'dan kopuyor

Aynı gece, 405 arızası düzeltildikten sonraki doğrulama testinde ortaya çıktı.
**405 olayıyla ilgisi yoktur ve ondan bağımsız bir üründeki boşluktur.**
Kaynaktan doğrulanmıştır; gözlem değil, kod okumasıdır.

## Bulgu

Bir konuşma `human_handoff`'a düştüğünde, o hayvan sahibi **kalıcı olarak** AI
hizmetinden kopar. Sahibin sonraki her mesajı sonsuza kadar sabit "bu talebi
bot üzerinden yanıtlayamam, kliniği telefonla arayın" cevabını alır. Klinik
personeli iş kaydını çözse bile durum değişmez.

## Mekanizma (üç bağımsız kural birleşiyor)

1. **Devir durumu terminaldir.**
   `20260806000200_conversation_intake_state.sql:168-169`

   ```sql
   if v_current_stage in ('human_handoff', 'completed') then
     raise exception 'advance_conversation_intake: % is terminal', v_current_stage;
   ```

2. **Devredilmiş konuşma sonsuza kadar yeniden kullanılır.**
   `20260806000300_ingest_whatsapp_conversation_locator.sql:112-116`

   ```sql
   on conflict (clinic_id, owner_id) where status in ('active', 'handoff') do update
   ```

   Kısmi tekil indeks `active` **ve `handoff`** durumlarını kapsıyor. Yeni bir
   konuşma yalnızca eskisi `completed` olduğunda açılır. `handoff` asla
   kendiliğinden `completed` olmaz.

3. **İş kaydını çözmek konuşmayı kapatmaz.**
   `20260814000200_staff_assignment_and_alerts.sql:313-370` —
   `resolve_staff_work_item` yalnız `public.staff_work_items` satırını
   güncelliyor (`status = 'resolved'`). `public.conversations`'a hiç dokunmuyor;
   ne `status` ne `intake_stage` değişiyor.

Sonuç: şemada devredilen bir sahibi geri döndüren **desteklenen hiçbir yol
yok**. Tek çıkış, `conversations` satırını elle `completed` yapmaktır — yani
RPC sınırını atlayan doğrudan bir tablo yazımı.

## Neden pilot bloklayıcısı

Devir **istisna değil, normal akıştır**: acil durum, açık insan talebi, tıbbi
tavsiye sorusu ve sınırlı netleştirme denemesinin tükenmesi hepsi buraya çıkar
(sabit güvenlik kararları 2–4). Yani her klinikte sahiplerin bir kısmı
kaçınılmaz olarak devredilir.

Gerçek bir klinikte bu oran zamanla birikir ve devredilen her sahip kalıcı
olarak "bizi arayın" moduna geçer. Bu, botun hiç olmamasından daha kötüdür:
sahip çalışan bir bot bekler, çalışmayan bir bot bulur ve bunu kliniğin
hatası sayar.

Ayrıca `docs/production-readiness.md` §6'da zaten kayıtlı olan boşlukla
birleşiyor: **iş kaydının oluşması kimsenin haberdar edilmesi anlamına
gelmiyor.** Yani sahip kopar, personel de bunu bilmez.

## Bu gecenin kanıtı

```
kind           reason         priority  status  created_at
human_handoff  human_handoff  normal    open    2026-09-04 00:59:24+00
human_handoff  human_handoff  normal    open    2026-08-29 17:09:54+00
delivery_failure send_attempts_exhausted normal open 2026-08-23 15:23:10+00
```

```
status    intake_stage    updated_at
handoff   human_handoff   2026-09-04 01:06:49+00
completed completed       2026-08-30 19:07:21+00
```

29 Ağustos'tan beri **açık** duran bir devir kaydı var. Bu gecenin kaydı
`reason = human_handoff`, priority `normal` — `emergency_handoff` **değil**.
Güvenlik kapısında yanlış pozitif yoktur; AI, tek başına hayvan ve şikâyet
bilgisi taşımayan bir mesajdan intake'i tamamlayamayıp doğru şekilde
devretmiştir. Davranış tasarıma uygundur; **eksik olan geri dönüş yoludur.**

Bu davranışın Task 039 döneminde bir kez daha karşılaşıldığı, ancak sistemik
bir boşluk olarak tanınmadığı görülüyor: canlı iptal testi "ilgisiz bir
konuşma `human_handoff`'a gittiği için" sessiz kalmış ve o an noktasal olarak
aşılmış.

## Karar gerektiren nokta (ürün kararı, mühendislik değil)

Devredilmiş bir konuşmaya yeni mesaj geldiğinde ne olmalı? Seçenekler:

1. Personel iş kaydını çözdüğünde konuşma `completed` olur; sonraki mesaj
   **yeni** konuşma başlatır ve AI normal hizmete döner.
2. `/staff`'ta açık bir **"AI'a geri ver"** eylemi bulunur; denetim kaydıyla,
   personelin bilinçli kararı olarak.
3. Mevcut davranış korunur — ama bu ancak personel composer'ı (Task 048) **ve**
   gerçek bildirim birlikte canlı olduğunda savunulabilir: insan gerçekten
   cevap yazabiliyorsa "bot yanıtlamıyor" doğru bir mesaj olur.

Hangisi seçilirse seçilsin, devir sayısı ve devirde geçen süre `/admin`'de
görünür olmalıdır; aksi halde bu birikme sessizce büyür.

Not: seçenek 1 ve 2, terminal-durum invaryantını gevşetmeyi gerektirir. Bu
invaryant bilinçli bir güvenlik kararıdır ve gevşetilmesi **Opus güvenlik
kapısından** geçmelidir; özellikle `emergency_handoff` ile devredilmiş bir
konuşmanın AI'a geri dönmesi ayrı ve daha katı bir karar olmalıdır.

## Task 051 çözümü — yalnız bu yerel takip kapandı

Yukarıdaki "Karar gerektiren nokta" bölümünde **seçenek 1** seçildi: personel
iş kaydını `resolve_staff_work_item` ile çözdüğünde konuşma artık `completed`
olur, ve bu durum `conversations_one_open_per_owner_idx`'in kapsamı
(`where status in ('active', 'handoff')`) dışında kaldığı için aynı sahipten
gelen sonraki mesaj yeni bir konuşma başlatır ve safety-first intake en
baştan çalışır (bkz. `docs/database-schema.md` "Safe terminal-handoff
recovery (Task 051)", `docs/staff-workflow.md` ve
[`docs/inbound-queue.md`](../inbound-queue.md#fresh-conversation-after-a-resolved-handoff-task-051)).
Seçenek 2'deki ayrı, denetim kayıtlı "AI'a geri ver" eylemi bu görevin
kapsamında değildir; `emergency_handoff` ile devredilmiş bir konuşma için de
ek bir kolaylaştırma yoktur — yalnız personelin bilinçli çözüm eylemi
konuşmayı kapatır, tıpkı normal `human_handoff` gibi.

Bu not yalnız bu belgedeki devir-kilitlenmesi bulgusunu (§"Bulgu" ve devamı)
kapatır. Asıl 405 kök nedeni Task 049 migration'ı ve Task 050 canlı staging
kanıtıyla kapatılmıştır. Açık kalan bağımsız olay kalemi yalnız açıklanamayan
yaklaşık 50 dakikalık gecikmenin Task 052 kapsamında incelenmesidir.

Implementasyon aşamasında (Claude Sonnet) migration veya fixture hiçbir
veritabanına karşı çalıştırılmamıştır. Codex bunları 2026-09-05'te yalnız
disposable `vetai-test` üzerinde direct-query yoluyla doğruladı; rollback
fixture 13 sıfır kalıntı sayacıyla PASS verdi ve bağımsız artık sorgusu da 0
döndü. Bu işlem migration history'ye kayıt eklemedi; staging ve production
değişmedi. Claude Opus'un zorunlu salt-okunur incelemesi 2026-09-05'te PASS
verdi. Ayrı sahip onayı olmadan hiçbir staging aktivasyonu yapılmaz (bkz.
`docs/staging-runbook.md` §22, `docs/production-readiness.md`); production
ayrıca kendi kapıları kapalı kaldığı sürece değişmez.
