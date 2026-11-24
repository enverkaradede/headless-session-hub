# Changelog

## Yayınlanmamış

- `/` menüsü: Yeni Oturum'da `/` yazınca Claude'un komutları ile bu cihazın ve bağlı cihazların skill'leri listelenir; her satırın sağında skill'in hangi cihazda olduğu yazar. Bir cihazın skill'ini seçmek oturumu o cihaza ve profile sabitler. Açık bir oturumun mesaj kutusunda da çalışır; orada sadece o oturumun cihazı, profili ve proje klasörü kullanılır.
- Session Hub'ın kendi başlattığı Claude süreçleri, genel kurulu hook'lar yüzünden listede ikinci kez `claude -p` oturumu olarak görünmüyor.

- Mesaj kutusu artık hiç kilitlenmiyor. Soru ya da izin kartı açıkken yazılan mesaj o kartı cevaplar (Claude metni cevap olarak alır). Harici `claude -p` süreci çalışırken yazılan mesajlar sıraya girer, süreç bitince oturum onlarla devam eder. Sıradaki mesajlar mesaj kutusunun üstünde görünür ve temizlenebilir.

## 0.1.0 — 2026-11-24

- İlk sürüm: headless Claude Code oturumları, soru/izin kartları, defer/resume, claude -p uyumluluğu, yerel API ve hubctl, webhook'lar, P2P cihaz eşleştirme (salt okunur / operatör / tam yetkili), subagent konuşma görünümü, otomatik güncelleme.
