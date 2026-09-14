# 2026-09-14 — GitHub'a ilk gönderim öncesi sızıntı denetimi

**Durum:** denetim tamamlandı, gönderim sahibin onayına bağlı
**Kapsam:** `UcanInek691/pati-hatti` (private) deposuna yapılacak **ilk** push
**Denetleyen:** koordinasyon/inceleme oturumu (salt-okunur; hiçbir git komutu
çalıştırılmadı — bu ortamda sahibin makinesinde kabuk yok)
**Temel sürüm:** `bc21507` ("fix: remove closed product links from public site")

Bu kayıt, Codex oturumunun limitle kesildiği noktadan devralındı. Codex'in
bıraktığı plan şuydu: *"`UcanInek691/pati-hatti` deposunu private oluşturacağım;
henüz kod göndermeden önce remote'u doğrulayıp kapanış kaydını commit
edeceğim."* Bu belge o planın "kod gönderilmeden önce" adımıdır.

## 1. Tespit edilen git durumu

Doğrudan `.git` içeriğinden okundu, rapordan alınmadı:

| Gözlem | Değer |
| --- | --- |
| `origin` | `https://github.com/UcanInek691/pati-hatti.git` (eklenmiş) |
| `HEAD` | `refs/heads/main` |
| Yerel commit sayısı | 157 (reflog) |
| Son commit | `bc21507` |
| `refs/remotes/**` | **yok** |
| `packed-refs` | **yok** |
| Upstream (`[branch "main"]`) | **yok** |

Yorum: depoya **henüz hiçbir şey gönderilmemiştir**. Bu, denetimin gerçekten
"gönderim öncesi" olduğunun kanıtıdır; bulgular hâlâ yerel diskte durur.

Ek gözlem: `.git/refs/codex/turn-diffs/**` altında Codex'in tur-bazlı diff
checkpoint ref'leri var. `git push origin main` yalnız `refs/heads/main`
gönderdiği için bunlar dışarı çıkmaz. **`git push --all` veya `--mirror`
kullanılmamalıdır** — o iki komut bu ref'leri de yayımlar.

## 2. Takip edilen dosya envanteri

`.git/index` ayrıştırıldı: **233 takipli giriş** (222 metin + 11 ikili).

Takip edilmeyen, dolayısıyla push'a girmeyecek olanlar teyit edildi:

- `.dev.vars.live-ai` — **gerçek secret dosyası**, `.gitignore`'da, takipsiz.
- `.wrangler/`, `.claude/`, `node_modules/`, `tmp/`, `supabase/.temp/` — takipsiz.
- `docs/043-opus-inceleme.md` — sözleşme gereği takipsiz bırakıldı.
- `graphify-out/` — ~5 MB üretilmiş çıktı (`graph.html`, `graph.json`,
  `manifest.json`, günlük klasörler). Takipsizdi; bu denetimde `.gitignore`'a
  eklendi ki ileride bir `git add -A` onu kazara süpürmesin.

`output/pdf/**` (7 PDF, ~785 KB) **takipli**. Bunlar veteriner ve KVKK onay
paketlerinin üretilmiş sürümleri; içerikleri `docs/` altındaki kaynaklarından
türetilmiştir ve gerçek hasta/klinik verisi içermez. Bilinçli olarak bırakıldı.

## 3. Yürütülen taramalar

222 takipli metin dosyasının tamamı üzerinde desen taraması yapıldı. Aranan ve
**bulunmayan** sınıflar:

| Desen | Sonuç |
| --- | --- |
| JWT (`eyJ...`) | 0 |
| Supabase `sb_secret_` / `sb_publishable_` | 0 |
| OpenAI `sk-...` | 0 |
| Resend `re_...` | 0 |
| Meta erişim token'ı (`EAA...`) | 0 |
| Gerçek Supabase proje host'u | 0 (yalnız `example.supabase.co`) |
| Better Stack / uptime heartbeat URL'i | 0 |
| 32+ hane hex token | 0 gerçek (yalnız `0123456789abcdef...` gibi test değerleri) |
| IBAN / kart numarası / TCKN | 0 |
| `Bearer <gerçek token>` | 0 (yalnız `Bearer test-service-role-key`) |

Telefon numaralarının tamamı sentetik aralıktadır (`+90555...`, `1555...`,
`16315551181` gibi belgelenmiş test numaraları). E-posta adreslerinin tamamı
`@example.invalid`, ya da Resend'in genel kum havuzu göndericisi
`onboarding@resend.dev`, ya da sahibin kendi alan adı
`alerts@mail.patihatti.com`.

`.dev.vars.example` ve `.dev.vars.live-ai.example` yalnız `[köşeli-parantez]`
yer tutucuları içerir. `wrangler.toml` içindeki `CLOUDFLARE_ACCOUNT_ID` de bir
yer tutucudur (`"[cloudflare-account-id]"`).

## 4. Bulgular

Codex'in kendi taraması "yaygın gerçek secret/JWT/private-key biçimleri
bulunmadı" sonucuna varmıştı ve bu doğrudur. Ancak o tarama **kimlik
bilgisi** sınıfını arıyordu; `AGENTS.md` bundan daha geniş bir yasak koyar:
*gerçek secret, ödeme bilgisi, **hesap kimliği**, telefon numarası veya hasta
verisi depoya yazılmaz.* Hesap kimliği sınıfında iki bulgu vardır.

### B1 — Üç gerçek Meta WABA kimliği (düzeltildi, geçmişte kalıyor)

`docs/staging-runbook.md` §14.5b, madde 2, "weosa" portföyündeki üç kopya
WhatsApp Business Account'un gerçek kimliklerini yazıyordu. Bunlar kimlik
bilgisi **değildir** — tek başına bir WABA kimliğiyle mesaj gönderilemez veya
veri okunamaz; erişim token'ı gerekir. Yine de `AGENTS.md`'nin yasakladığı
"hesap kimliği" sınıfına girerler ve metindeki açıklayıcı değerleri sıfırdır:
bulgu "üç kopya var"dır, numaralar yalnız Meta panelinde işe yarar.

Bu denetimde çalışma ağacından çıkarıldılar ve yerlerine panele yönlendiren bir
not konuldu.

**Önemli ve dürüstçe belirtilmesi gereken sınır:** bu düzeltme yalnız çalışma
ağacını ve bundan sonraki commit'leri temizler. Değerler zaten 157 commit'lik
yerel geçmişin içindedir ve `git push` erişilebilir tüm geçmişi gönderir.
Dolayısıyla push edildiğinde bu üç numara deponun geçmişinde yer alacaktır.

### B2 — Gerçek `workers.dev` staging origin'i (bilinçli bırakıldı)

`docs/staging-runbook.md` (§ iki yerde) ve `CURRENT_TASK.md` (iki yerde)
`vetai-staging.mehmetsait7072.workers.dev` adresini içerir. Bu adres hem canlı
bir staging origin'ini hem de Cloudflare hesap alt alan adını (sahibin e-posta
yerel kısmı) açığa vurur.

Bilinçli olarak **bırakıldı**: bu adres, runbook'taki ve olay raporlarındaki
kanıtların okunabilmesi için gereken operasyonel bağlamdır; monitörün o gün
hangi adrese baktığını silmek kanıtı tahrif etmek olur. Depo **private**
kaldığı sürece maruziyet, sahibin erişim verdiği kişilerle sınırlıdır ve
origin'in kendisi zaten kimlik doğrulamalıdır.

## 5. Karar ve önkoşullar

Bu denetimin sonucu: **private depoya push için engel yoktur.**

Geçmişi yeniden yazmak (`git filter-repo` ile B1'deki üç değeri temizlemek)
**önerilmez.** Gerekçe: değerler kimlik bilgisi değildir, depo private'dır ve
yeniden yazma 157 commit'in tamamının SHA'sını değiştirir. Bu projenin kanıt
disiplini commit SHA'larına atıf yapar (`8c6d38f`, `4e69e9b`, `bc21507` ve
olay raporlarındaki diğerleri); hepsini geçersiz kılmak, korumaya çalıştığımız
denetim izini bozar. Üç hesap kimliğinin private bir geçmişte durması, tüm
kanıt zincirinin referanslarını kırmaktan daha az zararlıdır.

Bunun bedeli şu önkoşuldur ve **bağlayıcıdır**:

> Depo `public` yapılmadan önce geçmiş yeniden yazılmalı (B1'deki üç WABA
> kimliği ve B2'deki `workers.dev` adresi geçmişten temizlenmeli) ya da depo
> yeni ve temiz bir geçmişle yeniden yayımlanmalıdır. `public`'e geçiş, bu
> temizlik yapılmadan gerçekleştirilmemelidir.

## 6. Push sırasında uyulacak kurallar

1. Depo **private** olmalı; `git ls-remote` ile hem varlığı hem erişimi
   doğrulanmadan push edilmemeli.
2. Yalnız `git push -u origin main`. **`--all` ve `--mirror` yasak** (§1).
3. `git add -A` yerine dosyalar açıkça eklenmeli; en azından
   `git status --porcelain` çıktısı push öncesi okunmalı ve
   `docs/043-opus-inceleme.md` ile `graphify-out/` listede görünmemeli.
4. Push sonrası GitHub'da depo görünürlüğü gözle teyit edilmeli.

## 7. Bu denetimin kapatmadığı şeyler

- Deponun GitHub tarafında gerçekten var olduğu ve `private` olduğu **bu
  oturumda doğrulanamadı**; uzak depoya erişim yoktur. Sahibin
  `git ls-remote` ile teyit etmesi gerekir.
- İkili dosyalar (7 PDF, 4 görsel) desen taramasına girmedi; PDF'ler
  `docs/` altındaki takipli kaynaklarından üretilmiştir ve o kaynaklar
  taranmıştır, fakat PDF metni bağımsız olarak çıkarılıp taranmamıştır.
- Git geçmişindeki **silinmiş** dosyalar taranmadı. Tarama, `bc21507`
  ağacındaki takipli dosyalar üzerinde yapıldı; geçmişte bir noktada var olup
  sonra kaldırılmış bir dosya bu kapsamda değildir.
- Lisans dosyası yoktur. Private depoda sorun değildir; `public`'e geçişte
  `.codex/skills/graphify/**` (üçüncü taraf bir skill'in depoya kopyalanmış
  hâli, 11 dosya) için yeniden dağıtım hakkı ayrıca değerlendirilmelidir.
