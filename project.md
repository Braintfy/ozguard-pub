# OZGuard — Chrome Extension для мониторинга конкурентов на OZON

## Назначение

Chrome-расширение (Manifest V3) для продавцов OZON. Позволяет по артикулу (SKU) товара найти всех конкурентов — других продавцов, торгующих тем же товаром. Аналог функционала Telegram-бота @textophotdawick_bot, но в виде браузерного расширения.

## Стек

- **Chrome Extension Manifest V3**
- Vanilla JS (без фреймворков)
- Service Worker (background) + Content Scripts (interceptor + support-automation) + Popup UI

## Файловая структура

```
ozguard/
├── manifest.json                 # Конфигурация расширения v3
├── background/
│   └── service-worker.js         # Оркестратор: сканирование, API, парсинг, история, лицензия, жалобы
├── popup/
│   ├── popup.html                # UI — 4 таба + модальное окно истории
│   ├── popup.js                  # Логика UI: ввод, прогресс, рендер, экспорт, paywall, жалобы
│   └── popup.css                 # Светлая тема, PRO/FREE бейджи
├── content/
│   ├── interceptor.js            # Content script (MAIN world) — перехват fetch/XHR к API OZON
│   ├── scan-panel.js             # Плавающая панель прогресса сканирования на ozon.ru
│   └── support-automation.js     # Content script для seller.ozon.ru — парсер чатов, автоматизация жалоб
├── assets/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── _locales/ru/messages.json     # Локализация
├── logo.svg                      # Исходник иконки
├── m1.md                         # Техническая инструкция по API OZON (референс)
├── ozguard.md                    # Исходный промпт v1.0 (архив)
├── project.md                    # Этот файл — актуальная документация
├── CHANGELOG.md                  # История версий
├── tariff-migration-guide.md     # Инструкция по миграции тарифов для серверной части и сайта
├── user-guide.md                 # Инструкция пользователя для интеграции на сайт
├── deploy-guide.md               # Инструкция по деплою
└── .mcp.json                     # MCP-серверы (context7, pubmed, supabase)
```

## Архитектура

### Popup UI — 4 таба

**Сканирование**:
- Textarea для ввода SKU (по одному на строку)
- Переключатель режима: ⚡ Быстрый (API-only, без окна) / 🐢 Медленный (визуальный, имитация пользователя)
- Кнопки: Найти / Пауза / Стоп
- Прогресс-бар (X/N SKU, процент)
- Результаты: группировка по SKU, ссылки на карточки/продавцов, цены
- Кнопка копирования SKU + ссылка на OZON рядом с каждым SKU
- Sticky export buttons над результатами: Скопировать / SKU / Excel / В жалобы / Очистить
- Batch-зона: drag-n-drop XLSX «Цены товаров» из OZON (бесплатно), фильтр по статусам
- Плавающая панель `scan-panel.js` на ozon.ru: прогресс, Пауза/Стоп, drag, лог
- Сворачиваемый лог с таймстемпами

**История**:
- Последние 10 сессий (дата, кол-во SKU, найдено конкурентов)
- Карточки с кнопками: Excel / Детали / Удалить
- Кнопка «В жалобы» на каждой карточке (если есть SKU конкурентов)
- Модальное окно деталей: таблица (SKU конк. / Продавец / Цена), кнопки копирования, переключение на логи

**Настройки**:
- Лицензия PRO + кнопка «Купить PRO» (ссылка на codefic.ru/#pricing)
- Пробный период (7 дней) — кнопка «Попробовать PRO бесплатно»
- Исключения при сборе (textarea, по одному на строку)
- Задержка между запросами (мс)

**Жалобы** (PRO):
- Textarea для артикулов (по одному на строку) + предупреждения при 20+/50+ SKU
- Импорт CSV из истории сканирования (кнопка «Импорт из Excel»)
- Выбор режима: Автоматический / Тестовый (dry run)
- Выбор типа жалобы: Нарушение правил продавцом / Жалоба от бренда
- Drag-n-drop зона для файлов-доказательств
- Кнопки: Начать / Пауза / Стоп
- Умная проверка seller.ozon.ru перед запуском (жёлтый блок ошибки + кликабельная ссылка)
- Полная автономия: бот сам отправляет артикулы, файлы, ждёт результат
- Статус-карточка с подсказками
- Визуальная очередь SKU со статусами
- Прогресс-бар и сворачиваемый лог
- Кнопка «В жалобы» в разделе Сканирование — передаёт SKU конкурентов

### Поток подачи жалоб

```
1. Пользователь вводит артикулы (или нажимает «В жалобы» из Сканирования)
2. Выбирает режим (тестовый / пошаговый) → «Начать»
3. Paywall: требуется PRO-лицензия
4. Service Worker находит вкладку seller.ozon.ru
5. Автопереход на /app/messenger/?group=support_v2 + инжект content script
6. Коммуникация: chrome.tabs.sendMessage → bridge (ISOLATED) → postMessage → MAIN world
7. Навигация по дереву чата (автоматически):
   Поддержка → Новое обращение → Личный кабинет →
   Кабинет бренда → Жалоба на товар → Плагиат (brand) или
   Качество → Нарушение правил (seller)
8. Цикл для каждого артикула (полностью автоматически):
   Ввод артикула → Прикрепление + отправка файла → Ожидание ответа →
   «Пожаловаться на другой товар» → следующий артикул
9. Smart Self-Correction: stale state detection, SKU verification, phase transition check
10. Лимит новых обращений не ставит ручной gate: бот продолжает большие пакеты с антибот-паузами
11. При неизвестном состоянии DOM — автоматическая остановка
12. Результаты + сессия сохраняются в chrome.storage.local
```

### Поток сканирования

**Два режима**: ⚡ Быстрый (по умолчанию) и 🐢 Медленный (fallback)

```
⚡ Быстрый режим (API-only):
1. Пользователь вводит SKU → «Найти конкурентов»
2. Paywall снят с v5.9.8: любое количество SKU — бесплатно
3. Service Worker находит существующую вкладку ozon.ru (или создаёт скрытый таб)
4. Для каждого SKU:
   a. fetchProductDataDirect() — прямой fetch к API из контекста страницы:
      /api/entrypoint-api.bx/page/json/v2?url=/product/{sku}/
      Fallback: search API → поиск ссылки → запрос найденного товара
   b. parseMainPageSellers() → webBestSeller (count, modalLink)
   c. fetchSellersListDirect() → modal API → parseSellersFromModalData()
   d. Фильтрация по excludeSellers[]
   e. Задержка 600мс между SKU, антибот-пауза 3-8с каждые 20 SKU
5. Если API не отвечает 3 раза подряд → автоматический fallback на медленный режим
6. Результаты → popup + история

🐢 Медленный режим (визуальный):
1-2. Аналогично быстрому
3. Service Worker создаёт отдельное окно (chrome.windows.create)
4. Инжект scan-panel.js после каждой навигации
5. Для каждого SKU:
   a. Навигация → ozon.ru/search/?text={sku}
   b. findProductOnPage() → SPA-клик → SKU mismatch detection
   c. API-запрос из контекста страницы + fallback (XHR, React Fiber, DOM)
   d. modal endpoint → parseSellersFromModalData()
   e. humanDelay() ±30%, simulateHumanBehavior(), пауза каждые 20 SKU
6. Результаты → popup + история
7. Рабочее окно закрывается
```

### Ключевые API OZON

| Endpoint | Назначение | Ключевые данные |
|----------|------------|-----------------|
| `/api/entrypoint-api.bx/page/json/v2?url=/product/{slug}/` | Страница товара | `widgetStates` (80+ виджетов): `webBestSeller` (count, modalLink), `webCurrentSeller` |
| `/api/entrypoint-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id={id}` | Список продавцов | `webSellerList` → `sellers[]`: `{ sku, id, name, link, price, productLink, credentials }` |

### Обход ограничений OZON

| Проблема | Решение |
|----------|---------|
| 403 при прямых запросах | `chrome.scripting.executeScript({ world: 'MAIN' })` — запрос из контекста страницы |
| Отсутствие заголовка | `x-o3-app-name: ozonapp_web` обязателен |
| SKU ≠ Product ID в URL | Поиск через `ozon.ru/search`, потом SPA-навигация |
| Фоновые вкладки → мин. контент | Быстрый режим: скрытый таб + прямые API. Медленный: отдельное окно |
| Список продавцов не на главной | Отдельный запрос к modal endpoint |
| Антибот | `humanDelay()` ±30% джиттер, `simulateHumanBehavior()` (скролл, мышь), пауза каждые 20 SKU |
| Поиск показывает чужой товар | `findProductOnPage()` приоритизирует ссылки с SKU, post-nav проверка URL |

### Content Script: interceptor.js

- Инжектится в `world: MAIN` при `document_start` на `www.ozon.ru`
- Перехватывает `window.fetch` и `XMLHttpRequest` к API OZON
- Мержит `widgetStates` из всех ответов в `window.__ozguard`
- Используется как fallback-источник данных

### Content Script: scan-panel.js (ISOLATED world)

- Инжектится ПРОГРАММНО через `chrome.scripting.executeScript()` после каждой навигации при сканировании
- Плавающая панель прогресса на ozon.ru: текущий SKU, X/N, процент
- Кнопки Пауза / Стоп / Закрыть
- Drag-перетаскивание по экрану
- Лог сканирования в реальном времени
- Сворачивание/разворачивание панели

### Content Script: support-automation.js (ISOLATED world)

- Инжектится ПРОГРАММНО через `chrome.scripting.executeScript()` — НЕ через manifest
- ISOLATED world — прямая коммуникация через `chrome.runtime.onMessage` (без bridge)
- Поиск элементов по ТЕКСТУ и позиции viewport (не по CSS-классам)
- `simulateRealClick()` — полная цепочка React 17+ событий (PointerEvents + MouseEvents)
- `setInputValue()` — ввод через native prototype setter (обход React proxy)
- `findQuickReplyButtons()` — фильтрация по viewport (правая половина = чат, не сайдбар)
- `detectPhase()` — определение состояния по тексту сообщений и кнопок
- `getMessageText()` — извлечение текста без quick-reply кнопок (фильтр по размеру/структуре)
- Retry-логика: 5-8 попыток при поиске элементов (DOM может быть не готов)
- Guard от двойной инъекции: DOM-элемент `#__ozguard-support-guard`
- Плавающая панель прогресса: drag, close, сворачивание, лог в реальном времени

### Smart Self-Correction System (service-worker.js)

Интеллектуальная самокоррекция бота жалоб:

| Механизм | Что делает |
|----------|------------|
| Stale state detection | Если новый SKU видит `ready_for_next` — кликает кнопку цикла (до 3 попыток), не помечает SKU как обработанный |
| SKU verification | Перед пометкой «done» проверяет, что бот упомянул текущий артикул в ответе |
| Phase transition check | После клика навигации верифицирует смену фазы, добавляет ожидание если нет |
| Loop guard bypass | Стандартная защита от зацикливания пропускается для случаев, управляемых smart handler |
| `[SMART]` logging | Все действия самокоррекции логируются с префиксом для диагностики |

## Монетизация (Paywall)

### Модель FREE / PRO

| Функция | FREE | PRO |
|---------|------|-----|
| Одиночная проверка SKU (1 шт) | + | + |
| Множественная проверка (2+ SKU) | + | + |
| Пакетный XLSX импорт | + | + |
| Скачивание / копирование / экспорт | + | + |
| История сессий | + | + |
| Автоматическая подача жалоб (2 режима) | — | + |

**Бесплатно — весь функционал сбора конкурентов**. PRO-подписка нужна только для бота автоматической подачи жалоб в чат поддержки OZON. Изменение с v5.9.8 — ранее множественный скан и XLSX-импорт были PRO.

### Система лицензий

- **Формат кода**: `OZG-XXXXX-XXXXX-XXXXX`
- **Типы**: месячная подписка / годовая подписка / вечный доступ (легаси, не продаётся)
- **Валидация**: серверная через `POST /api/license` с `{action, key, fingerprint}` (codefic.ru)
- **Device fingerprint**: UUID в `chrome.storage.sync` (переживает переустановку, привязка к аккаунту браузера)
- **Хранение**: `chrome.storage.local` → `licenseCode`, `licenseType`, `licenseExpiresAt`, `licenseVerifiedAt`, `licenseActivatedAt`
- **Периодическая проверка**: `chrome.alarms` каждые 12ч + при старте SW. Offline grace period 7 дней
- **Проверки**: popup.js (UI-блокировка) + service-worker.js (серверная валидация)
- **UI**: секция в Настройках — ввод кода, автоформат, PRO/FREE бейдж, тип лицензии (Годовая/Месячная/Вечная-легаси), счётчик дней

### Пробный период (Trial)

- 7 дней PRO бесплатно, привязка к device fingerprint
- **API**: `trial_activate` — `POST /api/license { action: "trial_activate", fingerprint }`, `trial_validate` — проверка при каждом открытии
- Один триал на устройство навсегда (серверная привязка к fingerprint)
- 4 состояния: `FREE` / `TRIAL` / `PRO` / `TRIAL_EXPIRED`
- Кеширование в `chrome.storage.local`: `trialStatus`, `trialExpiresAt`, `trialCheckedAt`
- UI: оранжевый бейдж TRIAL в header, обратный отсчёт дней, после истечения — блок «Пробный период закончился» + CTA «Купить PRO»

## Хранение данных (chrome.storage.local)

| Ключ | Тип | Описание |
|------|-----|----------|
| `scanHistory` | Array (макс 10) | Сессии сканирования: id, date, skus, results, logs |
| `excludeSellers` | Array | Список имён продавцов для исключения из результатов (частичное совпадение) |
| `delayMs` | Number | Задержка между SKU (по умолчанию 2000 мс) |
| `licenseCode` | String | Код PRO-лицензии |
| `licenseType` | String | Тип: `monthly`, `yearly` или `lifetime` (легаси) |
| `licenseExpiresAt` | String (ISO) / null | Дата истечения (monthly/yearly) или null (lifetime-легаси) |
| `licenseVerifiedAt` | String (ISO) | Последняя успешная серверная проверка |
| `licenseActivatedAt` | String (ISO) | Дата активации лицензии |
| `licenseLastError` | Object / null | v5.9.17: `{code, message, at}` — детали последней ошибки активации/верификации для popup-диагностики |
| `lastScanResults` | Array | Результаты последнего скана (восстановление сессии при переоткрытии popup) |
| `lastScanLogs` | Array | Логи последнего скана |
| `supportHistory` | Array (макс 10) | Сессии жалоб: id, mode, queue, logs |
| `lastComplaintSession` | Object | Текущая сессия жалоб: skus, mode, complaintType, logs, fileNames |
| `trialStatus` | String | Статус триала: `active` / `expired` / `none` |
| `trialExpiresAt` | String (ISO) | Дата окончания пробного периода |
| `trialCheckedAt` | Number (timestamp) | Последняя серверная проверка триала |
| `lastActiveTab` | String | Имя последней открытой вкладки |
| `complaintExcludeSellers` | Array | v5.9.19: пользовательский blacklist магазинов для жалоб (доп. к Ozon-дефолту) |
| `ozonBlacklistDisabled` | Boolean | v5.9.19: отключить дефолтный Ozon-blacklist при «В жалобы» |
| `complaintSkuFiles` | Object | Per-SKU файлы (sku_first режим): `{parentSku: [{id, name, type, size, storage}]}` |
| `complaintSkuFilesBlobs` | Object | Мелкие base64-блобы для sku_first режима: `{id: base64}` |
| `evidenceMode` | String | v5.9.20: `'sku_first'` (default) / `'file_first'` |
| `complaintFileSkus` | Array | v5.9.20: file_first режим — `[{id, name, type, size, storage, skus[]}]` |
| `complaintFileSkusBlobs` | Object | v5.9.20: мелкие base64 для file_first режима |
| `dismissedHints` | Object | Скрытые крестиком подсказки: `{key: true}` |

## Экспорт данных

| Формат | Описание |
|--------|----------|
| CSV (Excel) | BOM + разделитель `;`: Мой SKU, Название, SKU конк., ID продавца, Продавец, Цена, Ссылка |
| Копировать | Текстовый формат в буфер обмена |
| Только SKU | Уникальные SKU конкурентов — по одному на строку |

## Пакетный импорт (бесплатно)

- Загрузка XLSX шаблона «Цены товаров» из OZON
- Встроенный ZIP+XML парсер (без внешних зависимостей)
- Извлечение из строк 4+: B=SKU, C=Название, D=Статус
- Фильтр по статусам: чекбоксы (Продается, Готов к продаже, Не продается) + кнопки «Все» / «Применить»
- Поддержка sharedStrings и deflate
- Предупреждения: 100+ SKU → рекомендация задержки, 1000+ → оценка времени
- Антибот: доп. пауза 10-20 сек каждые 20 SKU при 50+ товарах

## Версионирование

См. [CHANGELOG.md](CHANGELOG.md) (технический) и [CHANGELOG-USER.md](CHANGELOG-USER.md) (для клиентов, на codefic.ru).

Текущая версия: **5.9.32**

## Бот жалоб — фазы навигации (актуально на 5.9.32)

Детектор фаз в `content/support-automation.js` → `detectPhase()` возвращает `{phase, buttons, hasInput, detail?}`:

| Фаза | Триггер (lastBot.text) | Действие в service-worker |
|------|------------------------|---------------------------|
| `direction_selection` | кнопки «Личный кабинет» / «Товары и Цены» (BETA) | клик нужной по `complaintType` |
| `category_selection` | «Кабинет бренда» / «Контроль качества» | клик |
| `complaint_type` | «Жалоба на товар» / «Нарушение правил площадки» | клик |
| `complaint_subtype` | «Плагиат» / прямой переход | клик |
| `complaint_detail` | «Использование моих фото, видео, текста» / «Использование моего бренда» | клик |
| `waiting_parent_article` | v5.9.32: «вашего товара» + «карточку использовал» / «пришлите sku вашего» | sendText(item.parentSkus[item._parentTryIdx]); если у item нет parent → `failed` |
| `waiting_parent_article` `+ detail: not_found` | v5.9.32: «не нашли товар … в вашем магазине», «не нашли товар с … проверьте значение» | пробуем следующий из `item.parentSkus`; если исчерпаны → `failed` с диагностикой |
| `waiting_article` | «перейдите в карточку товара», «хотите пожаловаться», «скопируйте значение», «введите артикул» | sendText(item.sku) — SKU нарушителя |
| `waiting_attachment` | «доказательств», «правообладател» | attachFile(picked.files) — все на первом проходе |
| `waiting_attachment` `+ detail: evidence_insufficient` | v5.9.27: «доказательств недостаточно», «недостаточно для подтверждения ваших авторских прав», «авторские права не подтвержд…» | attachFile(picked.files[item._evidenceUsedIdx]) — следующий файл; для `content_beta` после исчерпания файлов допускаются 2 контрольных повтора последнего файла, затем SKU `failed`, сброс фазы и восстановление страницы чатов для следующего SKU |
| `in_progress` | «обрабатываю», «проверяю», или последнее сообщение от юзера | wait + reverify |
| `chat_escalated` | «направил ваше обращение», «создайте новое обращение», кнопка «Отменить обращение» | оставляем чат, открываем новый для следующего SKU |
| `item_completed` | «скрыли товар», «нарушение подтвердилось» | next SKU |
| `ready_for_next` | кнопка «пожаловаться на другой» | clickNewChat |
| `no_chat` | пусто | проверяем session/auth |
| `faq_page` | tippy-popup «Не нашли ответ» | clickFaqButton |

## Бот жалоб — этап parent SKU v5.9.32

Ozon добавил новый промежуточный шаг между «Использование моих фото, видео, текста» и запросом SKU нарушителя:

1. Бот: «Пришлите SKU **вашего товара**, чью карточку использовал другой продавец» → бот шлёт `item.parentSku`.
2. Если Ozon не нашёл его в магазине: «Не нашли товар с SKU X в вашем магазине. Проверьте значение и отправьте его снова» → бот пробует следующего родителя из `item.parentSkus[]`.
3. Если все родители исчерпаны → SKU `failed` с диагностикой «Ozon не нашёл ни один parent SKU в вашем магазине».
4. Если у `item` вообще нет `parentSku`/`parentSkus` (ручной список SKU без сканирования) → SKU `failed` с подсказкой использовать «В жалобы» из вкладки Сканирование.
5. После успеха: «Перейдите в карточку товара, на которую хотите пожаловаться» → бот шлёт `item.sku` (SKU нарушителя). Дальше как раньше — файл-доказательство.

Этап актуален для `plagiat_legacy` и `content_beta`. Для `brand_beta` Ozon обычно его пропускает, но детектор сработает корректно если этап появится.

`item.step`-машина: `null → parent_sent → article_sent → file_sent → completed`. `_parentTryIdx` хранит индекс текущего пробуемого родителя, сохраняется в `activeSupportSession` и сбрасывается в `resetSupportItemTransientState`.

## Бот жалоб — защита от изменения интерфейса Ozon v5.9.32

Раньше при пропадании ожидаемой кнопки (`handleNavPhase` retry 3 раза) бот делал `delay+continue` и ждал, пока сработает обычный loop guard с менее понятным «Зацикливание на фазе X».

Теперь:
- `handleNavPhase` после 3 неудачных проверок наличия кнопки в меню — ставит паузу + шлёт `supportNeedAction` с явным сообщением «Похоже, Ozon изменил интерфейс жалоб: на шаге X нет кнопки Y. Видимые кнопки: …».
- Loop guard для фаз `unknown` / `has_buttons` / `no_chat` / `faq_page` / `input_ready`: после `maxPhaseRepeats` (4) повторов пишет `[INTERFACE-CHANGE]`-блок с видимыми кнопками + последним сообщением Ozon, помечает SKU `failed` и просит проверить чат вручную или написать в `t.me/firadex`.
- Все остальные фазы по-прежнему попадают в стандартное «Зацикливание на фазе X».

## Режимы доказательств v5.9.20

- **`evidenceMode = 'sku_first'`** (default): `pickFilesForItem(item)` берёт `supportState.skuFiles[parentSku]`, объединяет со всех parent-ов с дедупом по `name+size`. Fallback к `supportState.files` (общий пул).
- **`evidenceMode = 'file_first'`**: `pickFilesForItem(item)` итерирует `supportState.fileSkus = [{id, name, type, size, storage, source, skus[]}]`, включает файл если **хотя бы один** parent-SKU из item совпадает с `file.skus`. Fallback к `supportState.files`.

С v5.9.24 `supportStart` передаёт в service worker только lightweight-метаданные файлов (`id/name/type/size/storage/source`), без `base64`. Base64 читается лениво перед конкретным `attachFile`: local-файлы из `chrome.storage.local.*Blobs`, IDB-файлы из extension IndexedDB в service worker, с fallback через popup action `getComplaintFilePayload`. Это защищает большие пакеты жалоб от ошибки сериализации `runtime.sendMessage`.

Storage обоих режимов **независим** — `chrome.storage.local.set({k:v})` это update указанных ключей, не replace storage. Переключение `evidenceMode` не теряет файлы другого режима. Storage переживает обновления той же установки расширения. Если пользователь загружает новую распакованную папку и Chrome выдаёт другой extension ID, это новая установка: старые IndexedDB/chrome.storage данные недоступны, popup покажет диагностику и попросит загрузить доказательства заново.

`item._evidenceUsedIdx` — счётчик отправленных файлов внутри одного SKU. Инкрементируется при verified attach. На повторном `evidence_insufficient` берётся файл с `[item._evidenceUsedIdx]`. Когда индекс `>= picked.files.length` → SKU `failed` с `error: 'Бот запросил доп. доказательства, но файлы исчерпаны'`. Для `content_beta` есть два контрольных повтора последнего файла; следующий повторный отказ Ozon переводит SKU в `failed`, сбрасывает фазу и продолжает очередь.

Для крупных доказательств окно верификации появления файла в чате динамическое: обычные файлы — 15с, крупные — 30с, 10+ MB — 60с, 50+ MB — 90с. Ожидание остаётся прерываемым через Пауза/Стоп.

## Бот жалоб — лимиты, паузы и восстановление v5.9.29

- `canOpenNewChat()` больше не включает `supportState.isPaused` и не отправляет `supportLimitReached` при достижении лимита новых обращений. Счётчик `newChatsOpened` остаётся только для диагностики в логах.
- `checkConsecutiveEscalations()` не создаёт ручной gate. При серии эскалаций подряд бот пишет предупреждение, делает keepalive-антибот-паузу с Chrome API heartbeat и продолжает.
- `supportKeepaliveDelay()` сохраняет активную сессию перед и во время длинной паузы. Если MV3 service worker уснул, `supportWatchdog`/`supportRefresh`/`supportResume`/`supportRecoverAndContinue` восстанавливают `activeSupportSession` из storage и перезапускают ровно один support loop через `ensureSupportLoop()`.
- `supportGetStatus` read-only: он показывает память или storage, но не запускает обработку сам. Popup явно вызывает `supportRecoverAndContinue` для активной storage-сессии.
- `chat_escalated` сохраняет прогресс перед антибот-паузой. После паузы бот открывает новую страницу чатов; если tab id потерялся, сначала заново ищет вкладку seller.ozon.ru.
- Если восстановление нового чата после `failed`/`chat_escalated` не удалось, бот ставит паузу и не запускает следующий SKU в старом обращении.
- `supportLimitContinue` сохранён для совместимости со старым UI/сессиями, но рабочий поток больших пакетов не зависит от кнопки «Продолжить».

## Бот жалоб — доказательства v5.9.29

- Для ручных SKU без `parentMap` сам SKU используется как fallback-ключ в `pickFilesForItem()`, `collectSkuFilesForSending()` и `collectFileFirstForSending()`.
- Безопасный размер файла жалобы — до 50 MB. Это снижает риск падения MV3 service worker при base64-конвертации больших видео.
