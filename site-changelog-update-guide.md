# Инструкция для ИИ сайта codefic.ru — блок «Обзор обновлений» (#changelog)

Этот файл — руководство для разработчика/ИИ сайта, как реализовать и поддерживать блок обзора обновлений расширения OZGuard.

## Цели блока

1. Объяснять продавцам OZON **простым языком**, что появилось в новой версии расширения
2. Располагаться **непосредственно под блоком скачивания расширения** на главной странице
3. Ссылка-якорь: `https://codefic.ru/#changelog` (используется в расширении из баннера обновления)
4. Контент подгружается из файла `CHANGELOG-USER.md` (загружается через админку сайта при каждом релизе)

## Расположение на сайте

```
[Главная страница]
  ├── Hero
  ├── Возможности
  ├── Тарифы (#pricing)
  ├── Установка расширения (#install)      ← кнопка «Скачать»
  ├── 👉 Обзор обновлений (#changelog)      ← НОВЫЙ БЛОК
  ├── FAQ
  └── Footer
```

Блок `#changelog` идёт **сразу после** `#install` — логика: пользователь скачал/обновил, сразу видит «что нового».

## Требования к дизайну

**Стиль сайта codefic.ru** (предполагаемый — сверить с существующими разделами):
- Chunky-секция на full-width контейнер с мягким фоном (светло-серый `#f9fafb` или градиент)
- Заголовок секции: H2 «🚀 Что нового», подзаголовок-серый «Обновления расширения простым языком»
- Карточки релизов — акцидентная раскладка: **первая** (свежая) версия крупнее, старые — сворачиваемая аккордеон-лента
- Каждая карточка релиза:
  - Бейдж версии (пример: `v5.9.16` в стиле `.btn-primary`-цвета)
  - Дата релиза — серый мелкий текст
  - Заголовок большой — краткое описание изменений
  - Список изменений с эмодзи-маркерами (🆕 / 🔧 / 🚀 / 🧪 / 🎯 / ✨)
  - Если это **BETA**-функционал — помечать жёлтым бейджем `BETA`
- **Мобильный UX** — приоритет: карточки складываются в одну колонку, текст не обрезается

## Структура данных

Источник — файл `CHANGELOG-USER.md` из репозитория OZGuard. Загружается через админку сайта:

```
POST /api/admin/changelog-user
Body (multipart): файл CHANGELOG-USER.md
```

Парсер на бэкенде разбивает по заголовкам `## 🆕 Версия X.Y.Z — DD месяца YYYY`, извлекает:

```json
{
  "releases": [
    {
      "version": "5.9.16",
      "date": "2026-04-24",
      "title": "Удобство и баннер обновлений",
      "emoji": "🆕",
      "sections": [
        {
          "title": "Что стало удобнее",
          "items": [
            "🔧 Меню «Тип жалобы» больше не обрезается.",
            "📣 Кнопка «Читать об обновлении» в баннере новой версии."
          ]
        }
      ],
      "note": "Это косметическая правка, ничего не сломалось. Можете спокойно обновляться."
    },
    ...
  ]
}
```

Храните parsed JSON в таблице `release_notes (id, version, date, title, emoji, payload JSONB, is_published BOOL, created_at)`.

## Реализация — React/Next.js пример

```tsx
// components/ChangelogSection.tsx
import { useState } from 'react';

type Release = {
  version: string;
  date: string;
  title: string;
  emoji: string;
  sections: Array<{ title: string; items: string[] }>;
  note?: string;
};

export default function ChangelogSection({ releases }: { releases: Release[] }) {
  const [expanded, setExpanded] = useState<string | null>(releases[0]?.version ?? null);
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? releases : releases.slice(0, 3);

  return (
    <section id="changelog" className="bg-gray-50 py-16 lg:py-24">
      <div className="container mx-auto max-w-4xl px-4">
        <header className="mb-10 text-center">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-2">
            🚀 Что нового
          </h2>
          <p className="text-gray-600">Обновления расширения простым языком</p>
        </header>

        <div className="space-y-4">
          {visible.map((rel, idx) => (
            <article
              key={rel.version}
              className={`bg-white rounded-xl shadow-sm border border-gray-200 transition-all ${
                idx === 0 ? 'ring-2 ring-blue-100' : ''
              }`}
            >
              <button
                onClick={() => setExpanded(expanded === rel.version ? null : rel.version)}
                className="w-full flex items-center justify-between px-6 py-5 hover:bg-gray-50 rounded-xl"
              >
                <div className="flex items-center gap-4 text-left">
                  <span className="text-2xl">{rel.emoji}</span>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white text-xs font-mono font-semibold">
                        v{rel.version}
                      </span>
                      <span className="text-xs text-gray-500">{formatDate(rel.date)}</span>
                      {idx === 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-green-100 text-green-700 text-xs font-semibold">
                          Последняя
                        </span>
                      )}
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900">{rel.title}</h3>
                  </div>
                </div>
                <svg
                  className={`w-5 h-5 text-gray-400 transition-transform ${
                    expanded === rel.version ? 'rotate-180' : ''
                  }`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {expanded === rel.version && (
                <div className="px-6 pb-6 space-y-4 text-gray-700 leading-relaxed">
                  {rel.sections.map((sec, i) => (
                    <div key={i}>
                      {sec.title && <h4 className="font-semibold text-gray-900 mb-2">{sec.title}</h4>}
                      <ul className="space-y-1 pl-1">
                        {sec.items.map((item, j) => (
                          <li key={j}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {rel.note && (
                    <p className="text-sm italic text-gray-500 border-l-2 border-gray-300 pl-3">{rel.note}</p>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>

        {!showAll && releases.length > 3 && (
          <div className="mt-6 text-center">
            <button
              onClick={() => setShowAll(true)}
              className="px-5 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-white transition"
            >
              Показать все предыдущие версии
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function formatDate(iso: string) {
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}
```

## Бэкенд — парсер CHANGELOG-USER.md

Парсер разбивает Markdown по заголовкам `## 🆕 Версия X.Y.Z — дата`, извлекает `###`-подзаголовки как `section.title`, списки `- ...` как `section.items`, выделенные курсивом абзацы `*...*` — как `note`. Эмодзи из заголовка версии → `emoji`.

Регэкс для разбора заголовка релиза:
```js
const RELEASE_HEADER = /^##\s+([\u{1F300}-\u{1FAFF}\u{2000}-\u{3300}])\s+Версия\s+(\d+\.\d+\.\d+)\s+—\s+(.+)$/u;
```

## Обновление — процесс

1. Разработчик OZGuard вносит изменения в `CHANGELOG-USER.md` в репозитории
2. В админке сайта codefic.ru: «Обновления расширения → Загрузить CHANGELOG-USER.md»
3. Парсер на бэкенде разбирает Markdown → таблица `release_notes`
4. Главная страница рендерит компонент `<ChangelogSection />` с данными из таблицы
5. Кэш Next.js/ISR на 5-10 минут — обновление на сайте появится почти моментально

## Стиль написания текста (важно!)

Эти правила используется редактором `CHANGELOG-USER.md`, но для сайта важно **не нарушить стиль** при парсинге:
- Короткие предложения, активный залог («Теперь бот прикрепляет все файлы»)
- Без технических терминов: **не** `isPaused`, `interruptibleDelay`, `supportState`. Да: «пауза», «интервал ожидания», «состояние бота»
- Эмодзи-маркеры в начале пункта: 🆕 новое, 🔧 фикс, 🚀 крупное обновление, 🧪 BETA, 🎯 точное исправление, ✨ улучшение
- Сценарий «раньше/теперь» для важных фиксов — облегчает понимание
- Ссылки на техдетали только для продвинутых: «Подробности в техническом CHANGELOG.md»

## SEO и аналитика

- Блок должен быть индексируемым — не использовать `display:none` для свёрнутых релизов (использовать `max-height: 0` + `overflow: hidden`)
- Для последнего релиза генерировать JSON-LD `Article` с датой публикации
- Трекать клики «Читать об обновлении» из расширения (UTM: `?utm_source=extension&utm_medium=update-banner&utm_campaign=changelog`)
- Опционально подшить utm к якорю в расширении: `https://codefic.ru/?utm_source=extension#changelog`

## Будущие улучшения

- RSS-фид `https://codefic.ru/changelog.rss` — продвинутые пользователи подписываются
- Фильтр по «только важные» — скрывать косметические patch-релизы
- Поиск по содержанию обновлений
- Интеграция с Telegram-каналом: новая версия → пост автоматически
