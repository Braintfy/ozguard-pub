(function() {
  'use strict';

  // === Константы ===
  const DEFAULT_DELAY_MS = 2000;
  const FAST_DELAY_MS = 600;  // Задержка между SKU в быстром режиме
  const MAX_HISTORY_SESSIONS = 10;
  const TAB_READY_TIMEOUT_MS = 20000;
  const DATA_POLL_INTERVAL_MS = 1000;
  const DATA_POLL_MAX_SECONDS = 20;
  const STABLE_POLLS_NEEDED = 3; // Виджеты не растут 3 секунды = загрузка завершена

  // === Лицензия PRO (серверная валидация) ===
  const LICENSE_API = 'https://codefic.ru/api/license';
  const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24ч
  const OFFLINE_GRACE_DAYS = 7;

  const _mk = [79,90,71,45,77,65,83,84,82,45,70,73,82,65,89,45,65,68,77,73,78];
  function _dmk() { return _mk.map(c => String.fromCharCode(c)).join(''); }
  function _isMK(k) { return k === _dmk(); }

  // Fingerprint устройства — UUID, переживает переустановку расширения
  // Стратегия: chrome.storage.sync → localStorage сайта ozon.ru (MAIN world) → новый UUID
  async function getDeviceFingerprint() {
    // 1. Из sync storage (привязан к Google-аккаунту)
    try {
      const syncData = await chrome.storage.sync.get(['deviceFingerprint']);
      if (syncData.deviceFingerprint) {
        await chrome.storage.local.set({ deviceFingerprint: syncData.deviceFingerprint });
        return syncData.deviceFingerprint;
      }
    } catch (e) {}

    // 2. Из local storage (быстрый доступ)
    try {
      const localData = await chrome.storage.local.get(['deviceFingerprint']);
      if (localData.deviceFingerprint) {
        await chrome.storage.sync.set({ deviceFingerprint: localData.deviceFingerprint });
        return localData.deviceFingerprint;
      }
    } catch (e) {}

    // 3. Из localStorage сайта ozon.ru (переживает удаление расширения!)
    try {
      const tabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
      if (tabs.length > 0) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => localStorage.getItem('__ozg_fp'),
          world: 'MAIN'
        });
        const savedFp = results?.[0]?.result;
        if (savedFp) {
          await chrome.storage.sync.set({ deviceFingerprint: savedFp });
          await chrome.storage.local.set({ deviceFingerprint: savedFp });
          return savedFp;
        }
      }
    } catch (e) {}

    // 4. Генерируем новый и сохраняем везде
    const fp = 'fp_' + crypto.randomUUID();
    await chrome.storage.sync.set({ deviceFingerprint: fp });
    await chrome.storage.local.set({ deviceFingerprint: fp });
    // Сохраняем в localStorage ozon.ru (переживёт переустановку)
    persistFingerprintToSite(fp);
    return fp;
  }

  // Сохранить fingerprint в localStorage сайта ozon.ru (MAIN world)
  async function persistFingerprintToSite(fp) {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
      if (tabs.length > 0) {
        await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: (fp) => { try { localStorage.setItem('__ozg_fp', fp); } catch(e) {} },
          args: [fp],
          world: 'MAIN'
        });
      }
    } catch (e) {}
  }

  async function licenseApiCall(action, body) {
    try {
      const resp = await fetch(LICENSE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body })
      });
      return await resp.json();
    } catch (e) {
      return { error: 'network_error', message: e.message };
    }
  }

  // Сервер шлёт человеческие строки ('License not found', 'Activation limit reached', ...),
  // расширение оперирует короткими кодами. Маппим и то и другое.
  function normalizeLicenseError(raw) {
    if (!raw) return 'unknown';
    const s = String(raw).toLowerCase();
    if (s.includes('not found') || s === 'invalid_key') return 'invalid_key';
    if (s.includes('revoked')) return 'revoked';
    if (s.includes('expired')) return 'expired';
    if (s.includes('limit reached') || s === 'max_activations') return 'max_activations';
    if (s.includes('not activated on this device') || s === 'not_activated_here') return 'not_activated_here';
    if (s.includes('missing') || s === 'missing_params') return 'missing_params';
    if (s.includes('too many requests')) return 'rate_limited';
    return s;
  }

  const LICENSE_ERROR_MESSAGES = {
    invalid_key: 'Неверный код. Проверьте его в письме или в личном кабинете.',
    revoked: 'Код отозван. Свяжитесь с поддержкой codefic.ru.',
    expired: 'Срок действия подписки истёк. Продлите в личном кабинете.',
    max_activations: 'Лимит устройств исчерпан. Деактивируйте ключ на другом устройстве или напишите в поддержку для расширения лимита.',
    not_activated_here: 'Ключ не привязан к этому устройству. Нажмите «Активировать» ещё раз — мы привяжем текущий браузер.',
    missing_params: 'Ошибка параметров запроса.',
    rate_limited: 'Слишком много запросов. Подождите минуту и попробуйте снова.',
    network_error: 'Нет подключения к серверу codefic.ru. Проверьте интернет/VPN.',
    unknown: 'Ошибка активации. Попробуйте позже или напишите в поддержку.'
  };

  function licenseErrorMessage(code, result) {
    if (code === 'max_activations' && result?.max) {
      return `Лимит устройств (${result.max}) исчерпан. Деактивируйте ключ на другом устройстве или напишите в поддержку codefic.ru для расширения лимита.`;
    }
    return LICENSE_ERROR_MESSAGES[code] || LICENSE_ERROR_MESSAGES.unknown;
  }

  async function getLicenseStatus() {
    const data = await chrome.storage.local.get([
      'licenseCode', 'licenseType', 'licenseExpiresAt',
      'licenseVerifiedAt', 'licenseActivatedAt', 'licenseLastError',
      'trialStatus', 'trialExpiresAt', 'trialCheckedAt'
    ]);

    // Приоритет: ключ > триал
    if (!data.licenseCode) {
      const t = await getTrialStatus(data);
      if (data.licenseLastError) t.lastError = data.licenseLastError;
      return t;
    }

    // Оффлайн-режим
    if (_isMK(data.licenseCode)) {
      return {
        isPro: true, code: data.licenseCode,
        type: 'lifetime', activatedAt: data.licenseActivatedAt || null,
        expiresAt: null, daysLeft: null
      };
    }

    const verifiedAt = data.licenseVerifiedAt ? new Date(data.licenseVerifiedAt) : null;
    const now = new Date();

    // Месячный ключ: проверяем локальный срок
    if (data.licenseType === 'monthly' && data.licenseExpiresAt) {
      if (new Date(data.licenseExpiresAt) < now) {
        return { isPro: false, code: data.licenseCode, error: 'expired',
          type: data.licenseType, expiresAt: data.licenseExpiresAt,
          lastError: data.licenseLastError || null };
      }
    }

    // Оффлайн grace period
    if (verifiedAt) {
      const daysSinceVerify = (now - verifiedAt) / 86400000;
      if (daysSinceVerify > OFFLINE_GRACE_DAYS) {
        return { isPro: false, code: data.licenseCode, error: 'verification_needed',
          type: data.licenseType,
          lastError: data.licenseLastError || null };
      }
    }

    // Фоновая проверка (не блокирует)
    if (!verifiedAt || (now - verifiedAt) > VERIFY_INTERVAL_MS) {
      backgroundVerify(data.licenseCode).catch(() => {});
    }

    const daysLeft = data.licenseType === 'lifetime' ? null :
      data.licenseExpiresAt ? Math.max(0, Math.ceil((new Date(data.licenseExpiresAt) - now) / 86400000)) : null;

    return {
      isPro: true,
      code: data.licenseCode,
      type: data.licenseType || 'lifetime',
      activatedAt: data.licenseActivatedAt || null,
      expiresAt: data.licenseExpiresAt || null,
      daysLeft,
      lastError: data.licenseLastError || null
    };
  }

  // === Триал ===
  async function getTrialStatus(data) {
    const now = Date.now();

    // Есть кеш триала и проверен < 1 часа назад — используем кеш
    if (data.trialStatus && data.trialCheckedAt && (now - data.trialCheckedAt) < 3600000) {
      if (data.trialStatus === 'active' && data.trialExpiresAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(data.trialExpiresAt) - now) / 86400000));
        if (daysLeft > 0) {
          return { isPro: true, code: null, type: 'trial', expiresAt: data.trialExpiresAt, daysLeft, isTrial: true };
        }
        // Истёк — обновляем кеш
        await chrome.storage.local.set({ trialStatus: 'expired', trialCheckedAt: now });
        return { isPro: false, code: null, trialExpired: true, canActivateTrial: false };
      }
      if (data.trialStatus === 'expired') {
        return { isPro: false, code: null, trialExpired: true, canActivateTrial: false };
      }
      if (data.trialStatus === 'none') {
        return { isPro: false, code: null, canActivateTrial: true };
      }
    }

    // Проверяем на сервере
    return backgroundTrialCheck();
  }

  async function backgroundTrialCheck() {
    const fp = await getDeviceFingerprint();
    persistFingerprintToSite(fp); // Поддерживаем fp в localStorage сайта
    const result = await licenseApiCall('trial_validate', { fingerprint: fp });
    const now = Date.now();

    if (result.error === 'network_error') {
      // Оффлайн — используем кеш как есть
      const data = await chrome.storage.local.get(['trialStatus', 'trialExpiresAt']);
      if (data.trialStatus === 'active' && data.trialExpiresAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(data.trialExpiresAt) - now) / 86400000));
        if (daysLeft > 0) return { isPro: true, code: null, type: 'trial', expiresAt: data.trialExpiresAt, daysLeft, isTrial: true };
      }
      return { isPro: false, code: null, canActivateTrial: false };
    }

    if (result.valid) {
      const daysLeft = result.days_left ?? Math.max(0, Math.ceil((new Date(result.expires_at) - now) / 86400000));
      await chrome.storage.local.set({ trialStatus: 'active', trialExpiresAt: result.expires_at, trialCheckedAt: now });
      return { isPro: true, code: null, type: 'trial', expiresAt: result.expires_at, daysLeft, isTrial: true };
    }

    if (result.can_activate) {
      await chrome.storage.local.set({ trialStatus: 'none', trialCheckedAt: now });
      return { isPro: false, code: null, canActivateTrial: true };
    }

    // Триал использован и истёк
    await chrome.storage.local.set({ trialStatus: 'expired', trialCheckedAt: now });
    return { isPro: false, code: null, trialExpired: true, canActivateTrial: false };
  }

  async function activateTrial() {
    const fp = await getDeviceFingerprint();
    const browser = navigator?.userAgent || 'Chrome Extension';
    const result = await licenseApiCall('trial_activate', { fingerprint: fp, browser });

    if (result.error === 'network_error') {
      return { success: false, error: 'Нет подключения к серверу. Проверьте интернет.' };
    }
    if (!result.success) {
      if (result.error === 'Trial already used') {
        await chrome.storage.local.set({ trialStatus: 'expired', trialCheckedAt: Date.now() });
        return { success: false, error: 'Пробный период уже использован' };
      }
      return { success: false, error: result.error || 'Ошибка активации триала' };
    }

    const daysLeft = result.days_left ?? 7;
    await chrome.storage.local.set({
      trialStatus: 'active',
      trialExpiresAt: result.expires_at,
      trialCheckedAt: Date.now()
    });
    return { success: true, type: 'trial', expiresAt: result.expires_at, daysLeft };
  }

  async function backgroundVerify(code) {
    // Оффлайн-ключ — не проверяем на сервере
    if (_isMK(code)) return;

    const fp = await getDeviceFingerprint();
    const result = await licenseApiCall('validate', { key: code, fingerprint: fp });
    if (result.valid) {
      await chrome.storage.local.set({
        licenseVerifiedAt: new Date().toISOString(),
        licenseType: result.type,
        licenseExpiresAt: result.expires_at || null,
        licenseLastError: null
      });
      return;
    }

    const errCode = normalizeLicenseError(result.error);

    // Fingerprint устройства изменился (например после реинсталла в другую папку) —
    // пробуем молча переактивировать на текущий fp. Квота позволит — лицензия восстановится.
    if (errCode === 'not_activated_here') {
      try {
        const browser = navigator?.userAgent || 'Chrome Extension';
        const re = await licenseApiCall('activate', { key: code, fingerprint: fp, browser });
        if (re.success) {
          await chrome.storage.local.set({
            licenseVerifiedAt: new Date().toISOString(),
            licenseType: re.type,
            licenseExpiresAt: re.expires_at || null,
            licenseActivatedAt: new Date().toISOString(),
            licenseLastError: null
          });
          return;
        }
        const reErr = normalizeLicenseError(re.error);
        await chrome.storage.local.set({
          licenseLastError: { code: reErr, message: licenseErrorMessage(reErr, re), at: Date.now() }
        });
        // Если квота забита — НЕ чистим licenseCode, пользователь сам деактивирует другое устройство.
        return;
      } catch (_) { return; }
    }

    if (errCode === 'expired' || errCode === 'revoked' || errCode === 'invalid_key') {
      await chrome.storage.local.remove([
        'licenseCode', 'licenseType', 'licenseExpiresAt',
        'licenseVerifiedAt', 'licenseActivatedAt'
      ]);
      await chrome.storage.local.set({
        licenseLastError: { code: errCode, message: licenseErrorMessage(errCode, result), at: Date.now() }
      });
    }
  }

  async function activateLicense(code) {
    if (!code || typeof code !== 'string' || code.trim().length < 5) {
      return { success: false, error: 'Введите код активации' };
    }
    const cleanKey = code.trim().toUpperCase();

    // Оффлайн-активация
    if (_isMK(cleanKey)) {
      await chrome.storage.local.set({
        licenseCode: cleanKey,
        licenseType: 'lifetime',
        licenseExpiresAt: null,
        licenseActivatedAt: new Date().toISOString(),
        licenseVerifiedAt: new Date().toISOString()
      });
      return { success: true, type: 'lifetime', expiresAt: null, daysLeft: null };
    }

    const fp = await getDeviceFingerprint();
    const browser = navigator?.userAgent || 'Chrome Extension';

    const result = await licenseApiCall('activate', {
      key: cleanKey, fingerprint: fp, browser
    });

    if (result.error === 'network_error') {
      const msg = licenseErrorMessage('network_error', result);
      await chrome.storage.local.set({ licenseLastError: { code: 'network_error', message: msg, at: Date.now() } });
      return { success: false, code: 'network_error', error: msg };
    }
    if (!result.success) {
      const errCode = normalizeLicenseError(result.error);
      const msg = licenseErrorMessage(errCode, result);
      await chrome.storage.local.set({ licenseLastError: { code: errCode, message: msg, at: Date.now() } });
      return { success: false, code: errCode, error: msg };
    }

    await chrome.storage.local.set({
      licenseCode: cleanKey,
      licenseType: result.type,
      licenseExpiresAt: result.expires_at || null,
      licenseActivatedAt: new Date().toISOString(),
      licenseVerifiedAt: new Date().toISOString(),
      licenseLastError: null
    });

    return {
      success: true,
      type: result.type,
      expiresAt: result.expires_at,
      daysLeft: result.days_left
    };
  }

  async function deactivateLicense() {
    const data = await chrome.storage.local.get(['licenseCode']);
    if (data.licenseCode && !_isMK(data.licenseCode)) {
      const fp = await getDeviceFingerprint();
      await licenseApiCall('deactivate', { key: data.licenseCode, fingerprint: fp });
    }
    await chrome.storage.local.remove([
      'licenseCode', 'licenseType', 'licenseExpiresAt',
      'licenseVerifiedAt', 'licenseActivatedAt', 'licenseLastError'
    ]);
    return { success: true };
  }

  // Периодическая проверка лицензии
  async function scheduleLicenseCheck() {
    const data = await chrome.storage.local.get(['licenseCode']);
    if (data.licenseCode) {
      await backgroundVerify(data.licenseCode);
    }
  }
  scheduleLicenseCheck();
  chrome.alarms.create('licenseCheck', { periodInMinutes: 60 * 12 });
  // Watchdog для бота жалоб — будит SW каждую минуту чтобы проверить не завис ли бот.
  // Service worker может уснуть пока бот «ждёт» (verify прикрепления, ответ Ozon) —
  // alarms просыпают его и дают возможность залогировать диагностику клиенту.
  chrome.alarms.create('supportWatchdog', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'licenseCheck') scheduleLicenseCheck();
    if (alarm.name === 'supportWatchdog') checkSupportWatchdog();
  });

  // === Состояние жалоб (support automation) ===
  let supportState = {
    isRunning: false,
    isPaused: false,
    mode: 'dry', // dry | auto
    queue: [],        // [{sku, status, step, chatId, error, parentSku}]
    currentIndex: 0,
    files: [],        // общий пул доказательств [{id, name, type, size, storage, source}]
    skuFiles: {},     // per-parent-SKU: { parentSku: [{id, name, type, size, storage, source}] }
    evidenceMode: 'sku_first',
    fileSkus: [],
    parentMap: {},    // competitorSku → [parentSku, ...]
    complaintType: 'plagiat_legacy', // plagiat_legacy | content_beta | brand_beta (v5.9.15)
    logs: [],
    sellerTabId: null,
    session: null,     // {id, startedAt, completedAt}
    lastPhase: null,   // последняя фаза для детекции зацикливания
    phaseRepeatCount: 0, // сколько раз подряд одна и та же фаза
    maxPhaseRepeats: 4,   // макс повторов одной фазы перед debug/стоп
    // Защита от массового создания чатов (v5.9.10)
    newChatsOpened: 0,            // счётчик новых обращений за сессию
    consecutiveEscalations: 0,    // подряд эскалированных SKU
    limits: { maxChatsPerSession: 10, maxConsecutiveEscalations: 5 },
    limitGateAllowance: 0,         // сколько ещё новых чатов разрешено после подтверждения
    limitGateActive: false,        // ждём ли подтверждения пользователя
    // BETA-защиты (v5.9.15)
    consecutiveFailed: 0,          // SKU подряд в failed на любом пути
    betaAutostopLimit: 5,          // BETA-режим: стоп после 5 подряд failed
    // v5.9.37: recovery после зависания на interface-like фазах
    consecutiveInterfaceStuck: 0,  // SKU подряд застрявших на input_ready/faq_page/unknown/has_buttons/no_chat
    maxConsecutiveInterfaceStuck: 5, // лимит recovery перед остановкой пакета (truly interface change)
    navClickRetries: {},           // { phase: count } — счётчик неудачных кликов по фазе
    // Watchdog (v5.9.18)
    lastActivityTs: 0,             // время последнего супер-лога/прогресса (ms)
    watchdogWarned: false,         // показано ли уже первое предупреждение о заморозке
    consecutiveAttachFails: 0,     // SKU подряд с провалом всех файлов
    attachFailAdviceShown: false,  // показан ли совет писать в поддержку при серии провалов
    limitGateReason: null          // причина ручного gate; лимит новых чатов больше не использует gate
  };

  let supportLoopRunning = false;
  let supportLoopToken = 0;

  // Watchdog: вызывается chrome.alarms раз в минуту. Если бот «жив» (isRunning && !isPaused),
  // но не было активности больше 3 минут — пишем диагностику. После 6 минут — ставим паузу.
  // Паника-режим выключаем если пользователь сам остановил.
  async function checkSupportWatchdog() {
    const hadMemory = supportState.queue && supportState.queue.length > 0;
    if (!hadMemory) {
      const restored = await restoreActiveSupportSession();
      if (restored && supportState.isRunning && !supportState.isPaused) {
        const tabId = supportState.sellerTabId || await findSellerTab();
        if (tabId) {
          supportState.sellerTabId = tabId;
          ensureSupportLoop(tabId, 'watchdog-restore');
        }
      }
    }

    if (!supportState.isRunning || supportState.isPaused) {
      supportState.watchdogWarned = false;
      return;
    }
    const now = Date.now();
    const idleMs = now - (supportState.lastActivityTs || now);
    if (idleMs < 3 * 60 * 1000) return;

    if (!supportState.watchdogWarned) {
      supportState.watchdogWarned = true;
      _supportLogRaw(`⏱ [WATCHDOG] Нет активности ${Math.round(idleMs/60000)} мин. Если зависло — скопируйте лог и отправьте в поддержку: t.me/firadex`);
      // Снимок DOM для диагностики (важно: _supportLogRaw, чтобы не сбросить idle-таймер)
      try {
        const tabId = supportState.sellerTabId;
        if (tabId) {
          const dbg = await getSupportDebugDOM(tabId);
          if (dbg) {
            _supportLogRaw(`[WATCHDOG-DOM] phase=${dbg.phase} msgs=${dbg.chatMsgCount} input=${dbg.hasInput} fileInput=${dbg.hasFileInput} sendBtn=${dbg.hasSendButton}`);
            _supportLogRaw(`[WATCHDOG-DOM] last bot: ${dbg.lastBotMsg || '—'}`);
            _supportLogRaw(`[WATCHDOG-DOM] last user: ${dbg.lastUserMsg || '—'}`);
          } else {
            _supportLogRaw(`[WATCHDOG] Связь с вкладкой потеряна. Убедитесь что seller.ozon.ru открыта и нажмите «Обновить».`);
          }
        }
      } catch (_) {}
    }

    if (idleMs >= 6 * 60 * 1000) {
      _supportLogRaw(`⛔ [WATCHDOG] ${Math.round(idleMs/60000)} мин без активности — ставлю паузу. Проверьте чат вручную и нажмите «Продолжить» или «Стоп».`);
      supportState.isPaused = true;
      supportState.watchdogWarned = false;
      sendToPopup({ action: 'supportNeedAction', message: `Бот не отвечает ${Math.round(idleMs/60000)} мин. Проверьте чат seller.ozon.ru — возможно Ozon заблокировал чат или поменял интерфейс. Скопируйте лог и пришлите в t.me/firadex.` });
      try { await saveSupportSession(); } catch (_) {}
    }
  }
  function _bumpActivity() {
    supportState.lastActivityTs = Date.now();
    supportState.watchdogWarned = false;
  }

  // Throttle для updatePanel — не чаще раза в секунду, иначе при потоке логов
  // создаются тысячи промисов которые вешают браузер
  let _lastPanelUpdate = 0;
  const PANEL_UPDATE_INTERVAL_MS = 1000;

  // Debounced persist активной сессии жалоб в storage — чтобы popup мог её прочитать
  // даже когда был закрыт во время работы бота
  let _persistActiveTimer = null;
  function buildActiveSupportSessionSnapshot() {
    return {
      isRunning: supportState.isRunning,
      isPaused: supportState.isPaused,
      mode: supportState.mode,
      queue: supportState.queue ? supportState.queue.map(q => ({
        sku: q.sku,
        status: q.status,
        step: q.step || null,
        error: q.error || null,
        chatId: q.chatId || null,
        parentSku: q.parentSku || null,
        parentSkus: Array.isArray(q.parentSkus) ? q.parentSkus.slice() : null,
        _counted: !!q._counted,
        _needsNextEvidence: !!q._needsNextEvidence,
        _evidenceUsedIdx: typeof q._evidenceUsedIdx === 'number' ? q._evidenceUsedIdx : undefined,
        _evidenceResendCount: typeof q._evidenceResendCount === 'number' ? q._evidenceResendCount : undefined,
        _parentTryIdx: typeof q._parentTryIdx === 'number' ? q._parentTryIdx : undefined
      })) : [],
      currentIndex: supportState.currentIndex || 0,
      files: Array.isArray(supportState.files) ? supportState.files : [],
      skuFiles: supportState.skuFiles && typeof supportState.skuFiles === 'object' ? supportState.skuFiles : {},
      evidenceMode: supportState.evidenceMode || 'sku_first',
      fileSkus: Array.isArray(supportState.fileSkus) ? supportState.fileSkus : [],
      parentMap: supportState.parentMap && typeof supportState.parentMap === 'object' ? supportState.parentMap : {},
      complaintType: supportState.complaintType || 'plagiat_legacy',
      logs: (supportState.logs || []).slice(-500),
      sellerTabId: supportState.sellerTabId || null,
      session: supportState.session || null,
      sessionId: supportState.session?.id || null,
      newChatsOpened: supportState.newChatsOpened || 0,
      consecutiveEscalations: supportState.consecutiveEscalations || 0,
      consecutiveFailed: supportState.consecutiveFailed || 0,
      consecutiveInterfaceStuck: supportState.consecutiveInterfaceStuck || 0,
      limits: supportState.limits || { maxChatsPerSession: 10, maxConsecutiveEscalations: 5 },
      limitGateAllowance: supportState.limitGateAllowance || supportState.limits?.maxChatsPerSession || 10,
      limitGateActive: !!supportState.limitGateActive,
      limitGateReason: supportState.limitGateReason || null,
      betaAutostopLimit: supportState.betaAutostopLimit || 5,
      consecutiveAttachFails: supportState.consecutiveAttachFails || 0,
      attachFailAdviceShown: !!supportState.attachFailAdviceShown,
      escalatedRetry: supportState._escalatedRetry || 0,
      chatSoftLimitNoticeAt: supportState._chatSoftLimitNoticeAt || null,
      updatedAt: Date.now()
    };
  }

  async function persistActiveSupportSessionNow() {
    try {
      await chrome.storage.local.set({ activeSupportSession: buildActiveSupportSessionSnapshot() });
    } catch (_) {}
  }

  function persistActiveSupportSession() {
    if (_persistActiveTimer) return; // debounce 1с
    _persistActiveTimer = setTimeout(() => {
      _persistActiveTimer = null;
      try {
        chrome.storage.local.set({ activeSupportSession: buildActiveSupportSessionSnapshot() });
      } catch (_) {}
    }, 1000);
  }

  // Низкоуровневое логирование без bump'а активности — для самого watchdog,
  // чтобы он не сбрасывал свои же таймеры при печати диагностики
  function _supportLogRaw(text) {
    const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = `[${ts}] ${text}`;
    supportState.logs.push(entry);
    sendToPopup({ action: 'supportLog', text: entry });
    console.log('[OZG-Support]', text);
    persistActiveSupportSession();
    return entry;
  }

  async function restoreActiveSupportSession() {
    if (supportState.queue && supportState.queue.length > 0) return true;
    try {
      const data = await chrome.storage.local.get(['activeSupportSession']);
      const s = data.activeSupportSession;
      if (!s || !s.isRunning || !Array.isArray(s.queue) || s.queue.length === 0) return false;

      supportState = {
        isRunning: true,
        isPaused: !!s.isPaused,
        mode: s.mode || 'auto',
        queue: s.queue,
        currentIndex: Math.max(0, Math.min(parseInt(s.currentIndex, 10) || 0, s.queue.length)),
        files: Array.isArray(s.files) ? s.files : [],
        skuFiles: s.skuFiles && typeof s.skuFiles === 'object' ? s.skuFiles : {},
        evidenceMode: s.evidenceMode === 'file_first' ? 'file_first' : 'sku_first',
        fileSkus: Array.isArray(s.fileSkus) ? s.fileSkus : [],
        parentMap: s.parentMap && typeof s.parentMap === 'object' ? s.parentMap : {},
        complaintType: (s.complaintType === 'content_beta' || s.complaintType === 'brand_beta' || s.complaintType === 'plagiat_legacy')
          ? s.complaintType
          : 'plagiat_legacy',
        logs: Array.isArray(s.logs) ? s.logs.slice(-500) : [],
        sellerTabId: s.sellerTabId || null,
        session: s.session || (s.sessionId ? { id: s.sessionId, startedAt: null } : null),
        lastPhase: null,
        phaseRepeatCount: 0,
        maxPhaseRepeats: 4,
        newChatsOpened: s.newChatsOpened || 0,
        consecutiveEscalations: s.consecutiveEscalations || 0,
        limits: s.limits || { maxChatsPerSession: 10, maxConsecutiveEscalations: 5 },
        limitGateAllowance: s.limitGateAllowance || s.limits?.maxChatsPerSession || 10,
        limitGateActive: !!s.limitGateActive,
        limitGateReason: s.limitGateReason || null,
        consecutiveFailed: s.consecutiveFailed || 0,
        consecutiveInterfaceStuck: s.consecutiveInterfaceStuck || 0,
        maxConsecutiveInterfaceStuck: s.maxConsecutiveInterfaceStuck || 5,
        betaAutostopLimit: s.betaAutostopLimit || 5,
        navClickRetries: {},
        lastActivityTs: Date.now(),
        watchdogWarned: false,
        consecutiveAttachFails: s.consecutiveAttachFails || 0,
        attachFailAdviceShown: !!s.attachFailAdviceShown,
        _escalatedRetry: s.escalatedRetry || 0,
        _chatSoftLimitNoticeAt: s.chatSoftLimitNoticeAt || null
      };
      _supportLogRaw('[RESTORE] Активная сессия жалоб восстановлена после сна service worker');
      return true;
    } catch (e) {
      console.log('[OZG-Support] restoreActiveSupportSession:', e.message);
      return false;
    }
  }

  function supportLog(text) {
    const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = `[${ts}] ${text}`;
    supportState.logs.push(entry);
    sendToPopup({ action: 'supportLog', text: entry });
    console.log('[OZG-Support]', text);
    // Любой лог = признак активности → перезапуск watchdog-таймера
    _bumpActivity();
    persistActiveSupportSession();
    // Обновить плавающую панель на seller.ozon.ru — с throttle и БЕЗ рекурсивного логирования
    // (раньше sendToSupport при ошибке вызывал supportLog → бесконечный каскад)
    const now = Date.now();
    if (supportState.sellerTabId && now - _lastPanelUpdate > PANEL_UPDATE_INTERVAL_MS) {
      _lastPanelUpdate = now;
      // ПРЯМОЙ chrome.tabs.sendMessage без авто-инжекта и без логирования при ошибке
      try {
        chrome.tabs.sendMessage(supportState.sellerTabId, {
          _ozguard: true, action: 'updatePanel',
          params: { log: entry, current: supportState.currentIndex + 1, total: supportState.queue.length }
        }, () => { void chrome.runtime.lastError; }); // молча проглатываем ошибку
      } catch (_) {}
    }
  }

  // Pre-flight проверка перед запуском жалоб:
  // 1) Если несколько вкладок seller.ozon.ru — попросить закрыть лишние
  // 2) Если одна — попробовать тестовую инъекцию (старые вкладки от предыдущей сессии расширения
  //    дают ошибку "Cannot access contents of the page" — из-за этого был баг с зацикливанием логов)
  async function preflightSellerTabs() {
    const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });

    // 0 вкладок — создаём новую
    if (tabs.length === 0) {
      try {
        const newTab = await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/messenger/?group=support_v2', active: false });
        await waitForTabComplete(newTab.id);
        await delay(3000);
        return { ok: true, tabId: newTab.id };
      } catch (e) {
        return { ok: false, code: 'no_tab', error: 'Не удалось открыть seller.ozon.ru. Откройте вручную и повторите.' };
      }
    }

    // Несколько вкладок — просим закрыть лишние
    if (tabs.length > 1) {
      return {
        ok: false,
        code: 'multiple_tabs',
        error: `Открыто ${tabs.length} вкладок seller.ozon.ru. Закройте все, оставьте только ОДНУ вкладку с чатом поддержки и нажмите «Начать» снова.`
      };
    }

    // Одна вкладка — тест инъекции
    const tab = tabs[0];
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        func: () => true
      });
      return { ok: true, tabId: tab.id };
    } catch (e) {
      // Старая вкладка от предыдущей сессии расширения — Chrome не разрешает скриптить
      return {
        ok: false,
        code: 'stale_tab',
        error: 'Старая вкладка seller.ozon.ru несовместима с обновлённым расширением. Закройте её, откройте новую (Ctrl+T → seller.ozon.ru) и нажмите «Начать» снова.'
      };
    }
  }

  async function findSellerTab() {
    const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    // Строгий приоритет: вкладка с support_v2 (чат поддержки)
    const supportTab = tabs.find(t => t.url && t.url.includes('group=support_v2'));
    if (supportTab) {
      supportState.sellerTabId = supportTab.id;
      return supportTab.id;
    }
    // Вкладка мессенджера без конкретной группы (может быть поддержка)
    const messengerTab = tabs.find(t => t.url && t.url.includes('/app/messenger') && !t.url.includes('group=customers'));
    if (messengerTab) {
      supportState.sellerTabId = messengerTab.id;
      return messengerTab.id;
    }
    // Любая вкладка seller.ozon.ru (будет перенаправлена на support_v2)
    if (tabs.length > 0) {
      supportState.sellerTabId = tabs[0].id;
      return tabs[0].id;
    }
    // Нет вкладки — создаём новую с чатом поддержки
    try {
      supportLog('Вкладка seller.ozon.ru не найдена — открываю автоматически...');
      const newTab = await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/messenger/?group=support_v2', active: false });
      await waitForTabComplete(newTab.id);
      await delay(3000); // даём SPA загрузиться
      supportState.sellerTabId = newTab.id;
      return newTab.id;
    } catch (e) {
      supportLog(`Не удалось открыть seller.ozon.ru: ${e.message}`);
      return null;
    }
  }

  // Circuit breaker: считает подряд неудачные injections.
  // Если падает >= MAX_INJECT_FAILURES за < MAX_INJECT_WINDOW_MS — аварийная остановка.
  const MAX_INJECT_FAILURES = 5;
  const MAX_INJECT_WINDOW_MS = 10000;
  let _injectFailureTimes = [];

  function recordInjectFailure() {
    const now = Date.now();
    _injectFailureTimes.push(now);
    // Оставляем только события за последнее окно
    _injectFailureTimes = _injectFailureTimes.filter(t => now - t < MAX_INJECT_WINDOW_MS);
    return _injectFailureTimes.length;
  }

  function resetInjectFailures() { _injectFailureTimes = []; }

  // Программная инъекция content scripts (НЕ через manifest — иначе не работает на уже открытых вкладках)
  // ВАЖНО: НЕ логируем ошибки через supportLog — это вызывало рекурсию (supportLog → updatePanel → fail → supportLog)
  async function injectSupportScripts(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ['content/support-automation.js']
      });
      resetInjectFailures();
      return true;
    } catch (e) {
      // Тихая запись ошибки — без вызова supportLog, чтобы не триггерить каскад
      console.log('[OZG-Support] Ошибка инъекции:', e.message);
      const failureCount = recordInjectFailure();
      // Circuit breaker: останавливаем всё если слишком много ошибок подряд
      if (failureCount >= MAX_INJECT_FAILURES && supportState.isRunning) {
        supportState.isRunning = false;
        supportState.isPaused = false;
        supportLog(`⛔ Critical: ${failureCount} ошибок инъекции за ${MAX_INJECT_WINDOW_MS / 1000}с — аварийная остановка`);
        sendToPopup({
          action: 'supportNeedAction',
          message: 'Не удалось получить доступ к вкладке seller.ozon.ru. ЗАКРОЙТЕ ВСЕ старые вкладки seller.ozon.ru, откройте новую и нажмите «Начать» снова.'
        });
        try { saveSupportSession(); } catch (_) {}
      }
      return false;
    }
  }

  // Перейти на страницу чатов поддержки + инжект скриптов
  async function ensureSellerChatPage(tabId) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      supportLog('⚠ Вкладка закрыта — ищу заново...');
      const newTabId = await findSellerTab();
      if (!newTabId) {
        supportLog('❌ Не удалось найти или открыть seller.ozon.ru');
        return false;
      }
      supportState.sellerTabId = newTabId;
      tab = await chrome.tabs.get(newTabId);
      tabId = newTabId;
    }

    const url = tab.url || '';

    // Проверка: редирект на логин (не авторизован)
    if (url.includes('/signin') || url.includes('/login') || url.includes('passport.ozon.ru')) {
      supportLog('⚠ Требуется авторизация на seller.ozon.ru — войдите в аккаунт');
      sendToPopup({ action: 'supportNeedAction', message: 'Войдите в аккаунт seller.ozon.ru и нажмите «Обновить»' });
      return false;
    }

    // ВАЖНО: нужна именно support_v2, а не customers_v2 или другая группа
    const onSupportChat = url.includes('group=support_v2') ||
      (url.includes('/app/messenger') && !url.includes('group=') && !url.includes('&id='));
    if (!onSupportChat) {
      supportLog('Переход на чат поддержки (support_v2)...');
      await chrome.tabs.update(tabId, { url: 'https://seller.ozon.ru/app/messenger/?group=support_v2' });
      await waitForTabComplete(tabId);
      await delay(5000);
      // Повторная проверка — мог произойти редирект на логин
      const updatedTab = await chrome.tabs.get(tabId);
      const updatedUrl = updatedTab.url || '';
      if (updatedUrl.includes('/signin') || updatedUrl.includes('/login') || updatedUrl.includes('passport.ozon.ru')) {
        supportLog('⚠ Требуется авторизация на seller.ozon.ru');
        sendToPopup({ action: 'supportNeedAction', message: 'Войдите в аккаунт seller.ozon.ru и нажмите «Обновить»' });
        return false;
      }
    }
    await injectSupportScripts(tabId);
    await delay(2000);
    return { ok: true, tabId };
  }

  // Отправить команду в content script (ISOLATED world, direct chrome.runtime.onMessage)
  // При ошибке связи — авто-инжект скрипта и повтор
  // ВАЖНО: используем тихий console.log вместо supportLog для технических ошибок,
  // иначе рекурсия (supportLog → updatePanel → fail → supportLog → ...)
  function sendToSupport(tabId, action, params) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { _ozguard: true, action, params }, async (resp) => {
        if (chrome.runtime.lastError) {
          // Тихая запись + авто-инжект и повтор
          console.log('[OZG-Support] Нет связи, инжектирую...', chrome.runtime.lastError.message);
          const injected = await injectSupportScripts(tabId);
          if (!injected) { resolve(null); return; }
          await delay(2000);
          // Повторная попытка
          chrome.tabs.sendMessage(tabId, { _ozguard: true, action, params }, (resp2) => {
            if (chrome.runtime.lastError) {
              console.log('[OZG-Support] Повторная ошибка связи:', chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            resolve(resp2);
          });
          return;
        }
        resolve(resp);
      });
    });
  }

  async function getSupportPageState(tabId) {
    return await sendToSupport(tabId, 'getState');
  }

  async function getSupportDebugDOM(tabId) {
    return await sendToSupport(tabId, 'debugDOM');
  }

  async function saveSupportSession() {
    try {
      const session = {
        id: supportState.session?.id || Date.now().toString(36),
        startedAt: supportState.session?.startedAt || new Date().toISOString(),
        completedAt: supportState.isRunning ? null : new Date().toISOString(),
        mode: supportState.mode,
        complaintType: supportState.complaintType,
        queue: supportState.queue.map(q => ({ sku: q.sku, status: q.status, chatId: q.chatId || null, error: q.error || null })),
        logs: supportState.logs.slice(-500)
      };
      const data = await chrome.storage.local.get(['supportHistory']);
      let history = data.supportHistory || [];
      // Обновляем существующую или добавляем новую
      const idx = history.findIndex(h => h.id === session.id);
      if (idx >= 0) history[idx] = session;
      else history.unshift(session);
      if (history.length > 10) history = history.slice(0, 10);

      // Быстрый доступ: SKU с финальным статусом для skip-логики на рестарте
      const processedSkus = supportState.queue
        .filter(q => q.status === 'done' || q.status === 'failed' || q.status === 'skipped' ||
          q.status === 'escalated' || q.status === 'no_violation')
        .map(q => ({ sku: q.sku, status: q.status }));

      await chrome.storage.local.set({
        supportHistory: history,
        complaintProgress: {
          sessionId: session.id,
          processedSkus,
          updatedAt: Date.now()
        }
      });
    } catch (e) {}
  }

  // === Хелперы для работы с файлами и лимитами v5.9.10 ===
  const MAX_SUPPORT_FILE_BYTES = 50 * 1024 * 1024;

  // Выбрать набор файлов для конкретного SKU конкурента.
  // v5.9.20: поддерживает 2 режима через supportState.evidenceMode:
  //   'sku_first' (default) — sku → [files]: per-parent файлы (объединение со всех родителей, дедуп)
  //   'file_first'           — file → [skus]: для каждого файла проверяем, что parent SKU входит в его список
  // Fallback к общему пулу supportState.files если ничего не нашли.
  function pickFilesForItem(item) {
    const parentSkus = (item.parentSkus && Array.isArray(item.parentSkus) && item.parentSkus.length > 0)
      ? item.parentSkus
      : (item.parentSku ? [item.parentSku] : []);
    const parents = Array.from(new Set([
      ...parentSkus.map(p => String(p || '').trim()).filter(Boolean),
      String(item.sku || '').trim()
    ].filter(Boolean)));
    const mode = supportState.evidenceMode || 'sku_first';
    const out = [];
    const seen = new Set();

    if (mode === 'file_first' && Array.isArray(supportState.fileSkus) && supportState.fileSkus.length > 0) {
      // Каждый file имеет lightweight-метаданные + skus: ['12345', '67890'].
      // Включаем file если хотя бы один parent SKU есть в его skus.
      for (const f of supportState.fileSkus) {
        const fileSkus = Array.isArray(f.skus) ? f.skus.map(s => String(s).trim()) : [];
        if (fileSkus.length === 0) continue;
        const matches = parents.some(p => fileSkus.includes(String(p).trim()));
        if (!matches) continue;
        const key = f.id || ((f.name || '') + '|' + (f.size || 0));
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
      }
      if (out.length > 0) return { files: out, source: 'file_first' };
    } else {
      // sku_first (или fallback)
      for (const p of parents) {
        const list = supportState.skuFiles && supportState.skuFiles[p];
        if (!Array.isArray(list) || list.length === 0) continue;
        for (const f of list) {
          const key = f.id || ((f.name || '') + '|' + (f.size || 0));
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(f);
        }
      }
      if (out.length > 0) return { files: out, source: 'parent' };
    }

    if (Array.isArray(supportState.files) && supportState.files.length > 0) {
      return { files: supportState.files.slice(), source: 'common' };
    }
    return { files: [], source: 'none' };
  }

  // === BETA navigation (v5.9.15) ===
  // Резолвер кнопки для каждой навигационной фазы в зависимости от complaintPath.
  // Возвращает { patterns, label } — массив паттернов для pageClickButton и человекочитаемую метку для лога.
  function resolveNavButton(phase, path) {
    const isBeta = path === 'content_beta' || path === 'brand_beta';
    switch (phase) {
      case 'direction_selection':
        return isBeta
          ? { patterns: ['товары и цены'], label: 'Товары и Цены' }
          : { patterns: ['личный кабинет'], label: 'Личный кабинет' };
      case 'category_selection':
        return isBeta
          ? { patterns: ['контроль качества'], label: 'Контроль качества' }
          : { patterns: ['кабинет бренда'], label: 'Кабинет бренда' };
      case 'complaint_type':
        return isBeta
          ? { patterns: ['нарушение правил площадки'], label: 'Нарушение правил площадки другим продавцом' }
          : { patterns: ['жалоба на товар/продавца', 'жалоба на товар', 'жалоба'], label: 'Жалоба на товар/продавца' };
      case 'complaint_subtype':
        // В BETA пути этого экрана НЕТ — всё равно вернём дефолт на случай detection edge-case
        return { patterns: ['плагиат', 'копирование', 'нарушение интеллект'], label: 'Плагиат карточек товара' };
      case 'complaint_detail':
        if (path === 'brand_beta') return { patterns: ['использование моего бренда'], label: 'Использование моего бренда' };
        // content_beta и plagiat_legacy используют одну и ту же кнопку
        return { patterns: ['использование моих фото, видео, текста', 'использование моих', 'фото, видео, текст'], label: 'Использование моих фото, видео, текста' };
      default:
        return null;
    }
  }

  // Хелпер: отметить item как завершённый и обновить consecutiveFailed.
  // Вызывается ВМЕСТО прямого `item.status = ...` там где это критично для BETA-autostop.
  // Также используется в начале supportProcessStep для обработки ранее-завершённых.
  function markItemStatus(item, status, error) {
    if (!item) return;
    item.status = status;
    if (error) item.error = error;
    if (!item._counted) {
      item._counted = true;
      if (status === 'failed') supportState.consecutiveFailed = (supportState.consecutiveFailed || 0) + 1;
      else if (status === 'done' || status === 'escalated' || status === 'no_violation') supportState.consecutiveFailed = 0;
      // v5.9.37: любой "не-стак" статус сбрасывает счётчик interface-stuck recovery
      if (status === 'done' || status === 'escalated' || status === 'no_violation') {
        supportState.consecutiveInterfaceStuck = 0;
      }
    }
  }

  // Лог с префиксом [BETA] для новых путей — упрощает поиск проблем в массиве логов
  function pathLog(msg) {
    const p = supportState.complaintType;
    if (p === 'content_beta' || p === 'brand_beta') {
      supportLog(`[BETA] ${msg}`);
    } else {
      supportLog(msg);
    }
  }

  // Общий обработчик навигационного клика для всех phase = direction_selection/category_selection/...
  // Считает retry, логгирует, при превышении — failed + autostop проверка.
  async function handleNavPhase(tabId, phase, state) {
    const resolved = resolveNavButton(phase, supportState.complaintType);
    if (!resolved) return null; // не навигационная фаза — дальше по основной логике
    const { patterns, label } = resolved;

    const retryKey = phase;
    const curRetry = supportState.navClickRetries[retryKey] || 0;

    // Проверка что нужная кнопка действительно видна в текущем меню
    const visibleBtns = state.buttons || [];
    const buttonPresent = patterns.some(p => visibleBtns.some(b => b.includes(p)));
    if (!buttonPresent) {
      pathLog(`⚠ Кнопка «${label}» НЕ найдена в меню (${visibleBtns.length} кнопок: [${visibleBtns.slice(0, 6).join(', ')}...])`);
      supportState.navClickRetries[retryKey] = curRetry + 1;
      if (supportState.navClickRetries[retryKey] >= 3) {
        // v5.9.32: остановка с явным сообщением «Ozon изменил интерфейс».
        // Раньше делали только delay+continue → loop guard срабатывал позже c менее
        // понятным «Зацикливание на фазе X». Теперь пауза + supportNeedAction сразу.
        const visibleList = visibleBtns.slice(0, 6).join(', ') || '—';
        pathLog(`⛔ ИНТЕРФЕЙС OZON ИЗМЕНИЛСЯ: кнопка «${label}» не найдена в меню после 3 проверок. Путь жалоб «${supportState.complaintType}» больше не работает.`);
        sendToPopup({
          action: 'supportNeedAction',
          message: `Похоже, Ozon изменил интерфейс жалоб: на шаге «${phase}» нет кнопки «${label}». Видимые кнопки: ${visibleList}. Проверьте чат вручную, попробуйте другой тип жалобы или сообщите в t.me/firadex.`
        });
        supportState.navClickRetries[retryKey] = 0;
        supportState.isPaused = true;
        try { await persistActiveSupportSessionNow(); } catch (_) {}
        return 'wait';
      }
      await delay(3000);
      return 'continue';
    }

    await humanDelay(800 + Math.random() * 1200);
    pathLog(`Клик «${label}» (фаза ${phase}, путь ${supportState.complaintType})...`);
    const resp = await pageClickButton(tabId, patterns);
    if (!resp?.ok) {
      pathLog(`⚠ Клик «${label}» неуспешен (${resp?.error || ''}), retry ${curRetry + 1}/3`);
      supportState.navClickRetries[retryKey] = curRetry + 1;
      if (supportState.navClickRetries[retryKey] >= 3) {
        pathLog(`✗ Кнопка «${label}» не кликается после 3 попыток — остановка навигации`);
        supportState.navClickRetries[retryKey] = 0;
      }
      await delay(3000);
      return 'continue';
    }
    // Успешный клик — сброс retry
    supportState.navClickRetries[retryKey] = 0;
    pathLog(`✓ «${label}» кликнута`);
    await humanDelay(2500 + Math.random() * 1500);
    return 'continue';
  }

  // BETA autostop: если 5 SKU подряд failed на BETA-пути — пауза с предупреждением
  async function checkBetaAutostop() {
    const p = supportState.complaintType;
    if (p !== 'content_beta' && p !== 'brand_beta') return true;
    if (supportState.consecutiveFailed >= (supportState.betaAutostopLimit || 5)) {
      if (!supportState.limitGateActive) {
        supportState.limitGateActive = true;
        supportState.limitGateReason = 'beta_autostop';
        supportState.isPaused = true;
        pathLog(`⛔ AUTOSTOP: ${supportState.consecutiveFailed} SKU подряд в failed на BETA-пути`);
        sendToPopup({
          action: 'supportLimitReached',
          title: `BETA: ${supportState.consecutiveFailed} ошибок подряд`,
          details: `Режим BETA (${p === 'content_beta' ? 'Использование моего контента' : 'Использование моего бренда'}) остановлен — ${supportState.consecutiveFailed} SKU подряд завершились ошибкой. Возможно путь в чате Ozon изменился. Проверьте вручную или переключитесь на «Плагиат моих карточек». Нажмите «Продолжить» чтобы попробовать ещё, «Остановить» чтобы прервать.`
        });
        await saveSupportSession();
      }
      return false;
    }
    return true;
  }

  // Проверка лимита новых обращений перед навигацией/открытием нового чата.
  // v5.9.25: лимит больше не останавливает бота и не требует «Продолжить».
  // Счётчик оставлен как мягкая диагностика, чтобы большие пакеты не зависали на gate.
  async function canOpenNewChat() {
    const opened = supportState.newChatsOpened;
    const allow = supportState.limitGateAllowance;
    if (opened >= allow) {
      const nextNoticeAt = supportState._chatSoftLimitNoticeAt || allow;
      if (opened >= nextNoticeAt) {
        const step = Math.max(1, supportState.limits.maxChatsPerSession || 50);
        supportState._chatSoftLimitNoticeAt = opened + step;
        supportLog(`ℹ Создано ${opened} новых обращений. Автопауза лимита отключена, бот продолжает работу с антибот-паузами.`);
      }
    }
    return true;
  }

  // Проверка подряд идущих эскалаций (Q2).
  // v5.9.25: без ручного gate — только предупреждение и мягкая антибот-пауза.
  async function checkConsecutiveEscalations() {
    const maxConsec = supportState.limits.maxConsecutiveEscalations;
    if (maxConsec === 0) {
      // Режим «брендовый каталог»: только увеличенная пауза, не останавливаемся.
      // Пауза прерываемая — если юзер нажал ⏸/⏹, выходим сразу.
      const betweenDelay = 20000 + Math.random() * 15000;
      const ok = await supportKeepaliveDelay(betweenDelay, {
        label: `⏱ Длинная антибот-пауза при эскалациях подряд ${supportState.consecutiveEscalations}`,
        logEveryMs: 10000
      });
      if (!ok) return false; // прервана — остановка в вызывающем
      return true;
    }
    if (supportState.consecutiveEscalations >= maxConsec) {
      const betweenDelay = 20000 + Math.random() * 15000;
      const ok = await supportKeepaliveDelay(betweenDelay, {
        label: `⚠ ${supportState.consecutiveEscalations} эскалаций подряд — ручная остановка отключена, делаю антибот-паузу и продолжаю`,
        logEveryMs: 10000
      });
      if (!ok) return false;
    }
    return true;
  }

  // Инкремент счётчика новых обращений — вызывается когда мы ТОЧНО открыли новый чат
  function registerNewChatOpened(reason) {
    supportState.newChatsOpened++;
    supportLog(`[chat-counter] Новое обращение открыто (${supportState.newChatsOpened}/${supportState.limitGateAllowance}) — ${reason || ''}`);
  }

  // Уведомить popup о проблемном SKU
  function notifyProblem(category, sku, error) {
    sendToPopup({ action: 'supportProblem', category, sku, error });
  }

  function resetSupportItemTransientState(item) {
    supportState.lastPhase = null;
    supportState.phaseRepeatCount = 0;
    supportState._staleWaitCount = 0;
    if (item) {
      delete item._needsNextEvidence;
      delete item._evidenceUsedIdx;
      delete item._evidenceResendCount;
      delete item._parentTryIdx;
    }
  }

  async function finishProblemSupportItem(tabId, item, idx, error, opts = {}) {
    const status = opts.status || 'failed';
    const category = opts.category || status;
    const recoverChat = !!opts.recoverChat;

    if (opts.logMessage) supportLog(opts.logMessage);
    if (item) {
      item.status = status;
      item.step = 'completed';
      item.error = error;
      if (category) notifyProblem(category, item.sku, item.error);
    }

    supportState.currentIndex = Math.max(supportState.currentIndex, idx + 1);
    resetSupportItemTransientState(item);
    sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });
    await saveSupportSession();

    if (recoverChat && supportState.isRunning && supportState.currentIndex < supportState.queue.length) {
      supportLog(opts.recoverLogMessage || 'Открываю новую страницу чатов для следующего SKU после ошибки текущего обращения...');
      const nextTabId = await openSupportChatsPage(tabId, 'восстановление после ошибки текущего обращения');
      if (!nextTabId) {
        await pauseSupportForChatRecoveryFailure('Не удалось открыть новую страницу чатов после ошибки текущего SKU');
        return false;
      }
    } else {
      await humanDelay(2000);
    }
    return true;
  }

  async function pauseSupportForChatRecoveryFailure(reason) {
    supportState.isPaused = true;
    supportState.lastPhase = null;
    supportState.phaseRepeatCount = 0;
    supportState._staleWaitCount = 0;
    supportLog(`⛔ ${reason}. Ставлю паузу, чтобы следующий SKU не ушёл в старое обращение.`);
    sendToPopup({
      action: 'supportNeedAction',
      message: `${reason}. Проверьте seller.ozon.ru и нажмите «Продолжить».`
    });
    await saveSupportSession();
    await persistActiveSupportSessionNow();
  }

  async function openSupportChatsPage(tabId, reason) {
    let targetTabId = tabId || supportState.sellerTabId;
    try {
      if (targetTabId) await chrome.tabs.get(targetTabId);
    } catch (_) {
      targetTabId = null;
    }

    if (!targetTabId) {
      supportLog(`⚠ Вкладка потерялась (${reason || 'переход к чатам'}) — ищу seller.ozon.ru заново...`);
      targetTabId = await findSellerTab();
    }

    if (!targetTabId) {
      supportLog('❌ Не удалось найти или открыть вкладку seller.ozon.ru');
      return null;
    }

    try {
      supportState.sellerTabId = targetTabId;
      await chrome.tabs.update(targetTabId, { url: 'https://seller.ozon.ru/app/messenger/?group=support_v2' });
      await waitForTabComplete(targetTabId);
      await delay(4000);
      await injectSupportScripts(targetTabId);
      await delay(2000);
      return targetTabId;
    } catch (e) {
      supportLog(`Ошибка перехода к чатам (${reason || 'support_v2'}): ${e.message}`);
      return null;
    }
  }

  // Верификация что текущий SKU действительно дошёл до оператора/обработан.
  // Нужно для v5.9.10 требования «точно видит что чат передан в поддержку на рассмотрение»
  // перед созданием нового обращения.
  async function verifyItemHandedOff(tabId, item) {
    // Смотрим lastBotMsg + наличие системного уведомления о передаче оператору
    try {
      const debug = await getSupportDebugDOM(tabId);
      const bot = (debug?.lastBotMsg || '').toLowerCase();
      const handed = bot.includes('направил') || bot.includes('направили') ||
                     bot.includes('коллегам') || bot.includes('рассмотрит') ||
                     bot.includes('оператор') || bot.includes('создайте новое обращение');
      const confirmed = bot.includes('скрыли товар') && bot.includes(item.sku);
      return { handed, confirmed, botMsg: bot };
    } catch (e) {
      return { handed: false, confirmed: false, botMsg: '' };
    }
  }

  // Обёртки для действий на странице
  async function pageClickButton(tabId, patterns) {
    return await sendToSupport(tabId, 'clickButton', patterns);
  }
  async function pageClickNewChat(tabId) {
    return await sendToSupport(tabId, 'clickNewChat');
  }
  async function pageSendText(tabId, text) {
    return await sendToSupport(tabId, 'sendText', text);
  }
  async function pageAttachFile(tabId, fileName, fileBase64, fileMimeType) {
    return await sendToSupport(tabId, 'attachFile', { name: fileName, base64: fileBase64, type: fileMimeType });
  }

  function getComplaintFileBlobKey(source) {
    if (source === 'sku') return 'complaintSkuFilesBlobs';
    if (source === 'file_first') return 'complaintFileSkusBlobs';
    return 'complaintFilesBlobs';
  }

  function ozgOpenFileDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ozguard-files', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function ozgGetFileBlobFromDB(id) {
    const db = await ozgOpenFileDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function ozgBlobToBase64InWorker(blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  async function requestComplaintFileFromPopup(file) {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done({
        ok: false,
        error: 'Таймаут чтения файла. Откройте popup OZGuard и повторите запуск.'
      }), 120000);

      try {
        chrome.runtime.sendMessage({
          action: 'getComplaintFilePayload',
          source: file.source || 'common',
          id: file.id
        }, (resp) => {
          if (chrome.runtime.lastError) {
            done({
              ok: false,
              error: 'Откройте popup OZGuard, чтобы расширение могло прочитать крупный файл из IndexedDB'
            });
            return;
          }
          if (!resp || !resp.ok || !resp.file?.base64) {
            done({ ok: false, error: resp?.error || 'Не удалось прочитать файл' });
            return;
          }
          done({ ok: true, file: resp.file });
        });
      } catch (e) {
        done({ ok: false, error: e.message || String(e) });
      }
    });
  }

  async function resolveComplaintFilePayload(file) {
    if (file?.base64) return file; // backward compatibility with old in-memory sessions
    if (!file?.id) throw new Error('Файл без id — обновите доказательства в popup');
    const declaredSize = Number(file.size) || 0;
    if (declaredSize > MAX_SUPPORT_FILE_BYTES) {
      throw new Error(`Файл больше безопасного лимита ${Math.round(MAX_SUPPORT_FILE_BYTES / 1024 / 1024)} MB — сожмите видео или загрузите меньший файл`);
    }

    if ((file.storage || 'local') === 'local') {
      const key = getComplaintFileBlobKey(file.source || 'common');
      try {
        const data = await chrome.storage.local.get([key]);
        const b64 = data?.[key]?.[file.id];
        if (b64) {
          const approxBytes = Math.round(b64.length * 0.75);
          if (approxBytes > MAX_SUPPORT_FILE_BYTES) {
            throw new Error(`Файл больше безопасного лимита ${Math.round(MAX_SUPPORT_FILE_BYTES / 1024 / 1024)} MB — сожмите видео или загрузите меньший файл`);
          }
          return {
            ...file,
            base64: b64,
            type: file.type || 'application/octet-stream'
          };
        }
      } catch (e) {
        if ((e?.message || '').includes('больше безопасного лимита')) throw e;
      }
    }

    if (file.storage === 'idb') {
      try {
        const rec = await ozgGetFileBlobFromDB(file.id);
        if (rec && rec.blob) {
          const actualSize = Number(rec.size || rec.blob.size) || 0;
          if (actualSize > MAX_SUPPORT_FILE_BYTES) {
            throw new Error(`Файл больше безопасного лимита ${Math.round(MAX_SUPPORT_FILE_BYTES / 1024 / 1024)} MB — сожмите видео или загрузите меньший файл`);
          }
          return {
            ...file,
            name: rec.name || file.name,
            type: rec.type || file.type || 'application/octet-stream',
            base64: await ozgBlobToBase64InWorker(rec.blob)
          };
        }
      } catch (e) {
        if ((e?.message || '').includes('больше безопасного лимита')) throw e;
      }
    }

    const resp = await requestComplaintFileFromPopup(file);
    if (resp.ok) {
      return {
        ...file,
        ...resp.file,
        type: resp.file.type || file.type || 'application/octet-stream'
      };
    }
    throw new Error(resp.error || 'Не удалось прочитать файл');
  }

  // Главный цикл автоматизации — заменяет рекурсию
  // Лимит: 20 итераций на один SKU (защита от зацикливания)
  // Общий лимит: 20 * количество SKU + 50 запас (навигация, setup)
  const MAX_ITERATIONS_PER_SKU = 20;
  const MAX_ITERATIONS_BASE = 50;
  function ensureSupportLoop(tabId, reason) {
    if (!supportState.isRunning || supportState.isPaused) return false;
    const targetTabId = tabId || supportState.sellerTabId;
    if (!targetTabId) return false;

    if (supportLoopRunning) {
      console.log(`[OZG-Support] support loop already running (${reason || 'unknown'})`);
      return false;
    }

    supportState.sellerTabId = targetTabId;
    const token = ++supportLoopToken;
    supportLoopRunning = true;
    console.log(`[OZG-Support] support loop start (${reason || 'manual'}, token=${token})`);
    supportProcessLoop(targetTabId, token)
      .catch(async (e) => {
        supportLog(`⛔ Ошибка цикла жалоб: ${e.message}`);
        try { await saveSupportSession(); } catch (_) {}
      })
      .finally(() => {
        if (supportLoopToken === token) {
          supportLoopRunning = false;
          console.log(`[OZG-Support] support loop finished (token=${token})`);
        }
      });
    return true;
  }

  async function supportProcessLoop(tabId, token) {
    const totalSkus = supportState.queue ? supportState.queue.length : 100;
    const maxTotal = MAX_ITERATIONS_PER_SKU * totalSkus + MAX_ITERATIONS_BASE;
    let iterSinceLastProgress = 0; // Счётчик итераций без смены SKU
    let lastSkuIndex = supportState.currentIndex;

    for (let _iter = 0; _iter < maxTotal; _iter++) {
      if (token && token !== supportLoopToken) return;
      if (!supportState.isRunning || supportState.isPaused) return;
      await delay(50);
      if (token && token !== supportLoopToken) return;
      const stepResult = await supportProcessStep(tabId);
      if (stepResult === 'done' || stepResult === 'stop' || stepResult === 'wait') return;
      if (supportState.sellerTabId) tabId = supportState.sellerTabId;

      // Проверка прогресса: если SKU сменился — сброс счётчика
      if (supportState.currentIndex !== lastSkuIndex) {
        lastSkuIndex = supportState.currentIndex;
        iterSinceLastProgress = 0;
      } else {
        iterSinceLastProgress++;
      }

      // Зацикливание на одном SKU
      if (iterSinceLastProgress >= MAX_ITERATIONS_PER_SKU) {
        const idx = supportState.currentIndex;
        const item = supportState.queue[idx];
        if (item) {
          await finishProblemSupportItem(tabId, item, idx, 'Зацикливание', {
            recoverChat: true,
            logMessage: `⛔ Зацикливание на SKU ${item.sku}: ${MAX_ITERATIONS_PER_SKU} итераций без прогресса — пропускаю`
          });
        } else {
          supportLog(`⛔ Зацикливание на SKU ${idx}: ${MAX_ITERATIONS_PER_SKU} итераций без прогресса — пропускаю`);
          supportState.currentIndex++;
        }
        lastSkuIndex = supportState.currentIndex;
        iterSinceLastProgress = 0;
        // Продолжаем с следующим SKU
      }
    }
    supportLog('⛔ Превышен общий лимит итераций (' + maxTotal + ') — аварийная остановка');
    supportState.isRunning = false;
    sendToPopup({ action: 'supportNeedAction', message: 'Аварийная остановка: превышен лимит итераций' });
    await saveSupportSession();
  }

  // Один шаг автоматизации. Возвращает: 'continue' | 'done' | 'stop' | 'wait'
  async function supportProcessStep(tabId) {
    if (!supportState.isRunning || supportState.isPaused) return 'stop';

    // v5.9.15: перед обработкой текущего SKU учитываем итоги ПРЕДЫДУЩЕГО
    // (если он только что завершился failed/done — обновляем consecutiveFailed для BETA autostop)
    const prevIdx = supportState.currentIndex - 1;
    if (prevIdx >= 0 && prevIdx < supportState.queue.length) {
      const prev = supportState.queue[prevIdx];
      if (prev && !prev._counted && (prev.status === 'failed' || prev.status === 'done' ||
          prev.status === 'escalated' || prev.status === 'no_violation')) {
        prev._counted = true;
        if (prev.status === 'failed') supportState.consecutiveFailed = (supportState.consecutiveFailed || 0) + 1;
        else supportState.consecutiveFailed = 0;
        // v5.9.37: сбрасываем счётчик interface-stuck recovery при любом успешном статусе
        if (prev.status === 'done' || prev.status === 'escalated' || prev.status === 'no_violation') {
          supportState.consecutiveInterfaceStuck = 0;
        }
        // BETA autostop: проверяем перед началом следующего SKU
        const autostopOk = await checkBetaAutostop();
        if (!autostopOk) return 'wait';
      }
    }

    const idx = supportState.currentIndex;
    if (idx >= supportState.queue.length) {
      supportState.isRunning = false;
      supportLog('✅ Все жалобы обработаны');
      sendToPopup({ action: 'supportComplete', queue: supportState.queue });
      await saveSupportSession();
      return 'done';
    }

    const item = supportState.queue[idx];
    if (item.status === 'done' || item.status === 'failed' || item.status === 'skipped' ||
        item.status === 'escalated' || item.status === 'no_violation') {
      // v5.9.15: если это уже-обработанный из предыдущей сессии (не через prev-логику выше) —
      // обновляем счётчик всё равно
      if (!item._counted) {
        item._counted = true;
        if (item.status === 'failed') supportState.consecutiveFailed = (supportState.consecutiveFailed || 0) + 1;
        else if (item.status === 'done' || item.status === 'escalated' || item.status === 'no_violation') supportState.consecutiveFailed = 0;
      }
      supportState.currentIndex++;
      supportState._escalatedRetry = 0; // сброс счётчика handoff retry
      supportState.navClickRetries = {}; // сброс retry навигационных кликов для нового SKU
      sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });
      return 'continue';
    }

    pathLog(`[${idx + 1}/${supportState.queue.length}] Обработка SKU ${item.sku}`);
    sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });

    // === Проверка что мы на правильной странице (support_v2) ===
    try {
      const currentTab = await chrome.tabs.get(tabId);
      const currentUrl = currentTab.url || '';
      // Проверка авторизации
      if (currentUrl.includes('/signin') || currentUrl.includes('/login') || currentUrl.includes('passport.ozon.ru')) {
        supportLog('⚠ Сессия истекла — требуется авторизация на seller.ozon.ru');
        item.status = 'waiting';
        sendToPopup({ action: 'supportNeedAction', message: 'Сессия истекла. Войдите в аккаунт seller.ozon.ru и нажмите «Обновить»' });
        return 'wait';
      }
      // Проверка что не ушли со страницы seller.ozon.ru
      if (!currentUrl.includes('seller.ozon.ru')) {
        supportLog('⚠ Вкладка ушла с seller.ozon.ru — возвращаю на чат поддержки...');
        await chrome.tabs.update(tabId, { url: 'https://seller.ozon.ru/app/messenger/?group=support_v2' });
        await waitForTabComplete(tabId);
        await delay(5000);
        await injectSupportScripts(tabId);
        await delay(2000);
      }
      // Проверка что не в чате покупателя
      else if (currentUrl.includes('group=customers') || (currentUrl.includes('/app/messenger') && currentUrl.includes('&id=') && !currentUrl.includes('group=support'))) {
        supportLog('⚠ Обнаружен чат покупателя — переключаюсь на поддержку...');
        await chrome.tabs.update(tabId, { url: 'https://seller.ozon.ru/app/messenger/?group=support_v2' });
        await waitForTabComplete(tabId);
        await delay(5000);
        await injectSupportScripts(tabId);
        await delay(2000);
      }
    } catch (e) {
      // Вкладка могла быть закрыта — пробуем найти/создать заново
      supportLog('⚠ Вкладка недоступна — ищу заново...');
      const newTabId = await findSellerTab();
      if (!newTabId) {
        supportLog('❌ Не удалось найти seller.ozon.ru');
        item.status = 'waiting';
        sendToPopup({ action: 'supportNeedAction', message: 'Вкладка seller.ozon.ru закрыта. Откройте и нажмите «Обновить»' });
        return 'wait';
      }
      supportState.sellerTabId = newTabId;
      tabId = newTabId;
      await injectSupportScripts(tabId);
      await delay(2000);
    }

    // Получаем состояние страницы
    let state = await getSupportPageState(tabId);
    if (!state) {
      supportLog('Нет связи — пробую перейти на чаты...');
      try {
        const ensureResp = await ensureSellerChatPage(tabId);
        if (ensureResp?.tabId) tabId = ensureResp.tabId;
        state = await getSupportPageState(tabId);
      } catch (e) {}
      if (!state) {
        supportLog('Нет связи с seller.ozon.ru — откройте чат поддержки вручную');
        item.status = 'waiting';
        sendToPopup({ action: 'supportNeedAction', message: 'Нет связи со страницей. Откройте seller.ozon.ru → Сообщения → Поддержка и нажмите «Обновить»' });
        return 'wait';
      }
    }

    const phase = state.phase;
    supportLog(`Фаза: ${phase}, кнопки: [${(state.buttons || []).slice(0, 5).join(', ')}]`);

    // === Защита от зацикливания ===
    // Пропускаем стандартную защиту для ready_for_next/item_completed + новый SKU —
    // smart handler сам управляет этим случаем (клик кнопки цикла + ожидание)
    // evidence_insufficient тоже управляемая фаза: waiting_attachment handler должен успеть
    // исчерпать лимит повторов файла и завершить только текущий SKU.
    const isSmartHandled = ((phase === 'ready_for_next' || phase === 'item_completed') && !item.step) ||
      (phase === 'waiting_attachment' && state.detail === 'evidence_insufficient');
    // Для in_progress (ожидание ответа Ozon) используем повышенный лимит — Ozon иногда
    // отвечает через 30-60 секунд, а не 10-20. Без этого — ложные срабатывания на медленном интернете.
    const phaseRepeatLimit = phase === 'in_progress' ? 12 : supportState.maxPhaseRepeats;
    if (phase === supportState.lastPhase && !isSmartHandled) {
      supportState.phaseRepeatCount++;
      if (supportState.phaseRepeatCount >= phaseRepeatLimit) {
        // Debug при зацикливании
        const debug = await getSupportDebugDOM(tabId);
        if (debug) {
          supportLog(`[LOOP-DEBUG] URL: ${debug.url}`);
          supportLog(`[LOOP-DEBUG] Chat quick-replies: [${debug.chatQuickReplies?.slice(0, 10).join(', ')}]`);
          supportLog(`[LOOP-DEBUG] Std buttons: [${debug.allButtonTexts?.slice(0, 10).join(', ')}]`);
          supportLog(`[LOOP-DEBUG] Scored: [${debug.quickReplyTexts?.slice(0, 5).join(', ')}]`);
          supportLog(`[LOOP-DEBUG] Бот: ${debug.lastBotMsg || 'нет'} | Юзер: ${debug.lastUserMsg || 'нет'}`);
          supportLog(`[LOOP-DEBUG] chatContainer: ${debug.hasChatContainer}, input: ${debug.hasInput}, fileInput: ${debug.hasFileInput}, sendBtn: ${debug.hasSendButton}, botAfterUser: ${debug.lastBotAfterLastUser}`);
        }
        // v5.9.36: waiting_attachment и in_progress — recoverable фазы.
        // Завершаем только текущий SKU и продолжаем пакет, а не останавливаем всё.
        if (phase === 'waiting_attachment' || phase === 'in_progress') {
          const stepHint = item.step === 'parent_sent' ? ' (Ozon не ответил на parent SKU)' : '';
          const reason = `Зацикливание на фазе ${phase}${stepHint}`;
          await finishProblemSupportItem(tabId, item, idx, reason, {
            recoverChat: true,
            logMessage: `⛔ ${reason}: завершаю только SKU ${item.sku} и продолжаю пакет`
          });
          return 'continue';
        }
        // v5.9.32: специальное сообщение для подозрения на изменение интерфейса Ozon.
        // unknown/has_buttons/no_chat/faq_page/input_ready подряд = бот не понимает что показывает Ozon.
        // v5.9.37: пытаемся восстановиться (новый чат + следующий SKU) до 5 раз подряд.
        const isInterfaceLikely = phase === 'unknown' || phase === 'has_buttons' ||
          phase === 'no_chat' || phase === 'faq_page' || phase === 'input_ready';
        if (isInterfaceLikely) {
          const visibleList = (debug?.chatQuickReplies?.slice(0, 6) || []).join(', ') ||
            (debug?.allButtonTexts?.slice(0, 6) || []).join(', ') || '—';
          const lastBot = (debug?.lastBotMsg || '—').substring(0, 100);
          const stuckLimit = supportState.maxConsecutiveInterfaceStuck || 5;
          supportState.consecutiveInterfaceStuck = (supportState.consecutiveInterfaceStuck || 0) + 1;
          // Пока не достигли лимита подряд-зависаний — пропускаем SKU, открываем новый чат, продолжаем пакет
          if (supportState.consecutiveInterfaceStuck < stuckLimit) {
            supportLog(`[INTERFACE-STUCK ${supportState.consecutiveInterfaceStuck}/${stuckLimit}] Видимые кнопки: ${visibleList}`);
            supportLog(`[INTERFACE-STUCK] Последнее сообщение Ozon: «${lastBot}»`);
            await finishProblemSupportItem(tabId, item, idx,
              `Ozon показал нестандартный экран на фазе ${phase} — пропущен`, {
                recoverChat: true,
                logMessage: `⚠ SKU ${item.sku}: Ozon показал нестандартный экран на «${phase}» (${visibleList}). Пропускаю SKU, открываю новый чат и продолжаю пакет.`
              });
            return 'continue';
          }
          // Лимит достигнут — это уже похоже на реальное изменение интерфейса
          supportLog(`⛔ ИНТЕРФЕЙС OZON ИЗМЕНИЛСЯ: ${stuckLimit} SKU подряд застряли на «${phase}». Бот не распознал ни одной знакомой кнопки/сообщения.`);
          supportLog(`[INTERFACE-CHANGE] Видимые кнопки: ${visibleList}`);
          supportLog(`[INTERFACE-CHANGE] Последнее сообщение Ozon: «${lastBot}»`);
          item.status = 'failed';
          item.error = `Интерфейс Ozon не распознан на фазе ${phase} (${stuckLimit} SKU подряд)`;
          notifyProblem('failed', item.sku, item.error);
          supportState.isRunning = false;
          sendToPopup({
            action: 'supportNeedAction',
            message: `Похоже, Ozon изменил интерфейс жалоб: ${stuckLimit} SKU подряд застряли на «${phase}» (нет знакомых кнопок). Видимые кнопки: ${visibleList}. Проверьте чат вручную, попробуйте другой тип жалобы или сообщите в t.me/firadex.`
          });
          await saveSupportSession();
          return 'wait';
        }
        // Прочие фазы (навигационные) — останавливаем пакет для ручной проверки
        supportLog(`⛔ Зацикливание: фаза «${phase}» повторилась ${supportState.phaseRepeatCount} раз — остановка`);
        item.status = 'failed';
        item.error = `Зацикливание на фазе ${phase}`;
        notifyProblem('failed', item.sku, item.error);
        supportState.isRunning = false;
        sendToPopup({ action: 'supportNeedAction', message: `Зацикливание на фазе «${phase}». Проверьте чат вручную.` });
        await saveSupportSession();
        return 'wait';
      }
    } else if (phase !== supportState.lastPhase) {
      supportState.lastPhase = phase;
      supportState.phaseRepeatCount = 1;
    }

    // === DRY RUN ===
    if (supportState.mode === 'dry') {
      if (idx === 0) {
        const path = supportState.complaintType;
        let navStr;
        if (path === 'content_beta') {
          navStr = 'Поддержка → Новое обращение → Товары и Цены → Контроль качества → Нарушение правил площадки → Использование моих фото, видео, текста';
        } else if (path === 'brand_beta') {
          navStr = 'Поддержка → Новое обращение → Товары и Цены → Контроль качества → Нарушение правил площадки → Использование моего бренда';
        } else {
          navStr = 'Поддержка → Новое обращение → Личный кабинет → Кабинет бренда → Жалоба → Плагиат → Использование моих фото, видео, текста';
        }
        pathLog(`[DRY] Навигация: ${navStr}`);
      }
      pathLog(`[DRY] Ввод артикула: ${item.sku}`);
      if (supportState.files.length > 0) pathLog(`[DRY] Прикрепление + отправка ${supportState.files.length} файлов`);
      pathLog(`[DRY] Ожидание → «Пожаловаться на другой товар»`);
      item.status = 'done';
      supportState.currentIndex++;
      sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });
      await humanDelay(500);
      return 'continue';
    }

    // === АВТОМАТИЧЕСКИЙ РЕЖИМ ===

    if (!item.step) {
      const pickedBeforeArticle = pickFilesForItem(item);
      if (pickedBeforeArticle.files.length === 0) {
        await finishProblemSupportItem(tabId, item, idx, 'Нет файлов для прикрепления', {
          logMessage: `✗ SKU ${item.sku}: нет файлов (parent=${item.parentSku || '—'}). Пропускаю до ввода артикула.`
        });
        return 'continue';
      }
    }

    // Фаза: нет открытого чата
    if (phase === 'no_chat') {
      // Проверяем лимит ПЕРЕД созданием нового обращения
      const okLimit = await canOpenNewChat();
      if (!okLimit) return 'wait';

      supportLog('Ожидаю загрузку чата (5с)...');
      await delay(5000);

      const stateRetry = await getSupportPageState(tabId);
      if (stateRetry && stateRetry.phase !== 'no_chat') {
        supportLog(`Чат загрузился: фаза ${stateRetry.phase}`);
        return 'continue';
      }

      // Debug
      const debug = await getSupportDebugDOM(tabId);
      if (debug) {
        supportLog(`[DEBUG] URL: ${debug.url}, кнопок: ${debug.allButtonCount}, input: ${debug.hasInput}`);
        if (debug.allButtonTexts?.length > 0) supportLog(`[DEBUG] Кнопки: [${debug.allButtonTexts.slice(0, 10).join(', ')}]`);
      }

      supportLog('Ищу кнопку "Поддержка"...');
      const groupResp = await pageClickButton(tabId, ['поддержка']);
      if (groupResp?.ok) supportLog('"Поддержка" кликнута');
      else supportLog(`"Поддержка" не найдена: ${groupResp?.error || ''}`);
      await humanDelay(3000);

      supportLog('Создаю новое обращение...');
      const newChatResp = await pageClickNewChat(tabId);
      if (!newChatResp?.ok) {
        // Fallback: пробуем кнопку «Помощь» (плавающая кнопка → tippy → «Не нашли ответ»)
        supportLog('«Новое обращение» не найдена — пробую кнопку «Помощь»...');
        const helpResp = await sendToSupport(tabId, 'clickFaqButton');
        if (helpResp?.ok) {
          supportLog(`Кнопка «${helpResp.text}» нажата, ожидаю виджет (3с)...`);
          await delay(3000);
          return 'continue';
        }
        supportLog('Кнопки не найдены');
        sendToPopup({ action: 'supportNeedAction', message: 'Откройте новый чат поддержки вручную: нажмите «Помощь» → «Не нашли ответ на свой вопрос?»' });
        return 'wait';
      }
      registerNewChatOpened('через no_chat');
      supportLog('Новое обращение создано, ожидаю загрузку (4с)...');
      await delay(4000);
      return 'continue';
    }

    // Фаза: FAQ / виджет «Помощь и обучение» / плавающая кнопка «Помощь»
    // Двухшаговый flow: 1) клик «Помощь» → tippy → 2) клик «Не нашли ответ?» → чат
    if (phase === 'faq_page') {
      const faqType = state.faqType || 'unknown';
      supportLog(`Обнаружена FAQ-фаза (${faqType}: ${state.faqText || ''})`);

      if (faqType === 'faq_no_button' || faqType === 'messenger_no_chat') {
        // Нет кнопки — ждём загрузку или пробуем обновить
        supportLog('Кнопки не найдены, жду загрузку (3с)...');
        await delay(3000);
        return 'continue';
      }

      if (faqType === 'help_trigger') {
        // Шаг 1: кликаем плавающую кнопку «Помощь» → откроется tippy-виджет
        supportLog('Нажимаю плавающую кнопку «Помощь»...');
        const faqResp = await sendToSupport(tabId, 'clickFaqButton');
        if (faqResp?.ok) {
          supportLog('Кнопка «Помощь» нажата, ожидаю виджет FAQ (3с)...');
          await delay(3000);
        } else {
          supportLog(`Не удалось нажать «Помощь»: ${faqResp?.error || ''}`);
          await delay(2000);
        }
        return 'continue'; // следующая итерация обнаружит tippy с «Не нашли ответ»
      }

      // Шаг 2: tippy открыт → кликаем «Не нашли ответ на свой вопрос?» или «Чаты»
      supportLog('Нажимаю «Не нашли ответ на свой вопрос?»...');
      const faqResp = await sendToSupport(tabId, 'clickFaqButton');
      if (faqResp?.ok) {
        supportLog(`Кнопка FAQ нажата (${faqResp.type}: ${faqResp.text}), ожидаю чат (5с)...`);
        await delay(5000);
      } else {
        supportLog(`Не удалось нажать кнопку FAQ: ${faqResp?.error || 'неизвестная ошибка'}`);
        sendToPopup({ action: 'supportNeedAction', message: 'Нажмите «Не нашли ответ на свой вопрос?» вручную в виджете помощи' });
        return 'wait';
      }
      return 'continue';
    }

    // Навигационные фазы — клик по нужной кнопке.
    // v5.9.15: path-resolver + handleNavPhase — выбор кнопки зависит от complaintType:
    //   plagiat_legacy: Личный кабинет → Кабинет бренда → Жалоба на товар → Плагиат → Использование фото/видео/текста
    //   content_beta:   Товары и Цены → Контроль качества → Нарушение правил площадки → Использование моих фото/видео/текста
    //   brand_beta:     Товары и Цены → Контроль качества → Нарушение правил площадки → Использование моего бренда
    //
    // complaint_subtype в BETA-путях отсутствует (экран «Плагиат/Назад» пропускается).
    // Если detection всё-таки вернул complaint_subtype на BETA — значит неожиданная ветка, логгируем и идём по-старому.
    if (phase === 'direction_selection' || phase === 'category_selection' ||
        phase === 'complaint_type' || phase === 'complaint_detail' ||
        phase === 'complaint_subtype') {
      const result = await handleNavPhase(tabId, phase, state);
      if (result) return result;
    }

    // v5.9.32: НОВЫЙ этап Ozon — бот сначала просит ВАШ (parent) SKU, чью карточку
    // использовал нарушитель. Только потом — SKU нарушителя. Если у item нет parentSku,
    // помечаем failed с понятной подсказкой, что Ozon изменил сценарий.
    if (phase === 'waiting_parent_article') {
      const detail = state.detail || '';
      const isNotFound = detail === 'not_found';

      const parents = (Array.isArray(item.parentSkus) && item.parentSkus.length > 0)
        ? item.parentSkus
        : (item.parentSku ? [item.parentSku] : []);

      if (parents.length === 0) {
        await finishProblemSupportItem(tabId, item, idx,
          'Ozon просит ваш SKU перед SKU нарушителя — у задачи нет parent SKU', {
          recoverChat: true,
          logMessage: `✗ SKU ${item.sku}: Ozon добавил этап «пришлите свой SKU». В задаче нет родителя — используйте «В жалобы» из вкладки Сканирование, чтобы привязать ваш товар к SKU конкурента.`
        });
        return 'continue';
      }

      // Если Ozon отказал по предыдущему parent — пробуем следующий или fail
      if (isNotFound && item.step === 'parent_sent') {
        const triedIdx = item._parentTryIdx || 0;
        const triedSku = parents[triedIdx] || '?';
        item._parentTryIdx = triedIdx + 1;
        if (item._parentTryIdx >= parents.length) {
          const triedList = parents.slice(0, item._parentTryIdx).join(', ');
          await finishProblemSupportItem(tabId, item, idx,
            `Ozon не нашёл ни один parent SKU (${triedList}) в вашем магазине`, {
            recoverChat: true,
            logMessage: `✗ SKU ${item.sku}: Ozon не нашёл [${triedList}] в вашем магазине. Проверьте, что parent SKU действительно ваш товар.`
          });
          return 'continue';
        }
        const nextSku = parents[item._parentTryIdx];
        supportLog(`⚠ Ozon не нашёл parent ${triedSku} в магазине. Пробую следующего родителя: ${nextSku}`);
        item.step = null; // позволим повторно отправить parent SKU
      }

      // Защита от дубликатов: parent уже отправлен, ждём ответ Ozon
      if (item.step === 'parent_sent' && !isNotFound) {
        supportLog('Parent SKU уже отправлен, ожидаю проверку Ozon (5с)...');
        await delay(5000);
        return 'continue';
      }

      const tryIdx = item._parentTryIdx || 0;
      const parentSku = parents[tryIdx];
      if (!parentSku) {
        await finishProblemSupportItem(tabId, item, idx, 'Список parent SKU исчерпан', {
          recoverChat: true,
          logMessage: `✗ SKU ${item.sku}: исчерпан список parent SKU [${parents.join(', ')}]`
        });
        return 'continue';
      }

      await humanDelay(1000 + Math.random() * 1500);
      const tryLabel = parents.length > 1 ? ` (родитель ${tryIdx + 1}/${parents.length})` : '';
      supportLog(`Отправляю свой (parent) SKU ${parentSku}${tryLabel}...`);
      const resp = await pageSendText(tabId, parentSku);
      if (!resp?.ok) {
        await finishProblemSupportItem(tabId, item, idx, 'Не удалось отправить parent SKU', {
          recoverChat: true,
          logMessage: `Не удалось отправить parent SKU ${parentSku}: ${resp?.error || 'unknown'}`
        });
        return 'continue';
      }
      item.step = 'parent_sent';
      supportLog(`Parent SKU ${parentSku} отправлен ✓ (ожидаю проверку Ozon)`);
      await humanDelay(4000 + Math.random() * 2000);
      return 'continue';
    }

    // Фаза: ввод артикула НАРУШИТЕЛЯ (после parent_sent или старого пути без этапа parent)
    if (phase === 'waiting_article' || phase === 'input_ready') {
      // Защита от дублирования: артикул уже отправлен
      if (item.step === 'article_sent' || item.step === 'file_sent' || item.step === 'completed') {
        supportLog('Артикул уже отправлен, ожидаю следующую фазу (5с)...');
        await delay(5000);
        return 'continue';
      }

      // input_ready без явного запроса артикула — бот может ещё не ответить
      if (phase === 'input_ready' && !item.step) {
        const debug = await getSupportDebugDOM(tabId);
        const botMsg = (debug?.lastBotMsg || '').toLowerCase();
        // Расширенный набор паттернов запроса артикула от бота
        const isArticleRequest = botMsg.includes('скопируйте') || botMsg.includes('артикул') ||
          botMsg.includes('пришлите только') || botMsg.includes('введите') ||
          botMsg.includes('пришлите одно') || botMsg.includes('значение артикула') ||
          botMsg.includes('номер товара') || botMsg.includes('укажите товар') ||
          botMsg.includes('sku') || botMsg.includes('номер артикула') ||
          botMsg.includes('отправьте артикул');
        if (isArticleRequest) {
          supportLog(`[SMART] Бот запросил артикул: «${botMsg.substring(0, 80)}...»`);
        }
        // Fallback: если фаза повторяется 3+ раза — отправляем артикул
        // (бот уже запросил, но текст не распарсился)
        if (!isArticleRequest && supportState.phaseRepeatCount < 3) {
          supportLog(`[SMART] input_ready без запроса артикула (попытка ${supportState.phaseRepeatCount}/3), бот: «${botMsg.substring(0, 80)}» — жду 3с...`);
          await delay(3000);
          return 'continue';
        }
        if (!isArticleRequest) {
          supportLog(`[SMART] Fallback: отправляю артикул (бот-текст: «${botMsg.substring(0, 60)}»)`);
        }
      }

      // Имитация человека: пауза перед вводом
      await humanDelay(1000 + Math.random() * 1500);

      supportLog(`Отправляю артикул ${item.sku}...`);
      const resp = await pageSendText(tabId, item.sku);
      if (!resp?.ok) {
        await finishProblemSupportItem(tabId, item, idx, 'Не удалось ввести артикул', {
          recoverChat: true,
          logMessage: `Не удалось отправить артикул: ${resp?.error || 'unknown'}`
        });
        return 'continue';
      }
      item.step = 'article_sent';
      supportLog(`Артикул ${item.sku} отправлен ✓`);
      await humanDelay(4000 + Math.random() * 2000);
      return 'continue';
    }

    // Фаза: прикрепление доказательств
    if (phase === 'waiting_attachment') {
      const detail = state.detail || '';
      const isInsufficientRequest = detail === 'evidence_insufficient';

      // v5.9.20: бот говорит «доказательств недостаточно» — добавить ещё один файл
      // (если есть). step остаётся file_sent, но мы должны попасть в attach-блок ниже.
      if (isInsufficientRequest && item.step === 'file_sent') {
        supportLog(`📩 Бот запросил дополнительные доказательства для SKU ${item.sku}`);
        item._evidenceUsedIdx = (item._evidenceUsedIdx || 0); // сколько уже отправили
        // Помечаем что нам нужно прикреплять следующий файл
        item._needsNextEvidence = true;
        item.step = 'article_sent'; // позволяем войти в attach
      } else if (item.step === 'file_sent') {
        // Стандартная проверка: может файл уже отправлен и просто ждём ответ бота
        const debug = await getSupportDebugDOM(tabId);
        const lastUserIsFile = debug?.lastUserMsg === '[FILE]';
        if (!lastUserIsFile && supportState.phaseRepeatCount < 3) {
          supportLog('Файл не появился в чате, повторяю отправку...');
          item.step = 'article_sent'; // Откатываем step для повторной попытки
        } else {
          supportLog('Файл уже отправлен, ожидаю ответ бота (5с)...');
          await delay(5000);
          return 'continue';
        }
      }

      // v5.9.10: выбираем файлы для ТЕКУЩЕГО SKU (per-parent с fallback на общий пул)
      const picked = pickFilesForItem(item);
      if (picked.files.length === 0) {
        // Для брендового сертификата / нет файлов → failed, не идём дальше.
        // Это корректное поведение для Q5: «фейлед если совсем нет файлов»
        await finishProblemSupportItem(tabId, item, idx, 'Нет файлов для прикрепления', {
          recoverChat: true,
          logMessage: `✗ SKU ${item.sku}: нет файлов (parent=${item.parentSku || '—'}). Помечаю failed.`
        });
        return 'continue';
      }

      // v5.9.20: на повторный запрос «доказательств недостаточно» отправляем ТОЛЬКО следующий файл,
      // а не все заново. Это естественнее для оператора Ozon и ближе к ручному поведению.
      // v5.9.27: для сценария «Мой контент» (content_beta) разрешаем два контрольных
      // повтора последнего файла. Если Ozon снова просит доказательства — SKU failed, бот идёт дальше.
      let filesToAttach;
      if (isInsufficientRequest) {
        const startIdx = item._evidenceUsedIdx || 0;
        if (startIdx >= picked.files.length) {
          const isContentBeta = supportState.complaintType === 'content_beta';
          const maxResends = 2;
          item._evidenceResendCount = (item._evidenceResendCount || 0);

          if (isContentBeta && picked.files.length > 0 && item._evidenceResendCount < maxResends) {
            // Повторно отправляем последний файл из набора
            const lastFile = picked.files[picked.files.length - 1];
            filesToAttach = [lastFile];
            item._evidenceResendCount++;
            supportLog(`🔁 [Мой контент] Файлы исчерпаны (${picked.files.length}/${picked.files.length}). Повторно отправляю последний файл (попытка ${item._evidenceResendCount}/${maxResends})`);
          } else {
            const reason = isContentBeta
              ? `Ozon повторно запросил доказательства после ${maxResends} контрольных повторов файла`
              : 'Бот запросил доп. доказательства, но файлы исчерпаны';
            await finishProblemSupportItem(tabId, item, idx, reason, {
              recoverChat: true,
              logMessage: `⚠ SKU ${item.sku}: ${reason}. Помечаю failed и перехожу к следующему SKU.`
            });
            return 'continue';
          }
        } else {
          filesToAttach = [picked.files[startIdx]];
          supportLog(`Прикрепляю ДОПОЛНИТЕЛЬНЫЙ файл (${startIdx + 1}/${picked.files.length}, источник: ${picked.source})`);
        }
      } else {
        // Первичная подача: все файлы по порядку
        filesToAttach = picked.files.slice();
        item._evidenceUsedIdx = 0;
        item._evidenceResendCount = 0;
        supportLog(`Прикрепляю ${filesToAttach.length} файл(ов) (источник: ${picked.source}, parent=${item.parentSku || '—'})`);
      }

      let attachedOk = false;
      let lastDbgSnap = null; // снимок DOM при провале для диагностики
      for (let fi = 0; fi < filesToAttach.length; fi++) {
        const file = filesToAttach[fi];
        const totalCount = isInsufficientRequest ? picked.files.length : filesToAttach.length;
        const fileNum = isInsufficientRequest ? ((item._evidenceUsedIdx || 0) + 1) : (fi + 1);
        const idxLabel = `${fileNum}/${totalCount}`;
        let filePayload;
        try {
          filePayload = await resolveComplaintFilePayload(file);
        } catch (e) {
          supportLog(`[${idxLabel}] Ошибка чтения файла ${file.name || file.id || 'document'}: ${e.message || e}`);
          continue;
        }
        // Имитация: человек не сразу прикрепляет файл
        await humanDelay(2000 + Math.random() * 2000);
        // Для крупных (видео) — увеличенная пауза после старта прикрепления
        const isLarge = filePayload.base64 && filePayload.base64.length > 6 * 1024 * 1024; // ~4.5MB raw
        const fileSizeKb = filePayload.base64 ? Math.round((filePayload.base64.length * 0.75) / 1024) : 0;
        // Baseline: сколько сообщений в чате ДО отправки файла (для верификации по росту счётчика)
        const baselineDbg = await getSupportDebugDOM(tabId);
        const baselineCount = baselineDbg?.chatMsgCount || 0;
        supportLog(`[${idxLabel}] Прикрепляю${isLarge ? ' КРУПНЫЙ файл (видео/HD)' : ''}: ${filePayload.name || file.name || 'document'} (${fileSizeKb} КБ, тип ${filePayload.type || '?'}, baseline ${baselineCount})...`);
        const attachT0 = Date.now();
        const resp = await pageAttachFile(tabId, filePayload.name, filePayload.base64, filePayload.type);
        const attachMs = Date.now() - attachT0;
        if (resp?.ok) {
          supportLog(`[${idxLabel}] Файл прикреплён${resp.sent ? ' и отправлен ✓' : ' ⚠ НЕ отправлен (файл остался в поле ввода)'} за ${attachMs}мс`);
          // Если файл не был отправлен (остался в поле ввода) — пробуем clickSend с повторами
          if (!resp.sent) {
            supportLog(`[${idxLabel}] Пробую отправить файл повторно...`);
            let retrySent = false;
            for (let retryAttempt = 0; retryAttempt < 3; retryAttempt++) {
              const clickResp = await sendToSupport(tabId, 'clickSend');
              await delay(isLarge ? 5000 : 3000);
              if (clickResp?.ok) {
                // Проверяем: файл ушёл?
                const dbgCheck = await getSupportDebugDOM(tabId);
                if (dbgCheck && (dbgCheck.chatMsgCount || 0) > baselineCount) {
                  retrySent = true;
                  supportLog(`[${idxLabel}] ✓ Файл отправлен после повторного клика (попытка ${retryAttempt + 1})`);
                  break;
                }
              }
              if (retryAttempt < 2) {
                supportLog(`[${idxLabel}] Повтор отправки (${retryAttempt + 2}/3)...`);
                await delay(3000 + retryAttempt * 3000);
              }
            }
            if (!retrySent) {
              supportLog(`[${idxLabel}] ⚠ Файл так и не ушёл из поля ввода после 3 попыток`);
              // Не ждём 60с впустую — сразу переходим к следующему файлу
              lastDbgSnap = await getSupportDebugDOM(tabId);
              if (fi < filesToAttach.length - 1) await delay(2000);
              continue;
            }
          }
          // Верификация что файл дошёл. Принимаем ЛЮБОЕ из:
          //  (a) lastUserMsg === '[FILE]' (прямой признак — наше сообщение-файл)
          //  (b) lastBotMsg содержит маркер принятия жалобы (бот отвечает ПОСЛЕ файла)
          //  (c) counter сообщений вырос на 2+ (файл + ответ бота вместе)
          //  (d) counter вырос на 1 (только файл, бот ещё не ответил)
          let verified = false;
          let maxWait = 15;
          if (isLarge) {
            maxWait = fileSizeKb >= 50 * 1024 ? 90 : (fileSizeKb >= 10 * 1024 ? 60 : 30);
          }
          const botAckPatterns = ['скрыли товар', 'нарушение подтвердилось', 'нарушение рассмотрено',
            'рассмотрим', 'получили ваш', 'направил', 'направили', 'проверим', 'жалобу рассмотр',
            'пожаловаться на другой', item.sku];
          let lastDbg = null;
          for (let w = 0; w < maxWait; w++) {
            await delay(1000);
            if (!supportState.isRunning || supportState.isPaused) return 'stop';
            const dbg = await getSupportDebugDOM(tabId);
            if (!dbg) continue;
            lastDbg = dbg;
            const grew = (dbg.chatMsgCount || 0) > baselineCount;
            const grewBig = (dbg.chatMsgCount || 0) >= baselineCount + 2;
            const botMsg = (dbg.lastBotMsg || '').toLowerCase();
            const botAck = grew && botAckPatterns.some(p => botMsg.includes(p));
            const userFile = dbg.lastUserMsg === '[FILE]';
            if (userFile || botAck || grewBig) { verified = true; break; }
            // Дополнительно: если счётчик вырос на 1 и lastMsgIsMine=true — файл ушёл, бот ещё не ответил
            if (grew && dbg.lastMsgIsMine) { verified = true; break; }
          }
          if (verified) {
            supportLog(`[${idxLabel}] ✓ Файл в чате`);
            attachedOk = true;
            // v5.9.20: учитываем сколько файлов уже отправили — для последовательных доп.запросов
            item._evidenceUsedIdx = (item._evidenceUsedIdx || 0) + 1;
          } else {
            // Подробная диагностика что увидели после ожидания
            lastDbgSnap = lastDbg;
            const finalCount = lastDbg?.chatMsgCount ?? '?';
            const lastUser = lastDbg?.lastUserMsg || '—';
            const lastBot = (lastDbg?.lastBotMsg || '—').slice(0, 80);
            supportLog(`[${idxLabel}] ⚠ Файл не появился в чате за ${maxWait}с (msgs ${baselineCount}→${finalCount}, last user: «${lastUser}», last bot: «${lastBot}») — пробую следующий`);
          }
          // Небольшая пауза между файлами
          if (fi < filesToAttach.length - 1) await delay(3000 + Math.random() * 2000);
        } else {
          supportLog(`[${idxLabel}] Ошибка прикрепления: ${resp?.error || 'неизвестная ошибка'} (за ${attachMs}мс)`);
        }
      }

      if (!attachedOk) {
        // Счётчик ТОЛЬКО для случая «ни один файл не прошёл» в waiting_attachment.
        // Эскалации (chat_escalated после успешного attach) сюда не попадают — эскалация
        // случается уже после reset'а на строке ниже. Поэтому 5+ подряд = реальная проблема
        // с приёмом файлов (Ozon antispam / DOM rate-limit / изменение интерфейса).
        supportState.consecutiveAttachFails = (supportState.consecutiveAttachFails || 0) + 1;
        // Финальный DOM-снимок чтобы клиент мог понять что увидел бот
        if (lastDbgSnap) {
          supportLog(`[ATTACH-DIAG] hasFileInput=${lastDbgSnap.hasFileInput} hasInput=${lastDbgSnap.hasInput} hasSendBtn=${lastDbgSnap.hasSendButton} viewport=${lastDbgSnap.viewportWidth}px`);
        }
        // Подсказки в зависимости от паттерна
        if (supportState.consecutiveAttachFails === 1) {
          supportLog(`💡 Возможные причины: файл слишком большой / неподдерживаемый формат / Ozon временно ограничил приём файлов в чате`);
        }
        if (supportState.consecutiveAttachFails >= 5 && !supportState.attachFailAdviceShown) {
          supportLog(`⚠ ${supportState.consecutiveAttachFails} SKU подряд: файлы прикрепляются, но НЕ ПОЯВЛЯЮТСЯ в чате. Это не эскалация — это проблема с загрузкой файлов. Возможно: Ozon antispam (сделайте паузу 30 мин), браузер тротлит фоновую вкладку (не сворачивайте), либо изменился интерфейс Ozon. Скопируйте лог и пришлите в t.me/firadex.`);
          supportState.attachFailAdviceShown = true;
        }
        // НЕ останавливаем бота — он продолжит со следующим SKU. Это не критическая ошибка.
        await finishProblemSupportItem(tabId, item, idx, 'Ни один файл не удалось прикрепить', {
          recoverChat: true,
          logMessage: `✗ SKU ${item.sku}: ни один из ${picked.files.length} файлов не прошёл — failed`
        });
        return 'continue';
      }

      // Успех — сбрасываем счётчик подряд-провалов
      supportState.consecutiveAttachFails = 0;

      item.step = 'file_sent';
      await humanDelay(5000);
      return 'continue';
    }

    // Фаза: обработка — ждём ответ бота
    // detail: 'article_sent_waiting' или 'file_sent_waiting'
    if (phase === 'in_progress') {
      const detail = state.detail || '';
      if (detail === 'file_sent_waiting') {
        item.step = 'file_sent'; // Файл уже отправлен пользователем
        supportLog('Файл отправлен — ожидаю ответ бота (5с)...');
      } else if (detail === 'article_sent_waiting') {
        // v5.9.36: НЕ перезаписываем step если parent_sent — иначе waiting_article
        // handler подумает что артикул нарушителя уже отправлен и уйдёт в бесконечный цикл
        if (item.step === 'parent_sent') {
          supportLog('Parent SKU отправлен — ожидаю ответ Ozon (5с)...');
        } else {
          item.step = 'article_sent';
          supportLog('Артикул отправлен — ожидаю ответ бота (5с)...');
        }
      } else {
        supportLog('Бот обрабатывает — ожидаю (5с)...');
      }
      await delay(5000);
      return 'continue';
    }

    // Фаза: Ozon проверил обращение, но не нашёл нарушений.
    // Это нормальный финальный исход текущего SKU, а не изменение интерфейса.
    if (phase === 'no_violation') {
      if (!item.step) {
        supportLog(`[SMART] Новый SKU ${item.sku} видит старый чат «без нарушений» — открываю новое обращение...`);
        const nextTabId = await openSupportChatsPage(tabId, 'старый no_violation перед новым SKU');
        if (nextTabId) {
          tabId = nextTabId;
          supportState.lastPhase = null;
          supportState.phaseRepeatCount = 0;
          supportState._staleWaitCount = 0;
          return 'continue';
        }
        await pauseSupportForChatRecoveryFailure('Не удалось открыть новое обращение после ответа Ozon «без нарушений»');
        return 'wait';
      }

      supportState.consecutiveFailed = 0;
      supportState.consecutiveEscalations = 0;
      await finishProblemSupportItem(tabId, item, idx, 'Ozon не нашёл нарушений', {
        status: 'no_violation',
        category: 'noViolation',
        recoverChat: true,
        recoverLogMessage: 'Открываю новую страницу чатов для следующего SKU после ответа «без нарушений»...',
        logMessage: `○ SKU ${item.sku}: Ozon не нашёл нарушений — перехожу к следующему SKU`
      });
      return 'continue';
    }

    // Фаза: чат эскалирован (бот передал запрос оператору / требуется новое обращение)
    // Встречается когда бот не подтверждает жалобу, а пишет «Я направил ваше обращение коллегам.
    // Для жалобы на товары другого продавца создайте новое обращение.»
    // v5.9.10: + защита от каскада обращений, + верификация handoff, + per-SKU проблемы
    if (phase === 'chat_escalated') {
      supportLog('⚠ Чат эскалирован оператору');

      if (item && item.step !== 'completed') {
        // Верификация: точно ли обращение уже передано оператору
        const v = await verifyItemHandedOff(tabId, item);
        if (v.confirmed) {
          // Жалоба принята до эскалации — помечаем done
          item.status = 'done';
          item.step = 'completed';
          supportLog(`SKU ${item.sku} — обработан ✓ (принят перед эскалацией)`);
          supportState.consecutiveEscalations = 0; // успех — сбрасываем счётчик
        } else if (v.handed) {
          // Уже передано оператору — сразу отмечаем escalated без повторной отправки
          item.status = 'escalated';
          item.step = 'completed';
          item.error = 'Передано оператору — ожидает ручной обработки';
          notifyProblem('escalated', item.sku, item.error);
          supportLog(`SKU ${item.sku} — уже передан оператору (escalated)`);
          supportState.consecutiveEscalations++;
          supportState.consecutiveFailed = 0;
        } else {
          // handoff НЕ подтверждён — пишем оператору вежливую просьбу рассмотреть жалобу
          // ВАЖНО: до подтверждения handoff НЕ создаём новое обращение (защита от пустых тикетов)
          const polite = 'Пожалуйста рассмотрите жалобу';
          await humanDelay(1500 + Math.random() * 1000);
          const sendResp = await pageSendText(tabId, polite);
          if (sendResp?.ok) {
            supportLog(`Отправлено оператору: «${polite}» ✓`);
            await delay(3000);
          } else {
            supportLog(`Не удалось написать оператору: ${sendResp?.error || 'поле ввода недоступно'}`);
          }
          // После отправки — ещё раз проверяем handoff
          const v2 = await verifyItemHandedOff(tabId, item);
          if (v2.handed || v2.confirmed) {
            if (v2.confirmed) {
              item.status = 'done';
              item.step = 'completed';
              supportLog(`SKU ${item.sku} — обработан ✓ (подтверждён после просьбы)`);
              supportState.consecutiveEscalations = 0;
            } else {
              item.status = 'escalated';
              item.step = 'completed';
              item.error = 'Передано оператору — ожидает ручной обработки';
              notifyProblem('escalated', item.sku, item.error);
              supportLog(`SKU ${item.sku} — передан оператору (escalated)`);
              supportState.consecutiveEscalations++;
              supportState.consecutiveFailed = 0;
            }
          } else {
            // Handoff НЕ подтверждён — счётчик попыток (до 3-х)
            supportState._escalatedRetry = (supportState._escalatedRetry || 0) + 1;
            if (supportState._escalatedRetry < 3) {
              supportLog(`⚠ Handoff не подтверждён (попытка ${supportState._escalatedRetry}/3) — остаюсь в чате, жду 10с`);
              const okr = await interruptibleDelay(10000);
              if (!okr) return 'stop';
              return 'continue'; // без currentIndex++
            }
            // 3 попытки не помогли — failed, НО новый чат не создаём
            supportLog(`✗ SKU ${item.sku}: 3 попытки не подтвердили handoff — помечаю failed БЕЗ создания нового чата`);
            item.status = 'failed';
            item.step = 'completed';
            item.error = 'Handoff не подтверждён после 3 попыток';
            notifyProblem('failed', item.sku, item.error);
            supportState._escalatedRetry = 0;
            supportState.currentIndex++;
            sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });
            // Пропускаем навигацию — возможно Ozon в плохом состоянии, лучше дать обработчику
            // следующей итерации заново прочитать phase
            supportState.lastPhase = null;
            supportState.phaseRepeatCount = 0;
            await saveSupportSession();
            return 'continue';
          }
        }
        supportState._escalatedRetry = 0;
        supportState.currentIndex++;
        sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });
        await saveSupportSession();
        await persistActiveSupportSessionNow();
      }

      // Проверка подряд идущих эскалаций перед открытием нового чата
      const okConsec = await checkConsecutiveEscalations();
      if (!okConsec) return 'wait';

      // Проверка лимита за сессию
      const okLimit = await canOpenNewChat();
      if (!okLimit) return 'wait';

      // КРИТИЧНО: навигируем на страницу чатов — открываем новое обращение
      supportLog('Открываю новую страницу чатов для следующего SKU...');
      const nextTabId = await openSupportChatsPage(tabId, 'после chat_escalated');
      if (nextTabId) {
        tabId = nextTabId;
        registerNewChatOpened('после chat_escalated');
      } else {
        await pauseSupportForChatRecoveryFailure('Не удалось открыть новую страницу чатов после передачи оператору');
        return 'wait';
      }

      supportState.lastPhase = null;
      supportState.phaseRepeatCount = 0;
      supportState._staleWaitCount = 0;
      await saveSupportSession();
      return 'continue';
    }

    // Фаза: товар скрыт / результат получен / кнопка «Пожаловаться на другой»
    if (phase === 'item_completed' || phase === 'ready_for_next') {

      // === SMART SELF-CORRECTION: новый SKU видит ready_for_next ===
      // Это НЕ ошибка — чат уже в состоянии «Пожаловаться на другой товар»
      // (предыдущая жалоба обработана, или бот перезапущен на существующем чате).
      // Нужно кликнуть кнопку цикла и ждать навигации к вводу артикула.
      if (!item.step) {
        if (!supportState._staleWaitCount) supportState._staleWaitCount = 0;
        supportState._staleWaitCount++;

        const MAX_STALE_ATTEMPTS = 5;
        // Клик «Пожаловаться на другой товар»
        if (supportState._staleWaitCount <= MAX_STALE_ATTEMPTS) {
          supportLog(`[SMART] Новый SKU ${item.sku} — чат в фазе ${phase}, кликаю «Пожаловаться на другой» (${supportState._staleWaitCount}/${MAX_STALE_ATTEMPTS})...`);
          const resp = await pageClickButton(tabId, ['пожаловаться на другой']);
          if (resp?.ok) {
            supportLog('[SMART] Кнопка цикла кликнута, жду переход...');
            // Увеличенное ожидание для медленных клиентов (Win11 + медленный Ozon)
            await delay(5000);
            const newState = await getSupportPageState(tabId);
            if (newState && newState.phase !== 'ready_for_next' && newState.phase !== 'item_completed') {
              supportLog(`[SMART] Переход успешен → фаза: ${newState.phase}`);
              supportState._staleWaitCount = 0;
              supportState.lastPhase = null;
              supportState.phaseRepeatCount = 0;
              return 'continue';
            }
            supportLog('[SMART] Фаза не сменилась, повторю...');
            await delay(3000);
          } else {
            supportLog('[SMART] Кнопка цикла не найдена — жду 3с...');
            await delay(3000);
          }
          return 'continue';
        }
        // Fallback: 5 попыток не помогли — пробуем ОТКРЫТЬ НОВЫЙ ЧАТ через навигацию
        // (раньше сразу помечали failed, что при медленном Ozon/Win11 давало ложные пропуски).
        // v5.9.10: проверка лимита обращений перед fallback-открытием нового чата
        const okLimitStale = await canOpenNewChat();
        if (!okLimitStale) return 'wait';
        supportLog(`[SMART] ${supportState._staleWaitCount} попыток не сменили фазу — открываю новый чат...`);
        supportState._staleWaitCount = 0;
        const nextTabId = await openSupportChatsPage(tabId, 'fallback после ready_for_next');
        if (nextTabId) {
          tabId = nextTabId;
          supportState.lastPhase = null;
          supportState.phaseRepeatCount = 0;
          // Следующая итерация → no_chat/faq_page → бот откроет новый чат (там registerNewChatOpened)
          return 'continue';
        }
        await pauseSupportForChatRecoveryFailure('Не удалось начать новую жалобу — кнопка цикла не работает');
        return 'wait';
      }

      // === SMART SELF-CORRECTION: верификация SKU ===
      // Проверяем, что бот действительно обработал ТЕКУЩИЙ артикул
      if (item.step === 'article_sent' || item.step === 'file_sent') {
        const debug = await getSupportDebugDOM(tabId);
        const chatHistory = debug?.lastBotMsg || '';
        // Если бот упоминает наш SKU в ответе — подтверждено
        const skuConfirmed = chatHistory.includes(item.sku) ||
          chatHistory.includes('скрыли товар') || chatHistory.includes('нарушение подтвердилось') ||
          chatHistory.includes('пожаловаться на другой');
        if (!skuConfirmed && phase !== 'item_completed') {
          supportLog(`[SMART] SKU ${item.sku} не подтверждён в ответе бота — жду (5с)...`);
          await delay(5000);
          return 'continue';
        }
      }

      // Сброс stale-счётчика
      supportState._staleWaitCount = 0;

      item.status = 'done';
      item.step = 'completed';
      supportState.currentIndex++;
      supportLog(`SKU ${item.sku} — жалоба обработана ✓`);
      sendToPopup({ action: 'supportProgress', current: idx + 1, total: supportState.queue.length, item });
      await saveSupportSession();

      if (supportState.currentIndex < supportState.queue.length) {
        // Антибот: пауза 7-15с между жалобами (прерываемая паузой/стопом)
        const betweenDelay = 7000 + Math.random() * 8000;
        supportLog(`Антибот-пауза ${Math.round(betweenDelay / 1000)}с...`);
        const ok1 = await interruptibleDelay(betweenDelay);
        if (!ok1) return 'stop'; // пользователь нажал ⏸ или ⏹ во время паузы

        if (phase === 'ready_for_next' || (state.buttons || []).some(b => b.includes('пожаловаться'))) {
          // Ещё одна проверка непосредственно перед кликом — мог быть race с supportPause
          if (!supportState.isRunning || supportState.isPaused) return 'stop';
          supportLog('Нажимаю «Пожаловаться на другой товар»...');
          const resp = await pageClickButton(tabId, ['пожаловаться на другой']);
          if (!resp?.ok) {
            supportLog('Кнопка цикла не найдена — жду обновления (5с)...');
            const ok2 = await interruptibleDelay(5000);
            if (!ok2) return 'stop';
            // Повторная попытка
            const resp2 = await pageClickButton(tabId, ['пожаловаться на другой']);
            if (!resp2?.ok) {
              supportLog('Кнопка цикла не найдена повторно');
              sendToPopup({ action: 'supportNeedAction', message: 'Нажмите «Пожаловаться на другой товар» вручную' });
              return 'wait';
            }
          }
          // Ждём пока страница обновится после клика
          supportLog('[SMART] Жду обновление страницы после клика «Пожаловаться на другой»...');
          const ok3 = await interruptibleDelay(4000);
          if (!ok3) return 'stop';
          // Верифицируем: фаза должна измениться с ready_for_next
          const newState = await getSupportPageState(tabId);
          if (newState && (newState.phase === 'ready_for_next' || newState.phase === 'item_completed')) {
            supportLog('[SMART] Страница ещё не обновилась — доп. ожидание 5с...');
            const ok4 = await interruptibleDelay(5000);
            if (!ok4) return 'stop';
          }
        }
      }

      // Сбрасываем трекинг фазы для нового SKU
      supportState.lastPhase = null;
      supportState.phaseRepeatCount = 0;
      return 'continue';
    }

    // has_buttons — неизвестные кнопки, пробуем навигировать
    if (phase === 'has_buttons') {
      supportLog(`Неизвестные кнопки: [${(state.buttons || []).slice(0, 8).join(', ')}]`);
      // Пробуем найти знакомую кнопку
      const knownPatterns = ['личный кабинет', 'кабинет бренда', 'качество', 'жалоба', 'плагиат',
        'использование моих', 'использование моего бренда', 'нарушение правил площадки',
        'нарушение', 'товары и цены', 'контроль качества', 'пожаловаться', 'поддержка'];
      for (const p of knownPatterns) {
        if ((state.buttons || []).some(b => b.includes(p))) {
          supportLog(`Найдена знакомая кнопка «${p}», пробую кликнуть...`);
          const resp = await pageClickButton(tabId, [p]);
          if (resp?.ok) {
            await humanDelay(2500);
            return 'continue';
          }
        }
      }
      // Ничего знакомого — пробуем кнопку «Помощь» (возможно мы на мессенджере без чата)
      supportLog('Знакомых кнопок нет — пробую кнопку «Помощь»...');
      const helpResp = await sendToSupport(tabId, 'clickFaqButton');
      if (helpResp?.ok) {
        supportLog(`Кнопка «${helpResp.text}» нажата, ожидаю виджет (3с)...`);
        await delay(3000);
        return 'continue';
      }
      supportLog('Жду обновление чата (5с)...');
      await delay(5000);
      return 'continue';
    }

    // unknown — ждём
    if (phase === 'unknown') {
      supportLog('Состояние неопределённо, ожидаю (5с)...');
      await delay(5000);
      return 'continue';
    }

    // Всё остальное — стоп
    supportLog(`⛔ Необработанная фаза: ${phase}`);
    supportLog(`Кнопки: [${(state.buttons || []).join(', ')}]`);
    supportState.isRunning = false;
    sendToPopup({ action: 'supportNeedAction', message: `Неожиданное состояние чата (${phase}). Проверьте страницу вручную.` });
    await saveSupportSession();
  }

  // === Состояние ===
  let scanState = {
    isRunning: false,
    isPaused: false,
    skus: [],
    currentIndex: 0,
    results: [],
    config: {},
    logs: [],
    workerTabId: null,
    workerWindowId: null,
    hiddenTabId: null,
    hiddenTabCreated: false
  };

  // === Утилиты ===
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Прерываемая пауза — проверяет isPaused/isRunning каждые 250ms.
  // Возвращает true если отработала полностью, false если прервана (stop/pause).
  // Используется для длинных антибот-пауз между жалобами, чтобы нажатие ⏸ работало мгновенно.
  async function supportKeepaliveHeartbeat() {
    try {
      if (supportState.sellerTabId) {
        await chrome.tabs.get(supportState.sellerTabId);
      } else {
        await chrome.runtime.getPlatformInfo();
      }
    } catch (_) {
      try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
    }
    await persistActiveSupportSessionNow();
  }

  async function supportKeepaliveDelay(totalMs, opts = {}) {
    const step = 250;
    const startToken = supportLoopToken;
    const heartbeatMs = opts.heartbeatMs || (totalMs >= 10000 ? 4000 : 0);
    const logEveryMs = opts.logEveryMs || 0;
    const label = opts.label || '';
    const endAt = Date.now() + Math.max(0, totalMs);
    let nextHeartbeatAt = Date.now();
    let nextLogAt = logEveryMs ? Date.now() + logEveryMs : Infinity;

    if (label) supportLog(`${label}: ${Math.round(totalMs / 1000)}с`);
    await supportKeepaliveHeartbeat();

    while (Date.now() < endAt) {
      await delay(Math.min(step, Math.max(1, endAt - Date.now())));
      if (!supportState.isRunning || supportState.isPaused) return false;
      if (startToken && startToken !== supportLoopToken) return false;

      const now = Date.now();
      if (heartbeatMs && now >= nextHeartbeatAt) {
        nextHeartbeatAt = now + heartbeatMs;
        await supportKeepaliveHeartbeat();
      }
      if (logEveryMs && now >= nextLogAt) {
        nextLogAt = now + logEveryMs;
        const leftSec = Math.max(1, Math.ceil((endAt - now) / 1000));
        supportLog(`${label || 'Антибот-пауза'}: осталось ${leftSec}с`);
      }
    }
    await supportKeepaliveHeartbeat();
    if (label) supportLog('Антибот-пауза завершена');
    return true;
  }

  async function interruptibleDelay(totalMs) {
    if (totalMs >= 10000) {
      return await supportKeepaliveDelay(totalMs);
    }
    const startToken = supportLoopToken;
    const step = 250;
    const iterations = Math.max(1, Math.ceil(totalMs / step));
    for (let i = 0; i < iterations; i++) {
      await delay(step);
      if (!supportState.isRunning || supportState.isPaused) return false;
      if (startToken && startToken !== supportLoopToken) return false;
    }
    return true;
  }

  // Рандомная задержка ±30% от базового значения (имитация человека)
  function humanDelay(baseMs) {
    const jitter = baseMs * 0.3;
    const ms = baseMs + (Math.random() * jitter * 2 - jitter);
    return delay(Math.round(ms));
  }

  function sendToPopup(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {}
    // Persist активной сессии жалоб в storage — чтобы popup мог восстановить состояние
    // после переоткрытия (без этого прогресс и queue теряются когда popup закрыт)
    if (msg && (msg.action === 'supportProgress' || msg.action === 'supportComplete' || msg.action === 'supportNeedAction')) {
      try { persistActiveSupportSession(); } catch (_) {}
    }
  }

  function logToPopup(text) {
    const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = `[${ts}] ${text}`;
    scanState.logs.push(entry);
    sendToPopup({ action: 'scanLog', text: entry });
    // Также отправляем на рабочую вкладку OZON для плавающей панели
    if (scanState.workerTabId) {
      try {
        chrome.tabs.sendMessage(scanState.workerTabId, {
          action: 'scanPanelUpdate',
          log: entry,
          current: scanState.currentIndex + 1,
          total: scanState.skus.length
        });
      } catch (_) {}
    }
    console.log('[OZG]', text);
  }

  // === Прямой API-запрос данных товара (без навигации) ===
  // Выполняет fetch к Ozon API из контекста открытой вкладки ozon.ru
  async function fetchProductDataDirect(sku, tabId) {
    const productPath = `/product/${sku}/`;

    const apiResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (sku, path) => {
        // Шаг 1: Пробуем прямой API-запрос к product page
        const endpoints = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`
        ];
        const headers = {
          'Accept': 'application/json',
          'x-o3-app-name': 'ozonapp_web',
          'x-o3-app-version': '1.0.0',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        };

        for (const apiUrl of endpoints) {
          try {
            const resp = await fetch(apiUrl, { method: 'GET', credentials: 'include', headers });
            if (!resp.ok) continue;
            const data = await resp.json();
            if (data && data.widgetStates && Object.keys(data.widgetStates).length > 0) {
              return { data, error: null, method: 'direct-' + (apiUrl.includes('entrypoint') ? 'entry' : 'composer') };
            }
          } catch (e) { continue; }
        }

        // Шаг 2: Поиск через search API
        try {
          const searchUrl = `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent('/search/?text=' + sku + '&from_global=true')}`;
          const searchResp = await fetch(searchUrl, { method: 'GET', credentials: 'include', headers });
          if (searchResp.ok) {
            const searchData = await searchResp.json();
            if (searchData && searchData.widgetStates) {
              // Ищем ссылку на товар в результатах поиска
              const ws = searchData.widgetStates;
              for (const [key, raw] of Object.entries(ws)) {
                try {
                  const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
                  const json = JSON.stringify(state);
                  // Ищем sku в ссылках /product/
                  const productMatch = json.match(new RegExp('/product/[^"]*' + sku + '[^"]*', 'i'));
                  if (productMatch) {
                    const foundPath = productMatch[0].split('?')[0];
                    // Запрашиваем данные найденного товара
                    for (const ep of endpoints) {
                      const epUrl = ep.replace(encodeURIComponent(path), encodeURIComponent(foundPath));
                      try {
                        const r = await fetch(epUrl, { method: 'GET', credentials: 'include', headers });
                        if (!r.ok) continue;
                        const d = await r.json();
                        if (d && d.widgetStates && Object.keys(d.widgetStates).length > 0) {
                          return { data: d, error: null, method: 'search-api' };
                        }
                      } catch (_) { continue; }
                    }
                  }
                } catch (_) {}
              }
            }
          }
        } catch (e) {}

        return { data: null, error: 'API не вернул данные', method: null };
      },
      args: [sku, productPath],
      world: 'MAIN'
    });

    const apiResult = apiResults?.[0]?.result;
    if (apiResult?.data?.widgetStates) {
      const wc = Object.keys(apiResult.data.widgetStates).length;
      logToPopup(`API прямой: ${wc} виджетов (${apiResult.method})`);
      return apiResult.data;
    }

    return null; // null = fallback на визуальный метод
  }

  // === Прямой запрос списка продавцов (без навигации) ===
  async function fetchSellersListDirect(tabId, modalLink) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (modalUrl) => {
        const urls = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(modalUrl)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(modalUrl)}`
        ];
        const headers = {
          'Accept': 'application/json',
          'x-o3-app-name': 'ozonapp_web',
          'x-o3-app-version': '1.0.0',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        };
        for (const apiUrl of urls) {
          try {
            const resp = await fetch(apiUrl, { method: 'GET', credentials: 'include', headers });
            if (!resp.ok) continue;
            const data = await resp.json();
            if (data && (data.widgetStates || data.modal || data.content)) {
              return { error: null, data };
            }
          } catch (e) { continue; }
        }
        return { error: 'Все API вернули пусто', data: null };
      },
      args: [modalLink],
      world: 'MAIN'
    });

    const result = results?.[0]?.result;
    if (!result || result.error || !result.data) return [];

    return parseSellersFromModalData(result.data);
  }

  // Парсинг продавцов из modal data (общий для обоих режимов)
  function parseSellersFromModalData(data) {
    const sellers = [];
    const ws = data.widgetStates || {};
    for (const [key, raw] of Object.entries(ws)) {
      let state;
      try { state = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { continue; }
      if (state.sellers && Array.isArray(state.sellers)) {
        for (const item of state.sellers) {
          const name = item.name || '';
          if (!name) continue;
          const sellerId = String(item.id || '');
          const competitorSku = String(item.sku || '');
          const sellerUrl = item.link || (sellerId ? `https://www.ozon.ru/seller/${sellerId}/` : '');
          const productLink = item.productLink || (competitorSku ? `https://www.ozon.ru/product/${competitorSku}/` : '');
          let price = '';
          try {
            if (item.price != null) {
              const priceJson = JSON.stringify(item.price);
              const rubleMatch = priceJson.match(/(\d[\d\s\u00a0]*)\s*₽/);
              if (rubleMatch) {
                price = rubleMatch[1].replace(/[\s\u00a0]/g, '');
              } else {
                const candidates = [
                  item.price?.price, item.price?.cardPrice, item.price?.originalPrice,
                  item.price?.value, item.price?.amount, item.price?.text,
                  typeof item.price === 'string' ? item.price : null,
                  typeof item.price === 'number' ? item.price : null
                ];
                for (const c of candidates) {
                  if (c == null) continue;
                  const s = String(c);
                  const m = s.match(/(\d[\d\s\u00a0.,]*)/);
                  if (m && m[1].replace(/[\s\u00a0]/g, '').length >= 2) {
                    price = m[1].replace(/[\s\u00a0]/g, '');
                    break;
                  }
                }
              }
            }
          } catch (e) {}
          sellers.push({ name: name.trim(), sellerId, price, competitorSku, url: sellerUrl, productLink });
        }
      }
    }
    return sellers;
  }

  // Проверка: это страница конкретного товара или категория/редирект?
  // Товар не в наличии → OZON возвращает категорию вместо product page
  function isProductPage(data, sku) {
    const ws = data.widgetStates || {};
    // Признак 1: есть виджет productHeading (конкретный товар)
    const hasProductHeading = Object.keys(ws).some(k =>
      k.toLowerCase().includes('productheading') || k.toLowerCase().includes('product_heading'));
    if (!hasProductHeading) return false;

    // Признак 2: SKU упоминается в widgetStates или SEO
    const dataStr = JSON.stringify(ws).substring(0, 50000);
    if (dataStr.includes(sku)) return true;

    // Признак 3: проверяем seo.url на наличие SKU
    if (data.seo?.url && data.seo.url.includes(sku)) return true;

    // Признак 4: title не содержит "купить на OZON" (маркер категории)
    const title = data.seo?.title || '';
    if (title.includes('купить на OZON') || title.includes('купить на Ozon')) return false;

    return hasProductHeading;
  }

  // === Быстрое сканирование одного SKU (API-only, без навигации) ===
  async function scanSkuFast(sku, tabId, config) {
    // Прямой API-запрос данных товара
    const pageData = await fetchProductDataDirect(sku, tabId);
    if (!pageData) return null; // fallback на визуальный

    // Проверка: OZON вернул конкретный товар или категорию (товар не в наличии)?
    if (!isProductPage(pageData, sku)) {
      logToPopup(`⚠ SKU ${sku}: OZON вернул категорию вместо товара (нет в наличии?) — пропуск`);
      return { sku, sellers: [], productName: '', error: 'Товар не найден или не в наличии' };
    }

    const mainInfo = parseMainPageSellers(pageData);
    let sellers = [];

    if (mainInfo.otherSellersCount > 0 && mainInfo.modalLink) {
      sellers = await fetchSellersListDirect(tabId, mainInfo.modalLink);
    } else if (mainInfo.otherSellersCount > 0) {
      // Пробуем извлечь product_id из widgetStates
      const productId = extractProductId(pageData, sku);
      if (productId) {
        const fallbackModal = `/modal/otherOffersFromSellers?product_id=${productId}`;
        sellers = await fetchSellersListDirect(tabId, fallbackModal);
      }
    }

    // Также добавляем продавцов из DOM-fallback если они были в pageData
    if (pageData.sellers && pageData.sellers.length > 0 && sellers.length === 0) {
      sellers = pageData.sellers;
    }

    const filtered = filterSellers(sellers, config);
    return { sku, sellers: filtered, productName: mainInfo.productName, error: null };
  }

  // Извлечь product_id из widgetStates (для fallback modal URL)
  function extractProductId(data, sku) {
    const ws = data.widgetStates || {};
    for (const [key, raw] of Object.entries(ws)) {
      try {
        const json = typeof raw === 'string' ? raw : JSON.stringify(raw);
        // Ищем product_id в JSON
        const m = json.match(/"product_id"\s*:\s*(\d+)/);
        if (m) return m[1];
        // Fallback: sku как product_id
        const skuMatch = json.match(new RegExp('"id"\\s*:\\s*' + sku));
        if (skuMatch) return sku;
      } catch (e) {}
    }
    return sku; // В крайнем случае используем сам SKU
  }

  // === Создать рабочее окно (отдельное от пользователя) ===
  async function getWorkerTab() {
    // Проверяем существующую
    if (scanState.workerTabId) {
      try {
        const tab = await chrome.tabs.get(scanState.workerTabId);
        if (tab && tab.url && tab.url.includes('ozon.ru')) {
          return scanState.workerTabId;
        }
      } catch (e) {
        scanState.workerTabId = null;
        scanState.workerWindowId = null;
      }
    }

    // Создаём ОТДЕЛЬНОЕ окно (не фоновую вкладку!)
    // Отдельное окно = вкладка считается "active" → OZON грузит полный контент
    logToPopup('Создаю рабочее окно OZON...');
    const win = await chrome.windows.create({
      url: 'https://www.ozon.ru/',
      focused: false,
      type: 'normal',
      width: 1200,
      height: 800,
      left: 0,
      top: 0
    });

    scanState.workerTabId = win.tabs[0].id;
    scanState.workerWindowId = win.id;
    await waitForTabComplete(scanState.workerTabId);
    await delay(2000);

    // Инжект плавающей панели
    try {
      await chrome.scripting.executeScript({
        target: { tabId: scanState.workerTabId },
        files: ['content/scan-panel.js']
      });
    } catch (_) {}

    return scanState.workerTabId;
  }

  // Инжект плавающей панели (вызывается после каждой навигации)
  async function injectScanPanel() {
    if (!scanState.workerTabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: scanState.workerTabId },
        files: ['content/scan-panel.js']
      });
    } catch (_) {}
  }

  // Закрыть рабочее окно
  async function closeWorkerWindow() {
    if (scanState.workerWindowId) {
      try { await chrome.windows.remove(scanState.workerWindowId); } catch (e) {}
    } else if (scanState.workerTabId) {
      try { await chrome.tabs.remove(scanState.workerTabId); } catch (e) {}
    }
    scanState.workerTabId = null;
    scanState.workerWindowId = null;
  }

  function waitForTabComplete(tabId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, TAB_READY_TIMEOUT_MS);

      function listener(updatedId, info) {
        if (updatedId === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }

      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          reject(new Error('Вкладка не найдена'));
          return 'continue';
        }
        if (tab.status === 'complete') {
          clearTimeout(timer);
          resolve();
        } else {
          chrome.tabs.onUpdated.addListener(listener);
        }
      });
    });
  }

  // === Имитация человеческого поведения ===
  async function simulateHumanBehavior(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Плавный скролл на случайное расстояние
          const scrollY = 200 + Math.random() * 600;
          window.scrollTo({ top: scrollY, behavior: 'smooth' });

          // Имитация движения мыши (MouseEvent)
          const x = 100 + Math.random() * (window.innerWidth - 200);
          const y = 100 + Math.random() * (window.innerHeight - 200);
          document.dispatchEvent(new MouseEvent('mousemove', {
            clientX: x, clientY: y, bubbles: true
          }));

          // Случайный hover на элемент
          const el = document.elementFromPoint(x, y);
          if (el) {
            el.dispatchEvent(new MouseEvent('mouseenter', { clientX: x, clientY: y, bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
          }

          // Небольшой скролл обратно (как будто пользователь читает)
          setTimeout(() => {
            window.scrollTo({ top: scrollY * 0.3, behavior: 'smooth' });
          }, 300 + Math.random() * 500);
        },
        world: 'MAIN'
      });
    } catch (e) {}
  }

  // Сбросить перехватчик
  async function resetInterceptor(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__ozguard = {
            widgetStates: {}, seo: null, layout: [],
            widgetCount: 0, callCount: 0, ready: false, method: '', urls: []
          };
        },
        world: 'MAIN'
      });
    } catch (e) {}
  }

  // Найти ссылку на товар на странице поиска
  async function findProductOnPage(tabId, sku) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sku) => {
        const allLinks = document.querySelectorAll('a[href*="/product/"]');
        let bestMatch = null;
        let firstProduct = null;

        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          if (!href.includes('/product/') || href.length < 15) continue;
          const clean = href.split('?')[0];
          if (!firstProduct) firstProduct = clean;
          // Приоритет: ссылка содержит наш SKU в URL
          if (clean.includes(sku)) {
            bestMatch = clean;
            break;
          }
        }
        return bestMatch || firstProduct || null;
      },
      args: [sku],
      world: 'MAIN'
    });

    return results?.[0]?.result || null;
  }

  // === Поиск SKU → SPA-клик на товар → перехват API-данных ===
  async function fetchProductData(sku) {
    const tabId = await getWorkerTab();

    // Шаг 1: Открываем поиск по SKU
    const searchUrl = `https://www.ozon.ru/search/?text=${encodeURIComponent(sku)}&from_global=true`;
    logToPopup(`Ищу SKU ${sku}...`);

    await chrome.tabs.update(tabId, { url: searchUrl });
    await waitForTabComplete(tabId);
    await injectScanPanel();
    await humanDelay(3000);

    // Имитация поведения на странице поиска
    await simulateHumanBehavior(tabId);
    await humanDelay(800);

    // Если OZON перенаправил на товар — возвращаемся к поиску
    // (нам нужна страница поиска чтобы кликнуть по ссылке = SPA-навигация)
    let tab = await chrome.tabs.get(tabId);
    let currentUrl = tab.url || '';

    if (currentUrl.includes('/product/')) {
      logToPopup('Редирект на товар, возвращаюсь к поиску...');
      await chrome.tabs.update(tabId, { url: searchUrl });
      await waitForTabComplete(tabId);
      await injectScanPanel();
      await humanDelay(3000);
      await simulateHumanBehavior(tabId);
      await humanDelay(600);
    }

    // Шаг 2: Находим ссылку на товар в результатах поиска
    const productHref = await findProductOnPage(tabId, sku);
    if (!productHref) {
      throw new Error(`Товар по SKU ${sku} не найден на OZON`);
    }
    logToPopup(`Найден: ${productHref.substring(0, 55)}`);

    // Шаг 3: Сбрасываем interceptor и КЛИКАЕМ по ссылке (SPA-навигация!)
    // Клик через SPA-роутер → OZON делает API-вызов клиентски → interceptor перехватит
    await resetInterceptor(tabId);
    logToPopup('SPA-переход на товар...');

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (href) => {
        const clean = href.split('?')[0];
        const links = document.querySelectorAll('a[href*="/product/"]');
        for (const link of links) {
          const lh = (link.getAttribute('href') || '').split('?')[0];
          if (lh === clean || lh.includes(clean) || clean.includes(lh)) {
            link.removeAttribute('target');
            link.click();
            return 'continue';
          }
        }
        // Fallback: программная навигация (может триггернуть SPA роутер)
        const a = document.createElement('a');
        a.href = href;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
      args: [productHref],
      world: 'MAIN'
    });

    // Ждём SPA-навигацию
    await humanDelay(3000);

    // Имитация на странице товара
    await simulateHumanBehavior(tabId);
    await humanDelay(500);

    // Проверяем что перешли на страницу товара
    tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url || '';
    if (!currentUrl.includes('/product/')) {
      // SPA не сработала — пробуем прямую навигацию
      logToPopup('SPA не сработала, пробую прямой переход...');
      await resetInterceptor(tabId);
      const fullUrl = productHref.startsWith('http') ? productHref : 'https://www.ozon.ru' + productHref;
      await chrome.tabs.update(tabId, { url: fullUrl });
      await waitForTabComplete(tabId);
      await injectScanPanel();
      await humanDelay(3000);
      await simulateHumanBehavior(tabId);
    }

    // Получаем путь товара из URL
    tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url || '';
    const productPath = new URL(currentUrl).pathname;
    logToPopup(`На странице: ${productPath}`);

    // Верификация: URL должен содержать наш SKU
    if (!currentUrl.includes(sku)) {
      logToPopup(`⚠ SKU ${sku} не найден в URL — возможно OZON показал другой товар, пропускаю`);
      return { widgetStates: {}, url: currentUrl, skuMismatch: true };
    }

    // === ГЛАВНЫЙ МЕТОД: прямой API-вызов из контекста страницы товара ===
    // Мы на странице товара → same-origin → cookies есть → должно работать
    // Задержка перед API (имитация чтения страницы)
    await humanDelay(1200);
    logToPopup('Запрашиваю данные через API...');

    const apiResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (path) => {
        const endpoints = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`
        ];

        for (const apiUrl of endpoints) {
          try {
            const resp = await fetch(apiUrl, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'x-o3-app-name': 'ozonapp_web',
                'x-o3-app-version': '1.0.0',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
              }
            });

            if (!resp.ok) {
              // Пробуем XHR fallback
              const xhrResult = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', apiUrl, true);
                xhr.setRequestHeader('Accept', 'application/json');
                xhr.setRequestHeader('x-o3-app-name', 'ozonapp_web');
                xhr.withCredentials = true;
                xhr.onload = function() {
                  if (xhr.status === 200) {
                    try { resolve({ data: JSON.parse(xhr.responseText), error: null, status: xhr.status }); }
                    catch (e) { resolve({ data: null, error: 'JSON parse', status: xhr.status }); }
                  } else {
                    resolve({ data: null, error: `HTTP ${xhr.status}`, status: xhr.status });
                  }
                };
                xhr.onerror = () => resolve({ data: null, error: 'network error', status: 0 });
                xhr.send();
              });

              if (xhrResult.data && xhrResult.data.widgetStates) {
                return { data: xhrResult.data, error: null, method: 'xhr-' + apiUrl.substring(5, 20) };
              }
              continue;
            }

            const data = await resp.json();
            if (data && data.widgetStates) {
              return { data, error: null, method: 'fetch-' + apiUrl.substring(5, 20) };
            }
          } catch (e) {
            continue;
          }
        }

        // Пробуем найти данные в DOM
        try {
          // React state через fiber
          const appEl = document.getElementById('__next') || document.getElementById('app') || document.getElementById('root');
          if (appEl) {
            const fiberKey = Object.keys(appEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (fiberKey) {
              // Traverse fiber tree looking for widgetStates
              let fiber = appEl[fiberKey];
              let depth = 0;
              while (fiber && depth < 20) {
                const state = fiber.memoizedState || fiber.stateNode?.state;
                if (state && typeof state === 'object') {
                  // Check for widgetStates in the state chain
                  let s = state;
                  while (s) {
                    if (s.memoizedState && typeof s.memoizedState === 'object') {
                      const ms = s.memoizedState;
                      if (ms.widgetStates) return { data: ms, error: null, method: 'react-fiber' };
                    }
                    s = s.next;
                  }
                }
                fiber = fiber.child || fiber.sibling || fiber.return;
                depth++;
              }
            }
          }
        } catch (e) {}

        // Ищем seller-ссылки в DOM
        const sellers = [];
        const sellerLinks = document.querySelectorAll('a[href*="/seller/"]');
        const seen = new Set();
        for (const link of sellerLinks) {
          const href = link.getAttribute('href') || '';
          if (href.includes('/info/') || href.includes('/reviews')) continue;
          const m = href.match(/\/seller\/([^/?#]+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          const idM = m[1].match(/(\d+)$/);
          const name = link.textContent.trim();
          if (name && name.length > 1) {
            sellers.push({ name, sellerId: idM ? idM[1] : '', url: 'https://www.ozon.ru' + href });
          }
        }

        return {
          data: null,
          sellers,
          error: 'API вернул пусто или 403',
          diag: {
            url: location.href,
            title: document.title,
            bodyLen: document.body?.innerHTML?.length || 0,
            dataWidgets: document.querySelectorAll('[data-widget]').length,
            sellerLinks: sellerLinks.length,
            allWidgetNames: [...document.querySelectorAll('[data-widget]')].map(el => el.getAttribute('data-widget')).slice(0, 30)
          }
        };
      },
      args: [productPath],
      world: 'MAIN'
    });

    const apiResult = apiResults?.[0]?.result;

    if (apiResult?.data?.widgetStates) {
      const ws = apiResult.data.widgetStates;
      const wc = Object.keys(ws).length;
      logToPopup(`API OK: ${wc} виджетов (${apiResult.method})`);

      return apiResult.data;
    }

    // DOM sellers fallback
    if (apiResult?.sellers?.length > 0) {
      logToPopup(`DOM: ${apiResult.sellers.length} продавцов`);
      return { widgetStates: {}, sellers: apiResult.sellers };
    }

    // Диагностика
    if (apiResult?.diag) {
      const d = apiResult.diag;
      logToPopup(`ДИАГ: body=${d.bodyLen}b, data-widget=${d.dataWidgets}, seller-links=${d.sellerLinks}`);
      if (d.allWidgetNames?.length > 0) {
        logToPopup(`DOM виджеты: ${d.allWidgetNames.join(', ')}`);
      }
    }
    logToPopup(`Ошибка API: ${apiResult?.error || 'нет результата'}`);

    throw new Error('Не удалось получить данные товара');
  }

  // Извлечение данных из DOM страницы
  function extractDataFromDOM() {
    const result = { widgetStates: {}, sellers: [], _method: '' };

    try {
      // __NEXT_DATA__
      const nextEl = document.getElementById('__NEXT_DATA__');
      if (nextEl) {
        try {
          const nd = JSON.parse(nextEl.textContent);
          if (nd?.props?.pageProps?.widgetStates) {
            result.widgetStates = nd.props.pageProps.widgetStates;
            result._method = 'NEXT_DATA';
            return result;
          }
          if (nd?.widgetStates) {
            result.widgetStates = nd.widgetStates;
            result._method = 'NEXT_DATA_root';
            return result;
          }
        } catch (e) {}
      }

      // JSON в script тегах
      for (const script of document.querySelectorAll('script:not([src])')) {
        const text = script.textContent || '';
        if (text.length < 500 || !text.includes('widgetStates')) continue;

        if (script.type === 'application/json') {
          try {
            const d = JSON.parse(text);
            if (d.widgetStates) {
              result.widgetStates = d.widgetStates;
              result._method = 'script-json';
              return result;
            }
          } catch (e) {}
        }
      }

      // DOM: ссылки на продавцов
      const sellerLinks = document.querySelectorAll('a[href*="/seller/"]');
      const seen = new Set();

      for (const link of sellerLinks) {
        const href = link.getAttribute('href') || '';
        if (href.includes('/info/') || href.includes('/reviews')) continue;

        const slugMatch = href.match(/\/seller\/([^/?#]+)/);
        if (!slugMatch) continue;

        const slug = slugMatch[1];
        if (seen.has(slug)) continue;
        seen.add(slug);

        const idMatch = slug.match(/(\d+)$/);
        const sellerId = idMatch ? idMatch[1] : '';

        let name = link.textContent.trim();
        if (!name || name.length < 2) {
          const parent = link.closest('[data-widget]') || link.parentElement?.parentElement?.parentElement;
          if (parent) {
            for (const sp of parent.querySelectorAll('span, div')) {
              const t = sp.textContent.trim();
              if (t.length > 2 && t.length < 100 && !t.includes('₽') && !t.match(/^\d/)) {
                name = t;
                break;
              }
            }
          }
        }
        if (!name || name.length < 2) continue;

        let price = '';
        const pc = link.closest('[data-widget]') || link.parentElement?.parentElement;
        if (pc) {
          const pm = (pc.textContent || '').match(/(\d[\d\s]*)\s*₽/);
          if (pm) price = pm[1].replace(/\s/g, '');
        }

        result.sellers.push({
          name, sellerId, price, competitorSku: '',
          url: href.startsWith('http') ? href : 'https://www.ozon.ru' + href
        });
      }

      if (result.sellers.length > 0) result._method = 'dom-links';
      return result;
    } catch (e) {
      result._method = 'error: ' + e.message;
      return result;
    }
  }

  // === Парсинг данных о продавцах с ГЛАВНОЙ страницы товара ===
  function parseMainPageSellers(data) {
    const productName = extractProductName(data);
    const ws = data.widgetStates || {};
    let otherSellersCount = 0;
    let modalLink = '';
    let currentSellerName = '';

    for (const [key, raw] of Object.entries(ws)) {
      const kl = key.toLowerCase();
      let state;
      try { state = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { continue; }

      if (kl.includes('bestseller') || kl.includes('best_seller')) {
        if (state.count) otherSellersCount = parseInt(state.count, 10) || 0;
        if (state.modalLink) modalLink = state.modalLink;
      }

      if (kl.includes('currentseller') || kl.includes('current_seller')) {
        // Имя продавца в subtitle или в link с /seller/
        const json = JSON.stringify(state);
        const sellerLinkMatch = json.match(/\/seller\/([^"/?]+)/);
        if (sellerLinkMatch) {
          // Ищем текст рядом с ссылкой — обычно имя продавца
          const nameMatch = json.match(/"title"[^}]*"text"\s*:\s*"([^"]+)"/);
          // subtitle обычно содержит имя
          if (state.header?.subtitle?.components) {
            for (const comp of state.header.subtitle.components) {
              if (comp.text && comp.text !== 'Подписаться' && !comp.text.includes('SIZE_')) {
                currentSellerName = comp.text;
                break;
              }
            }
          }
          if (!currentSellerName && state.header?.subtitle?.text && state.header.subtitle.text !== 'Подписаться') {
            currentSellerName = state.header.subtitle.text;
          }
        }
      }
    }

    return { productName, otherSellersCount, modalLink, currentSellerName };
  }

  // === Получить список продавцов через modal endpoint ===
  async function fetchSellersList(tabId, modalLink) {
    logToPopup('Загружаю список продавцов...');

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (modalUrl) => {
        // Пробуем несколько вариантов API для modal
        const urls = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(modalUrl)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(modalUrl)}`
        ];

        for (const apiUrl of urls) {
          try {
            const resp = await fetch(apiUrl, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'x-o3-app-name': 'ozonapp_web',
                'x-o3-app-version': '1.0.0',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin'
              }
            });

            if (!resp.ok) continue;
            const data = await resp.json();
            if (data && (data.widgetStates || data.modal || data.content || data.items)) {
              return { error: null, data, method: apiUrl.includes('entrypoint') ? 'entrypoint' : 'composer' };
            }
          } catch (e) { continue; }
        }

        return { error: 'Все API вернули пусто', data: null };
      },
      args: [modalLink],
      world: 'MAIN'
    });

    const result = results?.[0]?.result;
    if (!result || result.error || !result.data) {
      logToPopup(`Modal ошибка: ${result?.error || 'нет данных'}`);
      return [];
    }

    logToPopup(`Modal OK (${result.method})`);
    const sellers = parseSellersFromModalData(result.data);
    logToPopup(`Modal: ${sellers.length} продавцов`);
    return sellers;
  }

  function extractSellersFromState(state) {
    const sellers = [];
    if (!state || typeof state !== 'object') return sellers;

    const arrays = [
      state.items, state.offers, state.sellers, state.sellerList,
      state.data?.items, state.data?.offers, state.data?.sellers,
      state.content?.items, state.content?.offers
    ];

    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        const s = extractSeller(item);
        if (s) sellers.push(s);
      }
    }

    return sellers;
  }

  function deepFindSellers(obj, depth) {
    if (depth > 4 || !obj || typeof obj !== 'object') return [];
    const sellers = [];

    if (obj.sellerId && (obj.sellerName || obj.seller_name || obj.name)) {
      const s = extractSeller(obj);
      if (s) sellers.push(s);
      return sellers;
    }

    if (Array.isArray(obj)) {
      for (const item of obj) sellers.push(...deepFindSellers(item, depth + 1));
      return sellers;
    }

    for (const key of ['sellers', 'offers', 'items', 'sellerList', 'otherSellers', 'cheaperSellers']) {
      if (obj[key] && Array.isArray(obj[key])) {
        for (const item of obj[key]) {
          const s = extractSeller(item);
          if (s) sellers.push(s);
          sellers.push(...deepFindSellers(item, depth + 1));
        }
      }
    }

    return sellers;
  }

  function extractSeller(item) {
    if (!item || typeof item !== 'object') return null;

    const name = item.sellerName || item.seller_name || item.name || item.title || item.seller?.name || '';
    if (!name || typeof name !== 'string') return null;

    let sellerId = String(item.sellerId || item.seller_id || item.id || item.seller?.id || '');

    const deeplink = item.deeplink || item.link || item.url || '';
    if (!sellerId && deeplink) {
      const m = deeplink.match(/seller\/(?:[^/]*?-)?(\d+)/);
      if (m) sellerId = m[1];
    }

    let price = '';
    if (item.price != null) price = String(item.price).replace(/[^\d.,]/g, '');
    else if (item.finalPrice != null) price = String(item.finalPrice).replace(/[^\d.,]/g, '');
    else if (item.priceText) { const m = item.priceText.match(/(\d[\d\s.,]*)/); if (m) price = m[1].replace(/\s/g, ''); }

    let competitorSku = String(item.sku || item.productId || item.product_id || '');
    if (!competitorSku && deeplink) {
      const m = deeplink.match(/product\/[^/]*?-?(\d{5,})/);
      if (m) competitorSku = m[1];
    }

    let url = '';
    if (sellerId) url = `https://www.ozon.ru/seller/${sellerId}/`;
    const sellerUrl = item.sellerUrl || item.seller_url || '';
    if (sellerUrl) url = sellerUrl.startsWith('http') ? sellerUrl : 'https://www.ozon.ru' + sellerUrl;

    return { name: name.trim(), sellerId, price, competitorSku, url };
  }

  function extractProductName(data) {
    const ws = data.widgetStates || {};
    for (const [key, val] of Object.entries(ws)) {
      if (key.toLowerCase().includes('productheading') || key.toLowerCase().includes('product_heading')) {
        try {
          const st = typeof val === 'string' ? JSON.parse(val) : val;
          if (st.title) return st.title;
          if (st.name) return st.name;
        } catch (e) {}
      }
    }
    if (data.seo?.title) return data.seo.title;
    return '';
  }

  function filterSellers(sellers, config) {
    const seen = new Set();
    const filtered = [];
    const excludeNames = (config.excludeSellers || []).map(n => n.toLowerCase().trim()).filter(Boolean);

    for (const s of sellers) {
      const key = s.sellerId || s.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const nameLower = s.name.toLowerCase();
      if (excludeNames.some(ex => nameLower.includes(ex))) continue;
      filtered.push(s);
    }
    return filtered;
  }

  async function waitWhilePaused() {
    while (scanState.isPaused && scanState.isRunning) await delay(500);
  }

  async function getDelayMs() {
    try {
      const data = await chrome.storage.local.get(['delayMs']);
      return data.delayMs || DEFAULT_DELAY_MS;
    } catch (e) {
      return DEFAULT_DELAY_MS;
    }
  }

  async function saveToHistory(results, config, skus) {
    try {
      const session = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        date: new Date().toISOString(),
        skusCount: skus.length,
        skus,
        sellersFound: results.reduce((sum, r) => sum + (r.sellers ? r.sellers.length : 0), 0),
        excludeSellers: config.excludeSellers || [],
        results,
        logs: scanState.logs.slice()
      };

      const data = await chrome.storage.local.get(['scanHistory']);
      let history = data.scanHistory || [];
      history.unshift(session);
      if (history.length > MAX_HISTORY_SESSIONS) history = history.slice(0, MAX_HISTORY_SESSIONS);
      await chrome.storage.local.set({ scanHistory: history });
      logToPopup('Сессия сохранена');
    } catch (e) {
      console.error('[OZG] saveToHistory:', e);
    }
  }

  function startScanInternal(skus, config) {
    scanState = {
      isRunning: true, isPaused: false,
      skus, currentIndex: 0, results: [],
      config: config || {}, logs: [],
      workerTabId: scanState.workerTabId,
      workerWindowId: scanState.workerWindowId
    };
    logToPopup(`Старт: ${scanState.skus.length} SKU`);
    runScan();
  }

  // === Основной цикл ===
  async function runScan() {
    const { skus, config } = scanState;
    const total = skus.length;
    const delayMs = await getDelayMs();
    const scanMode = config.scanMode || 'fast'; // 'fast' | 'visual'

    // Быстрый режим: скрытый таб + прямые API-запросы
    // Визуальный режим: отдельное окно + навигация (как было)
    const isFastMode = scanMode === 'fast';

    if (isFastMode) {
      try {
        const existingTabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
        if (existingTabs.length > 0) {
          scanState.hiddenTabId = existingTabs[0].id;
          scanState.hiddenTabCreated = false;
        } else {
          logToPopup('Создаю скрытый таб OZON...');
          const tab = await chrome.tabs.create({ url: 'https://www.ozon.ru/', active: false });
          await waitForTabComplete(tab.id);
          await delay(2000);
          scanState.hiddenTabId = tab.id;
          scanState.hiddenTabCreated = true;
        }
        logToPopup('Быстрый режим: API-запросы без навигации');
      } catch (e) {
        logToPopup('Не удалось подготовить таб — переключаюсь на визуальный режим');
        return runScanVisual(skus, config, total, delayMs);
      }
    } else {
      try {
        await getWorkerTab();
        logToPopup('Рабочее окно готово (визуальный режим)');
      } catch (e) {
        logToPopup('Ошибка: не удалось открыть окно OZON');
        scanState.isRunning = false;
        sendToPopup({ action: 'scanComplete', results: [] });
        return;
      }
    }

    let fastFailCount = 0; // Счётчик подряд неудачных быстрых запросов

    for (let i = scanState.currentIndex; i < total; i++) {
      if (!scanState.isRunning) break;
      await waitWhilePaused();
      if (!scanState.isRunning) break;

      scanState.currentIndex = i;
      const sku = skus[i];
      logToPopup(`[${i + 1}/${total}] SKU ${sku}`);

      let result = null;

      // === Быстрый путь (API-only) ===
      if (isFastMode && fastFailCount < 3) {
        try {
          result = await scanSkuFast(sku, scanState.hiddenTabId, config);
          if (result) {
            logToPopup(`⚡ ${result.sellers.length} конкурентов` + (result.productName ? ` (${result.productName.substring(0, 40)})` : ''));
            fastFailCount = 0;
          } else {
            fastFailCount++;
            logToPopup(`API не вернул данные (попытка ${fastFailCount}/3), пробую визуальный...`);
          }
        } catch (e) {
          fastFailCount++;
          logToPopup(`Быстрый запрос ошибка: ${e.message} (${fastFailCount}/3)`);
        }
      }

      // === Визуальный fallback ===
      if (!result) {
        // Убедимся что рабочее окно готово
        if (!scanState.workerTabId) {
          try {
            await getWorkerTab();
          } catch (e) {
            logToPopup(`Ошибка: ${e.message}`);
            result = { sku, sellers: [], productName: '', error: e.message };
            scanState.results.push(result);
            sendToPopup({ action: 'scanProgress', current: i + 1, total, ...result });
            continue;
          }
        }

        try {
          const pageData = await fetchProductData(sku);

          if (pageData.skuMismatch) {
            result = { sku, sellers: [], productName: '', error: 'SKU не совпал — OZON перенаправил на другой товар' };
          } else {
            const mainInfo = parseMainPageSellers(pageData);
            logToPopup(`Продавцов на карточке: ${mainInfo.otherSellersCount}`);

            let sellers = [];
            if (mainInfo.otherSellersCount > 0 && mainInfo.modalLink) {
              sellers = await fetchSellersList(scanState.workerTabId, mainInfo.modalLink);
            } else if (mainInfo.otherSellersCount > 0) {
              const tab = await chrome.tabs.get(scanState.workerTabId);
              const currentUrl = new URL(tab.url);
              const pidMatch = currentUrl.pathname.match(/(\d+)\/?$/);
              if (pidMatch) {
                const fallbackModal = `/modal/otherOffersFromSellers?product_id=${pidMatch[1]}`;
                sellers = await fetchSellersList(scanState.workerTabId, fallbackModal);
              }
            }

            const filtered = filterSellers(sellers, config);
            logToPopup(`→ ${filtered.length} конкурентов` + (mainInfo.productName ? ` (${mainInfo.productName.substring(0, 40)})` : ''));
            result = { sku, sellers: filtered, productName: mainInfo.productName, error: null };
          }
        } catch (e) {
          logToPopup(`Ошибка: ${e.message}`);
          result = { sku, sellers: [], productName: '', error: e.message };
          scanState.workerTabId = null;
          scanState.workerWindowId = null;
        }
      }

      scanState.results.push(result);
      sendToPopup({ action: 'scanProgress', current: i + 1, total, ...result });

      // Задержка между SKU
      if (i < total - 1 && scanState.isRunning) {
        const actualDelay = isFastMode && fastFailCount === 0 ? FAST_DELAY_MS : delayMs;
        await humanDelay(actualDelay);

        // Визуальный режим: имитация поведения
        if (!isFastMode && scanState.workerTabId) {
          await simulateHumanBehavior(scanState.workerTabId);
        }
        // Антибот: доп. пауза каждые 20 SKU
        if (total >= 50 && (i + 1) % 20 === 0) {
          const pauseSec = isFastMode ? (3 + Math.round(Math.random() * 5)) : (10 + Math.round(Math.random() * 10));
          logToPopup(`Антибот: пауза ${pauseSec} сек (${i + 1}/${total})`);
          await delay(pauseSec * 1000);
        }
      }
    }

    scanState.isRunning = false;
    await saveToHistory(scanState.results, scanState.config, scanState.skus);

    const totalSellers = scanState.results.reduce((s, r) => s + (r.sellers ? r.sellers.length : 0), 0);
    sendToPopup({ action: 'scanComplete', results: scanState.results });
    logToPopup(`Завершено: ${totalSellers} конкурентов по ${skus.length} SKU`);

    await delay(1000);
    // Закрываем рабочее окно если использовалось
    await closeWorkerWindow();
    // Закрываем скрытый таб если мы его создали
    if (scanState.hiddenTabCreated && scanState.hiddenTabId) {
      try { await chrome.tabs.remove(scanState.hiddenTabId); } catch (e) {}
    }
    scanState.hiddenTabId = null;
    scanState.hiddenTabCreated = false;
  }

  // Визуальный режим — прежний полный цикл (используется как fallback)
  async function runScanVisual(skus, config, total, delayMs) {
    try {
      await getWorkerTab();
      logToPopup('Рабочее окно готово (fallback визуальный)');
    } catch (e) {
      logToPopup('Ошибка: не удалось открыть окно OZON');
      scanState.isRunning = false;
      sendToPopup({ action: 'scanComplete', results: [] });
      return;
    }

    for (let i = scanState.currentIndex; i < total; i++) {
      if (!scanState.isRunning) break;
      await waitWhilePaused();
      if (!scanState.isRunning) break;

      scanState.currentIndex = i;
      const sku = skus[i];
      logToPopup(`[${i + 1}/${total}] SKU ${sku} (визуальный)`);

      let result;
      try {
        const pageData = await fetchProductData(sku);
        if (pageData.skuMismatch) {
          result = { sku, sellers: [], productName: '', error: 'SKU не совпал' };
        } else {
          const mainInfo = parseMainPageSellers(pageData);
          let sellers = [];
          if (mainInfo.otherSellersCount > 0 && mainInfo.modalLink) {
            sellers = await fetchSellersList(scanState.workerTabId, mainInfo.modalLink);
          } else if (mainInfo.otherSellersCount > 0) {
            const tab = await chrome.tabs.get(scanState.workerTabId);
            const pidMatch = new URL(tab.url).pathname.match(/(\d+)\/?$/);
            if (pidMatch) sellers = await fetchSellersList(scanState.workerTabId, `/modal/otherOffersFromSellers?product_id=${pidMatch[1]}`);
          }
          const filtered = filterSellers(sellers, config);
          logToPopup(`→ ${filtered.length} конкурентов`);
          result = { sku, sellers: filtered, productName: mainInfo.productName, error: null };
        }
      } catch (e) {
        logToPopup(`Ошибка: ${e.message}`);
        result = { sku, sellers: [], productName: '', error: e.message };
        scanState.workerTabId = null;
        scanState.workerWindowId = null;
      }

      scanState.results.push(result);
      sendToPopup({ action: 'scanProgress', current: i + 1, total, ...result });

      if (i < total - 1 && scanState.isRunning) {
        await humanDelay(delayMs);
        if (scanState.workerTabId) await simulateHumanBehavior(scanState.workerTabId);
        if (total >= 50 && (i + 1) % 20 === 0) {
          const pauseSec = 10 + Math.round(Math.random() * 10);
          logToPopup(`Антибот: пауза ${pauseSec} сек`);
          await delay(pauseSec * 1000);
        }
      }
    }

    scanState.isRunning = false;
    await saveToHistory(scanState.results, config, skus);
    const totalSellers = scanState.results.reduce((s, r) => s + (r.sellers ? r.sellers.length : 0), 0);
    sendToPopup({ action: 'scanComplete', results: scanState.results });
    logToPopup(`Завершено: ${totalSellers} конкурентов по ${skus.length} SKU`);
    await delay(1000);
    await closeWorkerWindow();
  }

  // === Обработка сообщений ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'getLicenseStatus') {
      getLicenseStatus().then(status => sendResponse(status));
      return true;
    }

    if (msg.action === 'activateTrial') {
      activateTrial().then(result => sendResponse(result));
      return true;
    }

    if (msg.action === 'activateLicense') {
      activateLicense(msg.code).then(result => sendResponse(result));
      return true;
    }

    if (msg.action === 'deactivateLicense') {
      deactivateLicense().then(result => sendResponse(result));
      return true;
    }

    if (msg.action === 'startScan') {
      if (scanState.isRunning) { sendResponse({ status: 'already_running' }); return true; }
      const skus = msg.skus || [];
      // Сбор SKU (одиночный + множественный + пакетный XLSX) — бесплатный функционал.
      // PRO-подписка нужна только для бота подачи жалоб.
      startScanInternal(skus, msg.config);
      sendResponse({ status: 'started' });
      return true;
    }

    if (msg.action === 'getScanStatus') {
      sendResponse({
        isRunning: scanState.isRunning,
        isPaused: scanState.isPaused,
        currentIndex: scanState.currentIndex,
        total: scanState.skus ? scanState.skus.length : 0,
        results: scanState.results || [],
        logs: scanState.logs || []
      });
      return true;
    }

    if (msg.action === 'pauseScan') { scanState.isPaused = true; logToPopup('Пауза'); sendResponse({ status: 'paused' }); return true; }
    if (msg.action === 'resumeScan') { scanState.isPaused = false; logToPopup('Возобновлено'); sendResponse({ status: 'resumed' }); return true; }

    if (msg.action === 'stopScan') {
      scanState.isRunning = false;
      scanState.isPaused = false;
      logToPopup('Остановлено');
      if (scanState.results.length > 0) saveToHistory(scanState.results, scanState.config, scanState.skus);
      closeWorkerWindow();
      sendResponse({ status: 'stopped' });
      return true;
    }

    if (msg.action === 'getHistory') {
      chrome.storage.local.get(['scanHistory'], (data) => sendResponse({ history: data.scanHistory || [] }));
      return true;
    }

    if (msg.action === 'deleteHistorySession') {
      chrome.storage.local.get(['scanHistory'], (data) => {
        const history = (data.scanHistory || []).filter(s => s.id !== msg.sessionId);
        chrome.storage.local.set({ scanHistory: history }, () => sendResponse({ status: 'deleted' }));
      });
      return true;
    }

    if (msg.action === 'clearHistory') {
      chrome.storage.local.set({ scanHistory: [] }, () => sendResponse({ status: 'cleared' }));
      return true;
    }

    // === SUPPORT AUTOMATION ===
    if (msg.action === 'supportStart') {
      if (supportState.isRunning) { sendResponse({ status: 'already_running' }); return true; }
      // PRO check
      getLicenseStatus().then(async (license) => {
        await restoreActiveSupportSession();
        if (supportState.isRunning) {
          sendResponse({ status: 'already_running' });
          return;
        }
        if (!license.isPro) {
          sendResponse({ status: 'license_required', error: 'Жалобы доступны в PRO-версии' });
          return 'continue';
        }
        const skus = msg.skus || [];
        if (skus.length === 0) { sendResponse({ status: 'error', error: 'Нет SKU' }); return; }

        // Проверка ранее обработанных SKU — если есть и пользователь не попросил сбросить,
        // помечаем их сразу как done/failed и стартуем с первого pending
        let preProcessed = {};
        if (!msg.resetProgress) {
          try {
            const progressData = await chrome.storage.local.get(['complaintProgress']);
            const prog = progressData.complaintProgress;
            if (prog && prog.processedSkus && prog.processedSkus.length > 0) {
              for (const p of prog.processedSkus) preProcessed[p.sku] = p.status;
            }
          } catch (_) {}
        }

        // v5.9.23: явные логи каждого этапа подготовки —
        // раньше preflight + ensureSellerChatPage могли молча висеть до 30+ сек,
        // popup показывал «Ожидание» без признаков жизни.
        sendToPopup({ action: 'supportLog', text: `[${new Date().toLocaleTimeString('ru-RU')}] 🔍 Проверяю вкладки seller.ozon.ru...` });

        // Pre-flight: проверка вкладок seller.ozon.ru
        const preflight = await preflightSellerTabs();
        if (!preflight.ok) {
          sendToPopup({ action: 'supportLog', text: `[${new Date().toLocaleTimeString('ru-RU')}] ⚠ Pre-flight: ${preflight.error}` });
          sendResponse({ status: 'error', error: preflight.error, code: preflight.code });
          return;
        }
        sendToPopup({ action: 'supportLog', text: `[${new Date().toLocaleTimeString('ru-RU')}] ✓ Вкладка seller.ozon.ru найдена (id=${preflight.tabId})` });

        let tabId = preflight.tabId;
        // Автопереход на чаты если не на странице чатов
        sendToPopup({ action: 'supportLog', text: `[${new Date().toLocaleTimeString('ru-RU')}] 🔍 Проверяю что вкладка на чате поддержки...` });
        const chatReady = await ensureSellerChatPage(tabId);
        if (!chatReady?.ok) {
          sendToPopup({ action: 'supportLog', text: `[${new Date().toLocaleTimeString('ru-RU')}] ⚠ Не удалось перейти на чат поддержки` });
          sendResponse({ status: 'error', error: 'Не удалось перейти в чат поддержки. Откройте чат вручную: seller.ozon.ru → Сообщения → Поддержка' });
          return;
        }
        sendToPopup({ action: 'supportLog', text: `[${new Date().toLocaleTimeString('ru-RU')}] ✓ Чат поддержки готов` });
        tabId = chatReady.tabId || supportState.sellerTabId; // мог обновиться если вкладка пересоздана
        resetInjectFailures(); // Сброс circuit breaker для новой сессии

        // Строим очередь, помечая уже обработанные SKU
        const queue = skus.map(sku => {
          const prev = preProcessed[sku];
          if (prev === 'done' || prev === 'failed' || prev === 'skipped' ||
              prev === 'escalated' || prev === 'no_violation') {
            const prevError = prev === 'failed'
              ? 'ранее не удалось'
              : (prev === 'escalated'
                ? 'ранее передано оператору'
                : (prev === 'no_violation' ? 'ранее не нашли нарушений' : null));
            return { sku, status: prev, step: 'completed', chatId: null, error: prevError };
          }
          return { sku, status: 'pending', step: null, chatId: null, error: null };
        });

        // Стартуем с первого pending
        const firstPendingIdx = queue.findIndex(q => q.status === 'pending');
        const skipCount = firstPendingIdx === -1 ? queue.length : firstPendingIdx;

        const incomingLimits = msg.limits || {};
        const limits = {
          maxChatsPerSession: Math.max(1, Math.min(500, parseInt(incomingLimits.maxChatsPerSession, 10) || 10)),
          maxConsecutiveEscalations: Math.max(0, Math.min(50, parseInt(incomingLimits.maxConsecutiveEscalations, 10) || 5))
        };
        const parentMap = msg.parentMap && typeof msg.parentMap === 'object' ? msg.parentMap : {};
        // В queue проставляем parentSku для каждого SKU (первый родитель если несколько)
        for (const q of queue) {
          const parents = parentMap[q.sku];
          if (Array.isArray(parents) && parents.length > 0) {
            q.parentSku = parents[0];
            q.parentSkus = parents.slice(); // для объединения файлов из нескольких родителей (Q6)
          }
        }
        supportState = {
          isRunning: true,
          isPaused: false,
          mode: msg.mode || 'dry',
          queue,
          currentIndex: firstPendingIdx === -1 ? queue.length : firstPendingIdx,
          files: msg.files || [],
          skuFiles: msg.skuFiles && typeof msg.skuFiles === 'object' ? msg.skuFiles : {},
          // v5.9.20: режим работы с доказательствами
          // - 'sku_first' — старый: к каждому parent SKU привязан свой набор файлов
          // - 'file_first' — новый: каждый файл несёт список SKU к которым подходит
          evidenceMode: msg.evidenceMode === 'file_first' ? 'file_first' : 'sku_first',
          fileSkus: Array.isArray(msg.fileSkus) ? msg.fileSkus : [],
          parentMap,
          // v5.9.15: три типа пути — plagiat_legacy (default, stable) / content_beta / brand_beta.
          // Миграция старых значений seller/brand → plagiat_legacy для backward compat.
          complaintType: (msg.complaintType === 'content_beta' || msg.complaintType === 'brand_beta' || msg.complaintType === 'plagiat_legacy')
            ? msg.complaintType
            : 'plagiat_legacy',
          logs: [],
          sellerTabId: tabId,
          session: { id: Date.now().toString(36), startedAt: new Date().toISOString() },
          lastPhase: null,
          phaseRepeatCount: 0,
          maxPhaseRepeats: 4,
          newChatsOpened: 0,
          consecutiveEscalations: 0,
          limits,
          limitGateAllowance: limits.maxChatsPerSession,
          limitGateActive: false,
          limitGateReason: null,
          // BETA-защиты v5.9.15
          consecutiveFailed: 0,
          betaAutostopLimit: 5,
          // v5.9.37: recovery interface-stuck
          consecutiveInterfaceStuck: 0,
          maxConsecutiveInterfaceStuck: 5,
          navClickRetries: {},
          // Watchdog v5.9.18
          lastActivityTs: Date.now(),
          watchdogWarned: false,
          consecutiveAttachFails: 0,
          attachFailAdviceShown: false
        };

        // Сбрасываем старую activeSupportSession — начинается новая
        await chrome.storage.local.remove(['activeSupportSession']);

        if (skipCount > 0) {
          supportLog(`Пропуск ${skipCount} ранее обработанных SKU`);
        }
        if (firstPendingIdx === -1) {
          supportLog('Все SKU уже обработаны — нажмите «Очистить» для сброса прогресса');
          supportState.isRunning = false;
          sendResponse({ status: 'all_done', error: 'Все SKU из списка уже были обработаны ранее. Нажмите «Очистить» для сброса прогресса.' });
          return;
        }
        supportLog(`Старт: ${queue.length - skipCount} жалоб (из ${queue.length}), режим ${supportState.mode}`);
        await persistActiveSupportSessionNow();
        sendResponse({ status: 'started' });
        ensureSupportLoop(tabId, 'supportStart');
      });
      return true;
    }

    if (msg.action === 'supportPause') {
      (async () => {
        await restoreActiveSupportSession();
        supportState.isPaused = true;
        supportLoopToken++;
        supportLoopRunning = false;
        supportLog('Пауза');
        await persistActiveSupportSessionNow();
        sendResponse({ status: 'paused' });
      })();
      return true;
    }

    if (msg.action === 'supportResume') {
      (async () => {
        await restoreActiveSupportSession();
        supportState.isPaused = false;
        supportLog('Возобновлено');
        const tabId = supportState.sellerTabId || await findSellerTab();
        if (tabId) {
          supportState.sellerTabId = tabId;
          ensureSupportLoop(tabId, 'supportResume');
        }
        await persistActiveSupportSessionNow();
        sendResponse({ status: 'resumed' });
      })();
      return true;
    }

    // Пользователь подтвердил продолжение после достижения лимита обращений (v5.9.10)
    if (msg.action === 'supportLimitContinue') {
      if (supportState.limitGateActive) {
        const add = supportState.limits.maxChatsPerSession;
        supportState.limitGateAllowance = supportState.newChatsOpened + add;
        supportState.limitGateActive = false;
        supportState.limitGateReason = null;
        supportState.isPaused = false;
        supportState.consecutiveEscalations = 0; // Сбрасываем счётчик эскалаций подряд
        supportLog(`▶ Подтверждено — разрешено ещё ${add} обращений (до ${supportState.limitGateAllowance})`);
        if (supportState.sellerTabId) ensureSupportLoop(supportState.sellerTabId, 'supportLimitContinue');
      }
      sendResponse({ status: 'limit_continued' });
      return true;
    }

    if (msg.action === 'supportResetProgress') {
      chrome.storage.local.remove(['complaintProgress'], () => sendResponse({ status: 'reset' }));
      return true;
    }

    if (msg.action === 'supportGetProgress') {
      chrome.storage.local.get(['complaintProgress'], (data) => {
        sendResponse({ progress: data.complaintProgress || null });
      });
      return true;
    }

    if (msg.action === 'supportStop') {
      (async () => {
        await restoreActiveSupportSession();
        supportState.isRunning = false;
        supportState.isPaused = false;
        supportLoopToken++;
        supportLoopRunning = false;
        supportLog('Остановлено');
        await saveSupportSession();
        await persistActiveSupportSessionNow();
        sendResponse({ status: 'stopped' });
      })();
      return true;
    }

    if (msg.action === 'supportGetStatus') {
      // Read-only status: не запускаем loop из getter, только возвращаем память или storage.
      (async () => {
        const hasInMemory = supportState.queue && supportState.queue.length > 0;
        if (hasInMemory) {
          sendResponse({
            isRunning: supportState.isRunning,
            isPaused: supportState.isPaused,
            mode: supportState.mode,
            queue: supportState.queue,
            currentIndex: supportState.currentIndex,
            logs: supportState.logs,
            newChatsOpened: supportState.newChatsOpened || 0,
            consecutiveEscalations: supportState.consecutiveEscalations || 0,
            limitGateActive: !!supportState.limitGateActive,
            limitGateReason: supportState.limitGateReason || null,
            source: 'memory'
          });
        } else {
          const data = await chrome.storage.local.get(['activeSupportSession']);
          const s = data.activeSupportSession;
          if (s) {
            sendResponse({
              isRunning: !!s.isRunning,
              isPaused: !!s.isPaused,
              mode: s.mode,
              queue: s.queue || [],
              currentIndex: s.currentIndex || 0,
              logs: s.logs || [],
              sessionId: s.sessionId,
              newChatsOpened: s.newChatsOpened || 0,
              consecutiveEscalations: s.consecutiveEscalations || 0,
              limitGateActive: !!s.limitGateActive,
              limitGateReason: s.limitGateReason || null,
              source: 'storage'
            });
          } else {
            sendResponse({
              isRunning: false, isPaused: false, mode: null,
              queue: [], currentIndex: 0, logs: [], source: 'none'
            });
          }
        }
      })();
      return true;
    }

    if (msg.action === 'supportRecoverAndContinue') {
      (async () => {
        await restoreActiveSupportSession();
        if (!supportState.isRunning) {
          sendResponse({ ok: false, error: 'Нет активной сессии' });
          return;
        }
        if (supportState.isPaused) {
          sendResponse({ ok: false, paused: true });
          return;
        }
        const tabId = supportState.sellerTabId || await findSellerTab();
        if (!tabId) {
          sendResponse({ ok: false, error: 'seller.ozon.ru не найден' });
          return;
        }
        supportState.sellerTabId = tabId;
        ensureSupportLoop(tabId, 'supportRecoverAndContinue');
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (msg.action === 'supportRefresh') {
      // Принудительно обновить состояние страницы и продолжить
      (async () => {
        await restoreActiveSupportSession();
        const tabId = supportState.sellerTabId || await findSellerTab();
        if (tabId) {
          supportState.sellerTabId = tabId;
          if (supportState.isRunning && !supportState.isPaused) {
            ensureSupportLoop(tabId, 'supportRefresh');
          }
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'seller.ozon.ru не найден' });
        }
      })();
      return true;
    }

    if (msg.action === 'supportGetHistory') {
      chrome.storage.local.get(['supportHistory'], (data) => sendResponse({ history: data.supportHistory || [] }));
      return true;
    }

    if (msg.action === 'testApi') {
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });

          if (tabs.length === 0) {
            sendResponse({
              status: 'error',
              message: 'Откройте ozon.ru в любой вкладке и авторизуйтесь, затем повторите'
            });
            return 'continue';
          }

          const tabId = tabs[0].id;
          const tabUrl = tabs[0].url || '';

          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const hasInterceptor = typeof window.__ozguard !== 'undefined';
              const hasCookies = document.cookie.length > 0;
              const pageTitle = document.title || '';
              return { hasInterceptor, hasCookies, pageTitle };
            },
            world: 'MAIN'
          });

          const info = results?.[0]?.result;
          if (!info) {
            sendResponse({ status: 'error', message: 'Не удалось проверить вкладку' });
            return 'continue';
          }

          const checks = [];
          if (info.hasInterceptor) checks.push('перехватчик активен');
          else checks.push('перехватчик НЕ загружен (обновите страницу ozon.ru)');
          if (info.hasCookies) checks.push('cookies есть');
          else checks.push('cookies отсутствуют');

          const ok = info.hasInterceptor && info.hasCookies;
          sendResponse({
            status: ok ? 'ok' : 'error',
            message: ok ? `Готово. ${checks.join(', ')}` : `Проблема: ${checks.join(', ')}`,
            widgets: [`Вкладка: ${tabUrl.substring(0, 80)}`, ...checks]
          });
        } catch (e) {
          sendResponse({ status: 'error', message: e.message });
        }
      })();
      return true;
    }

    return true;
  });

})();
