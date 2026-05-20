// OZGuard Support Automation v5.9.38
// ISOLATED world — прямая коммуникация через chrome.runtime.onMessage
// Поиск элементов по ТЕКСТУ и атрибутам DOM, не по CSS-классам
// Quick-reply кнопки чата: div/span с cursor:pointer внутри контейнера сообщений
// Кнопка отправки определяется по SVG path (arrow vs paperclip)
// Фаза чата определяется по последним сообщениям бота + наличию ответа пользователя

(function() {
  'use strict';
  const OZG_SUPPORT_VERSION = '5.9.38';

  if (document.getElementById('__ozguard-support-guard')) return;
  const guard = document.createElement('div');
  guard.id = '__ozguard-support-guard';
  guard.style.display = 'none';
  document.body.appendChild(guard);

  // === УТИЛИТЫ ===

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
  }

  function getOwnText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
  }

  // Правая половина viewport = область разговора
  function isInChatArea(el) {
    const rect = el.getBoundingClientRect();
    return rect.left > window.innerWidth * 0.3 && rect.top > 50;
  }

  // === ЧТЕНИЕ ИСТОРИИ ЧАТА ===
  // Использует атрибут is-mine для определения отправителя:
  //   is-mine="" — сообщение бота
  //   is-mine="mine" — сообщение пользователя

  // Извлечь текст сообщения без кнопок быстрых ответов и таймстемпов
  // ВАЖНО: не стриппить текст из крупных контейнеров с cursor:pointer — только из мелких кнопок
  function getMessageText(div) {
    let fullText = div.textContent || '';
    // Собираем тексты ТОЛЬКО мелких кнопок быстрого ответа (quick-reply)
    // Критерии: cursor:pointer + маленький размер + не содержит вложенных блоков
    const strippedTexts = new Set();
    div.querySelectorAll('*').forEach(el => {
      try {
        if (el === div) return;
        const style = getComputedStyle(el);
        if (style.cursor !== 'pointer') return;
        // Размер элемента: кнопки быстрого ответа обычно компактные (высота < 50px)
        const rect = el.getBoundingClientRect();
        if (rect.height > 50 || rect.width > 500) return; // это контейнер, не кнопка
        // Кнопки не содержат вложенных блочных элементов (p, div с текстом)
        const hasBlockChildren = el.querySelector('p, div, ul, ol, li, h1, h2, h3, h4');
        if (hasBlockChildren) return;
        const btnText = el.textContent.trim();
        if (btnText.length < 2 || btnText.length > 80) return;
        // Не стриппить текст, который является частью более крупного сообщения
        // Кнопки обычно содержат короткие фразы типа "Назад", "Пожаловаться"
        if (btnText.split(/\s+/).length > 8) return; // слишком длинный для кнопки
        strippedTexts.add(btnText);
      } catch (_) {}
    });
    for (const t of strippedTexts) {
      fullText = fullText.replace(t, '');
    }
    // Убираем таймстемпы (22:18, 21:00 и т.д.)
    fullText = fullText.replace(/\b\d{1,2}:\d{2}\b/g, '');
    return fullText.trim();
  }

  function readChatHistory() {
    const messages = [];
    const allMsgDivs = document.querySelectorAll('[is-mine]');
    for (const div of allMsgDivs) {
      if (!isInChatArea(div)) continue;
      const isMine = div.getAttribute('is-mine') === 'mine';
      const text = getMessageText(div);

      // Расширенная детекция файла в сообщении:
      // - оригинальные SVG-селекторы для скрепки и превью
      // - ссылки/линки на файлы (a[download], a[href*="cdn"], a[href*=".pdf"], и т.д.)
      // - размер в КБ/МБ в тексте сообщения (напр. «бренд.pdf 809 Кб»)
      const hasFileIcon = div.querySelector('svg path[d^="M4 12.006"]') !== null;
      const hasFilePreviewClass = div.querySelector('[class*="om_15"]') !== null;
      const hasFileLink = div.querySelector('a[download], a[href*="cdn"], a[href*=".pdf"], a[href*=".jpg"], a[href*=".jpeg"], a[href*=".png"], a[href*=".mp4"], a[href*=".mov"], a[href*=".webm"], a[href*=".docx"], a[href*=".doc"]') !== null;
      const hasFileSize = /\b\d{1,5}[.,]?\d{0,2}\s*(кб|мб|kb|mb)\b/i.test(text);
      const isFile = hasFileIcon || hasFilePreviewClass || hasFileLink || hasFileSize;

      // Файл-сообщения часто имеют короткий текст (только имя + размер) — не отбрасываем
      if (!isFile && text.length < 3) continue;

      messages.push({
        isMine,
        text: text.substring(0, 500),
        isFile,
        el: div
      });
    }
    return messages;
  }

  // Получить последнее сообщение бота, последние сообщения бота и последнее сообщение пользователя
  function getLastMessages() {
    const history = readChatHistory();
    let lastBot = null;
    let lastUser = null;
    let lastOverall = null;
    const recentBotMessages = [];

    for (let i = history.length - 1; i >= 0; i--) {
      if (!lastOverall) lastOverall = history[i];
      if (!history[i].isMine) {
        if (!lastBot) lastBot = history[i];
        if (recentBotMessages.length < 5) recentBotMessages.push(history[i]);
      }
      if (history[i].isMine && !lastUser) lastUser = history[i];
      if (lastBot && lastUser && recentBotMessages.length >= 5) break;
    }

    return { lastBot, lastUser, lastOverall, recentBotMessages, total: history.length };
  }

  // === КЛИК ПО REACT-ЭЛЕМЕНТАМ ===

  async function simulateRealClick(element) {
    if (!element || !isVisible(element)) return false;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(300 + Math.random() * 300);

    const rect = element.getBoundingClientRect();
    // Случайная точка внутри элемента (не точно в центре — как человек)
    const offsetX = rect.width * (0.3 + Math.random() * 0.4);
    const offsetY = rect.height * (0.3 + Math.random() * 0.4);
    const x = rect.left + offsetX;
    const y = rect.top + offsetY;
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: 1
    };

    // Имитация: mousemove к элементу (2-4 промежуточных точки)
    const moveSteps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < moveSteps; i++) {
      const mx = x - (moveSteps - i) * (10 + Math.random() * 30) * (Math.random() > 0.5 ? 1 : -1);
      const my = y - (moveSteps - i) * (5 + Math.random() * 15);
      document.elementFromPoint(mx, my)?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: mx, clientY: my, view: window
      }));
      await sleep(30 + Math.random() * 50);
    }

    element.focus();
    await sleep(50 + Math.random() * 100);

    element.dispatchEvent(new PointerEvent('pointerover', opts));
    element.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    await sleep(30 + Math.random() * 40);
    element.dispatchEvent(new PointerEvent('pointerdown', opts));
    await sleep(60 + Math.random() * 80);
    element.dispatchEvent(new PointerEvent('pointerup', opts));

    element.dispatchEvent(new MouseEvent('mouseover', opts));
    element.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    element.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(30 + Math.random() * 50);
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    element.dispatchEvent(new MouseEvent('click', opts));

    // Не дублируем .click() — React 17+ обрабатывает dispatchEvent('click') выше
    // Двойной click вызывал двойную отправку артикулов и файлов
    return true;
  }

  // === ВВОД ТЕКСТА ===

  async function setInputValue(element, value) {
    if (!element) return false;
    element.focus();
    await sleep(100 + Math.random() * 200);

    if (element.getAttribute('contenteditable') === 'true') {
      element.textContent = '';
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(50);
      const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  // === ПОИСК ЭЛЕМЕНТОВ ===

  // Найти контейнер сообщений чата (scrollable parent элементов [is-mine])
  function findChatContainer() {
    const firstMsg = document.querySelector('[is-mine]');
    if (!firstMsg) return null;
    let el = firstMsg.parentElement;
    for (let i = 0; i < 10 && el; i++) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return el;
      el = el.parentElement;
    }
    // Fallback: parent of all [is-mine] elements
    return firstMsg.parentElement;
  }

  // Найти quick-reply кнопки чата — div/span с cursor:pointer ВНУТРИ контейнера чата
  // OZON использует НЕ стандартные <button>, а div/span с cursor:pointer для кнопок быстрого ответа
  function findChatQuickReplies() {
    const results = [];
    const chatContainer = findChatContainer();
    if (!chatContainer) return results;

    // Стратегия 1: Ищем все div/span с cursor:pointer внутри контейнера чата
    const candidates = chatContainer.querySelectorAll('div, span');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (!isInChatArea(el)) continue;

      // Пропускаем элементы внутри ПОЛЬЗОВАТЕЛЬСКИХ сообщений (is-mine="mine")
      // НО оставляем элементы внутри сообщений БОТА (is-mine="") — там живут quick-reply кнопки!
      const mineParent = el.closest('[is-mine]');
      if (mineParent && mineParent.getAttribute('is-mine') === 'mine') continue;

      const style = getComputedStyle(el);
      if (style.cursor !== 'pointer') continue;

      const text = el.textContent.trim();
      if (text.length < 2 || text.length > 100) continue;

      // Собственный текст должен быть осмысленным (не пустой контейнер)
      const ownText = getOwnText(el);

      // Проверяем размеры — кнопки могут быть широкими (длинный текст) до 600px
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.width > 700) continue;
      if (rect.height < 14 || rect.height > 80) continue;

      // Исключаем вложенные элементы — берём только самый внешний кликабельный
      let hasClickableParent = false;
      let parent = el.parentElement;
      for (let i = 0; i < 3 && parent && parent !== chatContainer; i++) {
        if (getComputedStyle(parent).cursor === 'pointer' && parent.textContent.trim() === text) {
          hasClickableParent = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (hasClickableParent) continue;

      results.push({ el, text, ownText: ownText || text });
    }

    // Стратегия 2: Ищем cursor:pointer элементы ВНУТРИ последнего бот-сообщения и рядом с ним
    if (results.length === 0) {
      const allMsgDivs = chatContainer.querySelectorAll('[is-mine]');
      const lastBotMsg = Array.from(allMsgDivs).reverse().find(d => d.getAttribute('is-mine') !== 'mine');
      if (lastBotMsg) {
        const checked = new Set();
        // Сначала внутри бот-сообщения
        const searchIn = [lastBotMsg];
        // Потом siblings
        let sibling = lastBotMsg.nextElementSibling;
        while (sibling) { searchIn.push(sibling); sibling = sibling.nextElementSibling; }

        for (const container of searchIn) {
          for (const el of container.querySelectorAll('*')) {
            if (checked.has(el)) continue;
            checked.add(el);
            if (!isVisible(el)) continue;
            const cs = getComputedStyle(el);
            if (cs.cursor !== 'pointer') continue;
            const text = el.textContent.trim();
            if (text.length < 2 || text.length > 100) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 20 || rect.width > 700 || rect.height < 14 || rect.height > 80) continue;
            // Дедупликация вложенных
            let skip = false;
            let p = el.parentElement;
            for (let j = 0; j < 3 && p && p !== container; j++) {
              if (getComputedStyle(p).cursor === 'pointer' && p.textContent.trim() === text) { skip = true; break; }
              p = p.parentElement;
            }
            if (skip) continue;
            results.push({ el, text, ownText: getOwnText(el) || text });
          }
        }
      }
    }

    // Дедупликация по тексту (оставляем первый)
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.text)) return false;
      seen.add(r.text);
      return true;
    });
  }

  // Стандартные кнопки (button, role=button, a)
  function findAllStandardButtons() {
    const results = [];
    for (const el of document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a[href]')) {
      if (!isVisible(el)) continue;
      const text = el.textContent.trim();
      if (text.length === 0 || text.length > 200) continue;
      results.push({ el, text, ownText: getOwnText(el) });
    }
    return results;
  }

  // Все кликабельные элементы: стандартные кнопки + quick-reply чата
  function findAllClickableWithText() {
    const standard = findAllStandardButtons();
    const chatReplies = findChatQuickReplies();

    // Мержим, дедупликация по элементу
    const seen = new Set(standard.map(s => s.el));
    const merged = [...standard];
    for (const cr of chatReplies) {
      if (!seen.has(cr.el)) {
        merged.push(cr);
        seen.add(cr.el);
      }
    }
    return merged;
  }

  function findButtonByText(patterns, excludePatterns) {
    const all = findAllClickableWithText();
    let bestMatch = null;
    let bestScore = 0;

    for (const item of all) {
      const lower = item.text.toLowerCase();
      if (excludePatterns) {
        let excluded = false;
        for (const ex of excludePatterns) {
          if (lower.includes(ex.toLowerCase())) { excluded = true; break; }
        }
        if (excluded) continue;
      }

      let score = 0;
      for (const p of patterns) {
        if (lower.includes(p.toLowerCase())) score += 5;
        if (item.ownText.toLowerCase().includes(p.toLowerCase())) score += 3;
      }
      if (item.el.tagName === 'BUTTON') score += 1;
      if (item.el.children.length === 0) score += 1;
      if (item.el.closest('header, nav')) score -= 10;
      if (score > bestScore) { bestScore = score; bestMatch = item; }
    }
    return bestMatch;
  }

  // Quick-reply кнопки В ОБЛАСТИ РАЗГОВОРА с оценкой релевантности
  function findQuickReplyButtons() {
    // Приоритет: кнопки из чата (div/span cursor:pointer)
    const chatReplies = findChatQuickReplies();
    const results = [];

    // Скоринг для chat quick-replies
    for (const item of chatReplies) {
      const lower = item.text.toLowerCase();
      let score = 5; // базовый бонус за нахождение внутри чата
      if (lower.includes('личный кабинет')) score += 10;
      if (lower.includes('кабинет бренда')) score += 10;
      if (lower.includes('жалоба')) score += 10;
      if (lower.includes('плагиат')) score += 10;
      if (lower.includes('использование моих')) score += 10;
      if (lower.includes('нарушение')) score += 8;
      if (lower.includes('качество')) score += 8;
      if (lower.includes('контроль')) score += 6;
      if (lower.includes('пожаловаться')) score += 10;
      if (lower.includes('отменить обращение')) score += 10;
      if (lower.includes('копирование')) score += 8;
      if (lower.includes('товар')) score += 3;
      if (lower.includes('главное меню')) score += 5;
      if (lower.includes('назад')) score += 2;
      if (lower.includes('помощь')) score += 1;
      if (lower.includes('новое обращение')) score += 8;
      if (lower.includes('подробнее')) score -= 3;
      results.push({ ...item, score });
    }

    // Fallback: стандартные кнопки в области чата (если chat quick replies пусты)
    if (results.length === 0) {
      for (const item of findAllStandardButtons()) {
        if (!isInChatArea(item.el)) continue;
        if (item.el.closest('header, nav')) continue;
        const lower = item.text.toLowerCase();
        let score = 0;
        if (lower.includes('личный кабинет')) score += 10;
        if (lower.includes('кабинет бренда')) score += 10;
        if (lower.includes('жалоба')) score += 10;
        if (lower.includes('плагиат')) score += 10;
        if (lower.includes('использование моих')) score += 10;
        if (lower.includes('нарушение')) score += 8;
        if (lower.includes('пожаловаться')) score += 10;
        if (lower.includes('копирование')) score += 8;
        if (lower.includes('товар')) score += 3;
        if (lower.includes('новое обращение')) score += 8;
        results.push({ ...item, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // Textarea / contenteditable В ОБЛАСТИ РАЗГОВОРА
  function findChatInput() {
    for (const ta of document.querySelectorAll('textarea')) {
      if (isVisible(ta) && isInChatArea(ta)) return ta;
    }
    for (const ed of document.querySelectorAll('[contenteditable="true"]')) {
      if (isVisible(ed) && isInChatArea(ed)) return ed;
    }
    return null;
  }

  // === КНОПКА ОТПРАВКИ — по SVG path ===
  // Send button SVG path начинается с "M5.086" (стрелка отправки)
  // Attach button SVG path начинается с "M11.055" (скрепка)
  function findSendButton() {
    // Стратегия 1: найти кнопку с SVG path стрелки отправки
    for (const btn of document.querySelectorAll('button')) {
      if (!isVisible(btn)) continue;
      const paths = btn.querySelectorAll('svg path');
      for (const p of paths) {
        const d = p.getAttribute('d') || '';
        if (d.startsWith('M5.086')) return btn; // Send arrow
      }
    }

    // Стратегия 2: найти ПОСЛЕДНЮЮ кнопку с SVG в контейнере textarea
    const textarea = findChatInput();
    if (textarea) {
      let container = textarea.parentElement;
      for (let i = 0; i < 7 && container; i++) {
        const btns = Array.from(container.querySelectorAll('button')).filter(b => isVisible(b) && b.querySelector('svg'));
        if (btns.length >= 2) {
          // Последняя SVG-кнопка = отправка, первая = прикрепление
          return btns[btns.length - 1];
        }
        container = container.parentElement;
      }
    }

    // Стратегия 3: кнопка с SVG справа внизу
    for (const btn of document.querySelectorAll('button')) {
      if (!isVisible(btn)) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.7 && rect.top > window.innerHeight * 0.7) {
        if (btn.querySelector('svg') && btn.textContent.trim().length === 0) return btn;
      }
    }

    return null;
  }

  // input[type=file] для прикрепления
  function findFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const chatInput = findChatInput();

    if (chatInput) {
      let container = chatInput.parentElement;
      for (let i = 0; i < 8 && container; i++) {
        const scoped = container.querySelector('input[type="file"]');
        if (scoped) return scoped;
        container = container.parentElement;
      }
    }

    const chatContainer = findChatContainer();
    if (chatContainer) {
      for (const fi of inputs) {
        if (chatContainer.contains(fi) || isInChatArea(fi)) return fi;
      }
    }

    if (inputs.length === 1) return inputs[0];
    return null;
  }

  // === ОПРЕДЕЛЕНИЕ ФАЗЫ ЧАТА ===
  // Основано на ПОСЛЕДНЕМ сообщении бота + наличии ответа пользователя

  // Обнаружить всплывающий tippy-виджет «Помощь и обучение» (после «Новое обращение»)
  // Это tippy-popup (position:fixed, z-index:8999) с iframe seller-edu.ozon.ru
  // Внизу виджета — кнопка «Не нашли ответ на свой вопрос?» которая открывает реальный чат
  function detectFaqPage() {
    // Стратегия 1: Ищем кнопку «Не нашли ответ на свой вопрос?» — может быть внутри tippy-popup или на странице
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!isVisible(el)) continue;
      const text = el.textContent.trim();
      if (text.toLowerCase().includes('не нашли ответ') && text.length < 80) {
        return { type: 'not_found_answer', el, text };
      }
    }

    // Стратегия 2: tippy-popup с текстом «Помощь и обучение»
    const tippyBoxes = document.querySelectorAll('.tippy-box, [data-tippy-root]');
    for (const tippy of tippyBoxes) {
      if (!isVisible(tippy)) continue;
      const tippyText = tippy.textContent || '';
      if (tippyText.includes('Помощь и обучение') || tippyText.includes('Популярные статьи')) {
        // Ищем кнопку внутри tippy
        for (const btn of tippy.querySelectorAll('button')) {
          if (!isVisible(btn)) continue;
          const btnText = btn.textContent.trim();
          if (btnText.toLowerCase().includes('не нашли ответ')) {
            return { type: 'not_found_answer', el: btn, text: btnText };
          }
        }
        // Кнопка «Чаты» (тег вверху виджета)
        for (const el of tippy.querySelectorAll('div, span')) {
          if (!isVisible(el)) continue;
          const t = el.textContent.trim();
          if (t === 'Чаты' && getComputedStyle(el).cursor === 'pointer') {
            return { type: 'chats_tag', el, text: 'Чаты' };
          }
        }
        return { type: 'faq_no_button', el: null, text: 'Tippy-виджет FAQ без кнопки' };
      }
    }

    // Стратегия 3: проверяем текст страницы (может быть full-page FAQ)
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('Помощь и обучение') || bodyText.includes('Популярные статьи') || bodyText.includes('Задайте вопрос')) {
      // Ищем любой кликабельный «Не нашли ответ» на странице
      for (const el of document.querySelectorAll('div, span, a, p')) {
        if (!isVisible(el)) continue;
        const text = el.textContent.trim().toLowerCase();
        if (text.includes('не нашли ответ') && text.length < 80) {
          let clickable = el;
          if (getComputedStyle(el).cursor !== 'pointer') {
            let parent = el.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
              if (getComputedStyle(parent).cursor === 'pointer') { clickable = parent; break; }
              parent = parent.parentElement;
            }
          }
          return { type: 'not_found_answer', el: clickable, text: el.textContent.trim() };
        }
      }

      // Плавающая иконка чата (круглая кнопка внизу справа)
      for (const el of document.querySelectorAll('button, div[role="button"], div')) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 80 && rect.height < 80 && rect.bottom > window.innerHeight - 120 && rect.right > window.innerWidth - 120) {
          const style = getComputedStyle(el);
          if (style.cursor === 'pointer' && (style.borderRadius.includes('50%') || parseInt(style.borderRadius) > 15)) {
            return { type: 'chat_icon', el, text: 'Иконка чата' };
          }
        }
      }

      return { type: 'faq_no_button', el: null, text: 'FAQ-страница без кнопки перехода' };
    }

    // Стратегия 4: Плавающая кнопка «Помощь» (триггер tippy-виджета FAQ)
    // Это <button> с SVG-иконкой чата и текстом «Помощь», position:fixed внизу справа
    // Нужно кликнуть чтобы открыть tippy → затем кликнуть «Не нашли ответ»
    for (const btn of document.querySelectorAll('button')) {
      if (!isVisible(btn)) continue;
      const text = btn.textContent.trim();
      if ((text === 'Помощь' || (text.includes('Помощь') && !text.includes('обучение') && text.length < 20)) && btn.querySelector('svg')) {
        return { type: 'help_trigger', el: btn, text };
      }
    }

    // Проверяем URL — если мы на странице мессенджера, значит нужна кнопка Помощь
    if (window.location.href.includes('/app/messenger')) {
      return { type: 'messenger_no_chat', el: null, text: 'Мессенджер без открытого чата' };
    }

    return null;
  }

  function detectPhase() {
    const chatContainer = findChatContainer();
    const { lastBot, lastUser, lastOverall, recentBotMessages, total } = getLastMessages();
    const qrButtons = findQuickReplyButtons();
    const btnTexts = qrButtons.map(b => b.text.toLowerCase());
    const hasInput = !!findChatInput();

    function detectNavigationButtonPhase() {
      // complaint_detail: финальный экран выбора сути нарушения.
      //   legacy: «Использование моих фото, видео, текста» / «Копирование описания»
      //   beta:   «Использование моих фото, видео, текста» + «Использование моего бренда»
      if (btnTexts.some(t => t.includes('использование моих') || t.includes('использование моего бренда') || t.includes('копирование описания'))) {
        return { phase: 'complaint_detail', buttons: btnTexts, hasInput };
      }

      // complaint_subtype: подтип для legacy (только «Плагиат»)
      if (btnTexts.some(t => t.includes('плагиат') || t.includes('нарушение интеллект'))) {
        return { phase: 'complaint_subtype', buttons: btnTexts, hasInput };
      }

      // complaint_type: тип жалобы.
      //   legacy: «Жалоба на товар/продавца»
      //   beta:   «Нарушение правил площадки другим продавцом» (первая кнопка в списке из 9)
      // Признак beta: наличие «скрытие товаров» или «документы качества» в том же меню.
      const isBetaTypeMenu = btnTexts.some(t => t.includes('скрытие товаров') || t.includes('документы качества и сертификаты') || t.includes('документы на бренд') || t.includes('бейдж'));
      if (btnTexts.some(t => t.includes('жалоба на товар') || t.includes('жалоба на продавца')) ||
          (isBetaTypeMenu && btnTexts.some(t => t.includes('нарушение правил площадки')))) {
        return { phase: 'complaint_type', buttons: btnTexts, hasInput };
      }

      // category_selection:
      //   legacy: «Кабинет бренда» / «Качество»
      //   beta:   «Контроль качества» + «Карточка товара» / «Управление ценами»
      if (btnTexts.some(t => t.includes('кабинет бренда') || t.includes('контроль качества') ||
                             (t === 'качество'))) {
        return { phase: 'category_selection', buttons: btnTexts, hasInput };
      }

      // direction_selection:
      //   legacy: «Личный кабинет»
      //   beta:   «Товары и Цены» (и остальные FBS/FBO/Возвраты)
      if (btnTexts.some(t => t.includes('личный кабинет') || t.includes('товары и цены'))) {
        return { phase: 'direction_selection', buttons: btnTexts, hasInput };
      }

      return null;
    }

    // Нет контейнера чата и нет сообщений — чат не открыт
    // ВАЖНО: проверяем chatContainer, а не только qrButtons,
    // т.к. fallback findQuickReplyButtons ловит nav-табы (Аналитика, Покупатели...)
    if (!chatContainer && total === 0) {
      const faq = detectFaqPage();
      if (faq) {
        return { phase: 'faq_page', buttons: btnTexts, hasInput: false, faqType: faq.type, faqText: faq.text };
      }
      return { phase: 'no_chat', buttons: btnTexts, hasInput: false };
    }

    // Дополнительная проверка: есть контейнер но пуст + нет input
    if (total === 0 && qrButtons.length === 0 && !hasInput) {
      const faq = detectFaqPage();
      if (faq) {
        return { phase: 'faq_page', buttons: btnTexts, hasInput: false, faqType: faq.type, faqText: faq.text };
      }
      return { phase: 'no_chat', buttons: btnTexts, hasInput: false };
    }

    // Кнопка «Пожаловаться на другой товар» — цикл готов
    if (btnTexts.some(t => t.includes('пожаловаться на другой'))) {
      return { phase: 'ready_for_next', buttons: btnTexts, hasInput };
    }

    const botText = lastBot ? lastBot.text.toLowerCase() : '';
    const recentBotText = (recentBotMessages || []).map(m => (m.text || '').toLowerCase()).join('\n');
    const lastBotAfterLastUser = !!(lastBot && lastUser &&
      (lastUser.el.compareDocumentPosition(lastBot.el) & Node.DOCUMENT_POSITION_FOLLOWING));

    // Ozon иногда оставляет последним распознанным сообщением пользовательский клик,
    // хотя следом уже отрисовал меню quick-reply. В таком состоянии нельзя уходить
    // в in_progress: нужно продолжать навигацию по кнопкам.
    const freshNavigationPhase = detectNavigationButtonPhase();
    if (freshNavigationPhase && (!lastOverall || !lastOverall.isMine || lastBotAfterLastUser)) {
      return freshNavigationPhase;
    }

    // Последнее сообщение от пользователя (бот ещё не ответил) → ждём ответ
    if (lastOverall && lastOverall.isMine) {
      // Если это файл — ждём результат проверки
      if (lastOverall.isFile) {
        return { phase: 'in_progress', buttons: btnTexts, hasInput, detail: 'file_sent_waiting' };
      }
      // Если это текст (артикул) — ждём запрос файла или результат
      return { phase: 'in_progress', buttons: btnTexts, hasInput, detail: 'article_sent_waiting' };
    }

    // Последнее от бота: чат эскалирован (передан оператору / требуется новое обращение)
    // Маркеры: «направил ваше обращение коллегам», «создайте новое обращение»,
    //          «нажмите Отменить обращение», или кнопка «Отменить обращение» доступна
    const hasCancelButton = btnTexts.some(t => t.includes('отменить обращение'));
    if (hasCancelButton ||
        botText.includes('направил ваше обращение') ||
        botText.includes('направили ваше обращение') ||
        botText.includes('создайте новое обращение') ||
        botText.includes('нажмите "отменить обращение"') ||
        botText.includes('нажмите «отменить обращение»') ||
        botText.includes('если помощь оператора не требуется')) {
      return { phase: 'chat_escalated', buttons: btnTexts, hasInput, hasCancelButton };
    }

    // Ozon проверил жалобу, но не нашёл нарушений. Часто после этого отдельным
    // сообщением приходит «Спасибо за обращение!», поэтому проверяем несколько
    // последних сообщений бота, а не только последнее.
    if (recentBotText.includes('не нашли наруш') ||
        recentBotText.includes('нарушений не нашли') ||
        recentBotText.includes('скрывать товар не будем') ||
        recentBotText.includes('не подтвердили нарушение')) {
      return { phase: 'no_violation', buttons: btnTexts, hasInput };
    }

    // Последнее от бота: «Скрыли товар»
    if (botText.includes('скрыли товар') || botText.includes('нарушение подтвердилось')) {
      return { phase: 'item_completed', buttons: btnTexts, hasInput };
    }

    // v5.9.20: бот запросил ДОПОЛНИТЕЛЬНЫЕ доказательства (после первой попытки)
    // Маркеры: «доказательств недостаточно», «приложить новые доказательства»,
    //          «авторские права не подтверждены», «доказательства, которые позволят»
    if (botText.includes('доказательств недостаточно') ||
        botText.includes('предоставленных доказательств недостаточно') ||
        botText.includes('недостаточно для подтверждения ваших авторских прав') ||
        botText.includes('приложить новые доказательства') ||
        botText.includes('авторские права не подтверждены') ||
        botText.includes('авторские права не подтвержд') ||
        (botText.includes('доказательства') && botText.includes('подтвердить') && botText.includes('авторск'))) {
      return { phase: 'waiting_attachment', buttons: btnTexts, hasInput, detail: 'evidence_insufficient' };
    }

    // Последнее от бота: запрос документов (первичный)
    if (botText.includes('пришлите в чат документ') || botText.includes('документы о том') ||
        botText.includes('правообладател') || botText.includes('доказательств')) {
      return { phase: 'waiting_attachment', buttons: btnTexts, hasInput };
    }

    // v5.9.32: Ozon отказал по нашему parent SKU («Не нашли товар с SKU X в вашем магазине»).
    // Должно проверяться ДО waiting_article/waiting_parent_article, т.к. сообщение тоже
    // содержит «отправьте его снова», но это РЕАКЦИЯ Ozon, не первичный запрос.
    if ((botText.includes('не нашли товар') && botText.includes('в вашем магазине')) ||
        (botText.includes('не нашли товар с') && botText.includes('проверьте значение')) ||
        (botText.includes('не нашли sku') && botText.includes('магазине'))) {
      return { phase: 'waiting_parent_article', buttons: btnTexts, hasInput, detail: 'not_found' };
    }

    // v5.9.32: НОВЫЙ этап Ozon — бот сначала просит ВАШ (parent) SKU, чью карточку
    // использовал нарушитель. Маркеры: «вашего товара» + «карточку использовал»/«карточке товара»,
    // или прямо «пришлите sku вашего». Должно проверяться ДО waiting_article, потому что
    // сообщение тоже содержит «пришлите только одно скопированное значение».
    if (botText.includes('пришлите sku вашего') ||
        (botText.includes('вашего товара') && (
          botText.includes('карточку использовал') ||
          botText.includes('карточке товара') ||
          botText.includes('другой продавец') ||
          botText.includes('копируйте его из поля')
        ))) {
      return { phase: 'waiting_parent_article', buttons: btnTexts, hasInput };
    }

    // Последнее от бота: запрос артикула НАРУШИТЕЛЯ (после успешной проверки parent SKU
    // или старого пути без parent-этапа). Маркеры: «перейдите в карточку товара,
    // на которую хотите пожаловаться» / общие фразы о вводе артикула.
    if (botText.includes('перейдите в карточку товара') ||
        botText.includes('хотите пожаловаться') ||
        botText.includes('скопируйте значение') || botText.includes('пришлите только одно') ||
        botText.includes('введите артикул') || botText.includes('укажите артикул')) {
      return { phase: 'waiting_article', buttons: btnTexts, hasInput };
    }

    // Бот обрабатывает
    if (botText.includes('обрабатываю') || botText.includes('проверяю') || botText.includes('подождите')) {
      return { phase: 'in_progress', buttons: btnTexts, hasInput };
    }

    // Кнопки навигации по дереву жалоб.
    // v5.9.15: два разных путя — plagiat_legacy (Личный кабинет → Кабинет бренда → ...)
    // и beta (Товары и Цены → Контроль качества → ...). Один детектор ловит обе вариации,
    // решение какую кнопку кликать — в service-worker по complaintPath.

    const navigationPhase = detectNavigationButtonPhase();
    if (navigationPhase) return navigationPhase;

    // Текстовый ввод доступен
    if (hasInput) {
      return { phase: 'input_ready', buttons: btnTexts, hasInput: true };
    }

    if (btnTexts.length > 0) {
      return { phase: 'has_buttons', buttons: btnTexts, hasInput };
    }

    return { phase: 'unknown', buttons: [], hasInput: false };
  }

  // === API ФУНКЦИИ ===

  async function clickQuickReply(patterns) {
    const allowGlobalFallback = patterns.some(p => {
      const t = String(p || '').toLowerCase();
      return t.includes('поддержка') || t.includes('помощь');
    });

    for (let attempt = 0; attempt < 8; attempt++) {
      const qrButtons = findQuickReplyButtons();
      console.log(`[OZG] clickQuickReply attempt ${attempt + 1}: ${qrButtons.length} кнопок [${qrButtons.map(b => b.text).join(', ')}], ищу [${patterns.join(', ')}]`);
      for (const btn of qrButtons) {
        for (const p of patterns) {
          if (btn.text.toLowerCase().includes(p.toLowerCase())) {
            console.log('[OZG] Клик по:', btn.text, 'el:', btn.el.tagName, btn.el.className);
            const ok = await simulateRealClick(btn.el);
            await sleep(1500 + Math.random() * 1000);
            return { ok, text: btn.text };
          }
        }
      }

      // Fallback: все кликабельные элементы (включая стандартные кнопки)
      const allClickable = findAllClickableWithText();
      for (const item of allClickable) {
        if (!allowGlobalFallback) {
          const inChat = isInChatArea(item.el) || !!item.el.closest('.tippy-box, [data-tippy-root]');
          if (!inChat || item.el.closest('header, nav')) continue;
        }
        for (const p of patterns) {
          if (item.text.toLowerCase().includes(p.toLowerCase())) {
            console.log('[OZG] Fallback клик:', item.text, 'el:', item.el.tagName);
            const ok = await simulateRealClick(item.el);
            await sleep(2000);
            return { ok, text: item.text };
          }
        }
      }
      await sleep(1500);
    }
    const avail = findQuickReplyButtons();
    return { ok: false, error: 'Кнопка не найдена', available: avail.map(b => b.text) };
  }

  async function clickFaqButton() {
    const faq = detectFaqPage();
    if (!faq) return { ok: false, error: 'Не FAQ-страница' };
    if (!faq.el) return { ok: false, error: `FAQ обнаружена (${faq.type}), но кнопка не найдена` };

    console.log(`[OZG] clickFaqButton: type=${faq.type}, text=${faq.text}`);
    const ok = await simulateRealClick(faq.el);
    await sleep(3000 + Math.random() * 2000);
    return { ok, type: faq.type, text: faq.text };
  }

  async function clickNewChat() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const match = findButtonByText(['новое обращение', 'новый чат', 'написать']);
      if (match) {
        const ok = await simulateRealClick(match.el);
        await sleep(3000);
        return { ok };
      }
      // SVG-кнопка "+" в верхней части
      for (const b of document.querySelectorAll('button')) {
        if (!isVisible(b)) continue;
        const rect = b.getBoundingClientRect();
        if (rect.top > 200 || b.textContent.trim().length > 0) continue;
        if (b.querySelector('svg')) {
          const ok = await simulateRealClick(b);
          await sleep(3000);
          return { ok, note: 'svg-button' };
        }
      }
      await sleep(2000);
    }
    return { ok: false, error: 'Кнопка нового чата не найдена' };
  }

  async function sendText(text) {
    let input = null;
    for (let i = 0; i < 8; i++) {
      input = findChatInput();
      if (input) break;
      await sleep(2000);
    }
    if (!input) return { ok: false, error: 'Поле ввода не найдено' };

    await setInputValue(input, text);
    await sleep(600 + Math.random() * 400);

    const sendBtn = findSendButton();
    if (sendBtn) {
      console.log('[OZG] Клик по send button (после ввода текста)');
      await simulateRealClick(sendBtn);
    } else {
      console.log('[OZG] Send button не найден, fallback Enter');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(50);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    await sleep(1500);
    return { ok: true, hadSendBtn: !!sendBtn };
  }

  // Прикрепить файл И ОТПРАВИТЬ
  async function attachFile(fileName, fileBase64, fileMimeType) {
    let fileInput = null;
    for (let i = 0; i < 5; i++) {
      fileInput = findFileInput();
      if (fileInput) break;
      await sleep(2000);
    }
    if (!fileInput) return { ok: false, error: 'File input не найден' };

    try {
      const dataUrl = 'data:' + (fileMimeType || 'application/pdf') + ';base64,' + fileBase64;
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: blob.type });
      const fileSizeKb = Math.round(blob.size / 1024);
      const isLargeFile = blob.size > 5 * 1024 * 1024; // >5MB
      const isVideo = (fileMimeType || '').startsWith('video/');

      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));

      console.log(`[OZG] Файл прикреплён (${fileSizeKb}КБ, large=${isLargeFile}, video=${isVideo}), жду появления превью...`);

      // Ждём пока файл загрузится и превью появится
      // Для крупных файлов/видео даём больше времени (до 30с vs 10с)
      const maxPreviewWait = isLargeFile ? 30 : 10;
      let fileReady = false;
      for (let i = 0; i < maxPreviewWait; i++) {
        await sleep(1000);
        // Признаки загруженного файла: превью-иконка, имя файла в области ввода, или кнопка удаления
        const chatArea = findChatInput()?.parentElement?.parentElement;
        if (chatArea) {
          const areaText = chatArea.textContent || '';
          // Если в области ввода появился текст с именем файла или значок прикрепления
          if (areaText.includes(fileName.substring(0, 10)) ||
              chatArea.querySelector('svg path[d^="M4 12.006"]') ||
              chatArea.querySelector('[class*="om_15"]') ||
              chatArea.querySelector('video') ||
              chatArea.querySelector('[class*="progress"]') ||
              chatArea.querySelector('[class*="upload"]') ||
              chatArea.querySelector('[class*="loader"]')) {
            fileReady = true;
            console.log(`[OZG] Превью файла обнаружено (${i + 1}с)`);
            break;
          }
        }
      }
      if (!fileReady) {
        console.log('[OZG] Превью файла не обнаружено, пробую отправить...');
      }

      // Для крупных файлов/видео: ждём чтобы Ozon завершил загрузку перед отправкой
      // Признак: прогресс-бар исчезает, или файл готов (нет спиннера/progress)
      if (isLargeFile && fileReady) {
        console.log('[OZG] Крупный файл — жду завершения загрузки на серверы Ozon...');
        let uploadDone = false;
        const maxUploadWait = isVideo ? 40 : 20; // видео может грузиться долго
        for (let i = 0; i < maxUploadWait; i++) {
          await sleep(1000);
          const chatArea = findChatInput()?.parentElement?.parentElement;
          if (!chatArea) continue;
          // Проверяем что НЕТ индикаторов загрузки (спиннер, прогресс-бар, анимация)
          const hasProgress = chatArea.querySelector('[class*="progress"]') ||
                              chatArea.querySelector('[class*="upload"]') ||
                              chatArea.querySelector('[class*="loader"]') ||
                              chatArea.querySelector('[class*="spinner"]') ||
                              chatArea.querySelector('[class*="loading"]');
          if (!hasProgress) {
            // Дополнительная проверка: кнопка отправки доступна (не disabled)
            const sendBtn = findSendButton();
            if (sendBtn && !sendBtn.disabled && !sendBtn.getAttribute('aria-disabled')) {
              uploadDone = true;
              console.log(`[OZG] Загрузка завершена, кнопка send активна (${i + 1}с)`);
              break;
            }
          }
          if (i === 5 || i === 15 || i === 30) {
            console.log(`[OZG] Ожидание загрузки... ${i + 1}/${maxUploadWait}с`);
          }
        }
        if (!uploadDone) {
          console.log('[OZG] Таймаут ожидания загрузки, пробую отправить...');
        }
      }

      await sleep(500 + Math.random() * 500);

      // ОТПРАВИТЬ: кликаем кнопку send (стрелка, НЕ скрепка)
      // ВАЖНО: после клика проверяем что файл реально ушёл (область ввода очистилась)
      let sent = false;
      const maxSendAttempts = isLargeFile ? 8 : 5;
      for (let attempt = 0; attempt < maxSendAttempts; attempt++) {
        const sendBtn = findSendButton();
        if (sendBtn) {
          console.log(`[OZG] Клик по send button (попытка ${attempt + 1}/${maxSendAttempts})`);
          await simulateRealClick(sendBtn);
          // Ждём после клика и проверяем что поле ввода очистилось (файл ушёл)
          await sleep(2000 + (isLargeFile ? 2000 : 0));
          const chatAreaAfter = findChatInput()?.parentElement?.parentElement;
          const areaTextAfter = chatAreaAfter?.textContent || '';
          const stillHasFile = areaTextAfter.includes(fileName.substring(0, 10)) ||
                               (chatAreaAfter && chatAreaAfter.querySelector('svg path[d^="M4 12.006"]')) ||
                               (chatAreaAfter && chatAreaAfter.querySelector('[class*="om_15"]')) ||
                               (chatAreaAfter && chatAreaAfter.querySelector('video'));
          if (!stillHasFile) {
            // Поле очистилось — файл отправлен
            sent = true;
            console.log(`[OZG] ✓ Файл отправлен (поле очистилось после клика ${attempt + 1})`);
            await sleep(1000);
            break;
          } else {
            // Файл ещё в области ввода — upload ещё идёт или клик не сработал
            console.log(`[OZG] Файл ещё в поле ввода после клика send (попытка ${attempt + 1}/${maxSendAttempts}) — жду...`);
            await sleep(3000 + attempt * 2000); // увеличиваем паузу с каждой попыткой
          }
        } else {
          console.log(`[OZG] Send button не найден (попытка ${attempt + 1}/${maxSendAttempts})`);
          await sleep(2000);
        }
      }

      if (!sent) {
        // Fallback: Enter в textarea
        const input = findChatInput();
        if (input) {
          console.log('[OZG] Fallback: Enter в textarea');
          input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          await sleep(100);
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          await sleep(3000);
          // Проверяем после Enter
          const chatAreaFinal = findChatInput()?.parentElement?.parentElement;
          const areaTextFinal = chatAreaFinal?.textContent || '';
          if (!areaTextFinal.includes(fileName.substring(0, 10))) {
            sent = true;
            console.log('[OZG] ✓ Файл отправлен через Enter');
          } else {
            console.log('[OZG] ⚠ Файл не ушёл даже через Enter');
          }
        }
      }

      await sleep(1000);
      return { ok: true, sent };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function clickSend() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const sendBtn = findSendButton();
      if (sendBtn) {
        await simulateRealClick(sendBtn);
        await sleep(1500);
        return { ok: true };
      }
      await sleep(1500);
    }
    // Fallback: Enter
    const input = findChatInput();
    if (input) {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(100);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(1500);
      return { ok: true, method: 'enter' };
    }
    return { ok: false, error: 'Кнопка отправки не найдена' };
  }

  function getDebugInfo() {
    const chatReplies = findChatQuickReplies();
    const qr = findQuickReplyButtons();
    const stdBtns = findAllStandardButtons();
    const { lastBot, lastUser, lastOverall, total } = getLastMessages();
    const phase = detectPhase();
    const sendBtn = findSendButton();
    const chatContainer = findChatContainer();
    return {
      url: location.href,
      phase: phase,
      chatMsgCount: total,
      lastBotMsg: lastBot ? lastBot.text.substring(0, 150) : null,
      lastUserMsg: lastUser ? (lastUser.isFile ? '[FILE]' : lastUser.text.substring(0, 100)) : null,
      lastMsgIsMine: lastOverall ? lastOverall.isMine : null,
      lastBotAfterLastUser: !!(lastBot && lastUser &&
        (lastUser.el.compareDocumentPosition(lastBot.el) & Node.DOCUMENT_POSITION_FOLLOWING)),
      chatQuickReplies: chatReplies.slice(0, 15).map(b => {
        const r = b.el.getBoundingClientRect();
        return `${b.text} [${Math.round(r.width)}x${Math.round(r.height)} ${b.el.tagName}]`;
      }),
      quickReplyTexts: qr.slice(0, 10).map(b => `[${b.score}] ${b.text}`),
      allButtonTexts: stdBtns.slice(0, 15).map(b => b.text),
      hasChatContainer: !!chatContainer,
      hasInput: !!findChatInput(),
      hasFileInput: !!findFileInput(),
      hasSendButton: !!sendBtn,
      sendButtonInfo: sendBtn ? { tag: sendBtn.tagName, class: sendBtn.className, hasSvg: !!sendBtn.querySelector('svg') } : null,
      viewportWidth: window.innerWidth
    };
  }

  // === ПЛАВАЮЩАЯ ПАНЕЛЬ ПРОГРЕССА ===
  // Видна на seller.ozon.ru даже когда popup закрыт

  function createFloatingPanel() {
    let panel = document.getElementById('__ozguard-float-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = '__ozguard-float-panel';
    panel.style.cssText = `
      position: fixed; bottom: 12px; right: 12px; z-index: 999999;
      background: #1a1a2e; color: #e0e0e0; border-radius: 10px;
      padding: 10px 14px; font-family: -apple-system, sans-serif; font-size: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4); min-width: 260px; max-width: 360px;
      max-height: 220px; display: flex; flex-direction: column; gap: 4px;
      border: 1px solid rgba(255,255,255,0.1); transition: opacity 0.3s;
    `;

    panel.innerHTML = `
      <div id="__ozg-panel-header" style="display:flex;align-items:center;justify-content:space-between;cursor:grab;user-select:none;">
        <span style="font-weight:600;color:#7b8cff;">🛡 OZGuard</span>
        <span id="__ozg-panel-status" style="font-size:11px;color:#aaa;">—</span>
        <div style="display:flex;gap:2px;">
          <button id="__ozg-panel-toggle" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 4px;" title="Свернуть">▼</button>
          <button id="__ozg-panel-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 4px;" title="Закрыть">✕</button>
        </div>
      </div>
      <div id="__ozg-panel-body">
        <div id="__ozg-panel-progress" style="margin:4px 0;display:none;">
          <div style="background:#333;border-radius:4px;height:6px;overflow:hidden;">
            <div id="__ozg-panel-bar" style="height:100%;background:linear-gradient(90deg,#4361ee,#7b8cff);width:0%;transition:width 0.5s;"></div>
          </div>
        </div>
        <div id="__ozg-panel-logs" style="max-height:120px;overflow-y:auto;font-size:11px;line-height:1.4;color:#bbb;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Toggle (свернуть/развернуть)
    const toggleBtn = panel.querySelector('#__ozg-panel-toggle');
    const body = panel.querySelector('#__ozg-panel-body');
    toggleBtn.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      toggleBtn.textContent = hidden ? '▼' : '▲';
    });

    // Close (закрыть)
    panel.querySelector('#__ozg-panel-close').addEventListener('click', () => {
      panel.remove();
    });

    // Drag (перетаскивание за header)
    const header = panel.querySelector('#__ozg-panel-header');
    let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return; // не перетаскивать при клике на кнопки
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      header.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - panel.offsetHeight));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        header.style.cursor = 'grab';
      }
    });

    return panel;
  }

  function updateFloatingPanel(data) {
    const panel = createFloatingPanel();
    const statusEl = panel.querySelector('#__ozg-panel-status');
    const progressEl = panel.querySelector('#__ozg-panel-progress');
    const barEl = panel.querySelector('#__ozg-panel-bar');
    const logsEl = panel.querySelector('#__ozg-panel-logs');

    if (data.status) statusEl.textContent = data.status;

    if (data.current != null && data.total) {
      progressEl.style.display = '';
      const pct = Math.round((data.current / data.total) * 100);
      barEl.style.width = pct + '%';
      statusEl.textContent = `${data.current}/${data.total} (${pct}%)`;
    }

    if (data.log) {
      const line = document.createElement('div');
      const isError = data.log.includes('Ошибка') || data.log.includes('⛔') || data.log.includes('failed');
      const isSuccess = data.log.includes('✓') || data.log.includes('✅') || data.log.includes('обработана');
      line.style.color = isError ? '#ff6b6b' : isSuccess ? '#51cf66' : '#bbb';
      line.textContent = data.log;
      logsEl.appendChild(line);
      logsEl.scrollTop = logsEl.scrollHeight;
      // Ограничиваем до 50 строк
      while (logsEl.children.length > 50) logsEl.removeChild(logsEl.firstChild);
    }

    if (data.hide) {
      panel.style.display = 'none';
    } else {
      panel.style.display = '';
    }
  }

  // === ОБРАБОТКА СООБЩЕНИЙ ===

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg._ozguard) return false;

    const action = msg.action;
    const params = msg.params;

    (async () => {
      let result = null;
      try {
        switch (action) {
          case 'getState':
            result = detectPhase();
            break;
          case 'debugDOM':
            result = getDebugInfo();
            break;
          case 'clickButton':
            result = await clickQuickReply(params);
            break;
          case 'clickNewChat':
            result = await clickNewChat();
            break;
          case 'clickFaqButton':
            result = await clickFaqButton();
            break;
          case 'sendText':
            result = await sendText(params);
            break;
          case 'attachFile':
            result = await attachFile(params.name, params.base64, params.type);
            break;
          case 'clickSend':
            result = await clickSend();
            break;
          case 'updatePanel':
            updateFloatingPanel(params);
            result = { ok: true };
            break;
          case 'ping':
            result = { ok: true, version: OZG_SUPPORT_VERSION };
            break;
          default:
            result = { error: 'Unknown action: ' + action };
        }
      } catch (e) {
        result = { error: e.message };
      }
      sendResponse(result);
    })();

    return true;
  });

  console.log(`[OZG-Support] v${OZG_SUPPORT_VERSION} loaded (navigation menu priority, no-violation handling, parent-SKU phase, interface-change guard)`);
})();
