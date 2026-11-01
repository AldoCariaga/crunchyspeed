// CrunchySpeed: phone-friendly additions for the Crunchyroll web player.
//  - playback-speed menu (top-right of the video)
//  - centre controls: back 10 s / play-pause / forward 10 s, shown together with the player's controls
//  - taps: first tap only reveals the controls; tap again to play/pause; double tap left/right = -/+10 s
//  - layout fixes for the desktop player on a phone-sized screen
// Injected at document start into every *.crunchyroll.com frame. The app prepends
// `window.__CR_SAVED_SPEED = <n>;` and exposes `CRSpeed.postMessage()` to save speed changes.
(() => {
  if (window.__crSpeedInstalled) return;
  window.__crSpeedInstalled = true;

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const SKIP_SECONDS = 10;    // matches the player's own jump buttons
  const DOUBLE_TAP_MS = 300;
  let rate = Number(window.__CR_SAVED_SPEED) || 1.5;

  const $ = (sel) => document.querySelector(sel);
  const label = (r) => r + 'x';
  const videos = () => Array.from(document.getElementsByTagName('video'));

  /* ------------------------------------------------------------------------------------------
   * Layout fixes for the desktop player on a phone
   * ------------------------------------------------------------------------------------------ */

  // In desktop mode, Crunchyroll's hidden header dropdowns stick out past a phone-width screen,
  // which makes the whole page lay out wider than the screen. Clip that sideways overflow (top
  // frame only). Use `clip`, not `hidden`: Crunchyroll gives <body> a fixed 100% height, and
  // `overflow-x: hidden` would turn <body> into its own scroll box, so the window would never
  // scroll and the site's scroll-to-top on navigation would do nothing.
  // The player's controls overlay also has a fixed min-height (so the control bar hangs below
  // the video), and the volume button is pointless next to hardware volume keys.
  const style = document.createElement('style');
  style.textContent =
    (window.top === window ? 'html, body { overflow-x: clip !important; max-width: 100vw !important; }\n' : '') +
    '#player-container .katamariDesktop { min-height: 0 !important; }\n' +
    // Our UI lives inside this element; keep its z-index local so the site header stays on top.
    '[data-testid="player-controls-root"] { isolation: isolate; }\n' +
    // No double-tap-to-zoom on the player: otherwise Chrome swallows both clicks of a double tap.
    '#player-container, #player-container * { touch-action: manipulation !important; }\n' +
    '[data-testid="volume-slider-container"] { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);

  // The control row needs ~485px; scale it down to fit narrower players so every button,
  // including fullscreen, stays on screen.
  function fitControls() {
    const right = $('[data-testid="bottom-right-controls-stack"]');
    const bar = $('[data-testid="bottom-controls-autohide"]');
    if (!right || !bar || !bar.parentElement) return;
    const row = right.parentElement;
    const width = Math.round(bar.parentElement.getBoundingClientRect().width);
    // Re-fit when the player width changes, or when the row still overflows (the controls can
    // finish laying out after the first fit, e.g. once the timestamp text appears).
    if (bar.__crFitWidth === width && row.scrollWidth <= row.clientWidth + 1) return;
    bar.style.zoom = '';
    if (!row.scrollWidth || !row.clientWidth) return; // not laid out yet
    const z = Math.min(1, row.clientWidth / row.scrollWidth);
    if (z < 1) bar.style.zoom = String(Math.floor(z * 100) / 100);
    bar.__crFitWidth = width;
  }

  /* ------------------------------------------------------------------------------------------
   * Player state and actions
   * ------------------------------------------------------------------------------------------ */

  function mainVideo() {
    let best = null, bestArea = 0;
    for (const v of videos()) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // Crunchyroll marks hidden controls with pointer-events: none (and fades their opacity).
  // Returns true/false for shown/hidden, or null when this frame has no Crunchyroll player.
  const AUTOHIDE = '[data-testid="bottom-controls-autohide"]';
  let watched = null;
  const autohideObserver = new MutationObserver(() => syncVisibility());
  function playerControlsShown() {
    const el = $(AUTOHIDE);
    if (!el) return null;
    if (el !== watched) {
      autohideObserver.disconnect();
      autohideObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
      watched = el;
    }
    return getComputedStyle(el).pointerEvents !== 'none';
  }

  function clickPlayerButton(testId) {
    const b = $(`[data-testid="${testId}"]`);
    if (!b) return false;
    b.click();
    return true;
  }

  function togglePlay() {
    if (clickPlayerButton('play-pause-button')) return;
    const v = mainVideo();
    if (v) v.paused ? v.play() : v.pause();
  }

  // Use the player's own jump buttons (they seek through the player properly); fall back to
  // seeking the <video> directly.
  function skip(seconds) {
    if (!clickPlayerButton(seconds > 0 ? 'jump-forward-button' : 'jump-backward-button')) {
      const v = mainVideo();
      if (v) v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + seconds));
    }
    flashSkip(seconds);
  }

  // Taps on our own buttons don't reach the player, so its controls would auto-hide while you
  // use them. A synthetic mousedown/mouseup (what a touch produces) resets the hide timer.
  // Don't use pointermove/mousemove: those switch the player into mouse-hover mode, where the
  // controls hide ~0.6 s after every tap.
  function keepControlsAlive() {
    const root = $('[data-testid="player-controls-root"]');
    if (!root) return;
    const r = root.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    root.dispatchEvent(new MouseEvent('mousedown', init));
    root.dispatchEvent(new MouseEvent('mouseup', init));
  }

  /* ------------------------------------------------------------------------------------------
   * Playback speed
   * ------------------------------------------------------------------------------------------ */

  // The player resets the speed on new episodes, ads and seeks, so keep enforcing it.
  function applyRate() {
    for (const v of videos()) {
      if (v.defaultPlaybackRate !== rate) v.defaultPlaybackRate = rate;
      if (v.playbackRate !== rate) v.playbackRate = rate;
    }
  }

  function setRate(r) {
    rate = r;
    applyRate();
    if (speedBtn) refreshSpeedUi();
    try { if (window.CRSpeed) window.CRSpeed.postMessage(String(r)); } catch (_) {}
  }

  // A speed picked in Crunchyroll's own player menu is adopted (and saved). A change back to 1x
  // is treated as the player resetting itself (new episode, ad, seek) and gets undone; use our
  // menu to choose 1x.
  function onRateChange(e) {
    const v = e.target;
    if (!(v instanceof HTMLMediaElement) || v.playbackRate === rate) return;
    if (v.playbackRate !== 1 && v.playbackRate >= 0.25 && v.playbackRate <= 4) setRate(v.playbackRate);
    else applyRate();
  }

  /* ------------------------------------------------------------------------------------------
   * Taps on the video
   * ------------------------------------------------------------------------------------------ */

  // We take over taps on the empty video area (not on the player's buttons, scrubber or menus):
  //  - controls hidden: the tap only reveals them (the player does that on mousedown; we drop
  //    the click, which would otherwise toggle play/pause)
  //  - controls shown: the tap toggles play/pause, after a short wait to rule out a double tap
  //  - double tap: skip 10 s back (left half) or forward (right half); keep tapping to skip more
  const BACKGROUND_IDS = new Set([
    'player-controls-root', 'top-gradient', 'top-gradient-background', 'ratings-advisories-overlay',
    'top-controls-autohide', 'bottom-controls-autohide',
  ]);
  function isVideoBackground(target) {
    if (!target || !target.closest) return false;
    if (target === speedHost || target === overlay) return false; // our own buttons (shadow DOM hosts)
    if (target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="menu"], [role="menuitem"], [role="dialog"]')) return false;
    const owner = target.closest('[data-testid]');
    return !!owner && BACKGROUND_IDS.has(owner.dataset.testid);
  }

  let downOnBackground = false, downWithControlsHidden = false, lastTapAt = 0, singleTapTimer = 0;
  addEventListener('pointerdown', (e) => {
    downOnBackground = isVideoBackground(e.target);
    downWithControlsHidden = downOnBackground && playerControlsShown() === false;
  }, true);

  addEventListener('click', (e) => {
    if (!downOnBackground || !isVideoBackground(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();

    const now = performance.now();
    const isRepeat = now - lastTapAt < DOUBLE_TAP_MS;
    lastTapAt = now;
    if (isRepeat) {
      clearTimeout(singleTapTimer);
      singleTapTimer = 0;
      const v = mainVideo();
      const r = (v || e.target).getBoundingClientRect();
      skip(e.clientX >= r.left + r.width / 2 ? SKIP_SECONDS : -SKIP_SECONDS);
      return;
    }
    if (downWithControlsHidden) return; // first tap just reveals the controls
    clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(() => { singleTapTimer = 0; togglePlay(); }, DOUBLE_TAP_MS);
  }, true);

  // The desktop player toggles fullscreen on double click; double tap means "skip" here.
  addEventListener('dblclick', (e) => {
    if (!isVideoBackground(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  /* ------------------------------------------------------------------------------------------
   * Our UI: speed button + centre controls overlay
   * ------------------------------------------------------------------------------------------ */

  const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>';
  const skipIcon = (forward) => `
    <svg viewBox="0 0 24 24">
      <g${forward ? ' transform="translate(24 0) scale(-1 1)"' : ''}>
        <path d="M12 4.5a7.5 7.5 0 1 1-7.5 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M12.5 1v7L8 4.5z"/>
      </g>
      <text x="12" y="15.3" text-anchor="middle" font-size="7.5" font-weight="700"
            font-family="system-ui, Roboto, sans-serif">10</text>
    </svg>`;

  let speedHost = null, speedWrap = null, speedBtn = null, menu = null, dimTimer = 0;
  let overlay = null, centre = null, playBtn = null, flashLeft = null, flashRight = null;

  // Keep taps on our UI away from the player (no pause/play, no controls toggle).
  function isolateEvents(el) {
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  // Our UI is mounted *inside* the player's controls root (see mount()). Touches then stay
  // "inside" the player: outside UI makes the emulated mouse leave the player, and the desktop
  // player hides its controls ~0.6 s after the mouse leaves.
  function buildSpeedButton() {
    speedHost = document.createElement('div');
    speedHost.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2147483647;';
    const shadow = speedHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .wrap { position: relative; font: 600 14px/1 system-ui, -apple-system, Roboto, sans-serif; transition: opacity .3s; }
        .wrap.dim { opacity: .35; }
        .wrap.hidden { opacity: 0; }
        button { all: unset; box-sizing: border-box; cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; }
        .btn { display: block; min-width: 54px; padding: 9px 10px; text-align: center; color: #fff;
               background: rgba(0,0,0,.65); border: 1.5px solid #f47521; border-radius: 8px; }
        .menu { position: absolute; top: calc(100% + 6px); right: 0; display: none; flex-direction: column;
                min-width: 80px; max-height: var(--menu-max, 75vh); overflow-y: auto; padding: 4px;
                background: rgba(18,18,18,.96); border: 1px solid #3a3a3a; border-radius: 10px;
                box-shadow: 0 6px 20px rgba(0,0,0,.5); }
        .menu.open { display: flex; }
        .opt { display: block; padding: 10px 14px; color: #ddd; border-radius: 6px; text-align: right; }
        .opt.on { color: #fff; background: #f47521; }
      </style>
      <div class="wrap"><button class="btn" aria-label="Playback speed"></button><div class="menu" role="menu"></div></div>`;
    speedWrap = shadow.querySelector('.wrap');
    speedBtn = shadow.querySelector('.btn');
    menu = shadow.querySelector('.menu');

    for (const s of SPEEDS) {
      const opt = document.createElement('button');
      opt.className = 'opt';
      opt.textContent = label(s);
      opt.dataset.speed = String(s);
      opt.addEventListener('click', () => { setRate(s); closeMenu(); });
      menu.appendChild(opt);
    }
    speedBtn.addEventListener('click', () => {
      keepControlsAlive();
      menu.classList.contains('open') ? closeMenu() : openMenu();
    });
    isolateEvents(speedHost);
    refreshSpeedUi();
  }

  function buildOverlay() {
    // Covers the video; only its buttons take taps, everything else passes through to the player.
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;z-index:2147483646;pointer-events:none;';
    const shadow = overlay.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .centre { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
                  gap: var(--gap, 36px); transition: opacity .3s; }
        .centre.hidden { opacity: 0; }
        button { all: unset; pointer-events: auto; box-sizing: border-box; display: flex; align-items: center;
                 justify-content: center; width: var(--s, 48px); height: var(--s, 48px); border-radius: 50%;
                 color: #fff; background: rgba(0,0,0,.45); cursor: pointer; -webkit-tap-highlight-color: transparent; }
        .centre.hidden button { pointer-events: none; }
        button.play { width: var(--p, 62px); height: var(--p, 62px); }
        button.pressed { background: rgba(244,117,33,.8); } /* not :active, which can stick after a touch */
        svg { width: 66%; height: 66%; fill: currentColor; }
        .flash { position: absolute; top: 50%; transform: translateY(-50%); padding: 10px 16px; border-radius: 999px;
                 color: #fff; background: rgba(0,0,0,.6); font: 600 15px/1 system-ui, Roboto, sans-serif;
                 opacity: 0; transition: opacity .2s; pointer-events: none; white-space: nowrap; }
        .flash.left { left: 7%; }
        .flash.right { right: 7%; }
        .flash.on { opacity: 1; }
      </style>
      <div class="centre hidden">
        <button class="back" aria-label="Back 10 seconds">${skipIcon(false)}</button>
        <button class="play" aria-label="Play or pause">${ICON_PAUSE}</button>
        <button class="fwd" aria-label="Forward 10 seconds">${skipIcon(true)}</button>
      </div>
      <div class="flash left"></div>
      <div class="flash right"></div>`;
    centre = shadow.querySelector('.centre');
    playBtn = shadow.querySelector('.play');
    flashLeft = shadow.querySelector('.flash.left');
    flashRight = shadow.querySelector('.flash.right');

    const onTap = (el, action) => el.addEventListener('click', () => {
      action();
      keepControlsAlive();
      el.classList.add('pressed');
      setTimeout(() => el.classList.remove('pressed'), 150);
    });
    onTap(shadow.querySelector('.back'), () => skip(-SKIP_SECONDS));
    onTap(shadow.querySelector('.fwd'), () => skip(SKIP_SECONDS));
    onTap(playBtn, togglePlay);
    isolateEvents(overlay);
  }

  function refreshSpeedUi() {
    speedBtn.textContent = label(rate); // rates from the player's own menu (e.g. 1.1x) show here too
    for (const opt of menu.children) opt.classList.toggle('on', Number(opt.dataset.speed) === rate);
  }

  function updatePlayIcon() {
    if (!playBtn) return;
    const v = mainVideo();
    const paused = !v || v.paused;
    if (playBtn.dataset.paused === String(paused)) return;
    playBtn.dataset.paused = String(paused);
    playBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
  }

  // "+20s" style feedback for (repeated) skips, on the side that was skipped.
  let flashTotal = 0, flashTimer = 0;
  function flashSkip(seconds) {
    if (!flashLeft) return;
    const forward = seconds > 0;
    flashTotal = (flashTotal > 0) === forward && flashTotal !== 0 ? flashTotal + seconds : seconds;
    const el = forward ? flashRight : flashLeft;
    (forward ? flashLeft : flashRight).classList.remove('on');
    el.textContent = forward ? `${flashTotal}s »` : `« ${-flashTotal}s`;
    el.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.classList.remove('on'); flashTotal = 0; }, 800);
  }

  function openMenu() { menu.classList.add('open'); wake(); }
  function closeMenu() { if (menu) menu.classList.remove('open'); syncVisibility(); }

  // Our buttons appear and disappear together with Crunchyroll's own controls.
  function syncVisibility() {
    if (!speedWrap) return false;
    updatePlayIcon();
    const shown = playerControlsShown();
    if (shown === null) { centre.classList.add('hidden'); return false; } // not the Crunchyroll player
    const menuOpen = menu.classList.contains('open');
    const speedVisible = shown || menuOpen;
    speedWrap.classList.remove('dim');
    speedWrap.classList.toggle('hidden', !speedVisible);
    speedHost.style.pointerEvents = speedVisible ? 'auto' : 'none'; // hidden: taps go to the player
    centre.classList.toggle('hidden', !shown || menuOpen);
    return true;
  }

  // Fallback for other players: speed button at full opacity while interacting, dim after 3 s.
  function wake() {
    if (!speedWrap) return;
    if (syncVisibility()) return;
    speedWrap.classList.remove('dim');
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => { if (!menu.classList.contains('open')) speedWrap.classList.add('dim'); }, 3000);
  }

  // Mount our UI inside Crunchyroll's player controls root, so it moves with the player
  // (portrait, fullscreen, scrolling) and sits under the site header like the player does.
  // React may re-create the root (e.g. on episode change); the periodic tick re-mounts.
  function mount() {
    const root = $('[data-testid="player-controls-root"]');
    if (!root || !mainVideo()) {
      if (speedHost) { speedHost.remove(); overlay.remove(); closeMenu(); }
      return;
    }
    if (!speedHost) { buildOverlay(); buildSpeedButton(); }
    if (overlay.parentNode !== root) root.appendChild(overlay);
    if (speedHost.parentNode !== root) root.appendChild(speedHost);

    const h = root.getBoundingClientRect().height;
    const size = Math.round(Math.max(40, Math.min(64, h * 0.2)));
    overlay.style.setProperty('--s', size + 'px');
    overlay.style.setProperty('--p', Math.round(size * 1.3) + 'px');
    overlay.style.setProperty('--gap', Math.round(size * 0.9) + 'px');
    speedHost.style.setProperty('--menu-max', Math.max(120, Math.round(h - 60)) + 'px');
    syncVisibility();
  }

  /* ------------------------------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------------------------------ */

  // Media events don't bubble, but capture-phase listeners on document still see them.
  document.addEventListener('ratechange', onRateChange, true);
  document.addEventListener('loadedmetadata', applyRate, true);
  document.addEventListener('play', () => { applyRate(); updatePlayIcon(); }, true);
  document.addEventListener('pause', updatePlayIcon, true);

  // Tell the app whether a video in this frame is playing, so it keeps the screen awake only
  // then (fullscreen or not). Sent as "playing"/"idle"; numbers on the same channel are speeds.
  let reportedPlaying = null;
  function reportPlaying() {
    const playing = videos().some((v) => !v.paused && !v.ended && v.readyState > 0);
    if (playing === reportedPlaying) return;
    reportedPlaying = playing;
    try { if (window.CRSpeed) window.CRSpeed.postMessage(playing ? 'playing' : 'idle'); } catch (_) {}
  }
  for (const type of ['play', 'playing', 'pause', 'ended', 'emptied']) {
    document.addEventListener(type, reportPlaying, true);
  }
  // The app sends "pause" when the user swipes back, so the video doesn't keep playing behind
  // the loading screen while the site switches back to the previous page.
  try {
    if (window.CRSpeed) {
      window.CRSpeed.addEventListener('message', (e) => {
        if (e.data === 'pause') videos().forEach((v) => v.pause());
      });
    }
  } catch (_) {}
  addEventListener('pagehide', () => {
    reportedPlaying = false;
    try { if (window.CRSpeed) window.CRSpeed.postMessage('idle'); } catch (_) {}
  });

  document.addEventListener('pointerdown', (e) => {
    if (!speedHost) return;
    if (!e.composedPath().includes(speedHost)) closeMenu(); // tap outside closes the menu
    wake();
  }, true);

  /* ------------------------------------------------------------------------------------------
   * Loading screen: tell the app when the page has really rendered (top frame only)
   * ------------------------------------------------------------------------------------------ */

  // The site is a single-page app: the HTML loads fast, then it shows grey placeholder boxes
  // (class names `loading-animation--…` / `…placeholder--…`) while it fetches the content. The
  // app covers the page with a spinner from the start of a page load until we post "ready",
  // i.e. once no placeholders are left on screen. In-site navigation reloads nothing, so there
  // we drive the spinner ourselves: going forward (pushState) shows it only if placeholders show
  // up; going back (popstate) always shows it (the app already does on the back gesture), since
  // the old page lingers for a moment and the previous one often returns without placeholders.
  if (window.top === window) {
    const LOADERS = '[class*="loading-animation--"], [class*="placeholder--"]';
    const SETTLE_MS = 200;      // placeholders must stay gone this long (they come in waves)
    const BACK_SETTLE_MS = 300; // after going back, give the previous view this long to redraw
    const NAV_GRACE_MS = 1000;  // after a forward in-site navigation, wait this long for placeholders
    const BACK_REDRAW_MS = 1500; // after going back, give up waiting for the page to change after this
    const post = (m) => { try { if (window.CRSpeed) window.CRSpeed.postMessage(m); } catch (_) {} };
    const onScreen = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    };
    const loading = () => Array.prototype.some.call(document.querySelectorAll(LOADERS), onScreen);

    let timer = 0, redraw = null;
    // mode: 'full' = real page load (the app is already showing the spinner),
    //       'push' = forward in-site navigation, 'back' = in-site history navigation.
    function watchLoading(mode) {
      clearInterval(timer);
      if (redraw) redraw.disconnect();
      const start = Date.now();
      let shown = mode !== 'push', seen = false, clearSince = 0;
      // Going back, the old view stays up until the site swaps in the previous one (that can take
      // a second); only start the settle countdown once the page has actually changed.
      let changed = mode !== 'back';
      if (mode === 'back' && document.body) {
        post('loading');
        redraw = new MutationObserver(() => { changed = true; redraw.disconnect(); });
        redraw.observe(document.body, { childList: true, subtree: true });
      }
      const done = () => { clearInterval(timer); if (shown) post('ready'); };
      timer = setInterval(() => {
        if (!document.body) return;
        if (!changed && Date.now() - start < BACK_REDRAW_MS) return;
        if (loading()) {
          seen = true;
          clearSince = 0;
          if (!shown) { shown = true; post('loading'); }
          return;
        }
        if (!seen) {
          // Page without placeholders: ready once fully loaded. Forward navigation without
          // placeholders: the new view rendered straight away, so never show the spinner.
          if (mode === 'full' && document.readyState !== 'complete') return;
          if (mode === 'push') {
            if (Date.now() - start > NAV_GRACE_MS) clearInterval(timer);
            return;
          }
        }
        if (!clearSince) clearSince = Date.now();
        if (Date.now() - clearSince >= (mode === 'back' ? BACK_SETTLE_MS : SETTLE_MS)) done();
      }, 100);
    }
    watchLoading('full');

    const pushState = history.pushState;
    history.pushState = function () {
      const result = pushState.apply(this, arguments);
      watchLoading('push');
      return result;
    };
    addEventListener('popstate', () => watchLoading('back'));
  }

  document.addEventListener('fullscreenchange', mount);
  document.addEventListener('webkitfullscreenchange', mount);
  addEventListener('resize', mount);
  addEventListener('resize', fitControls);
  setInterval(() => { applyRate(); fitControls(); mount(); reportPlaying(); }, 500);
})();
