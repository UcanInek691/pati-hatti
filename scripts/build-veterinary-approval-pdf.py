"""Build the printable Pati Hattı veterinary review and approval package."""

from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "pati-hatti-veteriner-onay-paketi-2026-09-14.pdf"

INK = colors.HexColor("#2E241E")
BROWN = colors.HexColor("#7B4F34")
LIGHT_BROWN = colors.HexColor("#E7D2BE")
CREAM = colors.HexColor("#FBF7EF")
SAGE = colors.HexColor("#DCE7DA")
TEAL = colors.HexColor("#2D6A66")
MUTED = colors.HexColor("#6A625B")
RED = colors.HexColor("#A63D40")
WHITE = colors.white


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("Pati", r"C:\Windows\Fonts\segoeui.ttf"))
    pdfmetrics.registerFont(TTFont("PatiBold", r"C:\Windows\Fonts\segoeuib.ttf"))


register_fonts()

styles = getSampleStyleSheet()
BODY = ParagraphStyle(
    "Body",
    parent=styles["BodyText"],
    fontName="Pati",
    fontSize=9.2,
    leading=13.2,
    textColor=INK,
    spaceAfter=5,
)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=7.7, leading=10.4, textColor=MUTED)
TITLE = ParagraphStyle(
    "Title",
    parent=styles["Title"],
    fontName="PatiBold",
    fontSize=28,
    leading=32,
    textColor=INK,
    alignment=TA_LEFT,
    spaceAfter=10,
)
SUBTITLE = ParagraphStyle(
    "Subtitle", parent=BODY, fontName="PatiBold", fontSize=14, leading=18, textColor=TEAL, spaceAfter=9
)
H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"], fontName="PatiBold", fontSize=18, leading=22, textColor=BROWN, spaceAfter=8
)
H2 = ParagraphStyle(
    "H2", parent=styles["Heading2"], fontName="PatiBold", fontSize=13, leading=16, textColor=TEAL, spaceBefore=6, spaceAfter=5
)
H3 = ParagraphStyle(
    "H3", parent=styles["Heading3"], fontName="PatiBold", fontSize=10.5, leading=13, textColor=INK, spaceBefore=4, spaceAfter=3
)
QUOTE = ParagraphStyle(
    "Quote",
    parent=BODY,
    fontSize=8.8,
    leading=12.3,
    leftIndent=7 * mm,
    rightIndent=3 * mm,
    borderColor=LIGHT_BROWN,
    borderWidth=0.8,
    borderPadding=6,
    backColor=CREAM,
    spaceAfter=6,
)
STATUS = ParagraphStyle(
    "Status",
    parent=BODY,
    fontName="PatiBold",
    fontSize=12,
    leading=15,
    textColor=WHITE,
    alignment=TA_CENTER,
)
CENTER = ParagraphStyle("Center", parent=BODY, alignment=TA_CENTER)


def p(text: str, style: ParagraphStyle = BODY) -> Paragraph:
    return Paragraph(text, style)


def checkbox_line(label: str = "Karar") -> Paragraph:
    return p(f"<b>{label}:</b> [ ] Uygun &nbsp;&nbsp; [ ] Değişiklik gerekli &nbsp;&nbsp; [ ] Kullanılmamalı", SMALL)


def note_lines(count: int = 2) -> list[Paragraph]:
    return [p("Not: " + "_" * 88, SMALL)] + [p("_" * 100, SMALL) for _ in range(count - 1)]


FIXED_COPY = [
    ("V-01", "Acil durum yönlendirmesi", "Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.", "Terminal yanıttır; randevu veya bekleme önermez."),
    ("V-02", "İnsan desteği / botun yanıtlayamayacağı talep", "Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.", "Genel güvenli geri dönüş metnidir."),
    ("V-03", "Yapılandırılmış açık klinik yönlendirmesi", "Bu talebi bot üzerinden yanıtlayamam. [KLİNİK ADI] ile [TELEFON] numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.", "Klinik adı ve telefon yalnız doğrulanmış klinik ayarından gelir."),
    ("V-04", "Yapılandırılmış kapalı klinik yönlendirmesi", "Bu talebi bot üzerinden yanıtlayamam. [KLİNİK ADI] şu anda kapalı. Acil olmayan konular için çalışma saatleri içinde [TELEFON] numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.", "Açık/kapalı sonucu klinik çalışma saatleri ayarına bağlıdır."),
    ("V-05", "Güvenlik soruları", "Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:<br/>• Nefes almakta güçlük var mı?<br/>• Bilinç kaybı var mı?<br/>• Şu anda devam eden nöbet var mı?<br/>• Şiddetli veya durmayan kanama var mı?<br/>• Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?<br/>• Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?<br/>• Yabancı bir cisim yutmuş olabilir mi?<br/>• İdrar yapamıyor mu?", "Yalnız bilinmeyen sorular sonraki turda tekrar gösterilir."),
    ("V-06", "Hayvan kimliği belirsiz", "Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.", "Birden fazla hayvan veya belirsiz eşleşmede kullanılır."),
    ("V-07", "Şikâyet veya belirti eksik", "Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?", "Teşhis istemez; sahibin gözlemini ister."),
    ("V-08", "Bilgiler alındı", "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.", "Randevu oluşturulduğu anlamına gelmez."),
    ("V-09", "Özet doğrulama şablonu", "Anladığım kadarıyla — Ad: \"[AD]\", Tür: [TÜR], Şikayet: [ŞİKÂYET]. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın.", "Alanlar sahibin mesajından çıkarılır, uzunlukları sınırlandırılır; olmayan alan gösterilmez."),
    ("V-10", "Özet düzeltme istemi", "Hangi bilgiyi düzeltmemi istersiniz? Doğru adı, türü veya şikayeti yazmanız yeterli.", "Yanlış özet HAYIR ile mutasyon yapmadan düzeltilir."),
    ("V-11", "Randevu daveti", "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun. Randevu oluşturmak ister misiniz?", "Bu yalnız davettir; uygun saat veya kesin randevu iddiası değildir."),
    ("V-12", "Uygun randevu bulunamadı", "Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen kliniğimizi telefonla arayın.", "Yanlış uygunluk güvencesi vermez."),
    ("V-13", "Geçici randevu teklifi", "En erken uygun randevu saati: [TARİH VE SAAT]. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.", "Tarih/saat Europe/Istanbul olarak gösterilir; geçici ayırma 10 dakikadır."),
    ("V-14", "Randevu onaylandı", "Randevunuz [TARİH VE SAAT] için oluşturuldu.", "Yalnız veritabanı kesinleştirmesi başarılıysa gönderilir."),
    ("V-15", "Randevu reddedildi", "Randevu oluşturulmadı.", "Tam HAYIR/HAYIR eşdeğeriyle kullanılır."),
    ("V-16", "Geçici saat kullanılamıyor", "Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.", "Süresi dolan veya kaybedilen ayırmayı kesin randevu gibi sunmaz."),
    ("V-17", "Mevcut randevu", "[HAYVAN ADI] için zaten [TARİH VE SAAT] tarihinde onaylanmış bir randevu bulunuyor.", "Aynı hayvan için ikinci gelecekteki randevuyu engeller."),
    ("V-18", "Başka görüşmede işleniyor", "Bu randevu şu anda başka bir görüşmede işleme alınıyor. Lütfen kliniğimizi telefonla arayın.", "İşlem yarışında ikinci bir slot veya yanlış kesinlik üretmez."),
    ("V-19", "Randevu iptal onayı", "Randevunuz: [TARİH VE SAAT]. Bu randevuyu iptal etmek istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.", "İptal ayrı ve tam EVET olmadan yapılmaz."),
    ("V-20", "Randevu iptal edildi", "Randevunuz [TARİH VE SAAT] iptal edildi.", "Yalnız kesin iptal başarıyla tamamlandıktan sonra gönderilir."),
    ("V-21", "İptalden vazgeçildi", "Randevunuz iptal edilmedi, mevcut haliyle geçerliliğini koruyor.", "Tam HAYIR/HAYIR eşdeğeri randevuyu korur."),
    ("V-22", "İptal edilebilir randevu yok", "Kaydınızda iptal edilebilecek onaylanmış bir randevu bulamadım. Lütfen kliniğimizi telefonla arayın.", "Olmayan bir iptali yapılmış gibi göstermez."),
    ("V-23", "İptal sırasında geçersizleşti", "Bu randevu artık mevcut değil ya da daha önce iptal edilmiş görünüyor. Lütfen kliniğimizi telefonla arayın.", "Eşzamanlı değişikliği dürüstçe bildirir."),
    ("V-24", "Desteklenmeyen medya", "Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.", "Medya içeriği analiz edilmez."),
    ("V-25", "Kayıt bilgilendirmesi", "Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu görüşmedeki mesajlar kayıt altına alınmaktadır.", "Klinik dil incelemesine ek olarak ayrı hukuk/KVKK incelemesi gerekir."),
]


SCENARIOS = [
    {
        "id": "S-01", "title": "Belirsiz yardım talebi önce güvenlik sorularına gider",
        "context": "Yeni sahip; hayvan adı ve türü belirsiz. Task 062 sınır vakası.",
        "dialog": [("Sahip", "Kurt hasta, ne yapmalıyım?"), ("Bot", "V-05’teki sekiz güvenlik sorusunu sorar.")],
        "expected": "‘Ne yapmalıyım?’ tek başına tıbbi tavsiye devri sayılmaz. Bilinmeyen güvenlik sinyalleri önce açıklığa kavuşur; henüz normal öncelikli devir açılmaz.",
        "question": "Bu belirsiz yardım talebinde önce sekiz sorunun sorulması klinik açıdan uygun mu?",
    },
    {
        "id": "S-02", "title": "Güvenlik sorularından sonra pozitif yanıt",
        "context": "S-01’in devamı.",
        "dialog": [("Sahip", "Nefes almakta güçlük var, diğerleri yok."), ("Bot", "Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.")],
        "expected": "Tek bir pozitif sinyal acil ve terminal yönlendirme üretir; randevu/normal devir bu kararın önüne geçmez. Personel işi acil önceliklidir.",
        "question": "Tek pozitif yanıtın beklemeden acil yönlendirme üretmesi doğru mu?",
    },
    {
        "id": "S-03", "title": "Tıbbi tavsiye talebi ve bilinmeyen güvenlik sinyalleri",
        "context": "Sahip açıkça ilaç/doz ister; sekiz sinyal henüz bilinmiyor.",
        "dialog": [("Sahip", "Kedime hangi ilacı kaç miligram vermeliyim?"), ("Bot", "V-05’teki sekiz güvenlik sorusunu sorar.")],
        "expected": "Model niyeti medical_advice_request olarak çıkarabilir; deterministik kapı yine de bilinmeyen güvenlik sinyallerini önce sorar. Bot ilaç veya doz vermez.",
        "question": "Açık ilaç/doz talebinde dahi önce güvenlik sorularının sorulması uygun mu?",
    },
    {
        "id": "S-04", "title": "Tıbbi tavsiye talebi, tüm güvenlik yanıtları negatif",
        "context": "S-03’ün devamı; sahip sekiz soruya açıkça hayır der.",
        "dialog": [("Sahip", "Sekizinin de cevabı hayır."), ("Bot", "Bu talebi bot üzerinden yanıtlayamam. [KLİNİK] ile [TELEFON] numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.")],
        "expected": "Tüm sinyaller negatif olsa da tıbbi tavsiye verilmez; normal öncelikli insan devri açılır. Yeni bir pozitif sinyal gelirse acil kuralı tekrar üstün gelir.",
        "question": "Tüm güvenlik yanıtları negatifken tavsiye talebinin personele devri doğru mu?",
    },
    {
        "id": "S-05", "title": "Açık insan talebi güvenlik anketi olmadan devredilir",
        "context": "Sahip doğrudan veteriner/personel ile konuşmak ister.",
        "dialog": [("Sahip", "Bir veterinerle konuşmak istiyorum."), ("Bot", "V-02, V-03 veya V-04’teki doğrulanmış devir metnini gönderir.")],
        "expected": "Açık insan talebi ikinci önceliktedir; kullanıcı zorla sekiz soruya sokulmaz. Mesaj yine acil kötüleşme çıkışını taşır.",
        "question": "Açık insan talebinin anketten önce karşılanması uygun mu?",
    },
    {
        "id": "S-06", "title": "İlk mesajda açık acil belirti",
        "context": "Sahip gözlemlenebilir bir pozitif sinyal bildirir.",
        "dialog": [("Sahip", "Boncuk nefes almakta çok zorlanıyor."), ("Bot", "Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.")],
        "expected": "Acil karar birinci ve koşulsuzdur; insan talebi, tavsiye talebi, randevu veya kayıt akışı bunu geciktiremez.",
        "question": "Acil metnin tonu, eylemi ve ‘beklemeyin’ vurgusu yeterli mi?",
    },
    {
        "id": "S-07", "title": "Kısmi güvenlik yanıtı",
        "context": "Sahip sekiz sorunun beşini yanıtlar.",
        "dialog": [("Sahip", "Nefes, bilinç, nöbet, kanama ve travma yok; diğerlerinden emin değilim."), ("Bot", "Yalnız zehir, yabancı cisim ve idrar sorularını tekrar sorar.")],
        "expected": "Yanıtlanan negatifler korunur; bilinmeyen üç soru atlanmaz. ‘Emin değilim’ güvenli çıkış uyarısını sürdürür.",
        "question": "Yalnız kalan soruların tekrar edilmesi yeterince açık ve güvenli mi?",
    },
    {
        "id": "S-08", "title": "Toplu mesaj penceresinde acil sinyal",
        "context": "İki mesaj yaklaşık üç saniyelik tek turda birleşir.",
        "dialog": [("Sahip", "Tarçın bugün çok halsiz."), ("Sahip", "Bir de şu an nefes alamıyor gibi."), ("Bot", "V-01 acil yönlendirmesini gönderir.")],
        "expected": "Parçalar birlikte değerlendirilir; ikinci parçadaki acil sinyal kaybolmaz. Birleştirme penceresi yaklaşık üç saniyedir.",
        "question": "Yaklaşık üç saniyelik teknik pencere bu acil örnekte kabul edilebilir mi?",
    },
    {
        "id": "S-09", "title": "Olağan belirti, güvenlik temiz, özet onayı",
        "context": "Kayıtlı olmayan Pamuk adlı kedi; kusma bildirimi.",
        "dialog": [("Sahip", "Pamuk dün geceden beri kusuyor."), ("Bot", "V-05 güvenlik soruları."), ("Sahip", "Sekizinin de cevabı hayır."), ("Bot", "Anladığım kadarıyla — Ad: \"Pamuk\", Tür: kedi, Şikayet: dün geceden beri kusuyor. Doğru mu? Onaylamak için EVET, düzeltmek için HAYIR yazın."), ("Sahip", "EVET"), ("Bot", "V-11 randevu daveti.")],
        "expected": "Bot teşhis üretmez. Özet açık onaydan önce kayıt oluşturmaz; randevu daveti kesin randevu değildir.",
        "question": "Güvenlikten özet onayına geçiş ve kullanılan dil uygun mu?",
    },
    {
        "id": "S-10", "title": "Özet yanlış; sahip düzeltir",
        "context": "Sahip çıkarılan adı/başlangıç zamanını reddeder.",
        "dialog": [("Bot", "Ad: \"Köpük\", Tür: kedi, Şikayet: iki gündür yemek yemiyor... Doğru mu?"), ("Sahip", "HAYIR"), ("Bot", "Hangi bilgiyi düzeltmemi istersiniz? Doğru adı, türü veya şikayeti yazmanız yeterli."), ("Sahip", "Adı Köpüş; bugün başladı."), ("Bot", "Düzeltilmiş özeti yeniden açık onaya sunar.")],
        "expected": "Yanlış bilgiyle hayvan/randevu oluşturulmaz; değişmeyen alanlar gereksiz yere silinmez.",
        "question": "Düzeltme istemi ve yeniden onay mekanizması klinik kayıt için yeterli mi?",
    },
    {
        "id": "S-11", "title": "Birden fazla hayvan; kimlik belirsiz",
        "context": "Sahibin Pamuk ve Tarçın kayıtları vardır.",
        "dialog": [("Sahip", "Randevu almak istiyorum."), ("Bot", "Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin."), ("Sahip", "Tarçın."), ("Bot", "Tarçın’a bağlı güvenli akışa devam eder.")],
        "expected": "Bot tahmin ederek yanlış hayvana klinik bilgi veya randevu bağlamaz.",
        "question": "Kimlik netleştirme sorusu yanlış hayvana işlem riskini yeterince azaltıyor mu?",
    },
    {
        "id": "S-12", "title": "Geçici randevu teklifi ve kesin onay",
        "context": "Güvenli intake tamamlanmış; uygun saat vardır.",
        "dialog": [("Bot", "En erken uygun randevu saati: [TARİH VE SAAT]. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın."), ("Sahip", "EVET"), ("Bot", "Randevunuz [TARİH VE SAAT] için oluşturuldu.")],
        "expected": "İlk mesaj yalnız 10 dakikalık geçici ayırmadır. Kesin randevu ikinci mesajdaki tam EVET ve başarılı veritabanı sonucu sonrası bildirilir.",
        "question": "Geçici ayırma ile kesin randevu arasındaki fark yeterince açık mı?",
    },
    {
        "id": "S-13", "title": "Randevu teklifi belirsiz yanıt ve vazgeçme",
        "context": "Sahip ‘olabilir’ yazar; sonra HAYIR der.",
        "dialog": [("Bot", "V-13 randevu teklifi."), ("Sahip", "Olabilir."), ("Bot", "Aynı açık EVET/HAYIR teklifini tekrarlar."), ("Sahip", "HAYIR"), ("Bot", "Randevu oluşturulmadı.")],
        "expected": "Belirsiz metin randevu oluşturmaz. Tam HAYIR ayırmayı bırakır.",
        "question": "Yalnız tam EVET/HAYIR kabulü kullanıcı açısından anlaşılır mı?",
    },
    {
        "id": "S-14", "title": "Aynı hayvan için ikinci randevu engeli",
        "context": "Pamuk’un gelecekte onaylı bir randevusu vardır.",
        "dialog": [("Sahip", "Pamuk için tekrar randevu almak istiyorum."), ("Bot", "Pamuk için zaten [TARİH VE SAAT] tarihinde onaylanmış bir randevu bulunuyor.")],
        "expected": "İkinci slot ayrılmaz; mevcut kayıt dürüstçe gösterilir.",
        "question": "Mevcut randevu mesajı yeterince açık mı?",
    },
    {
        "id": "S-15", "title": "Randevu başka görüşmede işleniyor",
        "context": "Aynı hayvan için eşzamanlı başka bir görüşme randevu işlemi yürütür.",
        "dialog": [("Sahip", "Pamuk için randevu almak istiyorum."), ("Bot", "Bu randevu şu anda başka bir görüşmede işleme alınıyor. Lütfen kliniğimizi telefonla arayın.")],
        "expected": "İkinci slot veya kesinleşmemiş sonuç gösterilmez.",
        "question": "‘Başka bir görüşmede işleniyor’ dili yeterince anlaşılır mı?",
    },
    {
        "id": "S-16", "title": "Randevu iptali ayrı açık onay ister",
        "context": "Sahip hayvan adını ve iptal niyetini ilk mesajda verir.",
        "dialog": [("Sahip", "Pamuk’un randevusunu iptal etmek istiyorum."), ("Bot", "Randevunuz: [TARİH VE SAAT]. Bu randevuyu iptal etmek istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın."), ("Sahip", "EVET"), ("Bot", "Randevunuz [TARİH VE SAAT] iptal edildi.")],
        "expected": "İlk iptal cümlesi mutasyon yapmaz; ayrı tam EVET gerekir.",
        "question": "Yanlışlıkla iptal riskine karşı iki aşamalı onay yeterli mi?",
    },
    {
        "id": "S-17", "title": "İptalden vazgeçme ve belirsiz cevap",
        "context": "Sahip önce belirsiz, sonra HAYIR yanıtı verir.",
        "dialog": [("Bot", "V-19 iptal onayı."), ("Sahip", "Sanırım."), ("Bot", "V-19’u tekrarlar; iptal yapmaz."), ("Sahip", "HAYIR"), ("Bot", "Randevunuz iptal edilmedi, mevcut haliyle geçerliliğini koruyor.")],
        "expected": "Belirsiz cevap mutasyon yapmaz; tam HAYIR mevcut randevuyu korur.",
        "question": "Vazgeçme sonucu ve tekrar sorusu yeterince açık mı?",
    },
    {
        "id": "S-18", "title": "İptal edilebilir randevu yok veya işlem sırasında kayboldu",
        "context": "İki ayrı güvenli hata dalı.",
        "dialog": [("Dal A Bot", "Kaydınızda iptal edilebilecek onaylanmış bir randevu bulamadım. Lütfen kliniğimizi telefonla arayın."), ("Dal B Bot", "Bu randevu artık mevcut değil ya da daha önce iptal edilmiş görünüyor. Lütfen kliniğimizi telefonla arayın.")],
        "expected": "Bot olmayan veya eşzamanlı değişen randevuyu iptal edilmiş gibi göstermez.",
        "question": "İki hata mesajı yanlış güvence vermeden yeterli eylem sunuyor mu?",
    },
    {
        "id": "S-19", "title": "Desteklenmeyen medya",
        "context": "Sahip yalnız fotoğraf, ses, video, belge, konum veya kişi kartı yollar.",
        "dialog": [("Sahip", "[Fotoğraf gönderir]"), ("Bot", "Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.")],
        "expected": "Bot medyayı gördüğünü/yorumladığını iddia etmez; acil çıkış korunur.",
        "question": "Medya sınırı ve alternatif eylem yeterince açık mı?",
    },
    {
        "id": "S-20", "title": "İnsan devri çözülür; sonraki mesaj yeni güvenli görüşme açar",
        "context": "Personel devredilen işi panelden çözer; eski görüşme completed/completed olur.",
        "dialog": [("Personel", "İşi üstlenir ve çözüldü olarak işaretler."), ("Sahip", "Ertesi gün: Pamuk bugün kusuyor."), ("Bot", "Eski terminal görüşmeyi yeniden kullanmaz; yeni görüşmede güvenlik değerlendirmesini baştan başlatır.")],
        "expected": "Çözülmüş devrin eski klinik durumu yeni belirtiyi bastırmaz. Yeni mesaj güvenlik-first akışına döner; eski kayıt silinmez.",
        "question": "Devir çözümünden sonra yeni görüşmenin güvenlik değerlendirmesini sıfırdan başlatması uygun mu?",
    },
]


def draw_paw(canvas, x: float, y: float, scale: float = 1.0, fill=BROWN) -> None:
    canvas.saveState()
    canvas.setFillColor(fill)
    canvas.circle(x, y, 6 * scale, fill=1, stroke=0)
    for dx, dy, r in [(-8, 8, 3.2), (-2.5, 12, 3.4), (4, 11.5, 3.3), (9, 7, 3.0)]:
        canvas.circle(x + dx * scale, y + dy * scale, r * scale, fill=1, stroke=0)
    canvas.restoreState()


def page_chrome(canvas, doc) -> None:
    canvas.saveState()
    width, height = A4
    if doc.page > 1:
        canvas.setFillColor(CREAM)
        canvas.rect(0, height - 14 * mm, width, 14 * mm, fill=1, stroke=0)
        draw_paw(canvas, 17 * mm, height - 10 * mm, 0.55, TEAL)
        canvas.setFont("PatiBold", 8.5)
        canvas.setFillColor(INK)
        canvas.drawString(29 * mm, height - 9.8 * mm, "PATI HATTI  ·  VETERİNER HEKİM İNCELEME PAKETİ")
        canvas.setStrokeColor(LIGHT_BROWN)
        canvas.line(15 * mm, 14 * mm, width - 15 * mm, 14 * mm)
        canvas.setFont("Pati", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(15 * mm, 9 * mm, "ONAY BEKLİYOR · 14.09.2026 · İmzalı kopyayı kaynak kod deposuna koymayın")
        canvas.drawRightString(width - 15 * mm, 9 * mm, f"Sayfa {doc.page}")
    canvas.restoreState()


class PatiDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=17 * mm,
            rightMargin=17 * mm,
            topMargin=20 * mm,
            bottomMargin=18 * mm,
            title="Pati Hattı Veteriner Hekim İnceleme ve Onay Paketi",
            author="Pati Hattı",
            subject="Klinik güvenlik, kullanıcı metinleri ve senaryo onayı",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="normal")
        self.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=page_chrome)])


def section_title(story: list, number: str, title: str, intro: str | None = None) -> None:
    story.append(p(f"{number}  {title}", H1))
    if intro:
        story.append(p(intro))


def decision_box(title: str = "Veteriner hekim kararı") -> Table:
    data = [
        [p(title, H3)],
        [p("[ ] Uygun &nbsp;&nbsp;&nbsp; [ ] Değişiklik gerekli &nbsp;&nbsp;&nbsp; [ ] Kullanılmamalı", SMALL)],
        [p("Gerekçe / önerilen metin: " + "_" * 65, SMALL)],
        [p("_" * 95, SMALL)],
    ]
    table = Table(data, colWidths=[174 * mm], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SAGE),
        ("BOX", (0, 0), (-1, -1), 0.7, TEAL),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, LIGHT_BROWN),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def add_cover(story: list) -> None:
    story.append(Spacer(1, 17 * mm))
    story.append(p("PATI HATTI", SUBTITLE))
    story.append(p("Veteriner Hekim<br/>İnceleme ve Onay Paketi", TITLE))
    story.append(p("Klinik güvenlik kapısı · Kullanıcı metinleri · Uçtan uca sentetik senaryolar", SUBTITLE))
    story.append(Spacer(1, 8 * mm))
    status = Table([[p("ONAY BEKLİYOR — İMZASIZ TASLAK", STATUS)]], colWidths=[174 * mm], rowHeights=[16 * mm])
    status.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), RED), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(status)
    story.append(Spacer(1, 10 * mm))
    meta = [
        [p("Paket tarihi", SMALL), p("14 Eylül 2026", BODY)],
        [p("Geçerli depo sürümü", SMALL), p("HEAD 15ff853 · klinik güvenlik değişikliği 2e14c89 (Task 062)", BODY)],
        [p("Marka / ürün", SMALL), p("Pati Hattı — WhatsApp tabanlı veteriner klinik iletişim asistanı", BODY)],
        [p("Veri sınıfı", SMALL), p("Tamamı sentetik örnek; gerçek kişi, hayvan, klinik veya sağlık verisi yoktur.", BODY)],
        [p("Onay kapsamı", SMALL), p("Metinlerin klinik uygunluğu, triyaj sırası, devir ve randevu sınırları", BODY)],
    ]
    table = Table(meta, colWidths=[43 * mm, 131 * mm], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_BROWN),
        ("BOX", (0, 0), (-1, -1), 0.8, BROWN),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C7B29F")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 10 * mm))
    story.append(p("Bu belge bir tedavi protokolü değildir", H2))
    story.append(p("Paket, yazılımın kullanıcıya gösterdiği dili ve karar sırasını değerlendirmek içindir. Bot teşhis koymaz, olası hastalık adı saymaz, ilaç/doz önermez ve tedaviyi değiştirmez. Bu taslak yalnız yetkili veteriner hekim tarafından doldurulup imzalandığında klinik inceleme kaydı olur. Hukuk/KVKK onayı ayrıca gerekir."))
    story.append(Spacer(1, 10 * mm))
    story.append(p("İnceleyen veteriner hekim: ____________________________________________", BODY))
    story.append(p("Klinik / kurum: _____________________________________________________", BODY))
    story.append(p("İnceleme tarihi: ____________________________________________________", BODY))
    story.append(PageBreak())


def add_intro(story: list) -> None:
    section_title(story, "1", "İnceleme yöntemi ve karar sınırı")
    story.append(p("Her metin ve senaryoda uygunluk kutusu boş bırakılmıştır. Hekim; beklememe yönlendirmesini, yanlış güvence riskini, dilin anlaşılabilirliğini, gecikme ihtimalini ve kliniğin gerçek çalışma biçimini değerlendirmelidir."))
    bullets = [
        "<b>Deterministik kural:</b> Sekiz güvenlik sinyalinin sırası, acil/devir kararı ve EVET/HAYIR mutasyonları modelin serbest kararına bırakılmaz.",
        "<b>Modelin görevi:</b> Sahibin serbest Türkçe mesajından yapılandırılmış niyet ve gözlemlenebilir bilgileri çıkarmaktır; tanı veya tedavi üretmek değildir.",
        "<b>İnsan kararı:</b> Tıbbi tavsiye, acil/normal devir işi, klinik takip ve gerçek bakım kararı yetkili personele aittir.",
        "<b>Fail-closed yaklaşım:</b> Belirsiz güvenlik yanıtı atlanmaz; yanlış şekilli/eksik teknik sonuç ilerleme sayılmaz.",
        "<b>Yeniden onay:</b> Bu PDF’deki sabit metin, sekiz soru, öncelik sırası veya mutasyon sınırı değişirse ilgili bölüm yeniden hekime sunulur.",
    ]
    for item in bullets:
        story.append(p("• " + item))
    story.append(Spacer(1, 3 * mm))
    story.append(decision_box("Paketin inceleme yöntemi"))
    story.append(PageBreak())

    section_title(story, "2", "Güncel klinik güvenlik önceliği", "Aşağıdaki sıra Task 062 sonrasında çalışan deterministik kapıdır. Üstteki karar alttakini geçersiz kılar.")
    rows = [
        [p("Sıra", H3), p("Koşul", H3), p("Sonuç", H3)],
        [p("1", CENTER), p("Sekiz sinyalden en az biri <b>evet</b>", BODY), p("<b>Acil devir.</b> V-01 gönderilir; diğer akışlar durur.", BODY)],
        [p("2", CENTER), p("Kullanıcı açıkça insan/veteriner ister", BODY), p("<b>İnsan devri.</b> V-02/03/04; güvenlik anketi zorla sorulmaz.", BODY)],
        [p("3", CENTER), p("Sekiz sinyalden en az biri bilinmiyor", BODY), p("<b>Güvenlik kontrolü.</b> Yalnız bilinmeyen sorular sorulur.", BODY)],
        [p("4", CENTER), p("Tüm sinyaller hayır ve niyet açık ilaç/doz/teşhis/tedavi talebi", BODY), p("<b>İnsan devri.</b> Bot tıbbi tavsiye vermez.", BODY)],
        [p("5", CENTER), p("Yukarıdakilerin hiçbiri yok", BODY), p("<b>Intake devam eder.</b> Kimlik/şikâyet/özet/randevu adımları.", BODY)],
    ]
    table = Table(rows, colWidths=[14 * mm, 72 * mm, 88 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TEAL),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.4, LIGHT_BROWN),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, CREAM]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 6 * mm))
    story.append(p("<b>Önemli sınır:</b> “Hastam var, ne yapmalıyım?” olağan belirti/yardım bildirimi olarak kalır; doğrudan tıbbi tavsiye devrine kaçmaz. “Hangi ilacı kaç miligram vereyim?” gibi açık ilaç/doz/teşhis/tedavi talepleri tıbbi tavsiye talebidir; ancak güvenlik sinyalleri bilinmiyorsa yine de önce sekiz soru sorulur.", QUOTE))
    story.append(decision_box("Öncelik sırası ve tıbbi tavsiye sınırı"))
    story.append(PageBreak())

    section_title(story, "3", "Sekiz gözlemlenebilir güvenlik sorusu")
    questions = [
        "Nefes almakta güçlük var mı?",
        "Bilinç kaybı var mı?",
        "Şu anda devam eden nöbet var mı?",
        "Şiddetli veya durmayan kanama var mı?",
        "Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?",
        "Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?",
        "Yabancı bir cisim yutmuş olabilir mi?",
        "İdrar yapamıyor mu?",
    ]
    qrows = [[p("#", H3), p("Kullanıcıya sorulan tam metin", H3), p("Hekim kararı", H3)]]
    for i, q in enumerate(questions, 1):
        qrows.append([p(str(i), CENTER), p(q), p("[ ] Uygun<br/>[ ] Değişsin<br/>[ ] Çıkarılsın", SMALL)])
    qtable = Table(qrows, colWidths=[10 * mm, 119 * mm, 45 * mm], repeatRows=1)
    qtable.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BROWN),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.45, LIGHT_BROWN),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, CREAM]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(qtable)
    story.append(Spacer(1, 5 * mm))
    story.append(p("Eksik olması gerektiğini düşündüğünüz gözlemlenebilir acil sinyal: " + "_" * 58, SMALL))
    story.extend(note_lines(3))
    story.append(PageBreak())


def add_fixed_copy(story: list) -> None:
    section_title(story, "4", "Kullanıcıya gösterilen 25 metin", "Köşeli parantezli alanlar dinamik şablon alanlarıdır; diğer cümleler mevcut sabit Türkçe metindir.")
    story.append(p("Herhangi bir metin değişirse ilgili kod/test ve bu onay kaydı birlikte yenilenmelidir.", QUOTE))
    for index, (code, title, text, note) in enumerate(FIXED_COPY):
        block = [
            p(f"{code} — {title}", H2),
            p(text, QUOTE),
            p(f"<b>Teknik/klinik bağlam:</b> {note}", SMALL),
            checkbox_line(),
            *note_lines(2),
            Spacer(1, 4 * mm),
        ]
        story.append(KeepTogether(block))
        if index in {3, 7, 11, 15, 19, 24}:
            story.append(PageBreak())


def add_scenarios(story: list) -> None:
    section_title(story, "5", "Uçtan uca sentetik onay senaryoları", "Senaryolar gerçek hasta verisi değildir. Amaç, yazılımın görünür davranışını ve güvenlik sırasını klinik karara sunmaktır.")
    for i, scenario in enumerate(SCENARIOS):
        story.append(p(f"{scenario['id']} — {scenario['title']}", H2))
        story.append(p(f"<b>Başlangıç:</b> {scenario['context']}", SMALL))
        dialog_rows = []
        for speaker, line in scenario["dialog"]:
            dialog_rows.append([p(f"<b>{speaker}</b>", SMALL), p(line, BODY)])
        dialog = Table(dialog_rows, colWidths=[28 * mm, 146 * mm], hAlign="LEFT")
        dialog.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (0, -1), SAGE),
            ("ROWBACKGROUNDS", (1, 0), (1, -1), [WHITE, CREAM]),
            ("GRID", (0, 0), (-1, -1), 0.35, LIGHT_BROWN),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(dialog)
        story.append(Spacer(1, 2 * mm))
        story.append(p(f"<b>Beklenen sistem davranışı:</b> {scenario['expected']}", SMALL))
        story.append(p(f"<b>Hekime soru:</b> {scenario['question']}", SMALL))
        story.append(checkbox_line("Senaryo kararı"))
        story.extend(note_lines(2))
        story.append(Spacer(1, 5 * mm))
        if i % 2 == 1:
            story.append(PageBreak())


def add_final_review(story: list) -> None:
    section_title(story, "6", "Grup düzeyinde zorunlu değerlendirme")
    items = [
        "Acil yönlendirme kullanıcıyı botta bekletmiyor.",
        "Sekiz soru klinik açıdan doğru, gözlemlenebilir ve kullanıcı tarafından yanıtlanabilir.",
        "Açık insan talebinin güvenlik anketinden önce gelmesi uygundur.",
        "Bilinmeyen güvenlik sinyallerinin tıbbi tavsiye devrinden önce sorulması uygundur.",
        "Tüm güvenlik sinyalleri negatifken açık ilaç/doz/teşhis/tedavi talebinin personele devri uygundur.",
        "Bot metinleri teşhis, hastalık listesi, ilaç, doz veya tedavi önermiyor.",
        "Açık/kapalı klinik ve telefon metinleri kliniğin çalışma biçimine uygundur.",
        "Kısmi güvenlik yanıtında yalnız bilinmeyen soruların tekrar edilmesi uygundur.",
        "Yaklaşık üç saniyelik mesaj birleştirme penceresi klinik açıdan kabul edilebilir.",
        "Özet doğrulama ve düzeltme yanlış hayvan/şikâyet kaydı riskine karşı yeterlidir.",
        "10 dakikalık geçici randevu ayırma süresi ve dili uygundur.",
        "Randevu ile iptal mutasyonlarında ayrı tam EVET şartı uygundur.",
        "İnsan devri çözüldükten sonra yeni mesajın yeni güvenlik değerlendirmesi başlatması uygundur.",
        "Desteklenmeyen medya metni yanlış analiz iddiası içermez ve güvenli çıkış sunar.",
        "Kayıt bilgilendirmesi klinik dil bakımından uygundur; ayrı KVKK/hukuk incelemesi gerektiği kabul edilmiştir.",
    ]
    rows = [[p("Değerlendirme", H3), p("Karar", H3)]]
    for item in items:
        rows.append([p(item, SMALL), p("[ ] Evet &nbsp; [ ] Hayır &nbsp; [ ] Koşullu", SMALL)])
    table = Table(rows, colWidths=[125 * mm, 49 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TEAL),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.4, LIGHT_BROWN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, CREAM]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(table)
    story.append(PageBreak())

    section_title(story, "7", "Açık riskler, kanıt sınırı ve yeniden inceleme")
    risks = [
        "Bu belge yazılım davranışını anlatır; gerçek vakaya klinik tavsiye vermez.",
        "Task 062’nin yerel test ve model değerlendirmeleri tamamlanmış olsa da bu PDF hazırlanırken üç sonuçlu canlı staging WhatsApp kanaryası yeniden çalıştırılmamıştır.",
        "Model sınıflandırması hata yapabilir; klinik güvenlik deterministik kapı, sabit metin ve insan devri ile sınırlandırılmıştır.",
        "‘Kurt hasta, ne yapmalıyım?’ benzeri sınır cümleleri üretim modeli için ölçülmüştür; yine de ilk ücretli pilot boyunca örneklenmiş kalite takibi gerekir.",
        "Klinik adı, telefon, çalışma saati, personel takibi ve bildirim alıcıları doğru yapılandırılmadan devir deneyimi eksik kalabilir.",
        "İmzalı paketteki ad, sicil ve imza kişisel veridir; kaynak kod deposuna veya herkese açık bağlantıya yüklenmemelidir.",
    ]
    for risk in risks:
        story.append(p("• " + risk))
    story.append(p("<b>Şunlardan biri değişirse yeniden veteriner incelemesi gerekir:</b>", H2))
    for item in [
        "Sekiz güvenlik sorusunun eklenmesi, çıkarılması veya anlamının değiştirilmesi",
        "Beş aşamalı öncelik sırasının değiştirilmesi",
        "Acil, insan devri, randevu veya iptal metinlerinin değiştirilmesi",
        "Yeni bir teşhis/tavsiye/ilaç/tedavi yeteneği eklenmesi",
        "Mesaj birleştirme gecikmesinin veya randevu ayırma süresinin klinik etkili biçimde değiştirilmesi",
        "Yeni medya analizi veya yeni sağlık verisi işleme alanı eklenmesi",
    ]:
        story.append(p("[ ] " + item, SMALL))
    story.append(Spacer(1, 6 * mm))
    story.append(decision_box("Açık riskler ve yeniden inceleme sınırı"))
    story.append(PageBreak())

    section_title(story, "8", "Veteriner hekim onay kaydı")
    story.append(p("Bu bölüm yalnız yetkili veteriner hekim tarafından doldurulup imzalandığında belge incelenmiş sayılır. Önceden işaretlenmiş kutu yoktur."))
    fields = [
        ("Klinik / kurum", ""),
        ("Veteriner hekim adı soyadı", ""),
        ("Unvan / yetki bilgisi", ""),
        ("Diploma / oda / sicil numarası", ""),
        ("İnceleme tarihi", ""),
        ("İncelenen paket", "Pati Hattı Veteriner Hekim İnceleme ve Onay Paketi — 14.09.2026"),
        ("Bağlı kod sürümü", "HEAD 15ff853 · klinik güvenlik 2e14c89"),
    ]
    rows = [[p(label, SMALL), p(value if value else "_" * 72, BODY)] for label, value in fields]
    table = Table(rows, colWidths=[52 * mm, 122 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_BROWN),
        ("GRID", (0, 0), (-1, -1), 0.45, BROWN),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(table)
    story.append(Spacer(1, 7 * mm))
    story.append(p("<b>Genel karar</b>", H2))
    story.append(p("[ ] Tümü onaylandı &nbsp;&nbsp;&nbsp; [ ] Koşullu / kısmi onay &nbsp;&nbsp;&nbsp; [ ] Onaylanmadı"))
    story.append(p("Onayın kapsadığı bölümler / hariç tutulan maddeler:", SMALL))
    story.extend(note_lines(4))
    story.append(p("Zorunlu değişiklikler / klinik koşullar:", SMALL))
    story.extend(note_lines(5))
    story.append(Spacer(1, 7 * mm))
    sign = Table([
        [p("Veteriner hekim imzası", H3), p("Klinik / kurum onayı (varsa)", H3)],
        [p("\n\n\n\nİmza: __________________________", BODY), p("\n\n\n\nİmza/kaşe: _____________________", BODY)],
    ], colWidths=[87 * mm, 87 * mm], rowHeights=[10 * mm, 40 * mm])
    sign.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SAGE),
        ("GRID", (0, 0), (-1, -1), 0.6, TEAL),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(sign)
    story.append(Spacer(1, 6 * mm))
    story.append(p("<b>Saklama:</b> İmzalı veya kişisel bilgi içeren kopyayı Git deposuna koymayın. Klinik tarafından belirlenen, erişimi sınırlı ve güvenli kayıt ortamında saklayın. Codex ancak gerçek imzalı kararın sonucu kullanıcı tarafından bildirildiğinde proje kapısını güncelleyebilir.", QUOTE))
    story.append(PageBreak())

    section_title(story, "Ek", "Teknik dayanak ve sürüm izi")
    refs = [
        ("Klinik güvenlik sırası", "src/safetyDecision.ts; commit 2e14c89"),
        ("Sabit intake ve devir metinleri", "src/intakeReply.ts"),
        ("Özet onayı ve randevu daveti", "src/petRegistration.ts"),
        ("Randevu / iptal EVET-HAYIR kapısı", "src/appointmentFlow.ts"),
        ("Gerçek consumer yolu", "src/intakeConsumer.ts"),
        ("Prompt sınırı", "prompts/intake-extraction-prompt.ts · sürüm 2026-09-13.1"),
        ("Olay analizi", "docs/olaylar/2026-09-13-triyaj-oncesi-devir.md"),
        ("Güvenlik sözleşmesi", "docs/safety-decision-gate.md"),
        ("Önceki kapsamlı senaryo paketi", "docs/onay-paketleri/task-039-veteriner-onay-senaryolari.md"),
    ]
    rows = [[p("Alan", H3), p("Depo kanıtı", H3)]] + [[p(a, SMALL), p(b, SMALL)] for a, b in refs]
    table = Table(rows, colWidths=[65 * mm, 109 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BROWN),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.4, LIGHT_BROWN),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, CREAM]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(table)
    story.append(Spacer(1, 8 * mm))
    story.append(p("Bu ek, hekimin kod incelemesini gerektirmez; onaylanan görünür davranışın hangi sürüme bağlı olduğunu denetlenebilir kılar.", SMALL))


def build() -> None:
    assert len(FIXED_COPY) == 25 and len({item[0] for item in FIXED_COPY}) == 25
    assert len(SCENARIOS) == 20 and len({item["id"] for item in SCENARIOS}) == 20
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = PatiDocTemplate(str(OUTPUT))
    story: list = []
    add_cover(story)
    add_intro(story)
    add_fixed_copy(story)
    add_scenarios(story)
    add_final_review(story)
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    build()
