const PRIVACY_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const PRIVACY_HTML = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pati Hattı Staging Gizlilik Bildirimi</title>
</head>
<body>
  <main>
    <h1>Pati Hattı Staging Gizlilik Bildirimi</h1>
    <p><strong>Son güncelleme:</strong> 23 Ağustos 2026</p>
    <p>Bu sayfa, yalnız sınırlı ve kontrollü bir teknik pilot için kullanılan Pati Hattı staging ortamını açıklar. Bu ortam halka açık bir veterinerlik hizmeti değildir; tanı, tedavi veya ilaç önerisi vermez ve acil durumda veteriner hekime başvurmanın yerine geçmez.</p>

    <h2>Kim işletiyor?</h2>
    <p>Staging pilotu WEOSA tarafından yürütülür. Gizlilik, erişim, düzeltme veya silme talepleri, test davetini aldığınız iletişim kanalı üzerinden test yöneticisine iletilmelidir.</p>

    <h2>Hangi veriler işlenebilir?</h2>
    <p>Meta imzalı WhatsApp webhook'unu teknik olarak Pati Hattı'na iletir. Yalnız test yöneticisinin açıkça AI listesine eklediği numaralarda telefon numarası, WhatsApp profil adı, mesaj metni, evcil hayvan ve randevu bilgileri ile sınırlı teknik olay ve teslimat kayıtları işlenebilir. Liste dışındaki numaraların mesaj içeriği incelenmez, kaydedilmez veya OpenAI'a gönderilmez.</p>

    <h2>Amaç ve otomasyon</h2>
    <p>Veriler; mesajı doğru test hesabına yönlendirmek, dijital resepsiyon akışını sınamak, güvenlik sorularını sabit kurallarla değerlendirmek, randevu akışını denemek, yanıt teslimatını takip etmek ve teknik hataları gidermek için kullanılır. Yapay zekâ yalnız yapılandırılmış bilgi çıkarımına yardımcı olur; kesin güvenlik ve işlem kararlarını sabit uygulama kuralları verir.</p>

    <h2>Hizmet sağlayıcılar ve yurt dışı aktarım</h2>
    <p>Pilot; WhatsApp/Meta, Cloudflare, Supabase ve OpenAI altyapılarını kullanır. Bu nedenle test verileri Türkiye dışındaki sistemlerde işlenebilir. OpenAI isteğinde saklama kapalıdır; ancak sağlayıcıların güvenlik ve yasal kayıt uygulamaları kendi koşullarına tabidir.</p>

    <h2>Saklama ve silme</h2>
    <p>Staging ortamında otomatik ve hukukçu tarafından onaylanmış genel bir saklama süresi henüz tanımlanmamıştır. Test verileri yalnız pilotun teknik doğrulaması için tutulur ve talep üzerine test yöneticisi tarafından incelenip silinir. Sağlayıcı yedekleri ve teknik kayıtları ilgili sağlayıcının koşullarına tabi olabilir.</p>

    <h2>Haklar ve başvuru</h2>
    <p>Verinizin işlenip işlenmediğini öğrenme, erişim, düzeltme, silme veya işlemenin sınırlandırılmasını isteme taleplerinizi test davetini aldığınız kanal üzerinden iletebilirsiniz. Kimlik doğrulaması yapılmadan üçüncü kişilere veri verilmez veya kayıt silinmez.</p>

    <h2>Önemli sınır</h2>
    <p>Bu bildirim, üretim hizmeti için hazırlanmış hukukçu onaylı KVKK aydınlatma metni, açık rıza metni veya saklama ve imha politikası değildir. Gerçek kullanıma geçmeden önce veri sorumlusu, hukuki sebepler, aktarım güvenceleri, saklama süreleri ve başvuru kanalı Türk hukuk/KVKK uzmanı tarafından kesinleştirilecektir.</p>
  </main>
</body>
</html>`;

export function handlePrivacyPage(): Response {
  return new Response(PRIVACY_HTML, { headers: PRIVACY_HEADERS });
}
