'use strict'
// Sürüm notları. Hem uygulamadaki "Yenilikler" ekranı hem de GitHub sürüm sayfası
// (scripts/release-notes.js) bu listeden üretilir. Yeni sürümde en üste ekle.
const CHANGELOG = [
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
