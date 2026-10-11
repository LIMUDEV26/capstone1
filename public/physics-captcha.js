// Delayed Reaction Physics CAPTCHA Frontend
(function () {
  'use strict';

  const STATE_EVENT = 'physics-captcha:state';
  const INIT_EVENT = 'physics-captcha:init';
  const BALL_RADIUS = 18;
  const BALL_COLOR_FALLING = '#3b82f6';
  const BALL_COLOR_NEAR = '#f59e0b';
  const BALL_COLOR_CAUGHT = '#10b981';
  const POSITION_LERP = 0.22;
  const MAX_FRAME_SCALE = 2.2;
  const POLL_INTERVAL_MS = 160;

  let physicsState = null;
  let animationId = null;
  let pollTimeoutId = null;
  let isSolved = false;
  let startedAt = 0;
  let currentCatchZoneY = null;
  let targetBallX = null;
  let targetBallY = null;
  let renderedBallX = null;
  let renderedBallY = null;
  let latestInitToken = 0;
  let boundCanvas = null;
  let boundRefreshButton = null;
  let cachedElements = null;
  let cachedGridCanvas = null;
  let cachedGridWidth = 0;
  let cachedGridHeight = 0;
  let lastAnimationTime = 0;
  let lastTimerText = '';
  let lastStatusText = '';
  let lastCatchZoneActive = null;

  function dispatchState(detail) {
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail }));
  }

  function getElements() {
    const canvas = document.getElementById('physicsCanvas');
    if (cachedElements && cachedElements.canvas === canvas) {
      return cachedElements;
    }

    cachedElements = {
      canvas,
      ctx: canvas ? canvas.getContext('2d') : null,
      timerEl: document.getElementById('physicsTimer') || document.getElementById('captchaTimer'),
      catchZone: document.getElementById('catchZone'),
      statusMsg: document.getElementById('physicsStatusMsg') || document.getElementById('statusMsg'),
      refreshButton: document.getElementById('physicsRefreshBtn') || document.getElementById('physicsRefresh'),
    };
    return cachedElements;
  }

  function getApiBase(canvas) {
    const configuredBase = String(canvas?.dataset?.apiBase || '/api').trim();
    return configuredBase.replace(/\/+$/, '');
  }

  function readPayload(data) {
    if (data && typeof data === 'object' && data.data && typeof data.data === 'object') {
      return data.data;
    }
    return data;
  }

  async function readJsonResponse(response, fallbackMessage) {
    const body = await response.text();
    try {
      return JSON.parse(body);
    } catch (_error) {
      const preview = body.replace(/\s+/g, ' ').trim().slice(0, 120);
      throw new Error(preview ? `${fallbackMessage} ${preview}` : fallbackMessage);
    }
  }

  function setTimer(elements, text) {
    if (text === lastTimerText) return;
    lastTimerText = text;
    if (elements.timerEl) {
      elements.timerEl.textContent = text;
    }
    dispatchState({ timerText: text });
  }

  function setStatus(elements, text, tone) {
    if (text !== lastStatusText && elements.statusMsg) {
      elements.statusMsg.textContent = text;
      elements.statusMsg.dataset.tone = tone || 'info';
      elements.statusMsg.style.color = tone === 'error'
        ? '#dc2626'
        : tone === 'success'
          ? '#059669'
          : '#64748b';
    }
    lastStatusText = text;
    dispatchState({ statusMessage: text });
  }

  function setCatchZoneActive(elements, active) {
    if (!elements.catchZone || lastCatchZoneActive === active) return;
    lastCatchZoneActive = active;
    elements.catchZone.style.opacity = active ? '1' : '0.75';
  }

  function ensureGridCanvas(canvas) {
    if (!canvas) return null;
    if (cachedGridCanvas && cachedGridWidth === canvas.width && cachedGridHeight === canvas.height) {
      return cachedGridCanvas;
    }

    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = canvas.width;
    gridCanvas.height = canvas.height;
    const gridCtx = gridCanvas.getContext('2d');
    if (!gridCtx) return null;

    gridCtx.strokeStyle = '#e5e7eb';
    gridCtx.lineWidth = 0.5;
    for (let y = 0; y < gridCanvas.height; y += 40) {
      gridCtx.beginPath();
      gridCtx.moveTo(0, y);
      gridCtx.lineTo(gridCanvas.width, y);
      gridCtx.stroke();
    }

    cachedGridCanvas = gridCanvas;
    cachedGridWidth = canvas.width;
    cachedGridHeight = canvas.height;
    return cachedGridCanvas;
  }

  function drawScene(elements, ballX, ballY, progress) {
    const { canvas, ctx } = elements;
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const gridCanvas = ensureGridCanvas(canvas);
    if (gridCanvas) {
      ctx.drawImage(gridCanvas, 0, 0);
    }

    const shadowOpacity = Math.min(1, Math.max(0, ballY) / canvas.height) * 0.3;
    ctx.fillStyle = `rgba(0,0,0,${shadowOpacity})`;
    ctx.beginPath();
    ctx.arc(ballX + 4, canvas.height - 8, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    const gradient = ctx.createRadialGradient(ballX, ballY, 0, ballX, ballY, BALL_RADIUS);
    if (isSolved) {
      gradient.addColorStop(0, BALL_COLOR_CAUGHT);
      gradient.addColorStop(1, 'rgba(16,185,129,0.6)');
    } else if (progress > 0.6) {
      gradient.addColorStop(0, BALL_COLOR_NEAR);
      gradient.addColorStop(1, 'rgba(245,158,11,0.5)');
    } else {
      gradient.addColorStop(0, BALL_COLOR_FALLING);
      gradient.addColorStop(1, 'rgba(59,130,246,0.4)');
    }

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(ballX, ballY, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff88';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function stopPhysics() {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
  }

  function animate(now) {
    const elements = getElements();
    if (!elements.canvas || !elements.ctx || !physicsState) return;

    const elapsed = (now - startedAt) / 1000;
    const frameScale = lastAnimationTime
      ? Math.min(MAX_FRAME_SCALE, (now - lastAnimationTime) / 16.67)
      : 1;
    lastAnimationTime = now;
    const fallbackBallX = physicsState.x0 * elements.canvas.width;
    const fallbackBallY = Math.max(
      0,
      Math.min(elements.canvas.height, 0.5 * physicsState.gravity * elapsed * elapsed * 1e6)
    );
    const nextTargetX = typeof targetBallX === 'number' ? targetBallX : fallbackBallX;
    const nextTargetY = typeof targetBallY === 'number' ? targetBallY : fallbackBallY;
    const lerpFactor = Math.min(0.9, POSITION_LERP * frameScale);

    renderedBallX = typeof renderedBallX === 'number'
      ? renderedBallX + ((nextTargetX - renderedBallX) * lerpFactor)
      : nextTargetX;
    renderedBallY = typeof renderedBallY === 'number'
      ? renderedBallY + ((nextTargetY - renderedBallY) * lerpFactor)
      : nextTargetY;

    const catchZoneY = typeof currentCatchZoneY === 'number'
      ? currentCatchZoneY
      : physicsState.catch_zone_y * elements.canvas.height;
    const progress = Math.max(0, Math.min(1, renderedBallY / Math.max(catchZoneY, 1)));

    setCatchZoneActive(elements, progress > 0.62 || isSolved);
    drawScene(elements, renderedBallX, renderedBallY, progress);

    if (!isSolved) {
      animationId = requestAnimationFrame(animate);
    }
  }

  async function pollPhysics(initToken) {
    const elements = getElements();
    if (!elements.canvas || !physicsState || isSolved || initToken !== latestInitToken) {
      return;
    }

    try {
      const apiBase = getApiBase(elements.canvas);
      const response = await fetch(`${apiBase}/captcha.php?action=physics_update`, {
        method: 'GET',
        credentials: 'include',
      });
      const data = await readJsonResponse(response, 'Failed to update the physics challenge.');
      const payload = readPayload(data);

      if (!response.ok || !data.success || !payload) {
        throw new Error(data.message || 'Failed to update the physics challenge.');
      }

      targetBallX = typeof payload.x === 'number' ? payload.x : targetBallX;
      targetBallY = typeof payload.y === 'number' ? payload.y : targetBallY;
      currentCatchZoneY = typeof payload.catch_zone_y === 'number' ? payload.catch_zone_y : currentCatchZoneY;

      const timeLeft = Math.max(0, Math.ceil(Number(payload.time_left || 0)));
      setTimer(elements, timeLeft > 0 ? `${timeLeft}s` : 'Expired');

      if (timeLeft <= 0) {
        setStatus(elements, 'Time expired. Click refresh to try again.', 'error');
        dispatchState({ loading: false, verified: false });
        stopPhysics();
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update the physics challenge.';
      setStatus(elements, message, 'error');
      dispatchState({ loading: false, verified: false, error: message });
      stopPhysics();
      return;
    }

    pollTimeoutId = setTimeout(() => {
      void pollPhysics(initToken);
    }, POLL_INTERVAL_MS);
  }

  async function initPhysics() {
    const initToken = ++latestInitToken;
    const elements = getElements();

    if (!elements.canvas || !elements.ctx) {
      dispatchState({
        loading: false,
        verified: false,
        timerText: 'Captcha unavailable',
        statusMessage: 'Captcha widget not ready yet.',
      });
      return;
    }

    stopPhysics();
    physicsState = null;
    isSolved = false;
    startedAt = performance.now();
    targetBallX = null;
    targetBallY = null;
    renderedBallX = null;
    renderedBallY = null;
    currentCatchZoneY = null;
    lastAnimationTime = 0;
    lastTimerText = '';
    lastStatusText = '';
    lastCatchZoneActive = null;

    setCatchZoneActive(elements, false);
    setStatus(elements, '', 'info');
    setTimer(elements, 'Loading physics challenge...');
    dispatchState({ loading: true, verified: false, timerText: 'Loading physics challenge...' });

    try {
      const apiBase = getApiBase(elements.canvas);
      const response = await fetch(`${apiBase}/captcha.php?action=physics_generate`, {
        method: 'GET',
        credentials: 'include',
      });
      const data = await readJsonResponse(response, 'Failed to load the physics challenge.');
      const payload = readPayload(data);

      if (initToken !== latestInitToken) return;

      if (!response.ok || !data.success || !payload?.state) {
        throw new Error(data.message || 'Failed to load the physics challenge.');
      }

      physicsState = payload.state;
      startedAt = performance.now();
      targetBallX = physicsState.x0 * elements.canvas.width;
      targetBallY = 0;
      renderedBallX = targetBallX;
      renderedBallY = targetBallY;
      currentCatchZoneY = physicsState.catch_zone_y * elements.canvas.height;
      if (elements.ctx) {
        elements.ctx.imageSmoothingEnabled = true;
      }

      const initialSeconds = Math.max(0, Math.ceil(Number(payload.expires_in || 0) / 1000));
      setTimer(elements, initialSeconds > 0 ? `${initialSeconds}s` : 'Ready');
      dispatchState({ loading: false, verified: false });

      void pollPhysics(initToken);
      animationId = requestAnimationFrame(animate);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load the physics challenge.';
      setTimer(elements, 'Error');
      setStatus(elements, message, 'error');
      dispatchState({ loading: false, verified: false, error: message, timerText: 'Error' });
    }
  }

  async function handleBallClick(event) {
    const elements = getElements();
    if (!elements.canvas || !physicsState || isSolved) {
      return;
    }

    const rect = elements.canvas.getBoundingClientRect();
    const scaleX = elements.canvas.width / rect.width;
    const scaleY = elements.canvas.height / rect.height;
    const clickX = (event.clientX - rect.left) * scaleX;
    const clickY = (event.clientY - rect.top) * scaleY;
    const clickTime = Date.now();

    try {
      const apiBase = getApiBase(elements.canvas);
      const response = await fetch(`${apiBase}/captcha.php?action=physics_verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          click_x: clickX,
          click_y: clickY,
          click_time: clickTime,
        }),
      });
      const data = await readJsonResponse(response, 'Failed to verify the physics challenge.');
      const payload = readPayload(data);

      if (!response.ok || !data.success || !payload) {
        throw new Error(data.message || 'Failed to verify the physics challenge.');
      }

      if (payload.success) {
        isSolved = true;
        targetBallX = typeof clickX === 'number' ? clickX : targetBallX;
        targetBallY = typeof clickY === 'number' ? clickY : targetBallY;
        renderedBallX = targetBallX;
        renderedBallY = targetBallY;
        setCatchZoneActive(elements, true);
        setStatus(elements, 'Perfect timing! Login enabled.', 'success');
        setTimer(elements, 'Verified');
        dispatchState({ loading: false, verified: true, timerText: 'Verified', statusMessage: 'Perfect timing! Login enabled.' });
        stopPhysics();
        drawScene(elements, renderedBallX, renderedBallY, 1);
        return;
      }

      setStatus(elements, 'Missed catch zone. Loading a new challenge...', 'error');
      dispatchState({ loading: true, verified: false });
      stopPhysics();
      setTimeout(() => {
        void initPhysics();
      }, 350);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error. Refresh and try again.';
      setStatus(elements, message, 'error');
      dispatchState({ loading: false, verified: false, error: message });
    }
  }

  function bindEvents() {
    const elements = getElements();
    if (!elements.canvas || !elements.ctx) return;

    if (boundCanvas && boundCanvas !== elements.canvas) {
      boundCanvas.removeEventListener('click', handleBallClick);
    }
    if (boundRefreshButton && boundRefreshButton !== elements.refreshButton) {
      boundRefreshButton.removeEventListener('click', initPhysics);
    }

    if (elements.canvas !== boundCanvas) {
      elements.canvas.addEventListener('click', handleBallClick);
      boundCanvas = elements.canvas;
    }

    if (elements.refreshButton && elements.refreshButton !== boundRefreshButton) {
      elements.refreshButton.addEventListener('click', initPhysics);
      boundRefreshButton = elements.refreshButton;
    }
  }

  function initWhenReady() {
    bindEvents();
    void initPhysics();
  }

  window.physicsCaptcha = {
    init: initWhenReady,
    refresh: initWhenReady,
    stop: stopPhysics,
  };

  window.addEventListener(INIT_EVENT, initWhenReady);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWhenReady, { once: true });
  } else {
    setTimeout(initWhenReady, 0);
  }
})();
