# Yerel Türkçe test ekranı

Bu ekran, botun karar mantığını (hayvan tanıma, güvenlik soruları, acil/insan
devri, randevu teklif ve EVET/HAYIR kararı) gerçek WhatsApp, yapay zekâ veya
veritabanı olmadan denemenizi sağlar. Teknik bilgi gerekmez, kimlik bilgisi
girmenize gerek yoktur.

## Nasıl başlatılır (Windows)

1. Proje klasöründe bir komut satırı açın.
2. Şunu yazıp Enter'a basın:

   ```
   pnpm.cmd demo
   ```

3. Tarayıcıda şu adresi açın: `http://127.0.0.1:8790`
4. Durdurmak için komut satırında `Ctrl+C` tuşlarına basın.

Sayfayı yenilemek ekranı sıfırlar; hiçbir şey kaydedilmez.

## Bu ekran neyi test etmez

- Gerçek OpenAI ile yapılan bilgi çıkarımını,
- Gerçek WhatsApp (Meta) web-hook teslimini,
- Gerçek Supabase veritabanı yazma/RLS/migration davranışını,
- Gerçek Queue/Dead-Letter Queue işlemesini,
- Gerçek zamanlanmış (Cron) görevleri,
- Personel giriş ekranını,
- Gerçek üretim yapılandırmasını.

Bu ekranda görülen sonuçlar, incelenmiş ve onaylanmış saf (I/O yapmayan) karar
fonksiyonlarının sabit örnek verilerle çalıştırılmasından ibarettir.
