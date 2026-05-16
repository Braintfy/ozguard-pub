# Инструкция: API версий расширения + админка

## Что нужно сделать на сайте codefic.ru

Расширение OZGuard ещё не в Chrome Web Store → обновления раздаём вручную через сайт. Это инструкция по добавлению:
1. Публичного endpoint `/api/extension-version` для проверки последней версии
2. Админки для управления версиями (загрузка .zip/.crx, описание релиза)

---

## 1. Эндпоинт `GET /api/extension-version`

Публичный, **без авторизации**. Расширение дергает его раз в 6 часов при открытии popup.

### Ответ (JSON)

```json
{
  "version": "5.9.7",
  "download_url": "https://codefic.ru/downloads/ozguard-5.9.7.zip",
  "release_notes": "Исправлен зацикливание жалоб на Win11, добавлена проверка новой версии"
}
```

### Поля
- `version` (string, обязательно) — семвер строка актуальной версии (`X.Y.Z`)
- `download_url` (string) — прямая ссылка на файл (zip с unpacked extension ИЛИ .crx)
- `release_notes` (string, опционально) — краткое описание изменений (может рендериться позже)

### Поведение при ошибках
- 200 + валидный JSON → расширение сравнивает версии
- 404 / 500 / невалидный JSON → расширение ничего не показывает (тихо игнорирует)

### CORS
Нужен заголовок `Access-Control-Allow-Origin: *` (или хотя бы `chrome-extension://*`). Без CORS fetch упадёт.

---

## 2. Админка

### Таблица БД

```sql
CREATE TABLE extension_versions (
  id            SERIAL PRIMARY KEY,
  version       VARCHAR(20) NOT NULL UNIQUE,        -- "5.9.7"
  download_url  TEXT NOT NULL,                      -- URL файла (можно через внутренний storage)
  release_notes TEXT,                               -- changelog
  is_latest     BOOLEAN NOT NULL DEFAULT FALSE,     -- только одна может быть TRUE
  file_size     INTEGER,                            -- в байтах
  file_sha256   VARCHAR(64),                        -- для верификации
  uploaded_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  uploaded_by   VARCHAR(100)
);

CREATE UNIQUE INDEX idx_only_one_latest ON extension_versions (is_latest) WHERE is_latest = TRUE;
```

### UI админки — страница `/admin/extension-versions`

**Список версий** (таблица):
| Версия | Загружен | Размер | Release notes (превью) | Latest | Действия |
|--------|----------|--------|------------------------|--------|----------|
| 5.9.7  | 19.04.2026 | 245 KB | Fix... | ✓ | Скачать / Сделать latest / Удалить |
| 5.9.6  | 18.04.2026 | 244 KB | ... | — | Скачать / Сделать latest / Удалить |

**Форма загрузки новой версии** (сверху страницы):
- Поле `version` — автозаполнение из manifest.json загруженного файла
- Поле `file` — drag-and-drop .zip/.crx
- Поле `release_notes` — textarea (markdown)
- Чекбокс `Сделать актуальной (is_latest)` — по умолчанию включён
- Кнопка `Загрузить`

**Серверная логика загрузки**:
1. Распаковать zip, прочитать `manifest.json`, извлечь `version`
2. Проверить что эта версия ещё не была загружена (`UNIQUE version`)
3. Сохранить файл в storage (S3 / локальный volume / CDN)
4. Посчитать SHA256 + размер
5. Записать в `extension_versions` с `is_latest = true`
6. Если был чекбокс — автоматически UPDATE `is_latest = false WHERE version != new.version`

### Endpoint реализация

```typescript
// GET /api/extension-version
async function handler() {
  const latest = await db.extension_versions.findFirst({
    where: { is_latest: true },
    orderBy: { uploaded_at: 'desc' }
  });
  if (!latest) {
    return Response.json({ error: 'no versions' }, { status: 404 });
  }
  return Response.json({
    version: latest.version,
    download_url: latest.download_url,
    release_notes: latest.release_notes
  }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300' // 5 минут кэш на стороне CDN
    }
  });
}
```

---

## 3. Публичная страница `/download` (опционально, но желательно)

Пользователь, перейдя по `download_url`, должен попасть на:
- Кнопку «Скачать ZIP»
- Краткую инструкцию по установке unpacked в Chrome (chrome://extensions → Режим разработчика → Загрузить распакованное расширение)
- Либо (если CRX подписан) — inline установку

---

## 4. Процесс релиза новой версии (для тебя)

1. Поднял версию в `manifest.json` → закоммитил → `git push`
2. Зашёл в `/admin/extension-versions`
3. Загрузил новый zip-файл из `/Users/firay/china-banned/ozguard-pub/ozguard-pub/` (минифицированная публичная версия)
4. Заполнил release notes (из CHANGELOG.md)
5. Поставил галочку `Сделать актуальной`
6. Сохранил

Через ~6 часов все пользователи увидят оранжевый бейдж у версии в popup + баннер «Доступна новая версия — Скачать».

---

## 5. Тестирование

После разворачивания:

```bash
curl https://codefic.ru/api/extension-version
# Должен вернуть JSON с актуальной версией
```

В расширении:
- Открыть popup, в DevTools → Application → Storage → Local Storage → найти `extensionVersionCache`
- Проверить что там свежий `version` + `download_url`
- Очистить `extensionVersionCache` и переоткрыть popup — должен снова фетчить и, если версия новее текущей, показать баннер
