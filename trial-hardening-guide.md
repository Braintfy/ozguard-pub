# Инструкция: защита триала от злоупотреблений

## Проблема

При удалении и повторной установке расширения `chrome.storage.sync` и `chrome.storage.local` очищаются. Device fingerprint создаётся заново → сервер видит новый fingerprint → выдаёт новый 7-дневный триал.

## Что уже сделано в расширении (v5.9.2)

Fingerprint теперь сохраняется в 3 местах:
1. `chrome.storage.sync` — привязан к Google-аккаунту (очищается при удалении расширения)
2. `chrome.storage.local` — быстрый доступ (очищается при удалении)
3. **`localStorage` сайта ozon.ru** — через `chrome.scripting.executeScript({ world: 'MAIN' })`, ключ `__ozg_fp`. Этот storage принадлежит домену ozon.ru и **НЕ очищается** при удалении расширения. При повторной установке расширение восстанавливает fingerprint оттуда.

## Что нужно сделать на сервере (ОБЯЗАТЕЛЬНО)

### 1. Привязка триала к нескольким идентификаторам

Сейчас триал привязан только к `fingerprint`. Нужно добавить **вторичные идентификаторы** для обнаружения переустановок.

#### 1.1 Сохранять при `trial_activate`:
```json
{
  "fingerprint": "fp_xxx",
  "browser": "Mozilla/5.0 ...",
  "ip": "request.ip",          // IP адрес клиента
  "created_at": "2026-04-05"
}
```

#### 1.2 При `trial_activate` проверять:
```
1. fingerprint уже использовал триал? → ОТКАЗАТЬ
2. IP + похожий userAgent уже активировали триал за последние 30 дней? → ОТКАЗАТЬ
3. Больше 3 триалов с одного IP за 90 дней? → ОТКАЗАТЬ
```

### 2. Модель данных — таблица trials

```sql
CREATE TABLE trials (
  id            SERIAL PRIMARY KEY,
  fingerprint   TEXT NOT NULL UNIQUE,
  ip_address    TEXT,
  user_agent    TEXT,
  activated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMP NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'  -- active | expired | revoked
);

CREATE INDEX idx_trials_ip ON trials(ip_address);
CREATE INDEX idx_trials_fingerprint ON trials(fingerprint);
```

### 3. Логика `trial_activate`

```typescript
async function handleTrialActivate(fingerprint: string, ip: string, userAgent: string) {
  // 1. Fingerprint уже есть?
  const existing = await db.trial.findUnique({ where: { fingerprint } });
  if (existing) {
    return { success: false, error: 'Trial already used' };
  }

  // 2. IP rate limit: не более 3 триалов с одного IP за 90 дней
  const recentFromIp = await db.trial.count({
    where: {
      ip_address: ip,
      activated_at: { gte: subDays(new Date(), 90) }
    }
  });
  if (recentFromIp >= 3) {
    return { success: false, error: 'Trial limit reached' };
  }

  // 3. IP + UserAgent combo: не более 1 за 30 дней (та же машина, другой fingerprint)
  const sameDevice = await db.trial.findFirst({
    where: {
      ip_address: ip,
      user_agent: { contains: extractBrowserKey(userAgent) }, // Chrome/xxx
      activated_at: { gte: subDays(new Date(), 30) }
    }
  });
  if (sameDevice) {
    return { success: false, error: 'Trial already used on this device' };
  }

  // 4. Создаём триал
  const expiresAt = addDays(new Date(), 3);
  await db.trial.create({
    data: { fingerprint, ip_address: ip, user_agent: userAgent, expires_at: expiresAt }
  });

  return { success: true, expires_at: expiresAt.toISOString(), days_left: 3 };
}

function extractBrowserKey(ua: string): string {
  // Извлекаем "Chrome/125" или "Firefox/128" для нечёткого сравнения
  const match = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d]+/);
  return match ? match[0] : ua.substring(0, 50);
}
```

### 4. Логика `trial_validate`

```typescript
async function handleTrialValidate(fingerprint: string) {
  const trial = await db.trial.findUnique({ where: { fingerprint } });
  
  if (!trial) {
    return { valid: false, can_activate: true };
  }

  if (trial.status === 'revoked') {
    return { valid: false, can_activate: false, error: 'Trial revoked' };
  }

  const now = new Date();
  if (now > trial.expires_at) {
    // Автоматически помечаем как expired
    if (trial.status !== 'expired') {
      await db.trial.update({ where: { fingerprint }, data: { status: 'expired' } });
    }
    return { valid: false, can_activate: false };
  }

  const daysLeft = Math.max(0, Math.ceil((trial.expires_at.getTime() - now.getTime()) / 86400000));
  return { valid: true, expires_at: trial.expires_at.toISOString(), days_left: daysLeft };
}
```

### 5. Админка — управление триалами

Добавить в админку:
- Таблица триалов: fingerprint, IP, userAgent, дата активации, статус
- Кнопка «Отозвать» (revoke) — меняет status на `revoked`
- Фильтр по IP — обнаружение злоупотреблений (несколько триалов с одного IP)
- Дашборд: количество активных / истёкших / отозванных триалов

### 6. Порядок внедрения

1. Добавить столбцы `ip_address`, `user_agent` в таблицу trials (если ещё нет)
2. Обновить endpoint `trial_activate` — проверки IP + UA
3. Обновить `trial_validate` — поддержка status `revoked`
4. Добавить триалы в админку
5. Протестировать:
   - Новый fingerprint → триал активируется
   - Тот же fingerprint → «Trial already used»
   - Другой fingerprint, тот же IP + UA → «Trial already used on this device»
   - 4-й fingerprint с того же IP за 90 дней → «Trial limit reached»
   - Отзыв триала в админке → расширение показывает «expired»
