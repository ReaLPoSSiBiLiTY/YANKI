'use strict'
// Sürüm notları. Hem uygulamadaki "Yenilikler" ekranı hem de GitHub sürüm sayfası
// (scripts/release-notes.js) bu listeden üretilir. Yeni sürümde en üste ekle.
const CHANGELOG = [
  {
    version: '1.5.0',
    date: '2026-11-10',
    title: 'Hafif YANKI, bağlantı istatistikleri ve yayın sesi',
    items: [
      { icon: 'zap', title: 'Çok daha hafif', desc: 'YANKI artık varsayılan olarak hafif modda: sürekli animasyon ve canlı cam bulanıklığı yok, hareketli avatarlar yalnızca üzerine gelince oynuyor, sesli kanalda değilken arka planda neredeyse hiç çalışmıyor. Görsel efektler Ayarlar › Görünüm\'den açılabilir.' },
      { icon: 'screen', title: 'Yayıncı için daha az yük', desc: 'Kendi yayınının önizlemesi varsayılan olarak kapalı; bilgisayarın kendi ekranını ikinci kez çizmekle uğraşmıyor. İstersen yayın kutusundan açabilirsin.' },
      { icon: 'eye', title: 'İzleyici sayısı düzeltildi', desc: 'İzleyiciler hangi yayını izlediklerini de duyuruyor; izleme isteği yolda kaybolsa bile sayaç kendiliğinden düzeliyor ve yayın gelmeye başlıyor.' },
      { icon: 'activity', title: 'Bağlantı istatistikleri', desc: 'Ses kartında ve sahnenin köşesinde anlık alınan/giden veri ile toplamlar görünüyor. Tıklayınca kişi kişi gecikme, bağlantı yolu, hız ve toplam trafik tablosu açılıyor. Yayın kutusunda da yayının anlık hızı ve kare sayısı var.' },
      { icon: 'volume', title: 'Yayın sesi', desc: 'İzlediğin yayının sesini, kişinin mikrofonundan bağımsız olarak yayın kutusundaki kaydırıcıyla ayarla.' },
      { icon: 'moon', title: 'macOS koyu simge', desc: 'Mac\'te sistem koyu moddayken Dock ve menü çubuğu simgesi ile uygulama içi logo koyu sürüme geçiyor; açık modda eskisi gibi.' }
    ]
  },
  {
    version: '1.4.0',
    date: '2026-11-09',
    title: 'Dosya paylaşımı ve daha sağlam ses',
    items: [
      { icon: 'paperclip', title: 'Dosya paylaşımı', desc: 'Ataç düğmesiyle, sürükle-bırakla ya da yapıştırarak 2 GB\'a kadar her türlü dosyayı paylaş. Dosya sunucuya değil, doğrudan paylaşan kişiden (ya da onu indirmiş bir üyeden) parça parça gelir ve bütünlüğü doğrulanır. Yalnızca o kanala erişimi olanlar indirebilir.' },
      { icon: 'signal', title: 'Duyulamama sorunu giderildi', desc: 'Doğrudan bağlantı kurulamayan kişiler arasında ses artık YANKI ağı üzerinden aktarılıyor ("Aktarmalı ses"). Bilgisayar saati yanlış olan kullanıcıların hiç duyulamaması düzeltildi; YANKI saat farkını kendisi telafi ediyor.' },
      { icon: 'activity', title: 'Daha az gir-çık', desc: 'Kısa ağ dalgalanmalarında bağlantı hemen kopartılmıyor; kişiler sesli kanaldan kendiliğinden düşüp geri gelmiyor.' },
      { icon: 'screen', title: 'Yayından düşme düzeltildi', desc: 'Bağlantı yenilendiğinde ya da durum bilgisi geç geldiğinde izleyici artık yayından atılmıyor; yayın kendiliğinden geri geliyor.' },
      { icon: 'shield', title: 'Güvenlik uyarıları', desc: 'Bağlantılar açılmadan önce hangi siteye gidileceği gösteriliyor. Dosyalar indirilmeden önce uyarı çıkıyor; program ve betik dosyalarında (.exe, .bat, .dmg…) ayrıca kırmızı uyarı var.' }
    ]
  },
  {
    version: '1.3.0',
    date: '2026-10-26',
    title: 'Davetle kullanım, grup simgeleri ve arka planda çalışma',
    items: [
      { icon: 'lock', title: 'Yalnızca davetle', desc: 'YANKI artık yalnızca bir davet koduyla kullanılabiliyor. Davetleri sunucu yöneticileri oluşturur; süresi ve kaç kişinin kullanabileceği seçilir, istenildiği an iptal edilir. Eski kalıcı davet kodları artık çalışmaz.' },
      { icon: 'shield', title: 'Davetsiz erişim kapalı', desc: 'Sunucu verisi yalnızca üyelerle ve geçerli bir davet sunanlarla paylaşılır. Ortak sunucusu olmayan biri arkadaşlık isteği ya da özel mesaj gönderemez; yeni sunucuyu yalnızca mevcut yöneticiler açabilir.' },
      { icon: 'star', title: 'Grup simgeleri', desc: 'Gruplar ve kanal erişimi penceresinden her gruba bir simge seç (ya da simgesiz bırak). Simge, üye listesinde o gruptaki kişilerin adının yanında görünür.' },
      { icon: 'chat', title: 'Çift tıkla mesaj at', desc: 'Sağdaki üye listesinde birine çift tıklayınca sağ altta onunla özel mesaj penceresi açılır.' },
      { icon: 'download', title: 'Arka planda çalışma', desc: 'Pencereyi kapatınca YANKI görev çubuğunun sağındaki simgelere (macOS\'ta menü çubuğuna) iner, sesli sohbet sürer. Tamamen kapatmak için simgeye sağ tıklayıp "Çıkış"ı seç. Ayarlar › Bildirimler ve pencere\'den kapatılabilir.' }
    ]
  },
  {
    version: '1.2.2',
    date: '2026-10-19',
    title: 'Lisans ve kullanım notu',
    items: [
      { icon: 'shield', title: 'Lisans', desc: 'YANKI artık MIT lisans metniyle birlikte dağıtılıyor: ücretsiz ve "olduğu gibi" sunulur.' },
      { icon: 'sparkle', title: 'Kullanım notu', desc: 'Ayarlar › Hakkında\'ya, paylaşılan içerikten paylaşan kişinin sorumlu olduğunu açıklayan kısa bir kullanım notu eklendi.' }
    ]
  },
  {
    version: '1.2.1',
    date: '2026-10-19',
    title: 'Güvenlik güncellemesi',
    items: [
      { icon: 'shield', title: 'Bağlantı önizlemesi güvenliği', desc: 'Sohbette paylaşılan bağlantıların önizlemesi artık yerel ağdaki adresleri (modem arayüzü, NAS, bilgisayarındaki servisler) açmıyor; yönlendirmeler de tek tek denetleniyor.' },
      { icon: 'shield', title: 'Güncelleme doğrulaması', desc: 'Güncellemeler yalnızca YANKI\'nın resmi GitHub sürüm sayfasından indiriliyor.' },
      { icon: 'shield', title: 'Ek sağlamlaştırma', desc: 'Grup üyeliği ve oyun algılamada kullanılan veriler daha sıkı denetleniyor.' },
      { icon: 'activity', title: 'Küçültülmüşken daha az yük', desc: 'Pencere küçültüldüğünde ya da gizlendiğinde arayüz çizimi duruyor; ses ve yayın kesintisiz sürüyor.' }
    ]
  },
  {
    version: '1.2.0',
    date: '2026-10-19',
    title: 'Gruplar, özel kanallar ve otomatik güncelleme',
    items: [
      { icon: 'sparkle', title: 'Otomatik güncelleme', desc: 'Yeni sürüm çıktığında "Güncelle" düğmesi belirir; tek tıkla indirilir, kurulur ve uygulama yeniden açılır.' },
      { icon: 'shield', title: 'Gruplar ve özel kanallar', desc: 'Yöneticiler kullanıcı grupları oluşturup metin ve ses kanallarını yalnızca belirli gruplara açabilir. Özel kanallar kilit simgesiyle ayrılır; mesajları uçtan uca şifrelenir.' },
      { icon: 'chat', title: '@bahsetme', desc: '@ yazınca sunucudaki kişiler ve @herkes listelenir. Bahsedilen kişiye bildirim gider ve kanal yanında sayaç görünür.' },
      { icon: 'screen', title: '"Yayını İzle"', desc: 'Yayınlar artık sen istediğinde açılır; üzerinde izleyici sayısı görünür, "Yayını Kapat" ile çıkabilirsin. Yayıncının bilgisayarı yalnızca izleyenler için kodlama yapar, oyunda takılma azalır.' },
      { icon: 'maximize', title: 'Tam ekran düzeltmesi', desc: 'Tam ekran izlenen yayın artık kendiliğinden küçülmüyor. Yayınlarda donanım hızlandırmalı H.264 tercih ediliyor.' },
      { icon: 'signal', title: 'Daha sağlam bağlantı', desc: 'Takılan ses bağlantıları daha hızlı onarılıyor; aynı kişiyle ikinci bir ağ bağlantısı açılınca eskisinin kopması düzeltildi.' },
      { icon: 'poll', title: 'Açık ve gizli anket', desc: 'Anketi oluşturan kişi, kimin neye oy verdiğinin görünüp görünmeyeceğini seçer.' },
      { icon: 'chat', title: 'Mini özel mesaj penceresi', desc: 'Özel mesajlar açık ekranını değiştirmeden sağ alttaki küçük pencerede açılır.' },
      { icon: 'palette', title: 'Koyu / Açık mod ve yeni temalar', desc: 'Ayarlar › Görünüm\'den mod seç. Futbol, FPS, RPG ve Yarış temaları eklendi; tüm temalar açık modda da çalışır.' },
      { icon: 'activity', title: 'Daha az kaynak tüketimi', desc: 'Oyun algılama hafifletildi, sohbet geçmişi artımlı işleniyor, arka plandayken gereksiz çizim yapılmıyor; isteğe bağlı Performans modu eklendi.' }
    ]
  },
  {
    version: '1.1.0',
    date: '2026-10-16',
    title: 'Arkadaşlar, botlar ve temalar',
    items: [
      { icon: 'users', title: 'Arkadaşlar ve özel mesajlar', desc: 'Arkadaşlık istekleri, engelleme ve yalnızca iki kişi arasında giden özel mesajlar.' },
      { icon: 'bot', title: 'Botlar', desc: 'Zar, Anket, Karşılama ve herkesin aynı anda dinlediği Müzik Çalar.' },
      { icon: 'gamepad', title: 'Etkinlik', desc: 'Oynadığın oyun ve dinlediğin şarkı profilinde görünür.' },
      { icon: 'palette', title: 'Temalar', desc: 'Oyun temalı arka planlar ve kendi resminden renk paleti.' }
    ]
  },
  {
    version: '1.0.0',
    date: '2026-10-15',
    title: 'İlk sürüm',
    items: [
      { icon: 'globe', title: 'Sunucusuz', desc: 'Eşler arası, uçtan uca şifreli topluluk uygulaması.' }
    ]
  }
]

if (typeof module !== 'undefined') module.exports = CHANGELOG
else window.CHANGELOG = CHANGELOG
