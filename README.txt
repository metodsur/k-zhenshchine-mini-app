ONBOARDING READY — к Женщине

Цепочка:
1. index.html → Telegram-канал https://t.me/k_zhenshcine
2. welcome-personal-telegram-ready.html → welcome-mission.html
3. welcome-mission.html → welcome-rituals.html
4. welcome-rituals.html → space.html

Оптимизация:
- встроенные PNG вынесены в WebP;
- общий вес HTML резко уменьшен;
- второстепенные изображения lazy + async decode;
- ключевое первое изображение получает fetchpriority=high;
- персонализированная страница сохраняет Telegram initData/auth и approved hero WebP;
- дизайн/тексты не перерабатывались.

Важно: перед production-переключением текущую страницу «Пространство» нужно сохранить как space.html, чтобы index.html мог стать стартовой страницей.
