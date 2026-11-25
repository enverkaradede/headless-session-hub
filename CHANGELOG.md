# Changelog

## 0.1.0 — 2026-11-25

İlk sürüm.

- Claude Code oturumlarını arka planda başlat, sohbet gibi izle, mesaj gönder, durdur ve kaldığı yerden devam ettir.
- Claude'un soruları ve izin istekleri kart olarak gelir; seçenekli, çoklu seçimli ya da serbest metinle cevaplanır. Cevap gecikirse oturum ertelenir ve cevap verince geçmişiyle birlikte devam eder.
- Mesaj kutusu hiç kilitlenmez. Kart açıkken yazdığın mesaj o kartı cevaplar. Harici bir `claude -p` süreci çalışırken yazdıkların sıraya girer ve süreç bitince gönderilir.
- `/` menüsü: Claude'un komutları ile bu cihazın ve bağlı cihazların skill'leri tek listede. Her satır skill'in hangi cihazda olduğunu gösterir; bir cihazın skill'ini seçmek oturumu o cihaza ve profile sabitler.
- Varsayılan çalışma modu "Otomatik": güvenli adımlar sorulmadan yapılır, riskliler sorulur. Ayarlar → Davranış'tan ve oturum çalışırken değiştirilebilir; model de öyle.
- Mevcut `claude -p` betikleri hook'lar ya da `hubctl run` ile listede görünür; düz metinle sorulan sorular algılanır ve cevaplanabilir.
- Alt ajanların (subagent) çalışması ayrı bir konuşma penceresinde canlı izlenir.
- Cihazlar arası eşleştirme (P2P): her cihaz kendi oturumlarını yönetir; eşleşen cihaza salt okunur, operatör ya da tam yetki verilir.
- Yerel API, `hubctl` komut satırı ve imzalı webhook'lar ile entegrasyon.
- Kullanım limiti koruması: abonelikten API anahtarına asla kendiliğinden geçilmez; limit dolunca oturum durur ve kararını bekler.
- İmzalı otomatik güncelleme (depo herkese açık olduğunda çalışır).
