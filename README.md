# Yankı

Merkezi sunucusuz, eşler arası (P2P) topluluk ve haberleşme uygulaması. Windows ve macOS için.

Discord benzeri bir deneyim sunar: sunucular, kategoriler, metin ve ses kanalları, profiller. Ancak hiçbir veri bir şirketin sunucusunda durmaz. Topluluk, üyelerinin bilgisayarlarında yaşar ve üyeler birbirine doğrudan, şifreli bağlantılarla bağlanır.

## Özellikler

**Sunucu ve kanallar**
- Tek sunucu içinde kategoriler, metin kanalları (`#genel`) ve ses kanalları (`🔊 Sesli Sohbet`)
- Kanal konusu, kullanıcı sınırı, kategori sıralama, daraltma
- Sunucu simgesi, bannerı ve açıklaması
- Davet kodu ile katılım (`yanki://…`)
- Roller: Sahip, Yönetici, Üye. Atma, yasaklama, yasak kaldırma

**Mesajlaşma**
- Markdown: **kalın**, *italik*, ~~üstü çizili~~, `kod`, kod blokları, ||spoiler||, > alıntı
- Resim paylaşımı: dosya seçme, yapıştırma (Ctrl+V), sürükle-bırak (otomatik küçültme, GIF korunur)
- YouTube bağlantıları tıkla-oynat şeklinde gömülür. Diğer bağlantılar için başlık ve görsel önizlemesi
- Yanıtlama, düzenleme (↑ tuşu son mesajı düzenler), silme, emoji tepkileri, sabitleme
- @bahsetme, "yazıyor…" göstergesi, okunmamış işaretleri, masaüstü bildirimleri
- Kanal içi arama, Ctrl/⌘+K ile hızlı kanal geçişi

**Ses, görüntü ve ekran**
- Sesli sohbet: gürültü bastırma, yankı engelleme, konuşma göstergesi, kişi başı ses düzeyi
- Kamera (720p)
- Ekran veya tek pencere paylaşımı: **1080p 30/60 FPS** (720p seçeneği de var). Windows'ta sistem sesi de paylaşılabilir
- Sahne görünümü: ızgara, odaklama, tam ekran
- Sustur/sağırlaştır kısayolları: Ctrl/⌘+Shift+M ve Ctrl/⌘+Shift+D

**Profil**
- Görünen ad, avatar, banner, biyografi (markdown), durum mesajı, zamirler, profil rengi
- Profil değişiklikleri tüm sunuculara anında yayılır

## Kurulum ve çalıştırma

Gereksinim: [Node.js 20+](https://nodejs.org)

```bash
npm install
npm start
```

Aynı bilgisayarda ikinci bir kullanıcıyla denemek için ikinci bir terminalde:

```bash
npm run start:2
```

Birinci pencerede bir sunucu oluşturun. Sunucu menüsünden **Davet kodunu kopyala** deyin ve ikinci penceredeki **+ › Davet koduyla katıl** alanına yapıştırın.

## Kurulum dosyası üretme

```bash
npm run dist:win   # Windows'ta → dist/Yanki-1.0.0-win-x64.exe
npm run dist:mac   # macOS'ta  → dist/Yanki-1.0.0-mac-arm64.dmg ve x64
```

Her platformun paketi kendi işletim sisteminde derlenmelidir. İki platform için birden derlemenin en kolay yolu, projeyi GitHub'a yükleyip `.github/workflows/build.yml` iş akışını çalıştırmaktır (Actions › Derle › Run workflow).

**macOS notları**
- İmzasız derlemeyi ilk açışta sağ tık › Aç ile başlatın. Dağıtım için Apple Developer sertifikasıyla imzalayıp notarize edin.
- İlk ekran paylaşımında *Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı* altından Yankı'ya izin verin ve uygulamayı yeniden başlatın.

## Nasıl çalışır

```
┌──────────┐   Hyperswarm DHT (keşif + NAT delme)   ┌──────────┐
│ Kullanıcı│◄──────────────────────────────────────►│ Kullanıcı│
│    A     │   Noise ile şifreli eş bağlantısı      │    B     │
│          │   • imzalı olay günlüğü eşitleme       │          │
│          │   • geçici sinyaller (ses, yazıyor)    │          │
│          │   • WebRTC sinyalleşmesi               │          │
│          │◄══════ WebRTC (DTLS-SRTP) ════════════►│          │
└──────────┘   ses / kamera / 1080p ekran           └──────────┘
```

- **Kimlik.** İlk açılışta bilgisayarda bir ed25519 anahtar çifti üretilir. Hesap, e-posta ya da şifre yoktur. Açık anahtar kimliğinizdir.
- **Keşif.** Her sunucu, kimliğinden türetilen bir konu (topic) ile Hyperswarm DHT'sine katılır. Aynı konudaki eşler birbirini bulur ve UDP hole-punching ile doğrudan bağlanır.
- **Veri.** Sunucudaki her şey (kanal oluşturma, mesaj, profil, rol, yasak) yazarınca imzalanan değişmez bir *op* olarak kaydedilir. Eşler bağlandığında elindeki op kimliklerini karşılaştırır ve eksikleri gönderir. Her üye, sunucunun tam bir kopyasını tutar. Durum, op'lardan deterministik olarak hesaplanır. Bu yüzden herkes aynı sonucu görür ve yetkisiz işlemler (örneğin yönetici olmayanın kanal oluşturması) her eşte yok sayılır.
- **Aktarma.** İki eş doğrudan bağlanamazsa, ikisine de bağlı üçüncü bir eş mesajları ve WebRTC sinyallerini iletir.
- **Gizlilik.** Eşler tanışırken sunucu kimliklerini çifte özgü özetlerle gönderir. Böylece karşı taraf, kendisinin üyesi olmadığı sunucuları öğrenemez.
- **Ses ve görüntü.** WebRTC mesh topolojisi kullanılır. NAT adresini öğrenmek için yalnızca halka açık STUN sunucuları kullanılır, içerik bunlardan geçmez. Çok katı ağlarda Ayarlar › Ağ altından kendi TURN sunucunuz eklenebilir.

### Sınırlar (mimarinin doğası gereği)

- Bir sunucunun verisi ancak en az bir üyesi çevrimiçiyken yeni katılanlara aktarılabilir. Hiç kimse çevrimiçi değilse, gönderilen mesaj ilk kim gelirse ona eşitlenir.
- Mesh topolojide her izleyici için ayrı bir akış yüklenir. 1080p60 ekran paylaşımı izleyici başına yaklaşık 9 Mbps yükleme ister. Ses kanallarının ~8–10 kişiye kadar rahat çalışması beklenir.
- Silme işlemleri "işaretleme" olarak çalışır. Arayüzden kalkar ama eşlerin diskindeki imzalı günlükte kalır.
- Sunucu sahipliği devredilemez.

## Proje yapısı

```
main.js              Electron ana süreç: pencere, IPC, ekran kaynakları, bağlantı önizleme, bildirimler
preload.js           Arayüze güvenli API köprüsü (contextIsolation + sandbox)
src/p2p/identity.js  ed25519 kimlik (Node yerleşik kripto) + Hyperswarm anahtarı
src/p2p/node.js      P2P düğümü: eş keşfi, op günlüğü, eşitleme, geçici mesajlar, sinyal aktarma
src/p2p/state.js     Op günlüğünden sunucu durumunu türetme + yetki kuralları
renderer/            Arayüz (bağımlılıksız HTML/CSS/JS)
  app.js             Kanallar, mesajlar, profiller, ayarlar, modallar
  rtc.js             WebRTC sesli/görüntülü sohbet ve ekran paylaşımı
test/p2p.test.js     P2P çekirdeğinin çok düğümlü testi (npm test)
```

Kullanıcı verileri şurada tutulur:
- Windows: `%APPDATA%\Yankı\p2p`
- macOS: `~/Library/Application Support/Yankı/p2p`

`identity.json` dosyası gizli anahtarınızdır. Yedeklerseniz kimliğinizi başka bilgisayara taşıyabilirsiniz.
