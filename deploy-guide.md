# OZGuard — Руководство по деплою и устранению проблем

## Архитектура взаимодействия

```
Расширение (Chrome)          Сервер (Ubuntu)
┌──────────────────┐         ┌──────────────────────┐
│ service-worker.js│───POST──▶│ codefic.ru/api/license│
│                  │◀──JSON───│ (Next.js API Route)   │
│ LICENSE_API =    │         │                       │
│ codefic.ru/api/  │         │ SQLite (Prisma)       │
│ license          │         │ data/ozguard.db       │
└──────────────────┘         └──────────────────────┘
```

### Запросы расширения → сервер

| Действие | Когда | Тело запроса | Ответ |
|----------|-------|-------------|-------|
| `POST /api/license` | Пользователь вводит ключ | `{ action: "activate", key, fingerprint, browser }` | `{ success, type, expires_at, days_left }` |
| `POST /api/license` | Каждые 24ч (фоновая проверка) | `{ action: "validate", key, fingerprint }` | `{ valid, type, expires_at }` |
| `POST /api/license` | Нажатие «Деактивировать» | `{ action: "deactivate", key, fingerprint }` | `{ success }` |

### Что хранится локально (chrome.storage.local)

| Ключ | Назначение |
|------|-----------|
| `licenseCode` | Активированный ключ |
| `licenseType` | `monthly` / `lifetime` |
| `licenseExpiresAt` | ISO-дата истечения (или null) |
| `licenseVerifiedAt` | Последняя успешная проверка на сервере |
| `licenseActivatedAt` | Дата активации |

### Логика оффлайн/онлайн

1. При активации → запрос к серверу → сохранение локально
2. Каждые 12ч → `chrome.alarms` → фоновый `validate` к серверу
3. Если сервер недоступен → работает из кэша до 7 дней (grace period)
4. После 7 дней без подтверждения → PRO блокируется, показывается «Требуется проверка»
5. Месячный ключ → дополнительно проверяется `expiresAt` локально

---

## Деплой сервера (с нуля)

### 1. Подготовка Ubuntu

```bash
# Обновление системы
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Nginx + Certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# pm2
sudo npm install -g pm2

# Проверка
node -v    # v20.x.x
npm -v     # 10.x.x
pm2 -v     # 5.x.x
nginx -v   # nginx/1.x.x
```

### 2. Клонирование и настройка

```bash
# Клонировать
git clone <repo-url> /opt/ozguard-web
cd /opt/ozguard-web

# Создать .env
cp .env.example .env
nano .env
```

Содержимое `.env`:
```
DATABASE_URL="file:./data/ozguard.db"
SITE_URL="https://codefic.ru"
NODE_ENV="production"
```

### 3. Сборка и запуск

```bash
cd /opt/ozguard-web

# Установить зависимости
npm ci

# Создать БД + таблицы
npx prisma migrate deploy

# Добавить тестовые ключи (если есть seed)
npx prisma db seed

# Сборка
npm run build

# Запуск
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # следовать инструкции в выводе команды
```

### 4. Nginx

```bash
sudo nano /etc/nginx/sites-available/ozguard
```

```nginx
server {
    listen 80;
    server_name codefic.ru;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ozguard /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default  # убрать дефолт если мешает
sudo nginx -t
sudo systemctl reload nginx
```

### 5. SSL

```bash
sudo certbot --nginx -d codefic.ru
# Следовать инструкциям, выбрать redirect HTTP → HTTPS
```

### 6. Проверка

```bash
# Лендинг
curl -I https://codefic.ru

# API (должен вернуть ошибку — нет параметров, но 200/400 = сервер жив)
curl -X POST https://codefic.ru/api/license \
  -H "Content-Type: application/json" \
  -d '{"action":"validate","key":"TEST-12345","fingerprint":"test"}'
```

---

## Обновление

```bash
cd /opt/ozguard-web
git pull
npm ci
npx prisma migrate deploy
npm run build
pm2 restart ozguard-web
```

Однострочник:
```bash
cd /opt/ozguard-web && git pull && npm ci && npx prisma migrate deploy && npm run build && pm2 restart ozguard-web
```

---

## Бэкапы

```bash
# Разовый бэкап
cp /opt/ozguard-web/data/ozguard.db ~/ozguard-backup-$(date +%Y%m%d).db

# Автоматический ежедневный (cron)
sudo mkdir -p /opt/backups
crontab -e
# Добавить строку:
0 3 * * * cp /opt/ozguard-web/data/ozguard.db /opt/backups/ozguard-$(date +\%Y\%m\%d).db

# Восстановление из бэкапа
pm2 stop ozguard-web
cp /opt/backups/ozguard-20260320.db /opt/ozguard-web/data/ozguard.db
pm2 start ozguard-web
```

---

## Управление лицензиями

### Просмотр через Prisma Studio (на сервере)

```bash
cd /opt/ozguard-web
npx prisma studio
# Откроется на http://localhost:5555 (можно пробросить через SSH)
```

SSH-туннель с локальной машины:
```bash
ssh -L 5555:localhost:5555 user@codefic.ru
# Затем открыть http://localhost:5555 в браузере
```

### Создание ключей через CLI

```bash
cd /opt/ozguard-web

# Вечный ключ
npx prisma db execute --stdin <<'SQL'
INSERT INTO License (id, key, type, maxActivations, isRevoked, createdAt)
VALUES ('id_' || hex(randomblob(8)), 'OZG-ABCDE-12345-FGHIJ', 'lifetime', 2, 0, datetime('now'));
SQL

# Месячный ключ (истекает через 30 дней)
npx prisma db execute --stdin <<'SQL'
INSERT INTO License (id, key, type, maxActivations, isRevoked, createdAt, expiresAt)
VALUES ('id_' || hex(randomblob(8)), 'OZG-MONTH-12345-ABCDE', 'monthly', 2, 0, datetime('now'), datetime('now', '+30 days'));
SQL
```

### Отзыв ключа

```bash
npx prisma db execute --stdin <<'SQL'
UPDATE License SET isRevoked = 1 WHERE key = 'OZG-ABCDE-12345-FGHIJ';
SQL
```

### Просмотр активаций

```bash
npx prisma db execute --stdin <<'SQL'
SELECT l.key, l.type, a.deviceFingerprint, a.isActive, a.lastSeenAt
FROM Activation a JOIN License l ON a.licenseId = l.id
ORDER BY a.lastSeenAt DESC;
SQL
```

---

## Устранение проблем

### Расширение не может подключиться к серверу

**Симптом**: в popup — «Нет подключения к серверу» при активации.

**Проверить**:
```bash
# 1. Сервер запущен?
pm2 status

# 2. Next.js слушает порт?
curl http://127.0.0.1:3000

# 3. Nginx проксирует?
curl -I https://codefic.ru

# 4. SSL валиден?
curl -vI https://codefic.ru 2>&1 | grep "SSL certificate"

# 5. Firewall?
sudo ufw status
# Должны быть открыты 80, 443
sudo ufw allow 'Nginx Full'
```

### Расширение показывает «Требуется проверка»

**Причина**: прошло >7 дней без успешного `validate` к серверу.

**Проверить**:
```bash
# Сервер доступен?
curl -X POST https://codefic.ru/api/license \
  -H "Content-Type: application/json" \
  -d '{"action":"validate","key":"OZG-XXXXX-XXXXX-XXXXX","fingerprint":"fp_test"}'
```

**Временное решение**: деактивировать и заново активировать ключ в расширении.

### «Подписка истекла» (месячный ключ)

**Проверить на сервере**:
```bash
npx prisma db execute --stdin <<'SQL'
SELECT key, expiresAt FROM License WHERE key = 'OZG-XXXXX-XXXXX-XXXXX';
SQL
```

**Продлить**:
```bash
npx prisma db execute --stdin <<'SQL'
UPDATE License SET expiresAt = datetime('now', '+30 days') WHERE key = 'OZG-XXXXX-XXXXX-XXXXX';
SQL
```

### pm2 не запускается после перезагрузки

```bash
pm2 startup
# Скопировать и выполнить команду из вывода (sudo env PATH=...)
pm2 save
```

### База повреждена

```bash
# Остановить
pm2 stop ozguard-web

# Проверить целостность
sqlite3 /opt/ozguard-web/data/ozguard.db "PRAGMA integrity_check;"

# Если повреждена — восстановить из бэкапа
ls -la /opt/backups/  # найти последний бэкап
cp /opt/backups/ozguard-YYYYMMDD.db /opt/ozguard-web/data/ozguard.db

pm2 start ozguard-web
```

### Nginx 502 Bad Gateway

```bash
# Next.js упал?
pm2 status
pm2 restart ozguard-web

# Логи Next.js
pm2 logs ozguard-web --lines 50

# Логи Nginx
sudo tail -50 /var/log/nginx/error.log
```

### SSL сертификат истёк

```bash
sudo certbot renew
# Certbot обычно ставит cron автоматически, но проверить:
sudo certbot renew --dry-run
```

### Нехватка памяти

```bash
free -h
# Если мало RAM — добавить swap:
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Смена домена

1. Обновить DNS A-запись → новый IP
2. На сервере:
```bash
# Nginx
sudo nano /etc/nginx/sites-available/ozguard
# Заменить server_name
sudo nginx -t && sudo systemctl reload nginx

# SSL
sudo certbot --nginx -d newdomain.ru

# .env
nano /opt/ozguard-web/.env
# Обновить SITE_URL
npm run build && pm2 restart ozguard-web
```
3. В расширении: обновить `LICENSE_API` в `service-worker.js` строка 13

---

## Миграция расширения на свой сервер

После деплоя и проверки работы API — изменить одну строку в `background/service-worker.js`:

```js
// Строка 13: заменить URL
const LICENSE_API = 'https://codefic.ru/api/license';
```

Проверка:
1. Открыть расширение → Настройки → ввести тестовый ключ
2. Должно показать «PRO-версия активирована»
3. Проверить на сервере: `SELECT * FROM Activation;`

---

## Мониторинг

### Быстрая проверка здоровья

```bash
# Сервер жив
curl -s -o /dev/null -w "%{http_code}" https://codefic.ru

# API отвечает
curl -s -X POST https://codefic.ru/api/license \
  -H "Content-Type: application/json" \
  -d '{"action":"validate","key":"test","fingerprint":"test"}' | head -c 100

# pm2 статус
pm2 status

# Диск
df -h /opt/ozguard-web

# Размер БД
ls -lh /opt/ozguard-web/data/ozguard.db
```

### Простой healthcheck cron (опционально)

```bash
# Проверять каждые 5 минут, рестартовать при падении
*/5 * * * * curl -sf https://codefic.ru > /dev/null || (cd /opt/ozguard-web && pm2 restart ozguard-web)
```
