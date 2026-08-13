# Canlı yapay zekâ test ekranı (Task 028)

Bu ekran, [yerel Türkçe test ekranından](local-demo.md) farklı olarak
girdiğiniz metni **gerçekten** OpenAI Responses API'sine gönderir ve
sonucu mevcut, incelenmiş saf planlayıcılardan geçirir. Yine de gerçek
WhatsApp, Supabase, Queue veya üretim yapılandırması kullanmaz.

**Yalnızca uydurma/sentetik metin girin.** Gerçek bir kişi, klinik,
telefon numarası, hasta veya hayvan bilgisi asla girmeyin.

## Kurulum

1. OpenAI hesabınızda yalnız bu test için ayrı bir proje oluşturun, mümkün
   olan en düşük bütçe/uyarı ayarını yapın ve o projeye ait bir API anahtarı
   alın. Ekrandaki 20 çağrılık sayaç yalnızca tarayıcı içi bir kolaylıktır;
   faturalandırmayı durduran bir limit değildir. Test sırasında proje
   kullanımını OpenAI panelinden izleyin.
2. PowerShell'de örnek dosyayı kopyalayın:

   ```powershell
   Copy-Item .dev.vars.live-ai.example .dev.vars.live-ai
   ```

3. `.dev.vars.live-ai` dosyasını bir metin düzenleyicide açın ve köşeli
   parantezli yer tutucuyu yalnızca ayrı test projesinin anahtarıyla değiştirin.

   `.dev.vars.live-ai` git tarafından yok sayılır (`.gitignore`). Anahtarı
   hiçbir zaman bir komuta, URL'ye, tarayıcı formuna, kaynak koduna veya
   commit'lenen bir yapılandırma dosyasına yapıştırmayın.

## Nasıl başlatılır (Windows)

1. Proje klasöründe bir komut satırı açın.
2. Şunu yazıp Enter'a basın:

   ```
   pnpm.cmd live-demo
   ```

3. Tarayıcıda şu adresi açın: `http://127.0.0.1:8791`
4. Durdurmak için komut satırında `Ctrl+C` tuşlarına basın.

`OPENAI_API_KEY` tanımlı değilse veya geçersizse, ekran her mesajda
kapalı (fail-closed) bir sonuç döner; sızıntı yaşanmaz, sadece "OpenAI
çağrısı başarısız oldu veya API anahtarı yapılandırılmamış" yazar.

## Bu ekran neyi gösterir

- Modelin döndürdüğü gerçek, doğrulanmış çıkarım (intent, şikayet,
  belirtiler, güvenlik sinyalleri),
- Mevcut planlayıcıların sonucu (sonraki aşama, hayvan eşleşmesi,
  güvenlik kararı, randevu işlemi, planlanan yanıt metni),
- Seçilen model (Luna/Terra), geçen süre ve varsa token kullanımı.

Model bu ekranda **yalnızca o anki mesajı** görür; önceki turdaki kısa
yanıtları (ör. "evet", "3 gün önce") bağlamla yorumlamaz. Bu bilinen bir
sınırlamadır ve ayrı bir görevin kapsamındadır.

## Bu ekran neyi yapmaz

- Gerçek WhatsApp mesajı göndermez,
- Personeli bilgilendirmez,
- Hiçbir veritabanını değiştirmez,
- Gerçek bir randevu oluşturmaz,
- Üretim modelini (`gpt-5.6-luna` varsayılanını) değiştirmez — bu ekranda
  görülen sonuçlar üretime otomatik olarak yansımaz.

Sayfayı yenilemek veya "Oturumu sıfırla" düğmesine basmak, yerel oturumu
(tarayıcı belleğindeki durumu) tamamen temizler; hiçbir şey sunucu
tarafında kaydedilmez.

## Model karşılaştırma (canlı eval) — opt-in

`evals/intake-live-cases.json` içinde ≥60 sentetik Türkçe senaryo
bulunur. Bunlar mühendislik beklentileridir, bir veteriner tarafından
onaylanmamıştır.

Normal `pnpm test` bu senaryolar için hiçbir gerçek OpenAI çağrısı
yapmaz. Gerçek bir karşılaştırma çalıştırmak için `.dev.vars.live-ai`
dosyasına ayrıca `LIVE_OPENAI_EVAL=1` satırını ekleyin. Ardından yalnızca
şu komutu çalıştırın:

```text
pnpm eval:openai
```

Komut anahtarı bu izlenmeyen yerel dosyadan yükler; anahtar komut satırına
yazılmaz. Fiyat hesabı 13 Ağustos 2026 tarihinde doğrulanan resmi metin-token
fiyatlarını kullanır: Luna için milyon token başına 0,20 USD giriş / 1,20 USD
çıkış; Terra için 2,00 USD giriş / 12,00 USD çıkış. Canlı testi yeniden
çalıştırmadan önce [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
ve [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) resmi
sayfalarındaki güncel fiyatları yeniden kontrol edin.

Çalışma, Luna ve Terra'yı sıralı (eşzamanlılık 1) olarak dener, tek
çalıştırmada varsayılan olarak 66 × 2 = 132 sağlayıcı çağrısı yapar. Tekrar
sayısı özellikle artırılsa bile en fazla 2000 çağrıya izin verir ve yalnızca
toplu metrikler ile başarısız senaryo ID'lerini yazdırır — hiçbir zaman
anahtar, mesaj metni, ham sağlayıcı yanıtı veya model çıktısı
yazdırmaz. Alan eşleşmesi, tek bir ifade farkında tüm vakayı kaybetmek yerine
beklenen yaprak alanları ayrı ayrı sayar; kırmızı sinyal `true` yakalama ve
belirtilmeyen sinyali yanlışlıkla `false` saymama oranları ayrıca raporlanır.
Bir canlı çalıştırma yalnızca kanıttır; üretim modeli
sonuçtan bağımsız olarak Luna kalır.
