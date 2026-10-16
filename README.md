# YANKI

Merkezi sunucusuz, eşler arası (P2P) topluluk ve haberleşme uygulaması. Windows ve macOS için.

Sunucular, kanallar, sesli ve görüntülü sohbet, 1080p ekran paylaşımı, arkadaşlar, özel mesajlar ve botlar sunar. Hiçbir veri bir şirketin sunucusunda durmaz: topluluk, üyelerinin bilgisayarlarında yaşar ve üyeler birbirine doğrudan, şifreli bağlantılarla bağlanır.

## v1.1'de yenilikler

- **Yeni görsel kimlik:** Yeni logo ve uygulama simgesi; yüzen cam paneller, konuşurken avatardan yayılan yankı halkaları ve sahnede yüzen kontrol çubuğu.
- **Temalar:** 10 hazır tema (6'sı oyun temalı, YANKI için kodla üretilmiş özgün resimler).
  - Kendi resmini yükleyebilirsin; resminden otomatik renk paleti önerilir.
  - Karartma, bulanıklık ve panel saydamlığı ayarlanabilir.
- **Hareketli GIF:** Avatar, banner ve sunucu simgesi GIF olabilir ve uygulamada hareket eder.
- **Arkadaşlar ve özel mesajlar:**
  - Arkadaşlık isteği gönder, kabul et ya da reddet; engelleme de var.
  - Özel mesajlar yalnızca iki kişi arasında gider; üçüncü eşlere hiç gönderilmez.
  - Ortak sunucu gerekmez; arkadaş koduyla eklenir.
- **Botlar:** Yöneticiler botları açıp istedikleri kanallara ekler.
  - **Zar** (`/zar 2d6+1`): Sonuç herkes için aynıdır.
  - **Anket** (`/anket Soru | A | B`)
  - **Karşılama:** Yeni üyeleri seçilen kanalda karşılar.
  - **Müzik Çalar** (`/çal <YouTube>`, `/geç`, `/dur`): Ses kanalındaki herkes aynı şarkıyı aynı anda dinler; kuyruk desteği var.
- **Etkinlik:** Oynadığın oyun ("Valheim oynuyor") ya da Spotify / Apple Music'te çalan şarkı ("Sanatçı - Şarkı dinliyor"), uygulamanın kendi simgesiyle avatarında ve adının altında görünür.
  - Steam, Epic, GOG ve Riot oyunları klasöründen otomatik tanınır.
  - Tanınmayan oyunları kendin ekleyebilirsin.
- **Yankısız ekran paylaşımı:** Sistem sesi paylaşılırken YANKI'nın kendi çaldığı sesler (diğer konuşmacılar, müzik botu) yayından çıkarılır.
- **Daha sağlam ses bağlantısı:**
  - Çıkıp hemen geri girenlerde eski bağlantı artık takılmıyor.
  - Bağlanamayan eşler önce otomatik onarılıyor, gerekirse bağlantı sıfırdan kuruluyor.
- **Susturma göstergesi:** Hem mikrofon hem kulaklık kapalıysa iki simge birden görünür.
- **Ad:** Uygulama Görev Yöneticisi'nde ve macOS'ta "YANKI" olarak görünür.
  - v1.0 verileri (kimlik, sunucular) ilk açılışta otomatik taşınır.

## Kurulum ve çalıştırma

Gereksinim: [Node.js 22+](https://nodejs.org)

```bash
npm install
npm start
npm run start:2   # aynı bilgisayarda ikinci bir kullanıcıyla denemek için
```

## Kurulum dosyası üretme

```bash
npm run dist:win   # Windows'ta → dist/YANKI-1.1.0-win-x64.exe ve kurulumsuz .zip
npm run dist:mac   # macOS'ta  → dist/YANKI-1.1.0-mac-arm64.dmg ve mac-x64.dmg
```

İki platformu birden derlemek için projeyi GitHub'a yükle ve `v1.1.0` gibi bir etiket gönder. `.github/workflows/build.yml` iki platformu derleyip Releases sayfasında yayınlar.

## Nasıl çalışır

- **Kimlik:** Bilgisayarda üretilen bir ed25519 anahtarıdır; hesap, e-posta ya da şifre yoktur. Açık anahtar aynı zamanda arkadaş kodudur (`yanki://arkadas/…`).
- **Keşif:** Her sunucu, Hyperswarm DHT'de kendine ait bir konuya katılır. Ayrıca her kullanıcıya açık anahtarıyla doğrudan ulaşılabilir; arkadaşlık istekleri böyle iletilir.
- **Veri:** Sunucudaki her işlem, yazarınca imzalanan değişmez bir kayıttır. Durum bu kayıtlardan aynı kurallarla hesaplandığı için herkes aynı sonucu görür ve yetkisiz işlemler her eşte yok sayılır. Eski profil kayıtları (örneğin büyük GIF'ler) budanır, böylece günlük şişmez.
- **Özel alan:** Her kullanıcı çifti için yalnızca o ikisi arasında eşitlenen ayrı bir kayıt deposu vardır.
- **Botlar:** Sürekli çalışan bir bot sunucusu yoktur; botların davranışı herkesin uygulamasında aynı kurallarla hesaplanır.
  - Zar sonucu mesajın kimliğinden türetilir.
  - Müzik kuyruğunun zamanlaması kayıtlardan ve şarkı sürelerinden hesaplanır; her dinleyici YouTube'dan aynı saniyeden çalar.
- **Ses ve görüntü:** WebRTC mesh topolojisi kullanılır.
  - Her katılış yeni bir oturum kimliği alır.
  - Erken gelen ICE adayları tamponlanır.
  - Takılan bağlantılar 10 saniyede onarılmaya çalışılır, olmazsa 22 saniyede sıfırdan kurulur.

### Bilinen sınırlar

- Bir sunucunun ya da özel sohbetin yeni verisi, karşı tarafın uygulaması açıkken eşitlenir.
- Mesh topolojide her izleyiciye ayrı akış gider. 1080p60 izleyici başına yaklaşık 9 Mbps yükleme ister.
- Yankısız sistem sesi Windows'ta, Chromium'un `restrictOwnAudio` özelliğine dayanır. Sistem bunu desteklemezse ekran sessiz paylaşılır; istersen Ayarlar › Ekran Paylaşımı'ndan yine de sesli paylaşabilirsin. macOS'ta sistem sesi paylaşımı yoktur.
- Müzik Çalar YouTube gömme oynatıcısını kullanır. Sahibinin gömmeye kapattığı videolar çalmaz.
- Zar sonucu deterministiktir. Kendi uygulamasını değiştiren biri, istediği sonucu verecek bir mesaj kimliği arayabilir; bu sistem arkadaş ortamı için tasarlandı.
- Uygulama imzasız olduğu için ilk açılışta Windows ve macOS uyarı verebilir.

## Proje yapısı

```
main.js              Ana süreç: pencere, IPC, ekran paylaşımı, etkinlik, YouTube bilgisi, veri taşıma
preload.js           Arayüze güvenli API köprüsü
src/p2p/node.js      P2P düğümü: keşif, eşitleme, arkadaşlık/özel mesaj, sinyal aktarma, etkinlik
src/p2p/state.js     Kayıtlardan durum: sunucu, botlar (zar/anket/müzik), özel alan
src/activity.js      Oyun ve Spotify/Apple Music algılama
renderer/
  core.js            Ortak durum, avatarlar, modallar, resim/GIF yükleme
  app.js             Kanallar, mesajlar, sahne, ayarlar
  social.js          Arkadaşlar ve özel mesajlar
  bots.js            Bot kartları, komutlar, Müzik Çalar
  rtc.js             WebRTC ses/görüntü/ekran
  themes.js          Temalar ve resimden palet çıkarma
  themes/            Tema resimleri (özgün, telifsiz)
  assets/            Logo ve simge
test/p2p.test.js     Çok kullanıcılı çekirdek testi (npm test)
```

Veriler şu klasörlerde tutulur:
- Windows: `%APPDATA%\YANKI`
- macOS: `~/Library/Application Support/YANKI`

`p2p/identity.json` gizli anahtarındır; yedeklersen kimliğini başka bilgisayara taşıyabilirsin.
