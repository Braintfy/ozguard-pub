// OZGuard Scan Panel v5.9.16
// Плавающая панель прогресса сканирования на www.ozon.ru
// ISOLATED world — коммуникация через chrome.runtime.onMessage

(function() {
  'use strict';

  if (document.getElementById('__ozguard-scan-panel')) return;

  const panel = document.createElement('div');
  panel.id = '__ozguard-scan-panel';
  panel.innerHTML = `
    <div id="ozgScanHeader" style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#005bff;color:#fff;border-radius:8px 8px 0 0;cursor:grab;user-select:none;">
      <span style="font-weight:700;font-size:12px;">OZGuard</span>
      <span id="ozgScanProgress" style="font-size:11px;opacity:0.9;">0/0 (0%)</span>
      <div style="display:flex;gap:4px;">
        <button id="ozgScanPause" style="background:rgba(255,255,255,0.2);border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px;" title="Пауза">⏸</button>
        <button id="ozgScanStop" style="background:rgba(255,255,255,0.2);border:none;color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px;" title="Стоп">⏹</button>
        <button id="ozgScanClose" style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:14px;padding:0 2px;" title="Скрыть">✕</button>
      </div>
    </div>
    <div id="ozgScanBody" style="max-height:180px;overflow-y:auto;padding:6px 10px;font-size:11px;line-height:1.5;color:#333;"></div>
  `;
  Object.assign(panel.style, {
    position: 'fixed', bottom: '20px', right: '20px', width: '380px',
    background: '#fff', borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
    zIndex: '2147483647', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    border: '1px solid #e0e2e8', overflow: 'hidden'
  });
  document.body.appendChild(panel);

  const header = document.getElementById('ozgScanHeader');
  const body = document.getElementById('ozgScanBody');
  const progress = document.getElementById('ozgScanProgress');
  const pauseBtn = document.getElementById('ozgScanPause');
  const stopBtn = document.getElementById('ozgScanStop');
  const closeBtn = document.getElementById('ozgScanClose');

  let isPaused = false;

  // Drag
  let isDragging = false, dragX = 0, dragY = 0;
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragX = e.clientX - panel.offsetLeft;
    dragY = e.clientY - panel.offsetTop;
    header.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    let x = e.clientX - dragX;
    let y = e.clientY - dragY;
    x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, x));
    y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => {
    isDragging = false;
    header.style.cursor = 'grab';
  });

  // Close
  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

  // Pause
  pauseBtn.addEventListener('click', () => {
    if (isPaused) {
      chrome.runtime.sendMessage({ action: 'resumeScan' });
      isPaused = false;
      pauseBtn.textContent = '⏸';
      pauseBtn.title = 'Пауза';
    } else {
      chrome.runtime.sendMessage({ action: 'pauseScan' });
      isPaused = true;
      pauseBtn.textContent = '▶';
      pauseBtn.title = 'Продолжить';
    }
  });

  // Stop
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopScan' });
    progress.textContent = 'Остановлено';
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
  });

  // Receive updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'scanPanelUpdate') {
      if (msg.log) {
        const line = document.createElement('div');
        line.textContent = msg.log;
        body.appendChild(line);
        body.scrollTop = body.scrollHeight;
        // Ограничиваем 100 строк
        while (body.children.length > 100) body.removeChild(body.firstChild);
      }
      if (msg.total > 0) {
        const pct = Math.round((msg.current / msg.total) * 100);
        progress.textContent = `${msg.current}/${msg.total} (${pct}%)`;
      }
    }
    if (msg.action === 'scanComplete' || msg.action === 'scanStopped') {
      progress.textContent = 'Завершено';
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
    }
  });
})();
