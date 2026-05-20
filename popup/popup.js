(function() {
  'use strict';

  // === IndexedDB для больших файлов (>5 MB, видео до 200 MB) ===
  // chrome.storage.local лимит 10 MB на всё хранилище → видео туда не влезет.
  // Мелкие файлы (<5 MB) остаются в chrome.storage.local для совместимости,
  // крупные едут в IndexedDB. Ключ = id файла, значение = {name, type, size, blob}.
  const OZG_DB_NAME = 'ozguard-files';
  const OZG_DB_STORE = 'files';
  // Порог: всё что >2 MB идёт в IndexedDB. Chrome.storage.local лимит 10 MB на ВСЁ
  // хранилище — если класть туда base64 от пары PDF-ок уже можно упереться в квоту.
  // 2 MB * ~5 файлов = 10 MB ≈ безопасный потолок для быстрого кеша.
  const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024;  // 2 MB
  const MAX_FILE_SIZE = 50 * 1024 * 1024;        // безопасный потолок для MV3/base64-передачи

  function ozgOpenDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(OZG_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OZG_DB_STORE)) db.createObjectStore(OZG_DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function ozgPutBlob(id, blob, meta) {
    const db = await ozgOpenDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OZG_DB_STORE, 'readwrite');
      tx.objectStore(OZG_DB_STORE).put({ blob, ...meta }, id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function ozgGetBlob(id) {
    const db = await ozgOpenDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OZG_DB_STORE, 'readonly');
      const req = tx.objectStore(OZG_DB_STORE).get(id);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }
  async function ozgDeleteBlob(id) {
    const db = await ozgOpenDB();
    return new Promise((resolve) => {
      const tx = db.transaction(OZG_DB_STORE, 'readwrite');
      tx.objectStore(OZG_DB_STORE).delete(id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  }
  async function ozgBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  function ozgFormatSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }
  // Экспортируем в window scope для локальной диагностики/совместимости.
  // Файлы в background теперь передаются лениво через getComplaintFilePayload.
  window.__ozgFiles = { put: ozgPutBlob, get: ozgGetBlob, del: ozgDeleteBlob, toB64: ozgBlobToBase64 };

  // === Элементы UI ===
  const skuInput = document.getElementById('skuInput');
  const excludeSellersInput = document.getElementById('excludeSellersInput');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');
  const progressWrap = document.getElementById('progressWrap');
  const progressCurrent = document.getElementById('progressCurrent');
  const progressTotal = document.getElementById('progressTotal');
  const progressPercent = document.getElementById('progressPercent');
  const progressFill = document.getElementById('progressFill');
  const resultsSection = document.getElementById('resultsSection');
  const resultsContainer = document.getElementById('resultsContainer');
  const totalSellersEl = document.getElementById('totalSellers');
  const btnCopy = document.getElementById('btnCopy');
  const btnCopySku = document.getElementById('btnCopySku');
  const btnExcel = document.getElementById('btnExcel');
  const btnClearSession = document.getElementById('btnClearSession');
  const logContainer = document.getElementById('logContainer');
  const logCount = document.getElementById('logCount');
  const historyContainer = document.getElementById('historyContainer');
  const btnClearHistory = document.getElementById('btnClearHistory');

  // Настройки
  const delayMsInput = document.getElementById('delayMs');
  const btnSaveDelay = document.getElementById('btnSaveDelay');
  const btnSaveExclusions = document.getElementById('btnSaveExclusions');
  const exclusionsSavedHint = document.getElementById('exclusionsSavedHint');
  const complaintExcludeInput = document.getElementById('complaintExcludeInput');
  const btnSaveComplaintExclusions = document.getElementById('btnSaveComplaintExclusions');
  const complaintExclusionsSavedHint = document.getElementById('complaintExclusionsSavedHint');
  const disableOzonBlacklist = document.getElementById('disableOzonBlacklist');

  // Лицензия
  const proBadge = document.getElementById('proBadge');
  const freeBadge = document.getElementById('freeBadge');
  const licenseDot = document.getElementById('licenseDot');
  const licenseStatusText = document.getElementById('licenseStatusText');
  const licenseCodeInput = document.getElementById('licenseCodeInput');
  const btnActivateLicense = document.getElementById('btnActivateLicense');
  const licenseError = document.getElementById('licenseError');
  const licenseInputBlock = document.getElementById('licenseInputBlock');
  const licenseActiveBlock = document.getElementById('licenseActiveBlock');
  const licenseCodeDisplay = document.getElementById('licenseCodeDisplay');
  const licenseTypeInfo = document.getElementById('licenseTypeInfo');
  const licenseTypeBadge = document.getElementById('licenseTypeBadge');
  const licenseDaysLeft = document.getElementById('licenseDaysLeft');
  const btnDeactivateLicense = document.getElementById('btnDeactivateLicense');
  const licenseErrorHelp = document.getElementById('licenseErrorHelp');
  const licenseDiagBox = document.getElementById('licenseDiagBox');
  const btnBuyPro = document.getElementById('btnBuyPro');
  const btnBuyProSettings = document.getElementById('btnBuyProSettings');

  // Модалка
  const sessionModal = document.getElementById('sessionModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalClose = document.getElementById('modalClose');
  const modalDownload = document.getElementById('modalDownload');
  const modalCopy = document.getElementById('modalCopy');
  const modalLogs = document.getElementById('modalLogs');

  // Batch upload
  const batchDrop = document.getElementById('batchDrop');
  const batchFileInput = document.getElementById('batchFileInput');
  const batchFilename = document.getElementById('batchFilename');
  const batchInfo = document.getElementById('batchInfo');
  const batchWarning = document.getElementById('batchWarning');
  const btnBatchHistory = document.getElementById('btnBatchHistory');
  const batchHistoryMenu = document.getElementById('batchHistoryMenu');

  // === Состояние ===
  let allResults = [];
  let isPaused = false;
  let logEntries = 0;
  let currentModalSession = null;
  let showingLogs = false;
  let isProLicense = false;
  const BATCH_HISTORY_KEY = 'batchUploadHistory';
  const BATCH_HISTORY_LIMIT = 3;

  // Дефолтный blacklist продавцов для жалоб (Ozon-магазины).
  // Был инцидент: бот пожаловался на товар Ozon Беларусь (продавец сам Ozon).
  // Можно отключить чекбоксом #disableOzonBlacklist в Настройках.
  const DEFAULT_OZON_BLACKLIST = [
    'ozon',
    'озон',
    'интернет решения',
    'internet solutions'
  ];

  // Состояние пользовательских настроек blacklist'а — заполняется при загрузке storage
  let complaintExcludeList = [];
  let ozonBlacklistDisabled = false;

  function isBlacklistedComplaintSeller(sellerName) {
    if (!sellerName) return false;
    const s = String(sellerName).toLowerCase().trim();
    if (!ozonBlacklistDisabled && DEFAULT_OZON_BLACKLIST.some(pat => s.includes(pat))) return true;
    if (complaintExcludeList.some(pat => pat && s.includes(pat))) return true;
    return false;
  }

  // === Лицензия — загрузка статуса ===
  function loadLicenseStatus() {
    chrome.runtime.sendMessage({ action: 'getLicenseStatus' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      isProLicense = resp.isPro;
      updateLicenseUI(resp);
    });
  }

  const btnActivateTrial = document.getElementById('btnActivateTrial');
  const trialExpiredBlock = document.getElementById('trialExpiredBlock');
  const trialInfoBlock = document.getElementById('trialInfoBlock');
  const trialDaysLeftText = document.getElementById('trialDaysLeftText');

  // Подробные советы по кодам ошибок лицензии — показываем в блоке под полем ввода и под активным ключом.
  const LICENSE_HELP = {
    invalid_key: {
      title: 'Код не найден',
      tips: [
        'Проверьте код в письме после оплаты или в личном кабинете codefic.ru',
        'Вставляйте ключ целиком (включая OZG-). Пробелы и лишние символы расширение удалит само',
        'Если ключ потерян — напишите в поддержку t.me/firadex'
      ]
    },
    revoked: {
      title: 'Код отозван',
      tips: [
        'Ключ заблокирован администратором codefic.ru',
        'Это могло произойти из-за возврата оплаты или обнаружения передачи ключа',
        'Свяжитесь с поддержкой: t.me/firadex'
      ]
    },
    expired: {
      title: 'Срок подписки истёк',
      tips: [
        'Продлите подписку в личном кабинете codefic.ru',
        'После оплаты ключ автоматически продлится — заново вводить его не нужно',
        'Если оплата прошла, но ключ всё ещё истёкший — нажмите «Активировать» ещё раз'
      ]
    },
    max_activations: {
      title: 'Лимит устройств исчерпан',
      tips: [
        'Откройте расширение на другом устройстве и нажмите «Деактивировать»',
        'Или напишите в поддержку t.me/firadex — увеличим лимит устройств',
        'Обычно лимит 2 устройства. Если часто переустанавливаете — пишите нам, поднимем'
      ]
    },
    not_activated_here: {
      title: 'Ключ не привязан к этому устройству',
      tips: [
        'Нажмите «Активировать» ещё раз — мы привяжем текущий браузер',
        'Если после реинсталла не активируется — возможно, исчерпан лимит устройств',
        'Такое бывает, когда новую версию распаковали в другую папку (изменился ID расширения)'
      ]
    },
    verification_needed: {
      title: 'Требуется проверка связи с сервером',
      tips: [
        'Расширение не смогло подтвердить ключ более 7 дней',
        'Проверьте интернет и откройте codefic.ru в соседней вкладке',
        'Если сайт открывается — нажмите «Активировать» ещё раз или подождите авто-проверку'
      ]
    },
    network_error: {
      title: 'Нет связи с codefic.ru',
      tips: [
        'Проверьте интернет и отключите VPN, если он блокирует *.ru домены',
        'Если используете корпоративный прокси — добавьте codefic.ru в исключения',
        'Расширение продолжает работать в офлайн-режиме до 7 дней без верификации'
      ]
    },
    rate_limited: {
      title: 'Слишком много запросов',
      tips: [
        'Подождите минуту и попробуйте снова',
        'Не нажимайте «Активировать» многократно подряд'
      ]
    }
  };

  function renderLicenseHelp(targetEl, code, message) {
    if (!targetEl) return;
    if (!code) { targetEl.classList.add('hidden'); targetEl.innerHTML = ''; return; }
    const data = LICENSE_HELP[code];
    if (!data) {
      targetEl.classList.remove('hidden');
      targetEl.innerHTML = `<div class="license-diag-title">Ошибка активации</div><div class="license-diag-msg">${escapeHTML(message || '')}</div>`;
      return;
    }
    const tipsHtml = data.tips.map(t => `<li>${escapeHTML(t)}</li>`).join('');
    targetEl.classList.remove('hidden');
    targetEl.innerHTML = `
      <div class="license-diag-title">⚠️ ${escapeHTML(data.title)}</div>
      ${message ? `<div class="license-diag-msg">${escapeHTML(message)}</div>` : ''}
      <ul class="license-diag-tips">${tipsHtml}</ul>
      <div class="license-diag-footer">
        <a href="https://codefic.ru/#pricing" target="_blank">Личный кабинет</a>
        <span>·</span>
        <a href="https://t.me/firadex" target="_blank">Поддержка</a>
      </div>
    `;
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function updateLicenseUI(status) {
    isProLicense = status.isPro;
    // Сбрасываем диагностические подсказки — заполним ниже если есть ошибка
    renderLicenseHelp(licenseErrorHelp, null);
    renderLicenseHelp(licenseDiagBox, null);
    // Скрываем триал-элементы по умолчанию
    btnActivateTrial.classList.add('hidden');
    trialExpiredBlock.classList.add('hidden');
    trialInfoBlock.classList.add('hidden');

    if (status.isPro) {
      proBadge.classList.remove('hidden');
      freeBadge.classList.add('hidden');
      if (btnBuyPro) btnBuyPro.style.display = 'none';
      if (btnBuyProSettings) btnBuyProSettings.style.display = 'none';
      licenseDot.className = 'license-dot active';

      if (status.isTrial) {
        // Триал активен
        proBadge.textContent = 'TRIAL';
        proBadge.className = 'pro-badge trial-badge';
        licenseStatusText.textContent = 'PRO (пробный)';
        licenseInputBlock.classList.remove('hidden');
        licenseActiveBlock.classList.add('hidden');
        if (btnBuyProSettings) btnBuyProSettings.style.display = '';
        licenseTypeInfo.classList.remove('hidden');
        licenseTypeBadge.textContent = 'Пробный';
        licenseTypeBadge.className = 'license-type-badge trial';
        licenseDaysLeft.textContent = `осталось ${status.daysLeft} дн.`;
        licenseDaysLeft.className = 'license-days-left' + (status.daysLeft <= 1 ? ' expiring' : '');
        // Отображение оставшегося времени триала
        trialInfoBlock.classList.remove('hidden');
        if (status.daysLeft != null) {
          const daysText = status.daysLeft <= 0 ? 'менее 1 дня' : `${status.daysLeft} дн.`;
          trialDaysLeftText.textContent = daysText;
        }
      } else {
        // Полный PRO
        proBadge.textContent = 'PRO';
        proBadge.className = 'pro-badge';
        licenseStatusText.textContent = 'PRO-версия';
        licenseInputBlock.classList.add('hidden');
        licenseActiveBlock.classList.remove('hidden');
        const codeStr = status.code || '';
        licenseCodeDisplay.textContent = codeStr.length > 8
          ? codeStr.slice(0, 3) + '-*****-*****-*****' : codeStr;

        if (status.type) {
          licenseTypeInfo.classList.remove('hidden');
          if (status.type === 'lifetime') {
            licenseTypeBadge.textContent = 'Вечная';
            licenseTypeBadge.className = 'license-type-badge lifetime';
            licenseDaysLeft.textContent = '';
          } else {
            licenseTypeBadge.textContent = 'Месячная';
            licenseTypeBadge.className = 'license-type-badge monthly';
            if (status.daysLeft != null) {
              licenseDaysLeft.textContent = `осталось ${status.daysLeft} дн.`;
              licenseDaysLeft.className = 'license-days-left' + (status.daysLeft <= 3 ? ' expiring' : '');
            } else {
              licenseDaysLeft.textContent = '';
            }
          }
        } else {
          licenseTypeInfo.classList.add('hidden');
        }

        // Если активирован, но при последней фоновой проверке была ошибка (лимит/сеть/нет активации) —
        // показываем предупреждение под ключом
        if (status.lastError && status.lastError.code) {
          renderLicenseHelp(licenseDiagBox, status.lastError.code, status.lastError.message);
        }
      }
    } else {
      proBadge.classList.add('hidden');
      proBadge.textContent = 'PRO';
      proBadge.className = 'pro-badge hidden';
      freeBadge.classList.remove('hidden');
      if (btnBuyPro) btnBuyPro.style.display = '';
      licenseDot.className = 'license-dot';
      licenseInputBlock.classList.remove('hidden');
      licenseActiveBlock.classList.add('hidden');
      licenseTypeInfo.classList.add('hidden');

      if (status.trialExpired) {
        licenseStatusText.textContent = 'Пробный период закончился';
        trialExpiredBlock.classList.remove('hidden');
        if (btnBuyProSettings) btnBuyProSettings.style.display = 'none';
      } else if (status.canActivateTrial) {
        licenseStatusText.textContent = 'FREE-версия';
        btnActivateTrial.classList.remove('hidden');
      } else if (status.error === 'expired') {
        licenseStatusText.textContent = 'Подписка истекла';
        renderLicenseHelp(licenseErrorHelp, 'expired');
      } else if (status.error === 'verification_needed') {
        licenseStatusText.textContent = 'Требуется проверка (нет интернета)';
        renderLicenseHelp(licenseErrorHelp, 'verification_needed');
      } else {
        licenseStatusText.textContent = 'FREE-версия';
      }

      // Если есть свежая ошибка с прошлой попытки активации — показываем её
      if (status.lastError && status.lastError.code) {
        renderLicenseHelp(licenseErrorHelp, status.lastError.code, status.lastError.message);
      }
    }
  }

  loadLicenseStatus();

  // === Активация триала ===
  btnActivateTrial.addEventListener('click', () => {
    btnActivateTrial.disabled = true;
    btnActivateTrial.textContent = 'Активация...';
    chrome.runtime.sendMessage({ action: 'activateTrial' }, (resp) => {
      btnActivateTrial.disabled = false;
      if (chrome.runtime.lastError) {
        showLicenseError('Ошибка расширения');
        btnActivateTrial.textContent = '⚡ Попробовать PRO бесплатно — 7 дней';
        return;
      }
      if (resp.success) {
        loadLicenseStatus();
        addLog('PRO (пробный) активирован на 7 дней');
      } else {
        showLicenseError(resp.error || 'Ошибка активации');
        btnActivateTrial.textContent = '⚡ Попробовать PRO бесплатно — 7 дней';
      }
    });
  });

  // === Инструкция ===
  const helpModal = document.getElementById('helpModal');
  document.getElementById('btnHelp').addEventListener('click', () => helpModal.classList.toggle('hidden'));
  document.getElementById('helpModalClose').addEventListener('click', () => helpModal.classList.add('hidden'));
  helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.classList.add('hidden'); });

  // === Лог toggle ===
  const logSection = document.getElementById('logSection');
  const logToggle = document.getElementById('logToggle');
  logToggle.addEventListener('click', () => {
    logSection.classList.toggle('collapsed');
  });

  // Загрузка настроек blacklist'а для жалоб (отдельный getStorage чтобы не плодить ключи в основном)
  chrome.storage.local.get(['complaintExcludeSellers', 'ozonBlacklistDisabled'], (data) => {
    if (Array.isArray(data.complaintExcludeSellers)) {
      complaintExcludeList = data.complaintExcludeSellers
        .map(s => String(s || '').toLowerCase().trim())
        .filter(Boolean);
      if (complaintExcludeInput) complaintExcludeInput.value = data.complaintExcludeSellers.join('\n');
    }
    ozonBlacklistDisabled = !!data.ozonBlacklistDisabled;
    if (disableOzonBlacklist) disableOzonBlacklist.checked = ozonBlacklistDisabled;
  });

  // === Загрузка сохранённых настроек и последней сессии ===
  chrome.storage.local.get(['excludeSellers', 'delayMs', 'lastScanResults', 'lastScanLogs'], (data) => {
    if (data.excludeSellers) excludeSellersInput.value = data.excludeSellers.join('\n');
    if (data.delayMs) delayMsInput.value = data.delayMs;
    // Восстановить последнюю сессию если есть
    if (data.lastScanResults && data.lastScanResults.length > 0) {
      allResults = data.lastScanResults;
      renderResults();
      // Восстановить логи
      if (data.lastScanLogs && data.lastScanLogs.length > 0) {
        for (const log of data.lastScanLogs) addLog(log);
      }
    }
  });

  // === Табы ===
  function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    const tabId = 'tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if (tabName === 'history') loadHistory();
  }

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
      chrome.storage.local.set({ lastActiveTab: tab.dataset.tab });
    });
  });

  // Восстановить последнюю вкладку
  chrome.storage.local.get(['lastActiveTab'], (data) => {
    if (data.lastActiveTab && data.lastActiveTab !== 'scan') {
      switchTab(data.lastActiveTab);
    }
  });

  // === Парсинг SKU ===
  function parseSkus(text) {
    return text.split(/[\n,;\s]+/).map(s => s.trim()).filter(s => /^\d{3,}$/.test(s));
  }

  // === Список SKU с привязанными доказательствами (для бейджа в сканере) ===
  // Кэш обновляется через chrome.storage.onChanged и при открытии popup
  let skusWithEvidenceCache = new Set();
  function refreshSkusWithEvidenceCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['complaintSkuFiles'], (data) => {
        const map = data.complaintSkuFiles || {};
        skusWithEvidenceCache = new Set(Object.keys(map).filter(k => (map[k] || []).length > 0));
        resolve(skusWithEvidenceCache);
      });
    });
  }
  refreshSkusWithEvidenceCache();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.complaintSkuFiles) {
      const map = changes.complaintSkuFiles.newValue || {};
      skusWithEvidenceCache = new Set(Object.keys(map).filter(k => (map[k] || []).length > 0));
      // Обновляем бейджи в уже отрендеренных результатах
      if (typeof refreshEvidenceBadges === 'function') refreshEvidenceBadges();
    }
  });

  // === Лог ===
  function addLog(text) {
    logEntries++;
    logCount.textContent = logEntries;
    const line = document.createElement('div');
    line.className = 'log-line';
    if (text.includes('Ошибка') || text.includes('ошибка') || text.includes('Таймаут') || text.includes('error')) {
      line.classList.add('error');
    } else if (text.includes('конкурент') || text.includes('Завершено') || text.includes('завершен')) {
      line.classList.add('success');
    }
    line.textContent = text;
    logContainer.appendChild(line);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function getAllLogs() {
    return [...logContainer.querySelectorAll('.log-line')].map(el => el.textContent);
  }

  // === Прогресс ===
  function updateProgress(current, total) {
    progressCurrent.textContent = current;
    progressTotal.textContent = total;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    progressPercent.textContent = pct + '%';
    progressFill.style.width = pct + '%';
  }

  // === Рендер результатов ===
  function renderResults() {
    resultsContainer.innerHTML = '';
    if (allResults.length === 0) return;

    resultsSection.classList.remove('hidden');
    let totalCount = 0;

    for (const r of allResults) {
      const group = document.createElement('div');
      group.className = 'sku-group';
      const header = document.createElement('div');
      header.className = 'sku-header';

      if (r.error) {
        const productUrl = `https://www.ozon.ru/product/${r.sku}/`;
        header.innerHTML = `<span>SKU ${esc(r.sku)}</span><span class="sku-error">${esc(r.error)}</span>`;
        group.appendChild(header);
        const skuRow = document.createElement('div');
        skuRow.className = 'my-sku-row';
        skuRow.innerHTML = `<button class="btn-copy-my-sku" data-sku="${esc(r.sku)}" title="Копировать SKU">&#x2398;</button> <span class="my-sku-num">${esc(r.sku)}</span> <a href="${esc(productUrl)}" target="_blank" class="my-sku-link">открыть на OZON</a>`;
        group.appendChild(skuRow);
        resultsContainer.appendChild(group);
        continue;
      }

      const count = r.sellers ? r.sellers.length : 0;
      totalCount += count;
      const nameDisplay = r.productName ? r.productName.substring(0, 40) : 'SKU ' + r.sku;
      const productUrl = `https://www.ozon.ru/product/${r.sku}/`;
      const competitorSkuList = (r.sellers || []).map(s => s.competitorSku).filter(Boolean);
      const copyAllTitle = `Скопировать ${competitorSkuList.length} SKU конкурентов`;
      header.innerHTML = `<span>${esc(nameDisplay)}</span><span class="count-group">${count} конк.${competitorSkuList.length > 0 ? `<button class="btn-copy-group-skus" data-skus="${esc(competitorSkuList.join('\n'))}" title="${esc(copyAllTitle)}">&#x2398;</button>` : ''}</span>`;
      group.appendChild(header);

      // Строка с SKU товара: копировать + ссылка + кнопка «Доказательства»
      const skuRow = document.createElement('div');
      skuRow.className = 'my-sku-row';
      const hasEvidence = skusWithEvidenceCache.has(String(r.sku));
      skuRow.innerHTML = `<button class="btn-copy-my-sku" data-sku="${esc(r.sku)}" title="Копировать мой SKU">&#x2398;</button> <span class="my-sku-num">${esc(r.sku)}</span> <a href="${esc(productUrl)}" target="_blank" class="my-sku-link">открыть на OZON</a> <button class="btn-evidence-sku ${hasEvidence ? 'has-evidence' : ''}" data-sku="${esc(r.sku)}" title="${hasEvidence ? 'Доказательства уже привязаны — открыть в настройках' : 'Привязать доказательства для этого SKU'}">${hasEvidence ? '✓ Доказательства' : '📎 К доказательствам'}</button>`;
      group.appendChild(skuRow);

      if (count === 0) {
        const noSellers = document.createElement('div');
        noSellers.className = 'no-sellers';
        noSellers.textContent = 'Других продавцов не найдено';
        group.appendChild(noSellers);
      } else {
        for (const s of r.sellers) {
          const item = document.createElement('div');
          item.className = 'seller-item';
          const nameHtml = s.url ? `<a href="${esc(s.url)}" target="_blank">${esc(s.name)}</a>` : esc(s.name);
          const priceHtml = s.price ? ` <span class="seller-price">${esc(s.price)} ₽</span>` : '';
          const productUrl = s.productLink || (s.competitorSku ? `https://www.ozon.ru/product/${s.competitorSku}/` : '');
          const skuHtml = s.competitorSku ? `<a href="${esc(productUrl)}" target="_blank" class="seller-sku" title="Открыть карточку конкурента">${esc(s.competitorSku)}</a><button class="btn-copy-sku" data-sku="${esc(s.competitorSku)}" title="Копировать SKU">&#x2398;</button>` : '';
          item.innerHTML = `${skuHtml}${skuHtml && nameHtml ? ' ' : ''}${nameHtml}${priceHtml}`;
          group.appendChild(item);
        }
      }
      resultsContainer.appendChild(group);
    }
    totalSellersEl.textContent = totalCount;

    // Делегирование кликов по кнопкам копирования SKU
    resultsContainer.querySelectorAll('.btn-copy-sku, .btn-copy-my-sku').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.sku);
        btn.textContent = '\u2713';
        setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 800);
      });
    });

    // Копировать все SKU конкурентов по одному товару
    resultsContainer.querySelectorAll('.btn-copy-group-skus').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.skus);
        btn.textContent = '\u2713';
        setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 1000);
      });
    });

    // \u041a\u043d\u043e\u043f\u043a\u0430 \u00ab\ud83d\udcce \u041a \u0434\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0430\u043c\u00bb \u2014 \u043f\u0435\u0440\u0435\u043d\u043e\u0441\u0438\u0442 \u0440\u043e\u0434\u0438\u0442\u0435\u043b\u044c\u0441\u043a\u0438\u0439 SKU \u0432 \u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438
    resultsContainer.querySelectorAll('.btn-evidence-sku').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sku = btn.dataset.sku;
        switchTab('settings');
        chrome.storage.local.set({ lastActiveTab: 'settings' });
        const skuFileSkuInput = document.getElementById('skuFileSkuInput');
        const skuFilesList = document.getElementById('skuFilesList');
        if (skuFileSkuInput) {
          skuFileSkuInput.value = sku;
          skuFileSkuInput.focus();
          const section = skuFileSkuInput.closest('.settings-group');
          if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            section.classList.add('highlight-settings');
            setTimeout(() => section.classList.remove('highlight-settings'), 2000);
          }
          if (skuFilesList) {
            skuFilesList.querySelectorAll('.sku-file-bundle').forEach(b => {
              const sk = b.querySelector('.sku-file-bundle-sku');
              if (sk && sk.textContent.trim() === sku) {
                b.classList.add('highlight-bundle');
                setTimeout(() => b.classList.remove('highlight-bundle'), 2500);
              }
            });
          }
        }
      });
    });
  }

  // \u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435 \u0431\u0435\u0439\u0434\u0436\u0435\u0439 \u00ab\u2713 \u0414\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0430\u00bb \u043f\u0440\u0438 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0438 \u0441\u043a\u043b-\u0444\u0430\u0439\u043b\u043e\u0432
  function refreshEvidenceBadges() {
    if (!resultsContainer) return;
    resultsContainer.querySelectorAll('.btn-evidence-sku').forEach(btn => {
      const sku = btn.dataset.sku;
      const has = skusWithEvidenceCache.has(String(sku));
      btn.classList.toggle('has-evidence', has);
      btn.textContent = has ? '\u2713 \u0414\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0430' : '\ud83d\udcce \u041a \u0434\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0430\u043c';
      btn.title = has ? '\u0414\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0430 \u0443\u0436\u0435 \u043f\u0440\u0438\u0432\u044f\u0437\u0430\u043d\u044b \u2014 \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u0432 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0430\u0445' : '\u041f\u0440\u0438\u0432\u044f\u0437\u0430\u0442\u044c \u0434\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c\u0441\u0442\u0432\u0430 \u0434\u043b\u044f \u044d\u0442\u043e\u0433\u043e SKU';
    });
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // === UI состояния ===
  function setUiRunning() {
    isPaused = false;
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnPause.textContent = '⏸';
    btnStop.disabled = false;
    skuInput.disabled = true;
    progressWrap.classList.remove('hidden');
  }

  function setUiStopped() {
    isPaused = false;
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnPause.textContent = '⏸';
    btnStop.disabled = true;
    skuInput.disabled = false;
  }

  // === Режим сканирования ===
  let scanMode = 'fast';
  const scanModeFast = document.getElementById('scanModeFast');
  const scanModeVisual = document.getElementById('scanModeVisual');

  function setScanMode(mode) {
    scanMode = mode;
    scanModeFast.classList.toggle('active', mode === 'fast');
    scanModeVisual.classList.toggle('active', mode === 'visual');
    chrome.storage.local.set({ scanMode: mode });
  }

  // Восстановить сохранённый режим
  chrome.storage.local.get(['scanMode'], (data) => {
    if (data.scanMode) setScanMode(data.scanMode);
  });

  scanModeFast.addEventListener('click', () => setScanMode('fast'));
  scanModeVisual.addEventListener('click', () => setScanMode('visual'));

  // === Старт ===
  btnStart.addEventListener('click', () => {
    const skus = parseSkus(skuInput.value);
    if (skus.length === 0) { addLog('Нет валидных SKU'); return; }

    // Собираем исключения из настроек
    const excludeLines = (excludeSellersInput.value || '').split('\n').map(s => s.trim()).filter(Boolean);

    allResults = [];
    resultsContainer.innerHTML = '';
    resultsSection.classList.add('hidden');
    logContainer.innerHTML = '';
    logEntries = 0;
    logCount.textContent = '0';
    updateProgress(0, skus.length);
    setUiRunning();

    chrome.runtime.sendMessage({
      action: 'startScan',
      skus,
      config: { excludeSellers: excludeLines, scanMode }
    }, (resp) => {
      if (chrome.runtime.lastError) {
        addLog('Ошибка: ' + chrome.runtime.lastError.message);
        setUiStopped();
      }
    });
  });

  // === Пауза ===
  btnPause.addEventListener('click', () => {
    if (isPaused) {
      chrome.runtime.sendMessage({ action: 'resumeScan' });
      isPaused = false;
      btnPause.textContent = '⏸';
    } else {
      chrome.runtime.sendMessage({ action: 'pauseScan' });
      isPaused = true;
      btnPause.textContent = '▶';
    }
  });

  // === Стоп ===
  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopScan' });
    setUiStopped();
  });

  // === Сообщения от service-worker ===
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'scanProgress') {
      updateProgress(msg.current, msg.total);
      allResults.push({
        sku: msg.sku,
        sellers: msg.sellers || [],
        productName: msg.productName || '',
        error: msg.error || null
      });
      renderResults();
      // Сохраняем промежуточные результаты
      chrome.storage.local.set({ lastScanResults: allResults });
    }
    if (msg.action === 'scanComplete') {
      setUiStopped();
      if (msg.results) { allResults = msg.results; renderResults(); }
      // Сохраняем финальные результаты и логи
      chrome.storage.local.set({ lastScanResults: allResults, lastScanLogs: getAllLogs() });
    }
    if (msg.action === 'scanLog') {
      addLog(msg.text);
    }

    // Support automation messages
    if (msg.action === 'supportLog') {
      addComplaintLog(msg.text);
    }
    if (msg.action === 'supportProgress') {
      updateComplaintProgress(msg.current, msg.total);
      if (msg.item) {
        // Обновляем очередь — запрашиваем полный статус
        chrome.runtime.sendMessage({ action: 'supportGetStatus' }, (resp) => {
          if (resp && resp.queue) renderComplaintQueue(resp.queue);
        });
      }
      complaintStatusIcon.textContent = '▶';
      complaintStatusText.textContent = `Обработка ${msg.current}/${msg.total}`;
    }
    if (msg.action === 'supportComplete') {
      setComplaintUiStopped();
      complaintStatusIcon.textContent = '✓';
      complaintStatusText.textContent = 'Завершено';
      if (msg.queue) renderComplaintQueue(msg.queue);
    }
    if (msg.action === 'supportNeedAction') {
      complaintHint.classList.remove('hidden');
      complaintHint.textContent = msg.message || '';
      complaintStatusIcon.textContent = '⚠';
      complaintStatusText.textContent = 'Требуется действие';
    }
    if (msg.action === 'supportStateUpdate') {
      // Content script state update — log only
    }
  });

  // === Копировать / Excel ===
  btnCopy.addEventListener('click', () => { copyResults(allResults); flashBtn(btnCopy, '✓'); });
  btnCopySku.addEventListener('click', () => { copyOnlySkus(allResults); flashBtn(btnCopySku, '✓'); });
  btnExcel.addEventListener('click', () => { downloadExcel(allResults, 'ozguard_results'); });

  // Очистить текущую сессию (результаты сохранены в истории)
  btnClearSession.addEventListener('click', () => {
    allResults = [];
    resultsContainer.innerHTML = '';
    resultsSection.classList.add('hidden');
    logContainer.innerHTML = '';
    logEntries = 0;
    logCount.textContent = '0';
    skuInput.value = '';
    progressWrap.classList.add('hidden');
    chrome.storage.local.remove(['lastScanResults', 'lastScanLogs']);
    // Сброс batch
    batchFilename.classList.add('hidden');
    batchInfo.classList.add('hidden');
    batchWarning.classList.add('hidden');
    addLog('Сессия очищена. Результаты доступны в Истории.');
  });

  function copyResults(results) {
    const lines = [];
    for (const r of results) {
      if (r.error) { lines.push(`SKU ${r.sku}: ${r.error}`); continue; }
      lines.push(`SKU ${r.sku} (${r.productName || ''}) — ${(r.sellers || []).length} конкурентов:`);
      for (const s of (r.sellers || [])) {
        const parts = [`  ${s.name}`];
        if (s.price) parts.push(s.price + ' ₽');
        if (s.competitorSku) parts.push('SKU:' + s.competitorSku);
        if (s.sellerId) parts.push('ID:' + s.sellerId);
        lines.push(parts.join(' | '));
      }
    }
    navigator.clipboard.writeText(lines.join('\n'));
  }

  function copyOnlySkus(results) {
    const skus = new Set();
    for (const r of results) {
      if (r.error || !r.sellers) continue;
      for (const s of r.sellers) {
        if (s.competitorSku) skus.add(s.competitorSku);
      }
    }
    navigator.clipboard.writeText([...skus].join('\n'));
  }

  function downloadExcel(results, filename) {
    const rows = [['Мой SKU', 'Название', 'SKU конкурента', 'ID продавца', 'Продавец', 'Цена', 'Ссылка']];
    for (const r of results) {
      if (r.error) { rows.push([r.sku, '', '', '', 'ОШИБКА: ' + r.error, '', '']); continue; }
      if (!r.sellers || r.sellers.length === 0) { rows.push([r.sku, r.productName || '', '', '', 'Нет конкурентов', '', '']); continue; }
      for (const s of r.sellers) {
        rows.push([r.sku, r.productName || '', s.competitorSku || '', s.sellerId || '', s.name, s.price || '', s.url || '']);
      }
    }

    // CSV с BOM и ; разделителем — Excel открывает без предупреждений
    const csv = rows.map(row => row.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(';')).join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '_' + fmtDate(new Date()) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function fmtDate(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function flashBtn(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  // === ИСТОРИЯ ===
  function loadHistory() {
    chrome.runtime.sendMessage({ action: 'getHistory' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      renderHistory(resp.history || []);
    });
  }

  function renderHistory(history) {
    historyContainer.innerHTML = '';
    if (history.length === 0) {
      historyContainer.innerHTML = '<div class="empty-state">Нет сохранённых сессий</div>';
      return;
    }

    for (const session of history) {
      const card = document.createElement('div');
      card.className = 'history-card';
      const date = new Date(session.date);
      const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

      // Считаем количество SKU конкурентов в сессии + строим parent→competitor карту
      const competitorSkus = new Set();
      const sessionParentMap = {};
      if (session.results) {
        for (const r of session.results) {
          const parentSku = String(r.sku || '').trim();
          if (r.sellers) r.sellers.forEach(s => {
            if (!s.competitorSku) return;
            competitorSkus.add(s.competitorSku);
            if (parentSku) {
              if (!sessionParentMap[s.competitorSku]) sessionParentMap[s.competitorSku] = [];
              if (!sessionParentMap[s.competitorSku].includes(parentSku)) sessionParentMap[s.competitorSku].push(parentSku);
            }
          });
        }
      }

      card.innerHTML = `
        <div class="history-date">${esc(dateStr)}</div>
        <div class="history-stats">
          <div class="history-stat"><div class="label">SKU</div><div class="value">${session.skusCount}</div></div>
          <div class="history-stat"><div class="label">Найдено</div><div class="value accent">${session.sellersFound}</div></div>
        </div>
        <div class="history-actions">
          <button class="btn btn-small btn-download">📥 Excel</button>
          <button class="btn btn-small btn-view">👁 Детали</button>
          ${competitorSkus.size > 0 ? `<button class="btn btn-small btn-pro btn-to-complaints" title="${competitorSkus.size} SKU конкурентов">📨 Жалобы</button>` : ''}
          <button class="btn btn-small btn-danger-sm btn-delete">✕</button>
        </div>
      `;

      card.querySelector('.btn-download').addEventListener('click', (e) => { e.stopPropagation(); downloadExcel(session.results, 'ozguard_' + session.id); });
      card.querySelector('.btn-view').addEventListener('click', (e) => { e.stopPropagation(); openSessionModal(session); });
      const btnToComplaints = card.querySelector('.btn-to-complaints');
      if (btnToComplaints) {
        btnToComplaints.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!isProLicense) { alert('Жалобы доступны в PRO-версии'); return; }
          const sourceSkus = getUniqueSourceSkus(session.results);
          let selectedParentSku = '';
          if (sourceSkus.length === 1) {
            selectedParentSku = await askParentSkuForSingleSource(sourceSkus[0]);
            if (selectedParentSku === null) return;
            applyParentSkuOverride(sessionParentMap, competitorSkus, selectedParentSku);
          }
          const existing = parseSkus(complaintSkuInput.value);
          const merged = new Set([...existing, ...competitorSkus]);
          complaintSkuInput.value = [...merged].join('\n');
          if (selectedParentSku && existing.length === 0) setComplaintParentSku(selectedParentSku);
          complaintSkuInput.dispatchEvent(new Event('input'));
          // Мержим parent-карту
          try {
            const prev = await loadParentMap();
            for (const comp of Object.keys(sessionParentMap)) {
              const m = new Set([...(prev[comp] || []), ...sessionParentMap[comp]]);
              prev[comp] = [...m];
            }
            await saveParentMap(prev);
          } catch (_) {}
          switchTab('complaints');
          chrome.storage.local.set({ lastActiveTab: 'complaints' });
          if (selectedParentSku) addComplaintLog(`Родительский SKU ${selectedParentSku} привязан к ${competitorSkus.size} SKU`);
        });
      }
      card.querySelector('.btn-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: 'deleteHistorySession', sessionId: session.id }, () => loadHistory());
      });

      historyContainer.appendChild(card);
    }
  }

  btnClearHistory.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearHistory' }, () => loadHistory());
  });

  // === Модальное окно ===
  function openSessionModal(session) {
    currentModalSession = session;
    showingLogs = false;
    const date = new Date(session.date);
    modalTitle.textContent = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' — ' + session.skusCount + ' SKU';
    renderModalTable(session);
    sessionModal.classList.remove('hidden');
  }

  function renderModalTable(session) {
    let html = '<table class="results-table"><thead><tr><th>SKU конк.</th><th>Продавец</th><th>Цена</th></tr></thead><tbody>';
    for (const r of session.results) {
      if (r.error) { html += `<tr><td colspan="3" class="sku-error">${esc(r.sku)}: ${esc(r.error)}</td></tr>`; continue; }
      if (!r.sellers || r.sellers.length === 0) { html += `<tr><td colspan="3" class="no-sellers">${esc(r.sku)}: Нет конкурентов</td></tr>`; continue; }
      for (const s of r.sellers) {
        const productUrl = s.productLink || (s.competitorSku ? `https://www.ozon.ru/product/${s.competitorSku}/` : '');
        const skuLink = s.competitorSku
          ? `<span class="sku-cell"><a href="${esc(productUrl)}" target="_blank" title="Открыть карточку">${esc(s.competitorSku)}</a><button class="btn-copy-sku" data-sku="${esc(s.competitorSku)}" title="Копировать SKU">&#x2398;</button></span>`
          : '—';
        const sellerLink = s.url
          ? `<a href="${esc(s.url)}" target="_blank">${esc(s.name)}</a>`
          : esc(s.name);
        const priceStr = s.price ? esc(s.price) + ' ₽' : '—';
        html += `<tr><td>${skuLink}</td><td>${sellerLink}</td><td>${priceStr}</td></tr>`;
      }
    }
    html += '</tbody></table>';
    modalBody.innerHTML = html;

    // Делегирование копирования SKU в модалке
    modalBody.querySelectorAll('.btn-copy-sku').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.sku);
        btn.textContent = '\u2713';
        setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 800);
      });
    });
  }

  modalClose.addEventListener('click', () => { sessionModal.classList.add('hidden'); });
  sessionModal.addEventListener('click', (e) => { if (e.target === sessionModal) sessionModal.classList.add('hidden'); });
  modalDownload.addEventListener('click', () => { if (currentModalSession) downloadExcel(currentModalSession.results, 'ozguard_' + currentModalSession.id); });
  modalCopy.addEventListener('click', () => { if (currentModalSession) { copyResults(currentModalSession.results); flashBtn(modalCopy, '✓'); } });
  modalLogs.addEventListener('click', () => {
    if (!currentModalSession) return;
    if (showingLogs) {
      renderModalTable(currentModalSession);
      modalLogs.textContent = '📝 Логи';
      showingLogs = false;
    } else {
      const logs = currentModalSession.logs || [];
      modalBody.innerHTML = logs.length === 0
        ? '<div class="empty-state">Логи отсутствуют</div>'
        : '<div class="modal-logs">' + logs.map(l => esc(l)).join('\n') + '</div>';
      modalLogs.textContent = '📊 Таблица';
      showingLogs = true;
    }
  });

  // === ЛИЦЕНЗИЯ ===
  btnActivateLicense.addEventListener('click', () => {
    const code = licenseCodeInput.value.trim();
    if (!code) { showLicenseError('Введите код'); return; }
    licenseError.classList.add('hidden');
    renderLicenseHelp(licenseErrorHelp, null);
    btnActivateLicense.disabled = true;
    chrome.runtime.sendMessage({ action: 'activateLicense', code }, (resp) => {
      btnActivateLicense.disabled = false;
      if (chrome.runtime.lastError) { showLicenseError('Ошибка расширения'); return; }
      if (resp && resp.success) {
        licenseCodeInput.value = '';
        renderLicenseHelp(licenseErrorHelp, null);
        loadLicenseStatus();
        addLog('PRO-версия активирована');
      } else {
        const msg = (resp && resp.error) || 'Неверный код';
        showLicenseError(msg);
        renderLicenseHelp(licenseErrorHelp, (resp && resp.code) || 'unknown', msg);
      }
    });
  });

  // Нормализация ввода: только UPPERCASE + оставляем дефисы пользователя.
  // Форматтер НЕ перегруппирует блоки — иначе ломает ключи с блоками нестандартной длины
  // (например тестовые OZG-TEST1-LIFE-00001 становились OZG-TEST1-LIFE0-0001).
  licenseCodeInput.addEventListener('input', () => {
    const cleaned = licenseCodeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleaned !== licenseCodeInput.value) {
      const pos = licenseCodeInput.selectionStart;
      licenseCodeInput.value = cleaned;
      try { licenseCodeInput.setSelectionRange(pos, pos); } catch (_) {}
    }
  });

  btnDeactivateLicense.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'deactivateLicense' }, () => {
      loadLicenseStatus();
      addLog('Лицензия деактивирована');
    });
  });

  function showLicenseError(text) {
    licenseError.textContent = text;
    licenseError.classList.remove('hidden');
  }

  // === НАСТРОЙКИ ===
  // Сохранить исключения
  btnSaveExclusions.addEventListener('click', () => {
    const lines = (excludeSellersInput.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    chrome.storage.local.set({ excludeSellers: lines });
    exclusionsSavedHint.classList.remove('hidden');
    setTimeout(() => exclusionsSavedHint.classList.add('hidden'), 2000);
    flashBtn(btnSaveExclusions, '✓');
  });

  // Сохранить blacklist для жалоб
  if (btnSaveComplaintExclusions) {
    btnSaveComplaintExclusions.addEventListener('click', () => {
      const lines = (complaintExcludeInput.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      complaintExcludeList = lines.map(s => s.toLowerCase());
      chrome.storage.local.set({ complaintExcludeSellers: lines });
      if (complaintExclusionsSavedHint) {
        complaintExclusionsSavedHint.classList.remove('hidden');
        setTimeout(() => complaintExclusionsSavedHint.classList.add('hidden'), 2000);
      }
      flashBtn(btnSaveComplaintExclusions, '✓');
    });
  }

  // Чекбокс «отключить Ozon-blacklist по умолчанию»
  if (disableOzonBlacklist) {
    disableOzonBlacklist.addEventListener('change', () => {
      ozonBlacklistDisabled = disableOzonBlacklist.checked;
      chrome.storage.local.set({ ozonBlacklistDisabled });
    });
  }

  // Сохранить задержку
  btnSaveDelay.addEventListener('click', () => {
    const val = parseInt(delayMsInput.value, 10);
    if (val >= 500 && val <= 10000) {
      chrome.storage.local.set({ delayMs: val });
      flashBtn(btnSaveDelay, '✓');
    }
  });


  // === ЖАЛОБЫ (SUPPORT AUTOMATION) ===
  const complaintSkuInput = document.getElementById('complaintSkuInput');
  const complaintParentSkuInput = document.getElementById('complaintParentSkuInput');
  const btnCopyComplaintParentSku = document.getElementById('btnCopyComplaintParentSku');
  const parentSkuModal = document.getElementById('parentSkuModal');
  const parentSkuModalInput = document.getElementById('parentSkuModalInput');
  const parentSkuModalError = document.getElementById('parentSkuModalError');
  const parentSkuModalApply = document.getElementById('parentSkuModalApply');
  const parentSkuModalCancel = document.getElementById('parentSkuModalCancel');
  const parentSkuModalClose = document.getElementById('parentSkuModalClose');
  let parentSkuModalResolve = null;

  // Подсказки — скрытие на крестик, сохранение в chrome.storage.local.
  // Три группы подсказок:
  //   complaint  (vpn, instruction, evidence)           — в табе «Жалобы», управляются btnShowHints
  //   settings   (exclusions, delay, cascade, cascade_limit, cascade_consec, sku_files)
  //                                                      — в табе «Настройки», управляются btnShowSettingsHints
  // Крестик ✕ работает одинаково во всех, ключ сохраняется в dismissedHints.
  const vpnWarning = document.getElementById('vpnWarning');
  const instructionHint = document.getElementById('instructionHint');
  const btnShowHints = document.getElementById('btnShowHints');
  const btnShowSettingsHints = document.getElementById('btnShowSettingsHints');

  // Ключи по группам
  const COMPLAINT_HINT_KEYS = ['vpn', 'instruction', 'evidence'];
  const SETTINGS_HINT_KEYS = ['exclusions', 'complaint_exclusions', 'delay', 'cascade', 'cascade_limit', 'cascade_consec', 'sku_files', 'evidence_mode'];

  // Собираем все подсказки-баннеры по data-hint-host (в т.ч. в Настройках)
  function collectHintElements() {
    const map = { vpn: vpnWarning, instruction: instructionHint };
    document.querySelectorAll('[data-hint-host]').forEach(el => {
      const k = el.dataset.hintHost;
      if (k && !map[k]) map[k] = el;
    });
    return map;
  }

  function updateShowHintsButtons(dismissed) {
    // Обе кнопки работают по правилу «any hidden» — появляются сразу как хоть что-то скрыто.
    // Раньше для Жалоб была логика «all hidden» — но с 3+ ключами (vpn/instruction/evidence)
    // пользователь мог залипнуть если скрыл только одну, поэтому унифицировали.
    const complaintAnyHidden = COMPLAINT_HINT_KEYS.some(k => dismissed[k]);
    const settingsAnyHidden = SETTINGS_HINT_KEYS.some(k => dismissed[k]);
    btnShowHints.classList.toggle('hidden', !complaintAnyHidden);
    if (btnShowSettingsHints) {
      btnShowSettingsHints.classList.toggle('hidden', !settingsAnyHidden);
    }
  }

  const hintElements = collectHintElements();

  chrome.storage.local.get(['dismissedHints'], (data) => {
    const dismissed = data.dismissedHints || {};
    for (const [key, el] of Object.entries(hintElements)) {
      if (el && dismissed[key]) el.style.display = 'none';
    }
    updateShowHintsButtons(dismissed);
  });

  document.querySelectorAll('.hint-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.hint;
      const el = hintElements[key] || btn.closest('.hint-banner');
      if (el) el.style.display = 'none';
      chrome.storage.local.get(['dismissedHints'], (data) => {
        const dismissed = data.dismissedHints || {};
        dismissed[key] = true;
        chrome.storage.local.set({ dismissedHints: dismissed });
        updateShowHintsButtons(dismissed);
      });
    });
  });

  // Обобщённый восстановитель группы ключей
  function restoreHintGroup(keys, btnToHide) {
    for (const k of keys) {
      if (hintElements[k]) hintElements[k].style.display = '';
    }
    chrome.storage.local.get(['dismissedHints'], (data) => {
      const dismissed = data.dismissedHints || {};
      for (const k of keys) delete dismissed[k];
      chrome.storage.local.set({ dismissedHints: dismissed }, () => {
        updateShowHintsButtons(dismissed);
      });
    });
    if (btnToHide) btnToHide.classList.add('hidden');
  }

  btnShowHints.addEventListener('click', () => {
    restoreHintGroup(COMPLAINT_HINT_KEYS, btnShowHints);
  });

  if (btnShowSettingsHints) {
    btnShowSettingsHints.addEventListener('click', () => {
      restoreHintGroup(SETTINGS_HINT_KEYS, btnShowSettingsHints);
    });
  }

  const complaintSkuWarning = document.getElementById('complaintSkuWarning');
  const complaintMode = document.getElementById('complaintMode');
  const complaintType = document.getElementById('complaintType');
  const btnComplaintStart = document.getElementById('btnComplaintStart');
  const btnComplaintPause = document.getElementById('btnComplaintPause');
  const btnComplaintStop = document.getElementById('btnComplaintStop');
  const complaintStatus = document.getElementById('complaintStatus');
  const complaintStatusIcon = document.getElementById('complaintStatusIcon');
  const complaintStatusText = document.getElementById('complaintStatusText');
  const complaintHint = document.getElementById('complaintHint');
  const complaintProgressWrap = document.getElementById('complaintProgressWrap');
  const complaintProgressCurrent = document.getElementById('complaintProgressCurrent');
  const complaintProgressTotal = document.getElementById('complaintProgressTotal');
  const complaintProgressPercent = document.getElementById('complaintProgressPercent');
  const complaintProgressFill = document.getElementById('complaintProgressFill');
  const complaintQueue = document.getElementById('complaintQueue');
  const complaintLogContainer = document.getElementById('complaintLogContainer');
  const complaintLogCount = document.getElementById('complaintLogCount');
  const complaintFileDrop = document.getElementById('complaintFileDrop');
  const complaintFileInput = document.getElementById('complaintFileInput');
  const complaintFileList = document.getElementById('complaintFileList');
  const btnSendToComplaints = document.getElementById('btnSendToComplaints');

  // confirmGate removed — bot is fully autonomous

  let complaintLogEntries = 0;
  let complaintIsPaused = false;

  function getSingleSkuValue(value) {
    const skus = parseSkus(String(value || ''));
    return skus.length === 1 ? skus[0] : null;
  }

  function getUniqueSourceSkus(results) {
    const out = new Set();
    for (const r of (results || [])) {
      const sku = String(r?.sku || '').trim();
      if (/^\d{3,}$/.test(sku)) out.add(sku);
    }
    return [...out];
  }

  // v5.9.35: применить ручной родительский SKU к списку SKU.
  // v5.9.38: добавлен режим preserveExisting — если SKU уже имеет parentMap-привязку,
  // НЕ перезаписываем её. Это критично для multi-batch сборок (merge через v5.9.36),
  // когда поле «Родительский SKU» хранит только первый родитель, а в parentMap уже есть
  // правильные привязки разных competitor → разных parents.
  function applyParentSkuOverride(parentMap, skus, parentSku, opts = {}) {
    if (!parentSku) return 0;
    const preserveExisting = !!opts.preserveExisting;
    let count = 0;
    for (const sku of skus) {
      const comp = String(sku || '').trim();
      if (!comp) continue;
      if (preserveExisting && Array.isArray(parentMap[comp]) && parentMap[comp].length > 0) {
        continue; // оставляем существующую multi-parent привязку нетронутой
      }
      parentMap[comp] = [parentSku];
      count++;
    }
    return count;
  }

  function setComplaintParentSku(parentSku) {
    if (!complaintParentSkuInput) return;
    complaintParentSkuInput.value = parentSku || '';
    complaintParentSkuInput.dispatchEvent(new Event('change'));
  }

  function closeParentSkuModal(value) {
    if (parentSkuModal) parentSkuModal.classList.add('hidden');
    if (parentSkuModalResolve) {
      const resolve = parentSkuModalResolve;
      parentSkuModalResolve = null;
      resolve(value);
    }
  }

  function submitParentSkuModal() {
    const parentSku = getSingleSkuValue(parentSkuModalInput?.value || '');
    if (!parentSku) {
      if (parentSkuModalError) {
        parentSkuModalError.textContent = 'Укажите ровно один SKU, минимум 3 цифры.';
        parentSkuModalError.classList.remove('hidden');
      }
      return;
    }
    closeParentSkuModal(parentSku);
  }

  function askParentSkuForSingleSource(defaultSku) {
    if (!parentSkuModal || !parentSkuModalInput) {
      const answer = prompt('Ваш родительский SKU для этой сборки:', defaultSku || '');
      if (answer === null) return Promise.resolve(null);
      const parentSku = getSingleSkuValue(answer);
      if (!parentSku) {
        alert('Укажите ровно один SKU, минимум 3 цифры.');
        return Promise.resolve(null);
      }
      return Promise.resolve(parentSku);
    }
    return new Promise(resolve => {
      parentSkuModalResolve = resolve;
      parentSkuModalInput.value = defaultSku || '';
      if (parentSkuModalError) parentSkuModalError.classList.add('hidden');
      parentSkuModal.classList.remove('hidden');
      setTimeout(() => {
        parentSkuModalInput.focus();
        parentSkuModalInput.select();
      }, 0);
    });
  }

  if (parentSkuModalApply) parentSkuModalApply.addEventListener('click', submitParentSkuModal);
  if (parentSkuModalCancel) parentSkuModalCancel.addEventListener('click', () => closeParentSkuModal(null));
  if (parentSkuModalClose) parentSkuModalClose.addEventListener('click', () => closeParentSkuModal(null));
  if (parentSkuModalInput) {
    parentSkuModalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitParentSkuModal();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeParentSkuModal(null);
      }
    });
  }
  if (btnCopyComplaintParentSku) {
    btnCopyComplaintParentSku.addEventListener('click', () => {
      const parentSku = getSingleSkuValue(complaintParentSkuInput?.value || '');
      if (!parentSku) {
        flashBtn(btnCopyComplaintParentSku, '—');
        return;
      }
      navigator.clipboard.writeText(parentSku);
      flashBtn(btnCopyComplaintParentSku, '✓');
    });
  }

  // Предупреждение по количеству SKU в жалобах + сброс ошибки запуска
  complaintSkuInput.addEventListener('input', () => {
    const errEl = document.getElementById('complaintStartError');
    if (errEl) errEl.classList.add('hidden');
    const skus = parseSkus(complaintSkuInput.value);
    complaintSkuWarning.classList.add('hidden');
    if (skus.length > 50) {
      complaintSkuWarning.textContent = `⚠ ${skus.length} жалоб — это займёт ~${Math.round(skus.length * 45 / 60)} мин. Антибот-паузы будут активны.`;
      complaintSkuWarning.classList.remove('hidden');
    } else if (skus.length > 20) {
      complaintSkuWarning.textContent = `⚠ ${skus.length} жалоб — рекомендуем тестовый прогон сначала.`;
      complaintSkuWarning.classList.remove('hidden');
    }
  });

  function addComplaintLog(text) {
    complaintLogEntries++;
    complaintLogCount.textContent = complaintLogEntries;
    const line = document.createElement('div');
    line.className = 'log-line';
    if (text.includes('Ошибка') || text.includes('ошибка') || text.includes('failed') || text.includes('⛔')) line.classList.add('error');
    else if (text.includes('отправлен') || text.includes('✓') || text.includes('✅') || text.includes('done') || text.includes('завершено')) line.classList.add('success');
    line.textContent = text;
    complaintLogContainer.appendChild(line);
    // Прокрутка внутри лог-контейнера
    complaintLogContainer.scrollTop = complaintLogContainer.scrollHeight;
    // Прокрутка всего popup к лог-секции
    const logSection = document.getElementById('complaintLogSection');
    if (logSection) logSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
    saveComplaintSession();
  }

  function updateComplaintProgress(current, total) {
    complaintProgressCurrent.textContent = current;
    complaintProgressTotal.textContent = total;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    complaintProgressPercent.textContent = pct + '%';
    complaintProgressFill.style.width = pct + '%';
  }

  function renderComplaintQueue(queue) {
    complaintQueue.classList.remove('hidden');
    complaintQueue.innerHTML = '';
    for (const item of queue) {
      const el = document.createElement('div');
      el.className = 'queue-item queue-' + item.status;
      const icon = item.status === 'done' ? '✓'
        : item.status === 'failed' ? '✗'
        : item.status === 'escalated' ? '🛎'
        : item.status === 'no_violation' ? '○'
        : item.status === 'skipped' ? '—'
        : item.status === 'pending' ? '○' : '●';
      el.innerHTML = `<span class="queue-icon">${icon}</span><span class="queue-sku">${esc(item.sku)}</span>`;
      if (item.error) el.innerHTML += `<span class="queue-error">${esc(item.error)}</span>`;
      complaintQueue.appendChild(el);
    }
  }

  function setComplaintUiRunning() {
    btnComplaintStart.disabled = true;
    btnComplaintPause.disabled = false;
    btnComplaintStop.disabled = false;
    complaintSkuInput.disabled = true;
    if (complaintParentSkuInput) complaintParentSkuInput.disabled = true;
    if (btnCopyComplaintParentSku) btnCopyComplaintParentSku.disabled = true;
    complaintMode.disabled = true;
    complaintType.disabled = true;
    complaintProgressWrap.classList.remove('hidden');
    complaintStatus.classList.remove('hidden');
    // v5.9.23: меняем текст статуса с initial «Ожидание» на «Запуск…» —
    // первый supportProgress перепишет на «Обработка X/Y», но до этого
    // юзер видит признак активности (раньше казалось что зависло).
    complaintStatusIcon.textContent = '🚀';
    complaintStatusText.textContent = 'Запуск, подготовка чата…';
  }

  function setComplaintUiStopped() {
    complaintIsPaused = false;
    btnComplaintStart.disabled = false;
    btnComplaintPause.disabled = true;
    btnComplaintPause.textContent = '⏸';
    btnComplaintStop.disabled = true;
    complaintSkuInput.disabled = false;
    if (complaintParentSkuInput) complaintParentSkuInput.disabled = false;
    if (btnCopyComplaintParentSku) btnCopyComplaintParentSku.disabled = false;
    complaintMode.disabled = false;
    complaintType.disabled = false;
    complaintStatusIcon.textContent = '⏹';
    complaintStatusText.textContent = 'Остановлено';
    complaintHint.classList.add('hidden');
    // confirmGate removed
  }

  // Кнопка «В жалобы» — собирает SKU конкурентов из результатов и отправляет в таб Жалобы.
  // Сохраняет parent→competitor карту, чтобы бот мог подобрать файлы для SKU-родителя.
  btnSendToComplaints.addEventListener('click', async () => {
    if (!isProLicense) {
      addLog('⛔ Жалобы доступны в PRO-версии.');
      return;
    }
    const skus = new Set();
    const parentMap = {}; // {competitorSku: [parentSku, ...]}
    let skippedOzon = 0;
    const skippedSellers = new Set();
    for (const r of allResults) {
      if (r.error || !r.sellers) continue;
      const parentSku = String(r.sku || '').trim();
      for (const s of r.sellers) {
        if (!s.competitorSku) continue;
        // Защита от жалоб на продавцов из blacklist (Ozon Беларусь и т.д.)
        // В результатах сканирования имя продавца лежит в поле `name`
        const sellerName = s.name || s.sellerName || '';
        if (isBlacklistedComplaintSeller(sellerName)) {
          skippedOzon++;
          if (sellerName) skippedSellers.add(sellerName);
          continue;
        }
        skus.add(s.competitorSku);
        if (parentSku) {
          if (!parentMap[s.competitorSku]) parentMap[s.competitorSku] = [];
          if (!parentMap[s.competitorSku].includes(parentSku)) parentMap[s.competitorSku].push(parentSku);
        }
      }
    }
    if (skippedOzon > 0) {
      const sellersHint = [...skippedSellers].slice(0, 3).join(', ');
      const reason = ozonBlacklistDisabled
        ? 'из вашего списка исключений в Настройках'
        : 'Ozon-магазины и ваши исключения из Настроек';
      addLog(`⚠ Пропущено ${skippedOzon} SKU (${sellersHint}${skippedSellers.size > 3 ? '…' : ''}) — ${reason}`);
    }
    if (skus.size === 0) {
      addLog('Нет SKU конкурентов для отправки в жалобы');
      return;
    }
    const sourceSkus = getUniqueSourceSkus(allResults);
    let selectedParentSku = '';
    if (sourceSkus.length === 1) {
      selectedParentSku = await askParentSkuForSingleSource(sourceSkus[0]);
      if (selectedParentSku === null) {
        addLog('Перенос в Жалобы отменён');
        return;
      }
      applyParentSkuOverride(parentMap, skus, selectedParentSku);
    }
    // Мержим parent-карту со storage (может быть от предыдущих сессий)
    try {
      const prev = await loadParentMap();
      for (const comp of Object.keys(parentMap)) {
        const merged = new Set([...(prev[comp] || []), ...parentMap[comp]]);
        prev[comp] = [...merged];
      }
      await saveParentMap(prev);
    } catch (_) {}
    // v5.9.36: мержим с существующим списком (а не заменяем), чтобы можно было
    // собирать пакет из нескольких сборок с разными parent SKU
    const existing = parseSkus(complaintSkuInput.value);
    const merged = new Set([...existing, ...skus]);
    complaintSkuInput.value = [...merged].join('\n');
    // Parent SKU поле: устанавливаем только если пустое (каждый пакет привязан через parentMap)
    if (selectedParentSku && !getSingleSkuValue(complaintParentSkuInput?.value || '')) {
      setComplaintParentSku(selectedParentSku);
    }
    // Триггерим предупреждение и сохранение
    complaintSkuInput.dispatchEvent(new Event('input'));
    complaintSkuInput.dispatchEvent(new Event('change'));
    // Переключаемся на таб Жалобы
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="complaints"]').classList.add('active');
    document.getElementById('tabComplaints').classList.add('active');
    addLog(`${skus.size} SKU конкурентов отправлено в Жалобы`);
    if (selectedParentSku) addLog(`Родительский SKU ${selectedParentSku} привязан к ${skus.size} SKU`);
  });

  // === Импорт CSV из истории сканирования ===
  const btnImportCsv = document.getElementById('btnImportCsv');
  const importCsvInput = document.getElementById('importCsvInput');
  const importCsvHint = document.getElementById('importCsvHint');

  btnImportCsv.addEventListener('click', () => { importCsvInput.click(); });
  importCsvInput.addEventListener('change', () => {
    const file = importCsvInput.files[0];
    if (!file) return;
    importCsvInput.value = '';

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      // CSV формат: "Мой SKU";"Название";"SKU конкурента";"ID продавца";"Продавец";"Цена";"Ссылка"
      const lines = text.split(/\r?\n/).filter(Boolean);
      const skus = new Set();
      for (let i = 1; i < lines.length; i++) { // пропуск заголовка
        const cols = lines[i].split(';').map(c => c.replace(/^"|"$/g, '').trim());
        const competitorSku = cols[2] || '';
        if (/^\d{3,}$/.test(competitorSku)) skus.add(competitorSku);
      }
      if (skus.size === 0) {
        importCsvHint.textContent = 'SKU не найдены';
        importCsvHint.style.color = '#d32f2f';
        importCsvHint.classList.remove('hidden');
        setTimeout(() => importCsvHint.classList.add('hidden'), 3000);
        return;
      }
      // Добавляем к существующим
      const existing = parseSkus(complaintSkuInput.value);
      const merged = new Set([...existing, ...skus]);
      complaintSkuInput.value = [...merged].join('\n');
      complaintSkuInput.dispatchEvent(new Event('input'));
      importCsvHint.textContent = `+${skus.size} SKU`;
      importCsvHint.style.color = '#2e7d32';
      importCsvHint.classList.remove('hidden');
      setTimeout(() => importCsvHint.classList.add('hidden'), 3000);
      addComplaintLog(`Импортировано ${skus.size} SKU конкурентов из ${file.name}`);
    };
    reader.readAsText(file, 'utf-8');
  });

  // Элемент для ошибки "нет seller.ozon.ru"
  let complaintErrorEl = document.getElementById('complaintStartError');
  if (!complaintErrorEl) {
    complaintErrorEl = document.createElement('div');
    complaintErrorEl.id = 'complaintStartError';
    complaintErrorEl.className = 'complaint-start-error hidden';
    btnComplaintStart.parentNode.insertBefore(complaintErrorEl, btnComplaintStart.nextSibling);
  }
  function showComplaintStartError(msg) {
    complaintErrorEl.innerHTML = msg;
    complaintErrorEl.classList.remove('hidden');
  }
  function hideComplaintStartError() {
    complaintErrorEl.classList.add('hidden');
  }

  btnComplaintStart.addEventListener('click', async () => {
    hideComplaintStartError();
    const skus = parseSkus(complaintSkuInput.value);
    if (skus.length === 0) { addComplaintLog('Нет валидных артикулов'); return; }
    const manualParentRaw = String(complaintParentSkuInput?.value || '').trim();
    const manualParentSku = manualParentRaw ? getSingleSkuValue(manualParentRaw) : '';
    if (manualParentRaw && !manualParentSku) {
      addComplaintLog('⛔ Родительский SKU должен быть одним артикулом, минимум 3 цифры.');
      return;
    }

    if (!isProLicense) {
      addComplaintLog('⛔ Жалобы доступны в PRO-версии. Введите код активации в Настройках.');
      return;
    }

    // Проверяем предыдущий прогресс — если есть пересечение с текущими SKU, спрашиваем
    let resetProgress = false;
    try {
      const progressResp = await new Promise(resolve =>
        chrome.runtime.sendMessage({ action: 'supportGetProgress' }, resolve)
      );
      const prog = progressResp?.progress;
      if (prog && prog.processedSkus && prog.processedSkus.length > 0) {
        const processedSet = new Set(prog.processedSkus.map(p => p.sku));
        const overlap = skus.filter(s => processedSet.has(s));
        if (overlap.length > 0) {
          const msg = `Найдено ${overlap.length} SKU из ${skus.length}, которые уже обрабатывались ранее.\n\n` +
            `ОК — пропустить их (продолжить с неотработанных)\n` +
            `Отмена — начать заново (все SKU будут обработаны)`;
          resetProgress = !confirm(msg);
        }
      }
    } catch (_) {}

    // Проверяем, открыт ли seller.ozon.ru
    const sellerTabs = await new Promise(resolve =>
      chrome.tabs.query({ url: 'https://seller.ozon.ru/*' }, resolve)
    );
    if (sellerTabs.length === 0) {
      showComplaintStartError(
        '⚠ Нет открытой вкладки seller.ozon.ru<br>' +
        'Откройте <a href="https://seller.ozon.ru/app/messenger/?group=support_v2" target="_blank" class="link-ozon">seller.ozon.ru → Поддержка</a> ' +
        'в браузере, затем повторите запуск.'
      );
      return;
    }

    // Очистка
    complaintLogContainer.innerHTML = '';
    complaintLogEntries = 0;
    complaintLogCount.textContent = '0';
    complaintQueue.innerHTML = '';
    updateComplaintProgress(0, skus.length);
    setComplaintUiRunning();
    if (skus.length > 100) {
      addComplaintLog(`⚠ ${skus.length} жалоб — большой пакет. Старт может занять больше времени, антибот-паузы будут активны.`);
    }

    // Карта конкурент→родитель (для выбора per-SKU файлов)
    const parentMap = await loadParentMap();
    // v5.9.38: считаем уникальных parents в текущем пакете для диагностики multi-batch сборок
    const uniqueParentsInBatch = new Set();
    for (const sku of skus) {
      const ps = parentMap[sku];
      if (Array.isArray(ps)) for (const p of ps) {
        const v = String(p || '').trim();
        if (v) uniqueParentsInBatch.add(v);
      }
    }
    if (manualParentSku) {
      // v5.9.38: preserveExisting=true — НЕ перезаписываем уже привязанные SKU.
      // manualParentSku применяется только к SKU без parentMap-привязки.
      // Это сохраняет корректное mapping для multi-batch сборок (merge v5.9.36).
      const linkedCount = applyParentSkuOverride(parentMap, skus, manualParentSku, { preserveExisting: true });
      if (linkedCount > 0) {
        await saveParentMap(parentMap);
        addComplaintLog(`Родительский SKU ${manualParentSku} привязан к ${linkedCount} SKU без существующей привязки`);
      }
      // Если в пакете уже есть несколько разных parents — предупреждаем что поле не управляет ими
      if (uniqueParentsInBatch.size > 1 && !uniqueParentsInBatch.has(manualParentSku)) {
        addComplaintLog(`ℹ В пакете ${uniqueParentsInBatch.size} разных родительских SKU из «В жалобы». Поле «${manualParentSku}» применено только к новым SKU; остальные используют свои родители из истории.`);
      } else if (uniqueParentsInBatch.size > 1) {
        addComplaintLog(`ℹ В пакете ${uniqueParentsInBatch.size} разных родительских SKU из «В жалобы». Каждый использует свой parent для подбора файлов.`);
      }
    } else if (uniqueParentsInBatch.size > 1) {
      addComplaintLog(`ℹ В пакете ${uniqueParentsInBatch.size} разных родительских SKU. Каждый использует свой parent для подбора файлов.`);
    }
    const activeParentSkus = getActiveParentSkus(skus, parentMap);
    // Файлы передаём в background только как lightweight-метаданные.
    // Base64 подтягивается лениво в момент прикрепления, иначе большие пакеты
    // упираются в лимит сериализации chrome.runtime.sendMessage.
    const filesData = collectComplaintFilesForSending();
    const skuFilesData = collectSkuFilesForSending(activeParentSkus);
    // Настройки лимитов
    const limits = await loadComplaintLimits();
    // v5.9.20: режим работы с доказательствами + список файлов с SKU
    const { evidenceMode, fileSkus } = collectFileFirstForSending(activeParentSkus);

    const supportStartMsg = {
      action: 'supportStart',
      skus,
      mode: complaintMode.value,
      complaintType: complaintType.value,
      files: filesData,
      skuFiles: skuFilesData,
      evidenceMode,
      fileSkus,
      parentMap,
      limits,
      resetProgress
    };

    if (getApproxMessageSize(supportStartMsg) > 5 * 1024 * 1024) {
      addComplaintLog('Ошибка: стартовый пакет слишком большой. Уменьшите количество SKU или очистите лишние доказательства в Настройках.');
      setComplaintUiStopped();
      return;
    }

    try {
      chrome.runtime.sendMessage(supportStartMsg, (resp) => {
        if (chrome.runtime.lastError) {
          addComplaintLog('Ошибка: ' + chrome.runtime.lastError.message);
          setComplaintUiStopped();
          return;
        }
        if (!resp) {
          addComplaintLog('Ошибка: background не ответил на запуск жалоб');
          setComplaintUiStopped();
          return;
        }
        if (resp.status === 'license_required') {
          addComplaintLog('⛔ ' + resp.error);
          setComplaintUiStopped();
        } else if (resp.status === 'all_done') {
          addComplaintLog('ℹ ' + resp.error);
          showComplaintStartError('ℹ️ ' + resp.error);
          setComplaintUiStopped();
        } else if (resp.status === 'error') {
          addComplaintLog('Ошибка: ' + resp.error);
          // Pre-flight ошибки (multiple_tabs, stale_tab, no_tab) — выводим заметным блоком
          if (resp.code === 'multiple_tabs' || resp.code === 'stale_tab' || resp.code === 'no_tab') {
            showComplaintStartError('⚠️ ' + resp.error);
          }
          setComplaintUiStopped();
        }
      });
    } catch (e) {
      addComplaintLog('Ошибка запуска: не удалось передать задачу в background (' + (e.message || e) + ')');
      setComplaintUiStopped();
    }
  });

  btnComplaintPause.addEventListener('click', () => {
    if (complaintIsPaused) {
      chrome.runtime.sendMessage({ action: 'supportResume' });
      complaintIsPaused = false;
      btnComplaintPause.textContent = '⏸';
      complaintStatusIcon.textContent = '▶';
      complaintStatusText.textContent = 'Выполнение...';
    } else {
      chrome.runtime.sendMessage({ action: 'supportPause' });
      complaintIsPaused = true;
      btnComplaintPause.textContent = '▶';
      complaintStatusIcon.textContent = '⏸';
      complaintStatusText.textContent = 'На паузе';
    }
  });

  btnComplaintStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'supportStop' });
    setComplaintUiStopped();
    // confirmGate removed
  });

  // Файлы для жалоб
  complaintFileDrop.addEventListener('click', () => complaintFileInput.click());
  complaintFileDrop.addEventListener('dragover', (e) => { e.preventDefault(); complaintFileDrop.classList.add('dragover'); });
  complaintFileDrop.addEventListener('dragleave', () => complaintFileDrop.classList.remove('dragover'));
  complaintFileDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    complaintFileDrop.classList.remove('dragover');
    handleComplaintFiles(e.dataTransfer.files);
  });
  complaintFileInput.addEventListener('change', () => {
    handleComplaintFiles(complaintFileInput.files);
    complaintFileInput.value = '';
  });

  // complaintFilesMeta — [{id, name, type, size, storage}] — метаданные файлов (общий пул доказательств).
  // storage: 'local' — base64 лежит в chrome.storage.local.complaintFilesBlobs[id];
  //          'idb'   — blob лежит в IndexedDB по id. Разделение по размеру (LARGE_FILE_THRESHOLD).
  let complaintFilesMeta = [];
  // complaintFilesBlobsCache — кэш base64 мелких файлов для быстрой передачи в background
  let complaintFilesBlobsCache = {}; // {id: base64}

  function genFileId() { return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

  async function handleComplaintFiles(fileList) {
    for (const file of fileList) {
      if (file.size > MAX_FILE_SIZE) {
        addComplaintLog(`✗ ${file.name}: слишком большой (${ozgFormatSize(file.size)} > ${ozgFormatSize(MAX_FILE_SIZE)})`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        addComplaintLog(`⚠ ${file.name} — ${ozgFormatSize(file.size)} (сохраняется в IndexedDB, не в обычном хранилище)`);
      }
      const id = genFileId();
      const meta = { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
      try {
        if (file.size >= LARGE_FILE_THRESHOLD) {
          await ozgPutBlob(id, file, { name: meta.name, type: meta.type, size: meta.size });
          meta.storage = 'idb';
        } else {
          const base64 = await ozgBlobToBase64(file);
          complaintFilesBlobsCache[id] = base64;
          meta.storage = 'local';
        }
        complaintFilesMeta.push(meta);
      } catch (e) {
        addComplaintLog(`✗ ${file.name}: ошибка сохранения — ${e.message || e}`);
      }
    }
    await persistComplaintFiles();
    renderComplaintFiles();
  }

  async function persistComplaintFiles() {
    // Метаданные и мелкие blobs — в chrome.storage.local.
    // Крупные blobs остаются в IndexedDB (по id).
    const blobs = {};
    for (const m of complaintFilesMeta) {
      if (m.storage === 'local' && complaintFilesBlobsCache[m.id]) {
        blobs[m.id] = complaintFilesBlobsCache[m.id];
      }
    }
    await new Promise((resolve) => {
      chrome.storage.local.set({
        complaintFilesMeta,
        complaintFilesBlobs: blobs
      }, () => {
        if (chrome.runtime.lastError) {
          // QUOTA_EXCEEDED → миграция мелких файлов в IDB
          console.warn('[OZG] persistComplaintFiles error:', chrome.runtime.lastError.message);
          addComplaintLog('⚠ Хранилище переполнено — переношу файлы в IndexedDB...');
          migrateSmallFilesToIdb().then(resolve);
        } else {
          resolve();
        }
      });
    });
  }

  // Перенос всех local blobs из chrome.storage.local в IndexedDB (когда квота исчерпана)
  async function migrateSmallFilesToIdb() {
    for (const m of complaintFilesMeta) {
      if (m.storage !== 'local') continue;
      const b64 = complaintFilesBlobsCache[m.id];
      if (!b64) continue;
      try {
        const resp = await fetch('data:' + (m.type || 'application/octet-stream') + ';base64,' + b64);
        const blob = await resp.blob();
        await ozgPutBlob(m.id, blob, { name: m.name, type: m.type, size: m.size });
        m.storage = 'idb';
        delete complaintFilesBlobsCache[m.id];
      } catch (e) {
        console.warn('[OZG] migrate failed', m.name, e);
      }
    }
    await new Promise(r => chrome.storage.local.set({
      complaintFilesMeta, complaintFilesBlobs: {}
    }, r));
  }

  function renderComplaintFiles() {
    if (complaintFilesMeta.length === 0) {
      complaintFileList.classList.add('hidden');
      return;
    }
    complaintFileList.classList.remove('hidden');
    complaintFileList.innerHTML = complaintFilesMeta.map((f, i) => {
      const sizeBadge = f.size ? `<span class="file-size">${ozgFormatSize(f.size)}</span>` : '';
      const storageBadge = f.storage === 'idb' ? '<span class="file-storage" title="Крупный файл в IndexedDB">IDB</span>' : '';
      return `<div class="file-item"><span class="file-name">${esc(f.name)}</span>${sizeBadge}${storageBadge}<button class="btn-close" data-idx="${i}" title="Удалить">&times;</button></div>`;
    }).join('');
    complaintFileList.querySelectorAll('.btn-close').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const m = complaintFilesMeta[idx];
        if (!m) return;
        if (m.storage === 'idb') { try { await ozgDeleteBlob(m.id); } catch (_) {} }
        delete complaintFilesBlobsCache[m.id];
        complaintFilesMeta.splice(idx, 1);
        await persistComplaintFiles();
        renderComplaintFiles();
      });
    });
  }

  // Восстановить файлы при открытии popup
  chrome.storage.local.get(['complaintFilesMeta', 'complaintFilesBlobs', 'complaintFilesData'], async (data) => {
    // Миграция старого формата complaintFilesData → complaintFilesMeta (одноразовая)
    if ((!data.complaintFilesMeta || data.complaintFilesMeta.length === 0)
        && Array.isArray(data.complaintFilesData) && data.complaintFilesData.length > 0) {
      const migrated = [];
      const blobs = {};
      for (const f of data.complaintFilesData) {
        const id = genFileId();
        migrated.push({ id, name: f.name, type: f.type, size: null, storage: 'local' });
        blobs[id] = f.base64;
        complaintFilesBlobsCache[id] = f.base64;
      }
      complaintFilesMeta = migrated;
      await new Promise(res => chrome.storage.local.set({
        complaintFilesMeta: migrated,
        complaintFilesBlobs: blobs
      }, res));
      chrome.storage.local.remove(['complaintFilesData']);
    } else {
      complaintFilesMeta = data.complaintFilesMeta || [];
      complaintFilesBlobsCache = data.complaintFilesBlobs || {};
    }
    renderComplaintFiles();
    warnMissingIdbFiles(complaintFilesMeta, 'Общие доказательства');
  });

  function makeFileMetaForMessage(m, source) {
    return {
      id: m.id,
      name: m.name,
      type: m.type || 'application/octet-stream',
      size: m.size || 0,
      storage: m.storage === 'idb' ? 'idb' : 'local',
      source
    };
  }

  function getApproxMessageSize(obj) {
    try { return JSON.stringify(obj).length; } catch (_) { return Infinity; }
  }

  async function warnMissingIdbFiles(files, label) {
    const missing = [];
    for (const m of (files || [])) {
      if (!m || m.storage !== 'idb' || !m.id) continue;
      try {
        const rec = await ozgGetBlob(m.id);
        if (!rec || !rec.blob) missing.push(m.name || m.id);
      } catch (_) {
        missing.push(m.name || m.id);
      }
    }
    if (missing.length === 0) return;
    const names = missing.slice(0, 3).join(', ');
    const suffix = missing.length > 3 ? ` и ещё ${missing.length - 3}` : '';
    addComplaintLog(`⚠ ${label}: файл числится в списке, но тело файла недоступно (${names}${suffix}). Загрузите доказательство заново. Такое бывает при установке новой распакованной копии расширения с другим ID.`);
  }

  function getActiveParentSkus(skus, parentMap) {
    const out = new Set();
    for (const sku of skus) {
      const ownSku = String(sku || '').trim();
      if (ownSku) out.add(ownSku);
      const parents = parentMap && parentMap[sku];
      if (!Array.isArray(parents)) continue;
      for (const p of parents) {
        const val = String(p || '').trim();
        if (val) out.add(val);
      }
    }
    return out;
  }

  // Собрать общий пул для background без base64.
  function collectComplaintFilesForSending() {
    return complaintFilesMeta.map(m => makeFileMetaForMessage(m, 'common'));
  }

  async function readComplaintFilePayload(source, id) {
    let meta = null;
    let b64 = null;

    if (source === 'common') {
      meta = complaintFilesMeta.find(f => f.id === id);
      if (!meta) throw new Error('Файл не найден в общем пуле');
      if (meta.storage === 'local') b64 = complaintFilesBlobsCache[id] || null;
    } else if (source === 'sku') {
      for (const sku of Object.keys(skuFilesMap)) {
        meta = (skuFilesMap[sku] || []).find(f => f.id === id);
        if (meta) break;
      }
      if (!meta) throw new Error('Файл не найден в per-SKU доказательствах');
      if (meta.storage === 'local') b64 = skuFilesBlobsCache[id] || null;
    } else if (source === 'file_first') {
      meta = fileSkusList.find(f => f.id === id);
      if (!meta) throw new Error('Файл не найден в режиме файл → SKU');
      if (meta.storage === 'local') b64 = fileSkusBlobsCache[id] || null;
    } else {
      throw new Error('Неизвестный источник файла');
    }

    if (meta.storage === 'idb') {
      const rec = await ozgGetBlob(id);
      if (rec && rec.blob) b64 = await ozgBlobToBase64(rec.blob);
    }
    if (!b64) throw new Error('Не удалось прочитать файл');
    return { name: meta.name, type: meta.type || 'application/octet-stream', base64: b64 };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'getComplaintFilePayload') return false;
    readComplaintFilePayload(msg.source, msg.id)
      .then(file => sendResponse({ ok: true, file }))
      .catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  });

  // Лог toggle жалоб
  const complaintLogSection = document.getElementById('complaintLogSection');
  const complaintLogToggle = document.getElementById('complaintLogToggle');
  complaintLogToggle.addEventListener('click', () => {
    complaintLogSection.classList.toggle('collapsed');
  });

  // === Сохранение/восстановление сессии жалоб ===
  function saveComplaintSession() {
    const sessionData = {
      skus: complaintSkuInput.value,
      parentSku: complaintParentSkuInput ? complaintParentSkuInput.value : '',
      mode: complaintMode.value,
      complaintType: complaintType.value,
      logs: Array.from(complaintLogContainer.children).map(el => el.textContent),
      fileNames: complaintFilesMeta.map(f => f.name)
    };
    chrome.storage.local.set({ lastComplaintSession: sessionData });
  }

  // Автосохранение при изменениях
  complaintSkuInput.addEventListener('change', saveComplaintSession);
  if (complaintParentSkuInput) complaintParentSkuInput.addEventListener('change', saveComplaintSession);
  complaintMode.addEventListener('change', saveComplaintSession);
  complaintType.addEventListener('change', saveComplaintSession);

  // Восстановление при открытии popup
  chrome.storage.local.get(['lastComplaintSession'], (data) => {
    if (!data.lastComplaintSession) return;
    const s = data.lastComplaintSession;
    if (s.skus) complaintSkuInput.value = s.skus;
    if (s.parentSku && complaintParentSkuInput) complaintParentSkuInput.value = s.parentSku;
    if (s.mode) complaintMode.value = s.mode;
    // Миграция старых значений (v5.9.15): seller/brand → plagiat_legacy
    if (s.complaintType) {
      const migratedType = (s.complaintType === 'seller' || s.complaintType === 'brand')
        ? 'plagiat_legacy'
        : s.complaintType;
      complaintType.value = migratedType;
    }
    if (s.logs && s.logs.length > 0) {
      for (const log of s.logs) addComplaintLog(log);
    }
    // Файлы восстанавливаются из отдельного ключа complaintFilesMeta (см. выше)
    // Триггерим предупреждение
    complaintSkuInput.dispatchEvent(new Event('input'));
    // Показываем beta-предупреждение если текущий выбранный тип — BETA
    updateBetaWarning();
  });

  // BETA-предупреждение под селектором
  const betaWarning = document.getElementById('betaWarning');
  function updateBetaWarning() {
    if (!betaWarning) return;
    const isBeta = complaintType.value === 'content_beta' || complaintType.value === 'brand_beta';
    betaWarning.classList.toggle('hidden', !isBeta);
  }
  complaintType.addEventListener('change', updateBetaWarning);
  // начальная инициализация (если storage пустой)
  setTimeout(updateBetaWarning, 0);

  // Запрашиваем текущий статус из service worker (и из storage если SW остановлен).
  // Восстанавливаем логи/очередь/прогресс всегда, не только при isRunning —
  // popup может быть открыт после того как бот завершил работу или упал,
  // и пользователю важно видеть что произошло.
  chrome.runtime.sendMessage({ action: 'supportGetStatus' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    const hasData = (resp.queue && resp.queue.length > 0) || (resp.logs && resp.logs.length > 0);
    if (!hasData) return;

    // UI-состояние
    if (resp.isRunning) {
      setComplaintUiRunning();
      if (resp.limitGateActive) {
        // v5.9.25: gate лимита новых обращений больше не должен стопорить большие пакеты.
        // Показываем gate только для BETA-autostop, где нужна ручная проверка пути.
        if (resp.limitGateReason === 'beta_autostop') {
          const title = 'BETA: серия ошибок';
          const details = 'Путь жалобы остановлен после нескольких ошибок подряд. Проверьте чат вручную или нажмите «Продолжить», чтобы попробовать ещё.';
          showLimitGate(title, details);
        } else {
          hideLimitGate();
          chrome.runtime.sendMessage({ action: 'supportResume' });
          complaintStatusIcon.textContent = '▶';
          complaintStatusText.textContent = 'Выполнение...';
        }
      } else if (resp.isPaused) {
        complaintIsPaused = true;
        btnComplaintPause.textContent = '▶';
        complaintStatusIcon.textContent = '⏸';
        complaintStatusText.textContent = 'На паузе';
      } else {
        complaintStatusIcon.textContent = '▶';
        complaintStatusText.textContent = 'Выполнение...';
      }
      if (resp.source === 'storage' && !resp.isPaused && !resp.limitGateActive) {
        chrome.runtime.sendMessage({ action: 'supportRecoverAndContinue' });
      }
    } else {
      // Сессия завершена — показываем итоги
      complaintStatus.classList.remove('hidden');
      complaintStatusIcon.textContent = '✓';
      complaintStatusText.textContent = resp.source === 'storage' ? 'Последняя сессия' : 'Завершено';
    }

    // Очередь SKU с бейджами статусов (done/failed/pending)
    if (resp.queue && resp.queue.length > 0) {
      renderComplaintQueue(resp.queue);
      updateComplaintProgress(
        Math.min(resp.currentIndex + 1, resp.queue.length),
        resp.queue.length
      );
    }

    // Логи всей сессии
    if (resp.logs && resp.logs.length > 0) {
      complaintLogContainer.innerHTML = '';
      complaintLogEntries = 0;
      complaintLogCount.textContent = '0';
      for (const log of resp.logs) addComplaintLog(log);
    }
  });

  // === Per-SKU доказательства, лимиты, проблемные SKU, parent map ===

  // storage keys:
  //   complaintSkuFiles: { parentSku: [{id, name, type, size, storage}] } — метаданные
  //   complaintSkuFilesBlobs: { id: base64 } — мелкие файлы (идентично общему пулу)
  //   complaintParentMap: { competitorSku: [parentSku, ...] } — связь конкурент→родители
  //   complaintLimits: { maxChatsPerSession, maxConsecutiveEscalations }
  //   complaintProblems: { escalated: [{sku, error, ts}], failed: [...], noViolation: [...] }

  let skuFilesMap = {};       // parentSku → [meta, ...]
  let skuFilesBlobsCache = {}; // id → base64 (мелкие)
  let complaintLimits = { maxChatsPerSession: 10, maxConsecutiveEscalations: 5 };
  let complaintProblems = { escalated: [], failed: [], noViolation: [] };

  async function loadSkuFiles() {
    const d = await new Promise(r => chrome.storage.local.get(['complaintSkuFiles', 'complaintSkuFilesBlobs'], r));
    skuFilesMap = d.complaintSkuFiles || {};
    skuFilesBlobsCache = d.complaintSkuFilesBlobs || {};
  }
  async function persistSkuFiles() {
    const blobs = {};
    for (const sku of Object.keys(skuFilesMap)) {
      for (const m of (skuFilesMap[sku] || [])) {
        if (m.storage === 'local' && skuFilesBlobsCache[m.id]) blobs[m.id] = skuFilesBlobsCache[m.id];
      }
    }
    await new Promise((resolve) => {
      chrome.storage.local.set({
        complaintSkuFiles: skuFilesMap,
        complaintSkuFilesBlobs: blobs
      }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[OZG] persistSkuFiles error:', chrome.runtime.lastError.message);
          migrateSkuSmallFilesToIdb().then(resolve);
        } else {
          resolve();
        }
      });
    });
  }

  async function migrateSkuSmallFilesToIdb() {
    for (const sku of Object.keys(skuFilesMap)) {
      for (const m of (skuFilesMap[sku] || [])) {
        if (m.storage !== 'local') continue;
        const b64 = skuFilesBlobsCache[m.id];
        if (!b64) continue;
        try {
          const resp = await fetch('data:' + (m.type || 'application/octet-stream') + ';base64,' + b64);
          const blob = await resp.blob();
          await ozgPutBlob(m.id, blob, { name: m.name, type: m.type, size: m.size });
          m.storage = 'idb';
          delete skuFilesBlobsCache[m.id];
        } catch (_) {}
      }
    }
    await new Promise(r => chrome.storage.local.set({
      complaintSkuFiles: skuFilesMap, complaintSkuFilesBlobs: {}
    }, r));
  }

  async function loadComplaintLimits() {
    const d = await new Promise(r => chrome.storage.local.get(['complaintLimits'], r));
    if (d.complaintLimits) complaintLimits = Object.assign(complaintLimits, d.complaintLimits);
    return complaintLimits;
  }

  async function loadParentMap() {
    const d = await new Promise(r => chrome.storage.local.get(['complaintParentMap'], r));
    return d.complaintParentMap || {};
  }
  async function saveParentMap(map) {
    await new Promise(r => chrome.storage.local.set({ complaintParentMap: map }, r));
  }

  async function loadProblems() {
    const d = await new Promise(r => chrome.storage.local.get(['complaintProblems'], r));
    complaintProblems = Object.assign({ escalated: [], failed: [], noViolation: [] }, d.complaintProblems || {});
  }
  async function persistProblems() {
    await new Promise(r => chrome.storage.local.set({ complaintProblems }, r));
  }

  // Собрать per-SKU файлы для background без base64:
  // возвращает { parentSku: [{id, name, type, size, storage, source}] }.
  // В стартовый пакет попадают только parent SKU текущего запуска, чтобы старые
  // доказательства из storage не раздували supportStart.
  function collectSkuFilesForSending(activeParentSkus) {
    const out = {};
    for (const sku of Object.keys(skuFilesMap)) {
      if (activeParentSkus && !activeParentSkus.has(String(sku).trim())) continue;
      const list = skuFilesMap[sku] || [];
      if (list.length === 0) continue;
      const arr = list.map(m => makeFileMetaForMessage(m, 'sku'));
      if (arr.length > 0) out[sku] = arr;
    }
    return out;
  }

  // === v5.9.20: режим «файл → список SKU» ===
  // storage:
  //   evidenceMode: 'sku_first' | 'file_first'
  //   complaintFileSkus: [{id, name, type, size, storage, skus: ['12345', ...]}, ...]
  //   complaintFileSkusBlobs: { id: base64 } — мелкие файлы

  let evidenceMode = 'sku_first';
  let fileSkusList = [];
  let fileSkusBlobsCache = {};

  async function loadFileFirstFiles() {
    const d = await new Promise(r => chrome.storage.local.get(['evidenceMode', 'complaintFileSkus', 'complaintFileSkusBlobs'], r));
    evidenceMode = d.evidenceMode === 'file_first' ? 'file_first' : 'sku_first';
    fileSkusList = Array.isArray(d.complaintFileSkus) ? d.complaintFileSkus : [];
    fileSkusBlobsCache = d.complaintFileSkusBlobs || {};
  }
  async function persistFileFirstFiles() {
    // ВАЖНО: chrome.storage.local.set делает APPEND/UPDATE по ключам, а НЕ replace всего storage.
    // То есть complaintSkuFiles, complaintSkuFilesBlobs и другие ключи sku_first режима
    // ОСТАЮТСЯ нетронутыми. Переключение режима не теряет загруженные файлы — они просто
    // лежат в параллельных ветках storage. Storage переживает обновления расширения (Chrome
    // не чистит local storage при update, только при uninstall).
    const blobs = {};
    for (const m of fileSkusList) {
      if (m.storage === 'local' && fileSkusBlobsCache[m.id]) blobs[m.id] = fileSkusBlobsCache[m.id];
    }
    await new Promise(r => chrome.storage.local.set({
      evidenceMode,
      complaintFileSkus: fileSkusList,
      complaintFileSkusBlobs: blobs
    }, r));
  }

  // Сборка fileSkus для background — метаданные + список SKU из textarea.
  function collectFileFirstForSending(activeParentSkus) {
    const arr = [];
    if (evidenceMode !== 'file_first') return { evidenceMode, fileSkus: [] };
    for (const m of fileSkusList) {
      const fileSkus = Array.isArray(m.skus) ? m.skus.map(s => String(s).trim()).filter(Boolean) : [];
      if (activeParentSkus && !fileSkus.some(s => activeParentSkus.has(s))) continue;
      arr.push({
        ...makeFileMetaForMessage(m, 'file_first'),
        skus: fileSkus
      });
    }
    return { evidenceMode, fileSkus: arr };
  }

  // UI: настройки лимитов
  const limitNewChatsInput = document.getElementById('limitNewChats');
  const limitConsecEscInput = document.getElementById('limitConsecEsc');
  const btnSaveComplaintLimits = document.getElementById('btnSaveComplaintLimits');
  const complaintLimitsSavedHint = document.getElementById('complaintLimitsSavedHint');
  (async () => {
    await loadComplaintLimits();
    if (limitNewChatsInput) limitNewChatsInput.value = complaintLimits.maxChatsPerSession;
    if (limitConsecEscInput) limitConsecEscInput.value = complaintLimits.maxConsecutiveEscalations;
  })();
  if (btnSaveComplaintLimits) {
    btnSaveComplaintLimits.addEventListener('click', async () => {
      const maxChats = Math.max(1, Math.min(500, parseInt(limitNewChatsInput.value, 10) || 10));
      const maxConsec = Math.max(0, Math.min(50, parseInt(limitConsecEscInput.value, 10) || 5));
      complaintLimits = { maxChatsPerSession: maxChats, maxConsecutiveEscalations: maxConsec };
      limitNewChatsInput.value = maxChats;
      limitConsecEscInput.value = maxConsec;
      await new Promise(r => chrome.storage.local.set({ complaintLimits }, r));
      complaintLimitsSavedHint.classList.remove('hidden');
      setTimeout(() => complaintLimitsSavedHint.classList.add('hidden'), 2000);
      flashBtn(btnSaveComplaintLimits, '✓');
    });
  }

  // UI: per-SKU файлы
  const skuFileSkuInput = document.getElementById('skuFileSkuInput');
  const btnAddSkuFile = document.getElementById('btnAddSkuFile');
  const skuFileInput = document.getElementById('skuFileInput');
  const skuFilesList = document.getElementById('skuFilesList');

  let pendingSkuForFiles = null;

  function renderSkuFilesList() {
    const keys = Object.keys(skuFilesMap);
    if (keys.length === 0) {
      skuFilesList.classList.add('hidden');
      return;
    }
    skuFilesList.classList.remove('hidden');
    skuFilesList.innerHTML = keys.map(sku => {
      const files = skuFilesMap[sku] || [];
      const filesHtml = files.map((f, i) => {
        const sizeBadge = f.size ? `<span class="file-size">${ozgFormatSize(f.size)}</span>` : '';
        const storageBadge = f.storage === 'idb' ? '<span class="file-storage" title="IndexedDB">IDB</span>' : '';
        return `<div class="sku-file-bundle-file"><span class="file-name">${esc(f.name)}</span>${sizeBadge}${storageBadge}<button class="btn-close" data-sku="${esc(sku)}" data-idx="${i}" title="Удалить файл">&times;</button></div>`;
      }).join('');
      return `<div class="sku-file-bundle">
        <div class="sku-file-bundle-header">
          <span class="sku-file-bundle-sku">${esc(sku)}</span>
          <span style="color:#888;font-size:10px;">${files.length} файл(ов)</span>
          <div class="sku-file-bundle-actions">
            <button class="btn btn-small btn-add-files-to-sku" data-sku="${esc(sku)}" title="Добавить ещё файл к этому SKU">＋</button>
            <button class="btn btn-small btn-danger-sm btn-remove-sku" data-sku="${esc(sku)}" title="Удалить SKU и все его файлы">✕</button>
          </div>
        </div>
        <div class="sku-file-bundle-files">${filesHtml}</div>
      </div>`;
    }).join('');
    // Удаление одного файла
    skuFilesList.querySelectorAll('.sku-file-bundle-file .btn-close').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sku = btn.dataset.sku;
        const idx = parseInt(btn.dataset.idx, 10);
        const list = skuFilesMap[sku] || [];
        const m = list[idx];
        if (!m) return;
        if (m.storage === 'idb') { try { await ozgDeleteBlob(m.id); } catch (_) {} }
        delete skuFilesBlobsCache[m.id];
        list.splice(idx, 1);
        if (list.length === 0) delete skuFilesMap[sku];
        await persistSkuFiles();
        renderSkuFilesList();
      });
    });
    // Удаление всего бандла
    skuFilesList.querySelectorAll('.btn-remove-sku').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sku = btn.dataset.sku;
        if (!confirm(`Удалить все доказательства для SKU ${sku}?`)) return;
        for (const m of (skuFilesMap[sku] || [])) {
          if (m.storage === 'idb') { try { await ozgDeleteBlob(m.id); } catch (_) {} }
          delete skuFilesBlobsCache[m.id];
        }
        delete skuFilesMap[sku];
        await persistSkuFiles();
        renderSkuFilesList();
      });
    });
    // Добавить файлы к существующему SKU
    skuFilesList.querySelectorAll('.btn-add-files-to-sku').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingSkuForFiles = btn.dataset.sku;
        skuFileInput.click();
      });
    });
  }

  if (btnAddSkuFile && skuFileSkuInput && skuFileInput) {
    btnAddSkuFile.addEventListener('click', () => {
      const sku = (skuFileSkuInput.value || '').trim();
      if (!/^\d{3,}$/.test(sku)) {
        alert('Введите числовой SKU (минимум 3 цифры)');
        return;
      }
      pendingSkuForFiles = sku;
      skuFileInput.click();
    });
    skuFileInput.addEventListener('change', async () => {
      const files = Array.from(skuFileInput.files || []);
      skuFileInput.value = '';
      const sku = pendingSkuForFiles;
      pendingSkuForFiles = null;
      if (!sku || files.length === 0) return;
      if (!skuFilesMap[sku]) skuFilesMap[sku] = [];
      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          alert(`${file.name}: слишком большой (${ozgFormatSize(file.size)} > ${ozgFormatSize(MAX_FILE_SIZE)})`);
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          console.log(`[OZG] ${file.name} (${ozgFormatSize(file.size)}) → IndexedDB`);
        }
        const id = genFileId();
        const meta = { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
        try {
          if (file.size >= LARGE_FILE_THRESHOLD) {
            await ozgPutBlob(id, file, { name: meta.name, type: meta.type, size: meta.size });
            meta.storage = 'idb';
          } else {
            skuFilesBlobsCache[id] = await ozgBlobToBase64(file);
            meta.storage = 'local';
          }
          skuFilesMap[sku].push(meta);
        } catch (err) {
          alert(`${file.name}: ошибка сохранения — ${err.message || err}`);
        }
      }
      if (skuFilesMap[sku].length === 0) delete skuFilesMap[sku];
      await persistSkuFiles();
      renderSkuFilesList();
      skuFileSkuInput.value = '';
    });
  }

  loadSkuFiles().then(() => {
    renderSkuFilesList();
    const allSkuFiles = [];
    for (const files of Object.values(skuFilesMap)) {
      if (Array.isArray(files)) allSkuFiles.push(...files);
    }
    warnMissingIdbFiles(allSkuFiles, 'Per-SKU доказательства');
  });

  // === v5.9.20: UI режима «файл → список SKU» ===
  const evidenceSkuFirstUI = document.getElementById('evidenceSkuFirstUI');
  const evidenceFileFirstUI = document.getElementById('evidenceFileFirstUI');
  const btnAddFileFirst = document.getElementById('btnAddFileFirst');
  const fileFirstInput = document.getElementById('fileFirstInput');
  const fileFirstList = document.getElementById('fileFirstList');
  const evidenceModeRadios = document.querySelectorAll('input[name="evidenceMode"]');

  function applyEvidenceModeUI() {
    if (!evidenceSkuFirstUI || !evidenceFileFirstUI) return;
    if (evidenceMode === 'file_first') {
      evidenceSkuFirstUI.classList.add('hidden');
      evidenceFileFirstUI.classList.remove('hidden');
    } else {
      evidenceSkuFirstUI.classList.remove('hidden');
      evidenceFileFirstUI.classList.add('hidden');
    }
    evidenceModeRadios.forEach(r => { r.checked = r.value === evidenceMode; });
  }

  function renderFileFirstList() {
    if (!fileFirstList) return;
    if (fileSkusList.length === 0) {
      fileFirstList.classList.add('hidden');
      fileFirstList.innerHTML = '';
      return;
    }
    fileFirstList.classList.remove('hidden');
    fileFirstList.innerHTML = fileSkusList.map((m, idx) => {
      const sizeStr = m.size ? ozgFormatSize(m.size) : '';
      const skusStr = (m.skus || []).join('\n');
      return `
        <div class="file-first-bundle" data-idx="${idx}">
          <div class="file-first-bundle-header">
            <span class="file-first-name" title="${esc(m.name)}">${esc(m.name)}</span>
            <span class="file-first-meta">${esc(sizeStr)}</span>
            <button class="btn-close" data-action="remove-ff" data-idx="${idx}" title="Удалить">✕</button>
          </div>
          <label class="file-first-skus-label">SKU к которым применяется этот файл (по одному на строку):</label>
          <textarea class="file-first-skus" data-idx="${idx}" placeholder="1234567890&#10;9876543210">${esc(skusStr)}</textarea>
        </div>
      `;
    }).join('');
    fileFirstList.querySelectorAll('button[data-action="remove-ff"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.idx, 10);
        if (isNaN(i) || i < 0 || i >= fileSkusList.length) return;
        const meta = fileSkusList[i];
        if (meta.storage === 'idb') {
          try { await ozgDeleteBlob(meta.id); } catch (_) {}
        } else if (meta.storage === 'local') {
          delete fileSkusBlobsCache[meta.id];
        }
        fileSkusList.splice(i, 1);
        await persistFileFirstFiles();
        renderFileFirstList();
      });
    });
    fileFirstList.querySelectorAll('textarea.file-first-skus').forEach(ta => {
      ta.addEventListener('input', async () => {
        const i = parseInt(ta.dataset.idx, 10);
        if (isNaN(i) || !fileSkusList[i]) return;
        fileSkusList[i].skus = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
        await persistFileFirstFiles();
      });
    });
  }

  if (btnAddFileFirst && fileFirstInput) {
    btnAddFileFirst.addEventListener('click', () => fileFirstInput.click());
    fileFirstInput.addEventListener('change', async () => {
      const file = fileFirstInput.files?.[0];
      fileFirstInput.value = '';
      if (!file) return;
      if (file.size > MAX_FILE_SIZE) {
        alert(`${file.name}: слишком большой (${ozgFormatSize(file.size)} > ${ozgFormatSize(MAX_FILE_SIZE)})`);
        return;
      }
      const id = genFileId();
      const meta = { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, skus: [] };
      try {
        if (file.size >= LARGE_FILE_THRESHOLD) {
          await ozgPutBlob(id, file, { name: meta.name, type: meta.type, size: meta.size });
          meta.storage = 'idb';
        } else {
          fileSkusBlobsCache[id] = await ozgBlobToBase64(file);
          meta.storage = 'local';
        }
        fileSkusList.push(meta);
        await persistFileFirstFiles();
        renderFileFirstList();
      } catch (err) {
        alert(`${file.name}: ошибка сохранения — ${err.message || err}`);
      }
    });
  }

  evidenceModeRadios.forEach(r => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      evidenceMode = r.value === 'file_first' ? 'file_first' : 'sku_first';
      await persistFileFirstFiles();
      applyEvidenceModeUI();
    });
  });

  loadFileFirstFiles().then(() => {
    applyEvidenceModeUI();
    renderFileFirstList();
    warnMissingIdbFiles(fileSkusList, 'Доказательства режима «файл → SKU»');
  });

  // Кнопка «В настройки доказательств» в табе Жалобы
  const btnGoToEvidenceSettings = document.getElementById('btnGoToEvidenceSettings');
  if (btnGoToEvidenceSettings) {
    btnGoToEvidenceSettings.addEventListener('click', () => {
      // Переключаем активный таб на Настройки
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const settingsTabBtn = document.querySelector('[data-tab="settings"]');
      const settingsTabPane = document.getElementById('tabSettings');
      if (settingsTabBtn) settingsTabBtn.classList.add('active');
      if (settingsTabPane) settingsTabPane.classList.add('active');
      // Скроллим к секции «Доказательства»
      setTimeout(() => {
        const section = document.getElementById('evidenceSection');
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    });
  }

  // === Проблемные SKU ===
  const problemSkusBlock = document.getElementById('problemSkusBlock');
  const problemEscalatedWrap = document.getElementById('problemEscalatedWrap');
  const problemFailedWrap = document.getElementById('problemFailedWrap');
  const problemNoViolationWrap = document.getElementById('problemNoViolationWrap');
  const problemEscalatedList = document.getElementById('problemEscalatedList');
  const problemFailedList = document.getElementById('problemFailedList');
  const problemNoViolationList = document.getElementById('problemNoViolationList');
  const problemEscalatedCount = document.getElementById('problemEscalatedCount');
  const problemFailedCount = document.getElementById('problemFailedCount');
  const problemNoViolationCount = document.getElementById('problemNoViolationCount');
  const btnProblemSkusToggle = document.getElementById('btnProblemSkusToggle');

  if (btnProblemSkusToggle) {
    btnProblemSkusToggle.addEventListener('click', () => {
      problemSkusBlock.classList.toggle('collapsed');
    });
  }

  function renderProblems() {
    const esc_ = complaintProblems.escalated || [];
    const fail = complaintProblems.failed || [];
    const noViolation = complaintProblems.noViolation || [];
    if (esc_.length === 0 && fail.length === 0 && noViolation.length === 0) {
      problemSkusBlock.classList.add('hidden');
      return;
    }
    problemSkusBlock.classList.remove('hidden');
    // escalated
    if (esc_.length > 0) {
      problemEscalatedWrap.classList.remove('hidden');
      problemEscalatedCount.textContent = esc_.length;
      problemEscalatedList.innerHTML = esc_.map(p =>
        `<div class="problem-list-item"><span class="sku">${esc(p.sku)}</span><span class="reason">${esc(p.error || '')}</span></div>`
      ).join('');
    } else {
      problemEscalatedWrap.classList.add('hidden');
    }
    if (noViolation.length > 0) {
      problemNoViolationWrap.classList.remove('hidden');
      problemNoViolationCount.textContent = noViolation.length;
      problemNoViolationList.innerHTML = noViolation.map(p =>
        `<div class="problem-list-item"><span class="sku">${esc(p.sku)}</span><span class="reason">${esc(p.error || '')}</span></div>`
      ).join('');
    } else {
      problemNoViolationWrap.classList.add('hidden');
    }
    if (fail.length > 0) {
      problemFailedWrap.classList.remove('hidden');
      problemFailedCount.textContent = fail.length;
      problemFailedList.innerHTML = fail.map(p =>
        `<div class="problem-list-item"><span class="sku">${esc(p.sku)}</span><span class="reason">${esc(p.error || '')}</span></div>`
      ).join('');
    } else {
      problemFailedWrap.classList.add('hidden');
    }
  }

  function problemsDownloadXlsx(cat) {
    const list = complaintProblems[cat] || [];
    if (list.length === 0) return;
    const rows = [['SKU', 'Причина', 'Время']];
    for (const p of list) rows.push([p.sku, p.error || '', p.ts ? new Date(p.ts).toLocaleString('ru-RU') : '']);
    const csv = rows.map(r => r.map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ozguard_problems_${cat}_${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.addEventListener('click', async (e) => {
    const btnCopy = e.target.closest('.btn-problem-copy');
    const btnRequeue = e.target.closest('.btn-problem-requeue');
    const btnXlsx = e.target.closest('.btn-problem-xlsx');
    const btnClear = e.target.closest('.btn-problem-clear');
    if (btnCopy) {
      const cat = btnCopy.dataset.cat;
      const list = complaintProblems[cat] || [];
      navigator.clipboard.writeText(list.map(p => p.sku).join('\n'));
      flashBtn(btnCopy, '✓');
    } else if (btnRequeue) {
      const cat = btnRequeue.dataset.cat;
      const list = complaintProblems[cat] || [];
      if (list.length === 0) return;
      const existing = parseSkus(complaintSkuInput.value);
      const merged = new Set([...existing, ...list.map(p => p.sku)]);
      complaintSkuInput.value = [...merged].join('\n');
      complaintSkuInput.dispatchEvent(new Event('input'));
      complaintSkuInput.dispatchEvent(new Event('change'));
      flashBtn(btnRequeue, '✓');
    } else if (btnXlsx) {
      problemsDownloadXlsx(btnXlsx.dataset.cat);
    } else if (btnClear) {
      const cat = btnClear.dataset.cat;
      const label = cat === 'escalated'
        ? 'переданные оператору'
        : (cat === 'noViolation' ? 'без нарушений' : 'ошибки');
      if (!confirm(`Очистить список «${label}»?`)) return;
      complaintProblems[cat] = [];
      await persistProblems();
      renderProblems();
    }
  });

  loadProblems().then(renderProblems);

  // Добавить проблемный SKU в storage (вызывается по supportProgress от background)
  async function addProblemSku(cat, sku, error) {
    complaintProblems = Object.assign({ escalated: [], failed: [], noViolation: [] }, complaintProblems || {});
    if (!complaintProblems[cat]) complaintProblems[cat] = [];
    // Дедупликация: если уже есть такой SKU, обновляем запись (перетираем timestamp и error)
    const idx = complaintProblems[cat].findIndex(p => p.sku === sku);
    const entry = { sku, error: error || '', ts: Date.now() };
    if (idx >= 0) complaintProblems[cat][idx] = entry;
    else complaintProblems[cat].push(entry);
    await persistProblems();
    renderProblems();
  }

  // === Гейт лимита обращений ===
  const complaintLimitGate = document.getElementById('complaintLimitGate');
  const limitGateTitle = document.getElementById('limitGateTitle');
  const limitGateDetails = document.getElementById('limitGateDetails');
  const btnLimitGateContinue = document.getElementById('btnLimitGateContinue');
  const btnLimitGateStop = document.getElementById('btnLimitGateStop');

  function showLimitGate(reason, details) {
    complaintLimitGate.classList.remove('hidden');
    limitGateTitle.textContent = reason;
    limitGateDetails.textContent = details;
    complaintStatusIcon.textContent = '⏸';
    complaintStatusText.textContent = 'Ожидает подтверждения';
  }
  function hideLimitGate() { complaintLimitGate.classList.add('hidden'); }

  if (btnLimitGateContinue) {
    btnLimitGateContinue.addEventListener('click', () => {
      hideLimitGate();
      chrome.runtime.sendMessage({ action: 'supportLimitContinue' });
    });
  }
  if (btnLimitGateStop) {
    btnLimitGateStop.addEventListener('click', () => {
      hideLimitGate();
      chrome.runtime.sendMessage({ action: 'supportStop' });
      setComplaintUiStopped();
    });
  }

  // Слушатель событий от background
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.action === 'supportLimitReached') {
      if ((msg.title || '').includes('Лимит обращений')) {
        hideLimitGate();
        chrome.runtime.sendMessage({ action: 'supportResume' });
      } else {
        showLimitGate(msg.title || 'Пауза', msg.details || '');
      }
    } else if (msg.action === 'supportProblem') {
      // {sku, category: 'escalated' | 'failed' | 'noViolation', error}
      if (msg.sku && msg.category) addProblemSku(msg.category, msg.sku, msg.error);
    }
  });

  // Кнопка «📨 В жалобы» — запомнить parent→competitor связь
  // (перекрываем предыдущий обработчик? Нет, просто расширим его через прокси-фикс ниже)

  // Очистка сессии жалоб
  const btnComplaintClear = document.getElementById('btnComplaintClear');
  if (btnComplaintClear) {
    btnComplaintClear.addEventListener('click', () => {
      complaintSkuInput.value = '';
      if (complaintParentSkuInput) complaintParentSkuInput.value = '';
      complaintMode.value = 'auto';
      complaintType.value = 'plagiat_legacy';
      // Файлы НЕ очищаем — они переиспользуются между сессиями
      // Удаление файлов — только кнопкой × на каждом файле
      complaintLogContainer.innerHTML = '';
      complaintLogEntries = 0;
      complaintLogCount.textContent = '0';
      complaintQueue.innerHTML = '';
      complaintQueue.classList.add('hidden');
      complaintProgressWrap.classList.add('hidden');
      complaintStatus.classList.add('hidden');
      complaintSkuWarning.classList.add('hidden');
      complaintHint.classList.add('hidden');
      // confirmGate removed
      chrome.storage.local.remove(['lastComplaintSession', 'complaintProgress', 'activeSupportSession']);
    });
  }

  // === Восстановление состояния сканирования при переоткрытии popup ===
  chrome.runtime.sendMessage({ action: 'getScanStatus' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.isRunning) {
      setUiRunning();
      if (resp.isPaused) {
        isPaused = true;
        btnPause.textContent = '▶';
      }
      updateProgress(resp.currentIndex + 1, resp.total);
      if (resp.results && resp.results.length > 0) {
        allResults = resp.results;
        renderResults();
      }
      if (resp.logs && resp.logs.length > 0) {
        for (const log of resp.logs) addLog(log);
      }
    }
  });

  // === ПАКЕТНЫЙ СБОР (XLSX) ===

  // Клик по зоне → открывает файловый диалог
  batchDrop.addEventListener('click', (e) => {
    // Не открывать файловый диалог при клике на чекбоксы, кнопки фильтра и прочие интерактивные элементы
    const isInteractiveBatchTarget =
      e.target.closest('.batch-filter') ||
      e.target.closest('.batch-history-wrap') ||
      e.target.closest('#batchWarning') ||
      e.target.closest('#batchFilename') ||
      e.target.closest('#batchInfo') ||
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'BUTTON' ||
      e.target.tagName === 'LABEL' ||
      e.target.tagName === 'A';
    if (isInteractiveBatchTarget) return;
    batchFileInput.click();
  });
  batchDrop.addEventListener('dragover', (e) => { e.preventDefault(); batchDrop.classList.add('dragover'); });
  batchDrop.addEventListener('dragleave', () => { batchDrop.classList.remove('dragover'); });
  batchDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    batchDrop.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleBatchFile(file);
  });
  batchFileInput.addEventListener('change', () => {
    const file = batchFileInput.files[0];
    if (file) handleBatchFile(file);
    batchFileInput.value = '';
  });

  let batchItems = []; // {sku, name, status}[] из последнего XLSX
  let batchSourceName = '';
  let batchUploadHistory = [];

  loadBatchUploadHistory();

  btnBatchHistory.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btnBatchHistory.disabled) return;
    renderBatchHistoryMenu();
    batchHistoryMenu.classList.toggle('hidden');
  });

  batchHistoryMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const itemBtn = e.target.closest('.batch-history-item');
    if (!itemBtn) return;
    const idx = Number(itemBtn.dataset.index);
    const entry = batchUploadHistory[idx];
    if (entry) applyBatchHistoryEntry(entry);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.batch-history-wrap')) {
      batchHistoryMenu.classList.add('hidden');
    }
  });

  function normalizeBatchSkus(list) {
    if (!Array.isArray(list)) return [];
    return list.map(s => String(s).trim()).filter(s => /^\d{3,}$/.test(s));
  }

  function normalizeBatchHistory(rawHistory) {
    if (!Array.isArray(rawHistory)) return [];
    return rawHistory.map((entry) => {
      const skus = normalizeBatchSkus(entry?.skus);
      if (skus.length === 0) return null;
      return {
        id: String(entry.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7))),
        sourceName: String(entry.sourceName || 'XLSX').slice(0, 120),
        createdAt: entry.createdAt || new Date().toISOString(),
        skus,
        appliedStatuses: Array.isArray(entry.appliedStatuses) ? entry.appliedStatuses.map(String).filter(Boolean).slice(0, 12) : [],
        totalCount: Number(entry.totalCount) || skus.length,
        appliedCount: Number(entry.appliedCount) || skus.length
      };
    }).filter(Boolean).slice(0, BATCH_HISTORY_LIMIT);
  }

  function loadBatchUploadHistory() {
    chrome.storage.local.get([BATCH_HISTORY_KEY], (data) => {
      batchUploadHistory = normalizeBatchHistory(data[BATCH_HISTORY_KEY]);
      renderBatchHistoryMenu();
    });
  }

  function formatBatchHistoryDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function formatBatchStatuses(statuses) {
    const list = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
    if (list.length === 0) return '';
    if (list.length <= 2) return list.join(', ');
    return `${list.slice(0, 2).join(', ')} +${list.length - 2}`;
  }

  function renderBatchHistoryMenu() {
    const hasHistory = batchUploadHistory.length > 0;
    btnBatchHistory.disabled = !hasHistory;
    btnBatchHistory.title = hasHistory ? 'Показать последние пакетные загрузки' : 'История появится после применения XLSX';

    if (!hasHistory) {
      batchHistoryMenu.innerHTML = '<div class="batch-history-empty">История пока пустая</div>';
      batchHistoryMenu.classList.add('hidden');
      return;
    }

    batchHistoryMenu.innerHTML = batchUploadHistory.map((entry, idx) => {
      const dateText = formatBatchHistoryDate(entry.createdAt);
      const statusesText = formatBatchStatuses(entry.appliedStatuses);
      const meta = `${entry.appliedCount || entry.skus.length} SKU${dateText ? ' · ' + dateText : ''}`;
      return `<button type="button" class="batch-history-item" data-index="${idx}">
        <div class="batch-history-name">${esc(entry.sourceName)}</div>
        <div class="batch-history-meta">${esc(meta)}</div>
        ${statusesText ? `<div class="batch-history-statuses">${esc(statusesText)}</div>` : ''}
      </button>`;
    }).join('');
  }

  function saveBatchUploadHistory({ sourceName, skus, appliedStatuses, totalCount }) {
    const cleanSkus = normalizeBatchSkus(skus);
    if (cleanSkus.length === 0) return;

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      sourceName: sourceName || 'XLSX',
      createdAt: new Date().toISOString(),
      skus: cleanSkus,
      appliedStatuses: Array.isArray(appliedStatuses) ? appliedStatuses.filter(Boolean) : [],
      totalCount: Number(totalCount) || cleanSkus.length,
      appliedCount: cleanSkus.length
    };
    const entrySkus = entry.skus.join('\n');
    const withoutDuplicate = batchUploadHistory.filter(item => {
      return !(item.sourceName === entry.sourceName && item.skus.join('\n') === entrySkus);
    });
    batchUploadHistory = [entry, ...withoutDuplicate].slice(0, BATCH_HISTORY_LIMIT);
    chrome.storage.local.set({ [BATCH_HISTORY_KEY]: batchUploadHistory }, () => {
      renderBatchHistoryMenu();
    });
  }

  function applyBatchHistoryEntry(entry) {
    const skus = normalizeBatchSkus(entry.skus);
    if (skus.length === 0) {
      addLog('История XLSX пуста или повреждена');
      return;
    }
    skuInput.value = skus.join('\n');
    batchFilename.textContent = entry.sourceName || 'XLSX из истории';
    batchFilename.classList.remove('hidden');
    batchInfo.textContent = `Из истории: ${skus.length} SKU`;
    batchInfo.classList.remove('hidden');

    const statusesText = formatBatchStatuses(entry.appliedStatuses);
    batchWarning.innerHTML = `✅ Загружено из истории: ${skus.length} SKU`;
    if (statusesText) batchWarning.innerHTML += `<br>Статусы: ${esc(statusesText)}`;
    batchWarning.classList.remove('hidden');
    batchHistoryMenu.classList.add('hidden');
    addLog(`Из истории XLSX импортировано ${skus.length} SKU — ${entry.sourceName || 'XLSX'}`);
  }

  async function handleBatchFile(file) {
    if (!file.name.match(/\.xlsx?$/i)) {
      addLog('Ошибка: нужен файл .xlsx');
      return;
    }

    batchSourceName = file.name;
    addLog(`Загружен: ${file.name}`);
    batchFilename.textContent = file.name;
    batchFilename.classList.remove('hidden');
    batchInfo.classList.add('hidden');
    batchWarning.classList.add('hidden');

    try {
      const items = await parseXlsxItems(file);
      if (items.length === 0) {
        addLog('В файле не найдены числовые SKU');
        batchInfo.textContent = 'SKU не найдены. Проверьте что это шаблон «Цены товаров» из OZON.';
        batchInfo.classList.remove('hidden');
        return;
      }

      batchItems = items;
      batchInfo.textContent = `Найдено ${items.length} товаров`;
      batchInfo.classList.remove('hidden');

      // Показываем фильтр по статусам
      renderBatchFilter(items);

    } catch (e) {
      addLog(`Ошибка парсинга XLSX: ${e.message}`);
      batchInfo.textContent = 'Ошибка чтения файла: ' + e.message;
      batchInfo.classList.remove('hidden');
    }
  }

  function renderBatchFilter(items) {
    // Собираем уникальные статусы
    const statusMap = {};
    for (const item of items) {
      const st = item.status || 'Без статуса';
      if (!statusMap[st]) statusMap[st] = [];
      statusMap[st].push(item);
    }
    const statuses = Object.keys(statusMap).sort();

    let html = '<div class="batch-filter">';
    html += '<div class="batch-filter-title">Фильтр по статусу:</div>';
    for (const st of statuses) {
      const count = statusMap[st].length;
      const id = 'batchSt_' + st.replace(/\s+/g, '_');
      const checked = (st === 'Продается') ? 'checked' : '';
      html += `<label class="batch-filter-item"><input type="checkbox" class="batch-status-cb" value="${esc(st)}" ${checked}> ${esc(st)} <span class="batch-filter-count">(${count})</span></label>`;
    }
    html += '<div class="batch-filter-actions">';
    html += '<button id="btnBatchSelectAll" class="btn btn-small">Все</button>';
    html += '<button id="btnBatchApply" class="btn btn-small btn-primary">Применить</button>';
    html += '</div></div>';

    batchWarning.innerHTML = html;
    batchWarning.classList.remove('hidden');

    // Обработчики
    document.getElementById('btnBatchSelectAll').addEventListener('click', () => {
      batchWarning.querySelectorAll('.batch-status-cb').forEach(cb => cb.checked = true);
    });
    document.getElementById('btnBatchApply').addEventListener('click', () => {
      const selected = new Set();
      batchWarning.querySelectorAll('.batch-status-cb:checked').forEach(cb => selected.add(cb.value));
      const filtered = batchItems.filter(item => selected.has(item.status || 'Без статуса'));
      if (filtered.length === 0) {
        addLog('Нет товаров с выбранными статусами');
        return;
      }
      skuInput.value = filtered.map(i => i.sku).join('\n');
      addLog(`Импортировано ${filtered.length} SKU (из ${batchItems.length}) — статусы: ${[...selected].join(', ')}`);
      batchWarning.innerHTML = `✅ Выбрано ${filtered.length} из ${batchItems.length} товаров`;
      if (filtered.length > 100) {
        batchWarning.innerHTML += `<br>⚠ Рекомендуем задержку 3-5 сек для ${filtered.length} SKU`;
      }
      saveBatchUploadHistory({
        sourceName: batchSourceName || 'XLSX',
        skus: filtered.map(i => i.sku),
        appliedStatuses: [...selected],
        totalCount: batchItems.length
      });
    });
  }

  // Парсинг XLSX с извлечением статуса
  async function parseXlsxItems(file) {
    const buf = await file.arrayBuffer();
    const entries = await parseZip(buf);
    const sharedStringsXml = entries['xl/sharedStrings.xml'];
    const sharedStrings = [];
    if (sharedStringsXml) {
      const ssText = new TextDecoder().decode(sharedStringsXml);
      const tMatches = ssText.matchAll(/<t[^>]*>([^<]*)<\/t>/g);
      for (const m of tMatches) sharedStrings.push(m[1]);
    }
    let sheetFile = 'xl/worksheets/sheet2.xml';
    const workbookXml = entries['xl/workbook.xml'];
    if (workbookXml) {
      const wbText = new TextDecoder().decode(workbookXml);
      const sheetMatches = [...wbText.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*sheetId="(\d+)"[^>]*r:id="([^"]*)"/g)];
      for (const sm of sheetMatches) {
        if (sm[1].includes('Товары') || sm[1].includes('цен') || sm[1].includes('price')) {
          const rIdMatch = sm[3].match(/\d+/);
          if (rIdMatch) sheetFile = `xl/worksheets/sheet${rIdMatch[0]}.xml`;
        }
      }
    }
    const sheetData = entries[sheetFile];
    if (!sheetData) {
      for (const key of Object.keys(entries)) {
        if (key.match(/xl\/worksheets\/sheet\d+\.xml/)) {
          const text = new TextDecoder().decode(entries[key]);
          if (text.includes('SKU') || text.includes('Товары')) {
            return extractRowsFromSheet(text, sharedStrings);
          }
        }
      }
      throw new Error('Лист с данными не найден');
    }
    return extractRowsFromSheet(new TextDecoder().decode(sheetData), sharedStrings);
  }

  // Минимальный XLSX парсер (ZIP → XML → значения колонки B)
  async function parseXlsxSkus(file) {
    const buf = await file.arrayBuffer();
    const entries = await parseZip(buf);

    // Найти sharedStrings.xml (для строковых значений)
    const sharedStringsXml = entries['xl/sharedStrings.xml'];
    const sharedStrings = [];
    if (sharedStringsXml) {
      const ssText = new TextDecoder().decode(sharedStringsXml);
      const tMatches = ssText.matchAll(/<t[^>]*>([^<]*)<\/t>/g);
      for (const m of tMatches) sharedStrings.push(m[1]);
    }

    // Найти лист "Товары и цены" — обычно sheet2.xml
    // Сначала проверяем workbook.xml для имён листов
    let sheetFile = 'xl/worksheets/sheet2.xml'; // по умолчанию
    const workbookXml = entries['xl/workbook.xml'];
    if (workbookXml) {
      const wbText = new TextDecoder().decode(workbookXml);
      const sheetMatches = [...wbText.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*sheetId="(\d+)"[^>]*r:id="([^"]*)"/g)];
      for (const sm of sheetMatches) {
        if (sm[1].includes('Товары') || sm[1].includes('цен') || sm[1].includes('price')) {
          // Определить номер листа из r:id (rId1 → sheet1, rId2 → sheet2...)
          const rIdMatch = sm[3].match(/\d+/);
          if (rIdMatch) {
            sheetFile = `xl/worksheets/sheet${rIdMatch[0]}.xml`;
          }
        }
      }
    }

    const sheetData = entries[sheetFile];
    if (!sheetData) {
      // Пробуем все листы
      for (const key of Object.keys(entries)) {
        if (key.match(/xl\/worksheets\/sheet\d+\.xml/)) {
          const data = entries[key];
          const text = new TextDecoder().decode(data);
          if (text.includes('SKU') || text.includes('Товары')) {
            return extractSkusFromSheet(text, sharedStrings);
          }
        }
      }
      throw new Error('Лист с данными не найден');
    }

    const sheetText = new TextDecoder().decode(sheetData);
    return extractSkusFromSheet(sheetText, sharedStrings);
  }

  // Извлекает строки с данными: {sku, name, status} из колонок B, C, D
  function extractRowsFromSheet(xml, sharedStrings) {
    const rows = {};
    // Парсим ячейки колонок A-Z
    const cellRegex = /<c\s+r="([A-Z]+)(\d+)"([^>]*)>(?:<f>[^<]*<\/f>)?<v>([^<]*)<\/v><\/c>/g;
    let match;
    while ((match = cellRegex.exec(xml)) !== null) {
      const col = match[1];
      const row = parseInt(match[2], 10);
      if (row < 4) continue;
      const attrs = match[3];
      let value = match[4];
      if (attrs.includes('t="s"')) {
        const idx = parseInt(value, 10);
        value = sharedStrings[idx] || value;
      }
      if (!rows[row]) rows[row] = {};
      rows[row][col] = value.trim();
    }
    const items = [];
    for (const [, cells] of Object.entries(rows)) {
      const sku = (cells['B'] || '').trim();
      if (!/^\d{3,}$/.test(sku)) continue;
      items.push({
        sku,
        name: (cells['C'] || '').substring(0, 80),
        status: cells['D'] || ''
      });
    }
    return items;
  }

  // Обратная совместимость — только SKU
  function extractSkusFromSheet(xml, sharedStrings) {
    return extractRowsFromSheet(xml, sharedStrings).map(r => r.sku);
  }

  // Минимальный ZIP-парсер для XLSX
  async function parseZip(buffer) {
    const view = new DataView(buffer);
    const entries = {};
    const bytes = new Uint8Array(buffer);

    // Находим End of Central Directory
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error('Не ZIP-файл');

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdCount = view.getUint16(eocdOffset + 10, true);

    let pos = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const uncompSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));

      // Читаем данные из Local File Header
      const lfhPos = localOffset;
      if (view.getUint32(lfhPos, true) === 0x04034b50) {
        const lfNameLen = view.getUint16(lfhPos + 26, true);
        const lfExtraLen = view.getUint16(lfhPos + 28, true);
        const dataStart = lfhPos + 30 + lfNameLen + lfExtraLen;
        const rawData = bytes.slice(dataStart, dataStart + compSize);

        if (method === 0) {
          // Stored (не сжато)
          entries[name] = rawData;
        } else if (method === 8) {
          // Deflate
          try {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            writer.write(rawData);
            writer.close();
            const chunks = [];
            let totalLen = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalLen += value.length;
            }
            const result = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.length;
            }
            entries[name] = result;
          } catch (e) {
            // Пропускаем файлы которые не удалось распаковать
          }
        }
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }

  // ====================================================================
  // === Проверка обновлений расширения =================================
  // ====================================================================
  // Запрашивает с codefic.ru последнюю версию + ссылку на скачивание.
  // Кэш в storage на 6 часов. Если latest > current — подсвечивает версию и
  // показывает баннер «Доступна новая версия» со ссылкой.
  // Пользователь может скрыть баннер (запоминается в storage до следующего
  // обновления с сервера, где latest изменится).
  (function versionCheck() {
    const VERSION_API = 'https://codefic.ru/api/extension-version';
    // Страница установки/скачивания на сайте — единая точка входа для пользователя.
    // Используется как fallback если сервер не прислал download_url ИЛИ прислал битую ссылку
    // (например прямой .zip который 404-ит). На #install — инструкция + актуальная кнопка скачивания.
    const INSTALL_PAGE = 'https://codefic.ru/#install';
    const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 часов
    const versionBadge = document.getElementById('versionBadge');
    const updateBanner = document.getElementById('updateBanner');
    const updateLatestVersion = document.getElementById('updateLatestVersion');
    const updateDownloadLink = document.getElementById('updateDownloadLink');
    const updateBannerClose = document.getElementById('updateBannerClose');

    if (!versionBadge || !updateBanner) return;

    const currentVersion = chrome.runtime.getManifest().version;
    versionBadge.textContent = 'v' + currentVersion;

    // Определяет безопасный URL для открытия: если сервер вернул прямой .zip (часто 404-ит)
    // или пустое значение — используем install-страницу. Принимаем только http(s) URL.
    function resolveDownloadUrl(url) {
      if (!url || typeof url !== 'string') return INSTALL_PAGE;
      const trimmed = url.trim();
      if (!/^https?:\/\//i.test(trimmed)) return INSTALL_PAGE;
      if (/\.zip(\?|#|$)/i.test(trimmed)) return INSTALL_PAGE;
      return trimmed;
    }

    // Сравнение семвер-строк "5.9.7" vs "5.9.6"
    function isNewer(latest, current) {
      const a = String(latest || '').split('.').map(n => parseInt(n, 10) || 0);
      const b = String(current || '').split('.').map(n => parseInt(n, 10) || 0);
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        const av = a[i] || 0, bv = b[i] || 0;
        if (av > bv) return true;
        if (av < bv) return false;
      }
      return false;
    }

    function showUpdate(latest, downloadUrl, dismissedVersion) {
      const safeUrl = resolveDownloadUrl(downloadUrl);
      versionBadge.classList.add('has-update');
      versionBadge.title = `Доступна версия ${latest} — скачать`;
      // Клик на бейдж версии открывает install-страницу (инструкция + скачивание)
      versionBadge.style.cursor = 'pointer';
      versionBadge.onclick = () => { window.open(safeUrl, '_blank'); };
      // Баннер показываем только если юзер ещё не скрыл именно ЭТУ версию
      if (dismissedVersion !== latest) {
        updateLatestVersion.textContent = 'v' + latest;
        updateDownloadLink.href = safeUrl;
        updateBanner.classList.remove('hidden');
      }
    }

    async function fetchLatestVersion() {
      try {
        const resp = await fetch(VERSION_API, { method: 'GET', cache: 'no-cache' });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data || !data.version) return null;
        return {
          version: String(data.version).trim(),
          downloadUrl: data.download_url || data.downloadUrl || null,
          releaseNotes: data.release_notes || data.releaseNotes || null,
          checkedAt: Date.now()
        };
      } catch (e) { return null; }
    }

    async function check() {
      const stored = await new Promise(resolve =>
        chrome.storage.local.get(['extensionVersionCache', 'dismissedUpdateVersion'], resolve)
      );
      const dismissed = stored.dismissedUpdateVersion || null;
      const cache = stored.extensionVersionCache;

      let latestInfo = cache;
      // Используем кэш если он свежий
      if (!cache || !cache.checkedAt || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) {
        const fresh = await fetchLatestVersion();
        if (fresh) {
          latestInfo = fresh;
          chrome.storage.local.set({ extensionVersionCache: fresh });
        }
      }

      if (latestInfo && latestInfo.version && isNewer(latestInfo.version, currentVersion)) {
        showUpdate(latestInfo.version, latestInfo.downloadUrl, dismissed);
      }
    }

    updateBannerClose.addEventListener('click', () => {
      updateBanner.classList.add('hidden');
      // Запоминаем что юзер скрыл баннер для текущей latest-версии.
      // Когда сервер отдаст новую — баннер снова покажется.
      chrome.storage.local.get(['extensionVersionCache'], (data) => {
        const v = data.extensionVersionCache?.version;
        if (v) chrome.storage.local.set({ dismissedUpdateVersion: v });
      });
    });

    check();
  })();

})();
