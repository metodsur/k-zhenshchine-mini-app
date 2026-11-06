# к Женщине — Telegram Mini App prototype

Временная кликабельная сборка на основе 11 последних утверждённых дизайн-макетов.
Изображения вставлены без перерисовки. Позже экраны заменяются адаптивной вёрсткой в едином эталонном стиле.

Навигация: Пространство / Путь / Встречи / Я. Дополнительные экраны доступны через временный переключатель справа сверху.
Deploy 16.09.2026

## Удалённое открытие практик (прототип)

Функция закрыта по умолчанию и доступна только Telegram ID, заданному в серверной переменной `PRACTICE_REMOTE_OWNER_ID`. Это должен быть числовой Telegram ID владелицы; не указывайте его во frontend и не коммитьте секреты. Для работы требуются настроенное хранилище Valkey/Redis и Telegram Bot Token, уже используемые приложением. Пока переменная не задана, управление выключено. Production/Timeweb в рамках разработки не менялись.

На странице `/practice` в Telegram Mini App владельца появится переключатель приёма команд на этом устройстве. Разрешённые назначения: `/practice`, `/integrity`, `/accept`, `/abundance`, `/mirror`. Включение выдаёт случайный токен этому браузеру; токен хранится только в его `localStorage`, передаётся опросом в заголовке Authorization и не попадает в журнал. Сессия действует ровно 30 минут после включения (опрос не продлевает её). Выключение отзывает токен и ожидающую команду.

Команды отправляются в `POST /api/practice-remote` с `action: "command"`, `deviceId`, UUID `requestId`, одним из перечисленных `path` и свежим подписанным Telegram `initData` владельца (не старше 5 минут). Для проверки в DevTools Telegram Desktop можно прочитать `deviceId` из `localStorage.getItem('kz.practiceRemote.v1')`, затем на другой разрешённой странице открыть Console и выполнить, подставив значение ID:

```js
fetch('/api/practice-remote', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'command',
    initData: Telegram.WebApp.initData,
    deviceId: JSON.parse(localStorage.getItem('kz.practiceRemote.v1')).deviceId,
    requestId: crypto.randomUUID(),
    path: '/practice'
  })
}).then(r => r.json()).then(console.log)
```

Для первого теста откройте `/practice` в Telegram Desktop, включите переключатель, перейдите на `/integrity` и выполните команду выше: уже открытая вкладка должна сама перейти на `/practice`. Этот прототип не запускает Telegram Desktop извне, не открывает приложение, если оно закрыто, и пока не интегрирован с голосовым чатом ChatGPT; он управляет только уже открытой Mini App-вкладкой. Перед включением в production требуется отдельная настройка владельческого ID и одобрение публикации.

Проверки прототипа: `node --test tests/practice-remote.test.js`; полный регресс: `npm test`.
