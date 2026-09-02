/**
 * Rel.AI Companion — ChatGPT integration
 * Applies user-selected workspace, performance, privacy, and navigation tools.
 */
(() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────
  let totalTurns = 0;
  let cleanMemoryActive = false;
  let hideNotifications = false;
  let scrollContainer = null;
  let chatContainer = null;
  let lastURL = location.href;
  let initTimeout = null;
  let isInitialized = false;
  let styleTag = null;

  // ── Constants ─────────────────────────────────────────────────────
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const NOTIFICATION_STYLE_ID = 'relai-notification-hide-style';
  const VISIBILITY_STYLE_ID = 'relai-visibility-style';

  // ── i18n ──────────────────────────────────────────────────────────
  // Language is shared with popup via chrome.storage.local under "uiLang".
  // RELAI_I18N is provided by shared/i18n-data.js.
  let cachedLang = 'auto';
  function t(key, subs) {
    const I = (typeof window !== 'undefined' && window.RELAI_I18N) || null;
    if (!I) return key;
    return I.t(key, subs, cachedLang === 'auto' ? null : cachedLang);
  }
  try {
    chrome.storage.local.get(['uiLang'], (data) => {
      if (data && data.uiLang) cachedLang = data.uiLang;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.uiLang) return;
      cachedLang = changes.uiLang.newValue || 'auto';
    });
  } catch (_) {}

  // ── Utilities ─────────────────────────────────────────────────────

  function log(...args) {
    console.log('[Rel.AI Companion]', ...args);
  }

  function findScrollContainer(el) {
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function getTurns() {
    return document.querySelectorAll(TURN_SELECTOR);
  }

  // ── Visibility via Dynamic Style Tag ──────────────────────────────
  // Instead of manipulating classes on DOM elements (which React can
  // blow away during reconciliation), we use a <style> tag with CSS
  // selectors. This approach survives React re-renders completely.

  function ensureStyleTag() {
    if (!styleTag) {
      styleTag = document.getElementById(VISIBILITY_STYLE_ID);
    }
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = VISIBILITY_STYLE_ID;
      document.head.appendChild(styleTag);
    }
    return styleTag;
  }

  // ChatGPT handles turn virtualization. Rel.AI keeps every turn visible and
  // uses Clean Memory only for deliberate full reloads between conversations.
  function applyVisibility() {
    totalTurns = getTurns().length;
    ensureStyleTag().textContent = TURN_SELECTOR + ' { display: revert !important; }';
  }


  // ── Mutation Observer (new messages) ──────────────────────────────

  let mutationDebounce = null;
  let newMsgObs = null;
  function setupMutationObserver() {
    if (!chatContainer) return;
    // Disconnect any prior observer so repeated SPA re-inits (back/forward,
    // programmatic nav) don't leak one live observer per navigation.
    if (newMsgObs) { newMsgObs.disconnect(); newMsgObs = null; }

    const obs = new MutationObserver((mutations) => {
      // Only care about actual new conversation turns being added
      let hasNewTurn = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE &&
              (node.matches?.(TURN_SELECTOR) || node.querySelector?.(TURN_SELECTOR))) {
            hasNewTurn = true;
            break;
          }
        }
        if (hasNewTurn) break;
      }

      if (hasNewTurn) {
        clearTimeout(mutationDebounce);
        mutationDebounce = setTimeout(() => {
          const newTotal = getTurns().length;
          if (newTotal > totalTurns) {
            const added = newTotal - totalTurns;
            totalTurns = newTotal;
            applyVisibility();
            log('New messages detected:', added, '→ total:', totalTurns);
          }
        }, 800);
      }
    });

    obs.observe(chatContainer, { childList: true, subtree: false });
    newMsgObs = obs;
  }

  // ── Force Full Reload on Chat Switch ───────────────────────────
  // ChatGPT's SPA keeps old conversation data in memory, causing
  // CPU/memory bloat. We intercept sidebar chat clicks and force
  // a full page reload, which clears all previous state.

  function interceptChatLinks() {
    document.addEventListener('click', (e) => {
      // Clean Memory performs a fresh reload when switching conversations so
      // ChatGPT can release state accumulated by the previous conversation.
      // When off, leave ChatGPT's native SPA navigation alone.
      if (!cleanMemoryActive) return;
      const link = e.target.closest('nav a[href^="/c/"], nav a[href="/"]');
      if (!link) return;

      const href = link.getAttribute('href');
      // Don't reload if clicking the current chat
      if (location.pathname === href) return;

      // Smart mode: skip the disruptive full reload unless memory is actually
      // under pressure — reload only when the heap is large (>800MB) or the user
      // has switched chats several times this session. Otherwise let ChatGPT's
      // fast SPA nav run and just count the switch.
      if (toolPrefs.cleanMemorySmart) {
        const heap = (performance.memory && performance.memory.usedJSHeapSize) || 0;
        let switches = 0;
        try { switches = parseInt(sessionStorage.getItem('relaiSwitchCount') || '0', 10) || 0; } catch (_) {}
        const pressure = heap > 800 * 1024 * 1024 || switches >= 5;
        if (!pressure) {
          try { sessionStorage.setItem('relaiSwitchCount', String(switches + 1)); } catch (_) {}
          return; // let the SPA navigation proceed
        }
        try { sessionStorage.setItem('relaiSwitchCount', '0'); } catch (_) {}
      }

      // Force full page reload instead of SPA navigation. Preserve any unsent
      // draft and record heap-before so the freed-memory stat can be computed
      // after the reload.
      saveDraftBeforeReload();
      recordCleanBefore();
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      log('Forcing full reload →', href);
      window.location.href = href;
    }, true); // capture phase to beat React's handler
  }

  // Fallback SPA observer for non-sidebar navigations (back button, etc.)
  let spaDebounce = null;
  let spaPollTimer = null;
  function handleSPANavigation() {
    if (location.href === lastURL) return;
    lastURL = location.href;
    // Debounce to prevent rapid re-init loops
    if (spaDebounce) clearTimeout(spaDebounce);
    spaDebounce = setTimeout(() => {
      log('SPA navigation detected, re-initializing...');
      teardown();
      showLoadingIndicator();
      waitForTurns();
    }, 300);
  }
  function setupSPAObserver() {
    // Modern path (Chrome): the Navigation API fires on SPA route changes, so
    // no timer is needed.
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', () => setTimeout(handleSPANavigation, 0));
      return;
    }
    // Browser-native history events catch back/forward immediately. A slower
    // fallback timer remains for frameworks that call pushState without
    // dispatching an observable navigation event in the isolated world.
    window.addEventListener('popstate', handleSPANavigation);
    window.addEventListener('hashchange', handleSPANavigation);
    spaPollTimer = setInterval(handleSPANavigation, 1500);
    window.addEventListener('pagehide', () => {
      if (spaPollTimer) clearInterval(spaPollTimer);
      spaPollTimer = null;
      if (spaDebounce) clearTimeout(spaDebounce);
      spaDebounce = null;
    }, { once: true });
  }

  // ── Reactive Turn Detection ─────────────────────────────────────
  // Instead of polling every 1500ms, use MutationObserver to detect
  // turns the INSTANT they appear in the DOM.

  function isNewChatPage() {
    const path = location.pathname;
    return path === '/' || path === '' || !path.startsWith('/c/');
  }

  function waitForTurns() {
    // New/empty chat — no turns expected, don't show loading
    if (isNewChatPage()) {
      log('New chat page, no turns to wait for');
      removeLoadingIndicator();
      ensureStyleTag().textContent = TURN_SELECTOR + ' { display: revert !important; }';
      return;
    }

    // Check immediately first
    if (getTurns().length > 0) {
      init();
      return;
    }

    log('Waiting for turns...');
    const obs = new MutationObserver(() => {
      const turns = getTurns();
      if (turns.length > 0) {
        obs.disconnect();
        log('Turns detected! (' + turns.length + ')');
        init();
      }
    });

    const target = document.querySelector('main') || document.body;
    obs.observe(target, { childList: true, subtree: true });

    // Safety timeout: if no turns after 15s, clear loading
    setTimeout(() => {
      obs.disconnect();
      if (!isInitialized) {
        log('Timeout, clearing loading state');
        removeLoadingIndicator();
        ensureStyleTag().textContent = TURN_SELECTOR + ' { display: revert !important; }';
      }
    }, 15000);
  }

  // ── Notification Hiding ───────────────────────────────────────────

  function applyNotificationHiding(hide) {
    hideNotifications = hide;
    const existing = document.getElementById(NOTIFICATION_STYLE_ID);
    if (hide) {
      if (!existing) {
        const s = document.createElement('style');
        s.id = NOTIFICATION_STYLE_ID;
        s.textContent =
          '[data-testid="toast-notification"],' +
          '[aria-label*="notification"],' +
          '[data-notification-id]{display:none!important}';
        document.head.appendChild(s);
      }
    } else {
      if (existing) existing.remove();
    }
  }

  // ── Performance Features ──────────────────────────────────────────
  // Eight optional optimizations toggled from the popup. All are available to
  // every user; conservative defaults keep the heavier options opt-in.

  const PERF_DEFAULTS = {
    perfResourceHints: true,
    perfReduceAnim: true,
    perfOptimizeDom: true,
    perfFontSwap: true,
    perfLazyImg: true,
    perfBlockTrackers: false,
    perfKeepSession: false,
    perfDeferScripts: false
  };
  const PERF_KEYS = Object.keys(PERF_DEFAULTS);
  let perfPrefs = { ...PERF_DEFAULTS };

  // Known analytics/telemetry hosts neutralized by Block Trackers.
  const TRACKER_HOSTS = [
    'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
    'segment.com', 'segment.io', 'statsig.com', 'featuregates.org',
    'mixpanel.com', 'amplitude.com', 'fullstory.com', 'hotjar.com',
    'intercom.io', 'browser-intake'
  ];

  const perfState = { lazyObs: null, trackerObs: null, keepAliveTimer: null, deferObs: null };

  // Create/update/remove a managed <style> tag. Pass css=null to remove.
  function perfStyle(id, css) {
    let el = document.getElementById(id);
    if (css == null) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
  }

  // 1. Resource Hints — preconnect / dns-prefetch to ChatGPT origins.
  function applyResourceHints(on) {
    document.querySelectorAll('link.relai-perf-hint').forEach(l => l.remove());
    if (!on) return;
    const hosts = [
      'https://chatgpt.com', 'https://ab.chatgpt.com',
      'https://cdn.oaistatic.com', 'https://persistent.oaistatic.com',
      'https://files.oaiusercontent.com'
    ];
    const head = document.head || document.documentElement;
    for (const h of hosts) {
      for (const rel of ['preconnect', 'dns-prefetch']) {
        const link = document.createElement('link');
        link.className = 'relai-perf-hint';
        link.rel = rel;
        link.href = h;
        if (rel === 'preconnect') link.crossOrigin = 'anonymous';
        head.appendChild(link);
      }
    }
  }

  // 2. Reduce Animations — shorten transitions, tame decorative motion.
  function applyReduceAnim(on) {
    perfStyle('relai-perf-reduce-anim', on
      ? '*,*::before,*::after{animation-duration:.4s!important;' +
        'transition-duration:.12s!important}html{scroll-behavior:auto!important}'
      : null);
  }

  // 3. Optimize DOM — isolate each turn's layout to cut reflow cost.
  // NOTE: we deliberately do NOT use content-visibility:auto here. It skips
  // painting off-screen turns, which fights both Clean Memory's dynamic
  // show/hide and ChatGPT's own native virtualization on huge threads — the
  // revealed turns never repaint and the conversation goes black on scroll-up.
  // `contain: layout` isolates internal reflow without ever skipping paint.
  function applyOptimizeDom(on) {
    perfStyle('relai-perf-optimize-dom', on ? TURN_SELECTOR + '{contain:layout}' : null);
  }

  // 4. Font Optimization — minor: avoid synthetic faces (honest: small effect).
  function applyFontSwap(on) {
    perfStyle('relai-perf-font', on ? '*{font-synthesis:none!important}' : null);
  }

  // 5. Image Optimization — lazy-load + async-decode images.
  function tagImage(img) {
    if (img.dataset.relaiLazy) return;
    img.dataset.relaiLazy = '1';
    if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
    if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
  }
  function applyLazyImg(on) {
    if (perfState.lazyObs) { perfState.lazyObs.disconnect(); perfState.lazyObs = null; }
    if (!on) return;
    document.querySelectorAll('img').forEach(tagImage);
    perfState.lazyObs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') tagImage(n);
        else n.querySelectorAll?.('img').forEach(tagImage);
      }
    });
    perfState.lazyObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 6. Block Trackers — strip known analytics nodes as they appear.
  // Best-effort: no network-level blocking (would need extra permissions).
  function isTracker(url) {
    return !!url && TRACKER_HOSTS.some(h => url.includes(h));
  }
  function stripIfTracker(n) {
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (tag !== 'SCRIPT' && tag !== 'IFRAME' && tag !== 'IMG') return;
    if (isTracker(n.getAttribute('src') || n.getAttribute('href'))) {
      try { n.remove(); } catch (_) {}
    }
  }
  function applyBlockTrackers(on) {
    if (perfState.trackerObs) { perfState.trackerObs.disconnect(); perfState.trackerObs = null; }
    if (!on) return;
    document.querySelectorAll('script[src],iframe[src],img[src]').forEach(stripIfTracker);
    perfState.trackerObs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        stripIfTracker(n);
        if (n.nodeType === 1) n.querySelectorAll?.('script[src],iframe[src],img[src]').forEach(stripIfTracker);
      }
    });
    perfState.trackerObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 7. Keep Session — refresh the auth session to avoid idle logout.
  function applyKeepSession(on) {
    if (perfState.keepAliveTimer) { clearInterval(perfState.keepAliveTimer); perfState.keepAliveTimer = null; }
    if (!on) return;
    const ping = () => {
      try { fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' }).catch(() => {}); } catch (_) {}
    };
    perfState.keepAliveTimer = setInterval(ping, 4 * 60 * 1000); // every 4 min, same-origin
  }

  // 8. Defer Non-Essential — lower priority of off-screen media/iframes.
  function tagDefer(el) {
    if (el.dataset.relaiDefer) return;
    el.dataset.relaiDefer = '1';
    try { el.setAttribute('fetchpriority', 'low'); } catch (_) {}
    if (el.tagName === 'IFRAME' && !el.hasAttribute('loading')) el.setAttribute('loading', 'lazy');
  }
  function applyDeferScripts(on) {
    if (perfState.deferObs) { perfState.deferObs.disconnect(); perfState.deferObs = null; }
    if (!on) return;
    document.querySelectorAll('iframe,video,audio').forEach(tagDefer);
    perfState.deferObs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IFRAME' || n.tagName === 'VIDEO' || n.tagName === 'AUDIO') tagDefer(n);
        else n.querySelectorAll?.('iframe,video,audio').forEach(tagDefer);
      }
    });
    perfState.deferObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Orchestrator — apply each feature from its stored preference.
  function applyPerfFeatures() {
    const eff = (key) => perfPrefs[key];
    applyResourceHints(eff('perfResourceHints'));
    applyReduceAnim(eff('perfReduceAnim'));
    applyOptimizeDom(eff('perfOptimizeDom'));
    applyFontSwap(eff('perfFontSwap'));
    applyLazyImg(eff('perfLazyImg'));
    applyBlockTrackers(eff('perfBlockTrackers'));
    applyKeepSession(eff('perfKeepSession'));
    applyDeferScripts(eff('perfDeferScripts'));
  }

  // ── Stats ─────────────────────────────────────────────────────────

  function getStats() {
    const currentTotal = getTurns().length;
    if (currentTotal > 0) totalTurns = currentTotal;
    // No CSS virtualization anymore — ChatGPT renders/unmounts on its own, so
    // there is no "hidden" set to report. Surface the real message count;
    // cleanMemory reflects whether Clean Memory mode is active.
    return { total: totalTurns, rendered: totalTurns, memorySaved: '0.0', cleanMemory: cleanMemoryActive };
  }

  // ── Preferences ───────────────────────────────────────────────────

  function applyPreferences(prefs) {
    if (!prefs) return;

    if (typeof prefs.hideNotifications === 'boolean') {
      applyNotificationHiding(prefs.hideNotifications);
    }

    if (typeof prefs.cleanMemoryEnabled === 'boolean') {
      cleanMemoryActive = prefs.cleanMemoryEnabled;
    }

    // Performance feature toggles
    let perfChanged = false;
    for (const k of PERF_KEYS) {
      if (typeof prefs[k] === 'boolean') { perfPrefs[k] = prefs[k]; perfChanged = true; }
    }
    if (perfChanged) applyPerfFeatures();

    // Tool feature toggles
    let toolChanged = false;
    for (const k of TOOL_KEYS) {
      if (typeof prefs[k] === 'boolean') { toolPrefs[k] = prefs[k]; toolChanged = true; }
    }
    if (toolChanged) applyToolFeatures();
  }

  function loadStoredState() {
    return new Promise(resolve => {
      chrome.storage.local.get(
        ['cleanMemoryEnabled', 'hideNotifications', ...PERF_KEYS, ...TOOL_KEYS],
        result => {
          cleanMemoryActive = result.cleanMemoryEnabled !== false;

          if (typeof result.hideNotifications === 'boolean') {
            applyNotificationHiding(result.hideNotifications);
          }

          // Load performance prefs (fall back to curated defaults) and apply
          for (const k of PERF_KEYS) {
            if (typeof result[k] === 'boolean') perfPrefs[k] = result[k];
          }
          applyPerfFeatures();

          // Load tool prefs and apply widgets/features
          for (const k of TOOL_KEYS) {
            if (typeof result[k] === 'boolean') toolPrefs[k] = result[k];
          }
          applyToolFeatures();

          log('Clean Memory:', cleanMemoryActive);
          resolve(true);
        }
      );
    });
  }

  // ── Message Listener ──────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case 'GET_STATS':
        sendResponse(getStats());
        break;
      case 'PREFS_UPDATED':
        applyPreferences(msg.prefs);
        sendResponse({ ok: true });
        break;
      case 'GET_PERF_METRICS':
        getPerfMetrics().then(sendResponse);
        return true;
      default:
        return false; // Allow other listeners to handle unrelated messages.
    }
    return true;
  });

  // ── Selection Mode State ──────────────────────────────────────────
  // Strategy: Inject checkbox elements as DIRECT CHILDREN of each turn
  // (not floating overlays in body). This eliminates scroll listeners
  // entirely and lets the browser handle positioning natively. We use
  // a MutationObserver to detect React re-renders and re-inject.

  let selectionMode = false;
  const selectedIds = new Set();   // data-testid attribute values
  const overlayLabels = new Map(); // testId → label element (for re-render check)
  let selMutationObs = null;

  function toggleSelectionMode(enabled) {
    selectionMode = !!enabled;
    if (selectionMode) {
      // Apply CSS class globally — handles position:relative on all turns
      // via stylesheet (no getComputedStyle / inline style writes per turn).
      document.documentElement.classList.add('relai-sel-mode');
      injectAllCheckboxes();
      // Watch for React re-renders that wipe our checkboxes
      if (chatContainer) {
        selMutationObs = new MutationObserver(() => {
          if (!selectionMode) return;
          // Throttle via rAF to avoid loops
          if (selMutationObs._scheduled) return;
          selMutationObs._scheduled = true;
          requestAnimationFrame(() => {
            selMutationObs._scheduled = false;
            injectAllCheckboxes();
          });
        });
        selMutationObs.observe(chatContainer, { childList: true, subtree: false });
      }
    } else {
      document.documentElement.classList.remove('relai-sel-mode');
      removeAllCheckboxes();
      if (selMutationObs) {
        selMutationObs.disconnect();
        selMutationObs = null;
      }
      // NOTE: do NOT clear selectedIds here — we want state to persist
      // so the popup can restore the selection UI on reopen.
    }
  }

  // Inject a selection checkbox into every conversation turn. We avoid any
  // per-turn offsetParent / getComputedStyle layout reads (positioning is
  // handled by a single CSS rule) so this stays cheap on 300+ message chats.
  function injectAllCheckboxes() {
    const turns = getTurns();
    const total = turns.length;
    if (total === 0) return;

    // No CSS virtualization anymore — every turn is display:revert, so
    // selection checkboxes inject across the whole thread.
    const start = 0;

    for (let i = start; i < total; i++) {
      const turn = turns[i];
      if (!turn) continue;
      const testId = turn.getAttribute('data-testid');
      if (!testId) continue;
      // Skip if this turn already has our checkbox (direct-child query, no
      // layout). The label is appended as the LAST child, so a firstElementChild
      // test never matched — duplicates piled up on every re-inject pass.
      if (turn.querySelector(':scope > .relai-sel-label')) continue;

      const label = document.createElement('label');
      label.className = 'relai-sel-label';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedIds.has(testId);
      if (checkbox.checked) label.classList.add('relai-sel-checked');

      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        onTurnCheckboxChange(testId, checkbox.checked);
        if (checkbox.checked) label.classList.add('relai-sel-checked');
        else label.classList.remove('relai-sel-checked');
      });

      // Prevent click from bubbling to ChatGPT's own click handlers
      label.addEventListener('click', (e) => e.stopPropagation());

      label.appendChild(checkbox);
      turn.appendChild(label);
      overlayLabels.set(testId, label);
    }
  }

  function removeAllCheckboxes() {
    document.querySelectorAll('.relai-sel-label').forEach(el => el.remove());
    overlayLabels.clear();
  }

  // Find the testId of the adjacent turn that pairs with this one:
  // user → next assistant ; assistant → previous user.
  // Uses direct DOM lookup + sibling traversal — O(1), avoids iterating
  // all turns (which can be 300+ in long chats).
  function findPairedTestId(testId) {
    const turn = document.querySelector('[data-testid="' + testId + '"]');
    if (!turn) return null;
    // Prefer the turn's own data-turn (survives virtualization); fall back to
    // the inner author-role element for older DOMs.
    const role = turn.getAttribute('data-turn')
      || turn.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');

    // Resolve the adjacent turn across two DOM shapes:
    //   old: turns are direct siblings          → turn.nextElementSibling IS a turn
    //   new: each turn lives in its own wrapper  → hop wrapper→wrapper, then re-query
    const adjacentTurn = (dir /* 'next' | 'prev' */) => {
      const sibProp = dir === 'next' ? 'nextElementSibling' : 'previousElementSibling';
      const direct = turn[sibProp];
      if (direct && direct.matches?.(TURN_SELECTOR)) return direct;
      // getTurnWrapper resolves the real wrapper DIV (the <section> itself also
      // carries data-turn-id-container, so closest() from the turn is wrong).
      const wrapper = getTurnWrapper(turn);
      const wrapSib = wrapper && wrapper !== turn && wrapper[sibProp];
      return wrapSib?.querySelector?.(TURN_SELECTOR) || null;
    };
    const roleOf = (el) => el.getAttribute('data-turn')
      || el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');

    if (role === 'user') {
      const next = adjacentTurn('next');
      if (next && roleOf(next) === 'assistant') return next.getAttribute('data-testid') || null;
    } else if (role === 'assistant') {
      const prev = adjacentTurn('prev');
      if (prev && roleOf(prev) === 'user') return prev.getAttribute('data-testid') || null;
    }
    return null;
  }

  // Apply check state to a testId WITHOUT re-firing the change handler
  // (avoids infinite recursion when the pair updates the original).
  function setCheckboxState(testId, checked) {
    if (checked) selectedIds.add(testId);
    else selectedIds.delete(testId);
    const label = overlayLabels.get(testId);
    if (label) {
      const cb = label.querySelector('input[type=checkbox]');
      if (cb && cb.checked !== checked) cb.checked = checked;
      if (checked) label.classList.add('relai-sel-checked');
      else label.classList.remove('relai-sel-checked');
    }
  }

  function onTurnCheckboxChange(testId, checked) {
    // Apply state to the clicked one
    if (checked) selectedIds.add(testId);
    else selectedIds.delete(testId);

    // Auto-pair: mirror the state on the adjacent paired turn
    const pairedId = findPairedTestId(testId);
    if (pairedId) setCheckboxState(pairedId, checked);
  }

  // ── Content Extraction ────────────────────────────────────────────

  // Bridge to MAIN world helper (main-world.js) — content scripts run
  // in an isolated world and CANNOT access __reactFiber* on DOM elements.
  // We dispatch a CustomEvent to main-world.js, which walks the fibers
  // and writes the result to a documentElement attribute (synchronously).
  // Returns: { [testId]: { create_time, update_time, id } }
  function getAllTimestampsFromMainWorld() {
    try {
      // Clear any prior payload
      document.documentElement.removeAttribute('data-relai-ts-payload');
      // Dispatch synchronous event — main-world.js handler runs immediately
      document.dispatchEvent(new Event('relai-extract-ts'));
      const payload = document.documentElement.getAttribute('data-relai-ts-payload');
      if (!payload) return {};
      return JSON.parse(payload) || {};
    } catch {
      return {};
    }
  }

  // Extract a single turn's content into a message object.
  function extractTurn(turn, tsMap) {
    const roleEl = turn.querySelector('[data-message-author-role]');
    // Role: prefer the inner author-role element; fall back to the turn's own
    // data-turn attribute (present even on collapsed/virtualized turns).
    const role = roleEl?.getAttribute('data-message-author-role')
      || turn.getAttribute('data-turn')
      || 'unknown';
    // Use the role element directly as content container.
    // For user turns: contains text + uploaded images (no .markdown/.prose).
    // For assistant turns: contains .markdown/.prose internally.
    // Falls back to .markdown/.prose if role element missing.
    const contentEl = roleEl || turn.querySelector('.markdown, .prose') || turn;
    const text = cleanText(contentEl);
    const codeBlocks = extractCodeBlocks(contentEl);
    const html = sanitizeHTML(contentEl);
    const testId = turn.getAttribute('data-testid');
    const meta = (testId && tsMap[testId]) || {};
    return {
      role,
      text,
      codeBlocks,
      html,
      index: 0,
      createTime: meta.create_time || null,
      updateTime: meta.update_time || null,
      messageId: meta.id || null
    };
  }

  // A turn is "mounted" when ChatGPT has actually rendered its message content.
  // ChatGPT natively virtualizes long conversations: off-screen turns collapse
  // to height-preserving spacers — the <section> + data-testid persist, but the
  // inner [data-message-author-role] / text is unmounted. Reading such a turn
  // yields empty content; that silent gap is the export bug this code fixes.
  function isTurnMounted(turn) {
    if (turn.querySelector('[data-message-author-role]')) return true;
    return (turn.textContent || '').trim().length > 0;
  }

  // Synchronous fast path: extract straight from the current DOM. Correct ONLY
  // when every exportable turn is already mounted (short chats, or after
  // collectConversation has forced everything to mount). Runs in the same tick,
  // so the user gesture survives for PDF's window.open.
  function extractConversation(onlySelected) {
    const turns = Array.from(getTurns());
    const filtered = onlySelected
      ? turns.filter(t => selectedIds.has(t.getAttribute('data-testid')))
      : turns;

    // Fetch all timestamps in one batch (single event dispatch)
    const tsMap = getAllTimestampsFromMainWorld();

    // Omit turns whose extracted content is empty (virtualized spacers, or the
    // reasoning-only "Thought for Xs" rows) so they don't render as blank blocks.
    const out = [];
    for (const turn of filtered) {
      const msg = extractTurn(turn, tsMap);
      if (!msg.text || !msg.text.trim()) continue;
      msg.index = out.length;
      out.push(msg);
    }
    return out;
  }

  // How many of the turns we intend to export are NOT yet mounted.
  function countExportableGaps(onlySelected) {
    let total = 0, missing = 0;
    for (const turn of getTurns()) {
      if (onlySelected && !selectedIds.has(turn.getAttribute('data-testid'))) continue;
      total++;
      if (!isTurnMounted(turn)) missing++;
    }
    return { total, missing };
  }

  const _delay = (ms) => new Promise(r => setTimeout(r, ms));

  // Async path for virtualized conversations. Temporarily reveals every turn
  // (so each gets a layout box and ChatGPT will mount it — display:none turns
  // never mount), scrolls through the whole thread capturing each turn's
  // content as it mounts, then restores the previous visibility + scroll
  // position. Captured data is keyed by the stable data-turn-id so turns that
  // unmount again during the pass don't lose their content.
  async function collectConversation(onlySelected) {
    const sc = scrollContainer || findScrollContainer(getTurns()[0]);
    if (!sc) return extractConversation(onlySelected); // no scroller → best effort

    const wantSel = onlySelected ? new Set(selectedIds) : null;
    const keyOf = (turn) =>
      turn.getAttribute('data-turn-id') || turn.getAttribute('data-testid');

    const cache = new Map();
    const tsMap = getAllTimestampsFromMainWorld();

    const captureMounted = () => {
      for (const turn of getTurns()) {
        if (wantSel && !wantSel.has(turn.getAttribute('data-testid'))) continue;
        const key = keyOf(turn);
        if (!key || cache.has(key) || !isTurnMounted(turn)) continue;
        cache.set(key, extractTurn(turn, tsMap));
      }
    };

    // Stable set of keys we must collect
    const targetKeys = new Set();
    for (const turn of getTurns()) {
      if (wantSel && !wantSel.has(turn.getAttribute('data-testid'))) continue;
      targetKeys.add(keyOf(turn));
    }

    // Preserve state to restore afterwards
    const savedStyle = ensureStyleTag().textContent;
    const savedScroll = sc.scrollTop;

    try {
      // Reveal ALL turns so ChatGPT mounts them as they scroll into view
      ensureStyleTag().textContent = TURN_SELECTOR + ' { display: revert !important; }';
      await _delay(60);
      captureMounted();

      const step = Math.max(400, Math.floor(sc.clientHeight * 0.85));
      for (let pos = 0; pos <= sc.scrollHeight && cache.size < targetKeys.size; pos += step) {
        sc.scrollTop = pos;
        await _delay(85);
        Object.assign(tsMap, getAllTimestampsFromMainWorld());
        captureMounted();
        updateExportProgress(cache.size, targetKeys.size);
      }

      // Cleanup pass: scroll any still-missing turns directly into view
      if (cache.size < targetKeys.size) {
        for (const turn of getTurns()) {
          if (cache.size >= targetKeys.size) break;
          if (wantSel && !wantSel.has(turn.getAttribute('data-testid'))) continue;
          const key = keyOf(turn);
          if (!key || cache.has(key)) continue;
          turn.scrollIntoView({ block: 'center' });
          await _delay(110);
          Object.assign(tsMap, getAllTimestampsFromMainWorld());
          if (isTurnMounted(turn)) cache.set(key, extractTurn(turn, tsMap));
          updateExportProgress(cache.size, targetKeys.size);
        }
      }
    } finally {
      // Restore previous visibility + scroll position even if extraction throws
      // mid-pass — otherwise the long chat is left fully revealed (Clean Memory
      // defeated) and the scroll position is never restored.
      ensureStyleTag().textContent = savedStyle;
      requestAnimationFrame(() => { sc.scrollTop = savedScroll; });
    }

    // Assemble in DOM order using the stable testid sequence, omitting turns
    // whose content came back empty (virtualized spacers / reasoning-only rows).
    const ordered = [];
    for (const turn of getTurns()) {
      if (wantSel && !wantSel.has(turn.getAttribute('data-testid'))) continue;
      const data = cache.get(keyOf(turn)) || extractTurn(turn, tsMap);
      if (!data.text || !data.text.trim()) continue;
      data.index = ordered.length;
      ordered.push(data);
    }
    return ordered;
  }

  // ── Export progress overlay ───────────────────────────────────────
  function showExportProgress() {
    let el = document.getElementById('relai-export-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'relai-export-progress';
      el.style.cssText =
        'position:fixed;z-index:2147483647;bottom:20px;right:20px;display:flex;' +
        'align-items:center;gap:10px;background:#1f2937;color:#fff;padding:12px 16px;' +
        'border-radius:10px;font:13px ui-sans-serif,system-ui,sans-serif;' +
        'box-shadow:0 4px 20px rgba(0,0,0,.35);';
      el.innerHTML =
        '<div class="relai-spinner" style="display:block;width:16px;height:16px;"></div>' +
        '<span class="relai-export-progress-text"></span>';
      (document.body || document.documentElement).appendChild(el);
    }
    updateExportProgress(0, 0);
  }
  function updateExportProgress(done, total) {
    const span = document.getElementById('relai-export-progress')
      ?.querySelector('.relai-export-progress-text');
    if (span) span.textContent = t('exporting') + '  ' + done + (total ? '/' + total : '');
  }
  function hideExportProgress() {
    document.getElementById('relai-export-progress')?.remove();
  }

  // Format UNIX timestamp (seconds) → human-readable string
  function formatTimestamp(unixSeconds) {
    if (!unixSeconds || typeof unixSeconds !== 'number') return '';
    try {
      const d = new Date(unixSeconds * 1000);
      // Locale-aware: dd/mm/yyyy hh:mm in user's locale
      return d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return '';
    }
  }

  function cleanText(el) {
    if (!el) return '';

    // Clone to avoid modifying live DOM
    const clone = el.cloneNode(true);

    // Unwrap buttons containing images so we don't lose the [Image] marker
    clone.querySelectorAll('button').forEach(btn => {
      const img = btn.querySelector('img');
      if (img) {
        btn.replaceWith(img.cloneNode(true));
      } else {
        btn.remove();
      }
    });

    // Strip remaining UI chrome elements
    clone.querySelectorAll('.sr-only, [aria-hidden="true"], .copy-code-btn, [class*="copy-button"]')
      .forEach(n => n.remove());

    // Strip "Tú dijiste:" / "You said:" / "ChatGPT Plus" prefixes
    clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      const txt = h.textContent.trim();
      if (/^(Tú dijiste|You said|ChatGPT)/i.test(txt)) h.remove();
    });

    // Walk and build clean text
    let result = '';

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();

      // Skip pre>code (handled by extractCodeBlocks)
      if (tag === 'pre') {
        result += '\n' + t('codeBlockMarker') + '\n';
        return;
      }
      if (tag === 'img') {
        result += t('imageMarker');
        return;
      }
      // Math elements (KaTeX)
      if (node.classList && (node.classList.contains('katex') || node.classList.contains('katex-html'))) {
        const latex = node.getAttribute('aria-label') || node.textContent;
        result += t('mathMarker', [latex.trim()]);
        return;
      }
      // Tables
      if (tag === 'table') {
        node.querySelectorAll('tr').forEach(row => {
          const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim());
          result += cells.join(' | ') + '\n';
        });
        return;
      }
      // Inline code
      if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') {
        result += '`' + node.textContent + '`';
        return;
      }

      // Recurse children
      for (const child of node.childNodes) walk(child);

      // Add newlines after block elements
      if (['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'br', 'tr'].includes(tag)) {
        result += '\n';
      }
    }

    walk(clone);

    // Normalize whitespace
    return result.replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractCodeBlocks(el) {
    if (!el) return [];
    const blocks = [];
    el.querySelectorAll('pre').forEach(pre => {
      const cmLines = pre.querySelectorAll('.cm-line');
      if (cmLines.length) {
        // ChatGPT now renders code with CodeMirror: each source line is a
        // <div class="cm-line">, so pre.textContent has NO line breaks. Rebuild
        // the source from the line divs. Language isn't reliably present here.
        const langEl = pre.querySelector('[class*="language-"]');
        const langMatch = langEl && langEl.className.match(/language-(\w+)/);
        const code = Array.from(cmLines).map(l => l.textContent).join('\n');
        blocks.push({ lang: langMatch ? langMatch[1] : '', code });
        return;
      }
      const code = pre.querySelector('code');
      if (code) {
        const langMatch = code.className.match(/language-(\w+)/);
        blocks.push({ lang: langMatch ? langMatch[1] : '', code: code.textContent });
        return;
      }
      // Plain <pre> without <code> — still capture its text.
      const txt = pre.textContent;
      if (txt && txt.trim()) blocks.push({ lang: '', code: txt });
    });
    return blocks;
  }

  function sanitizeHTML(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);

    // Preserve images BEFORE button removal: ChatGPT user uploads are
    // wrapped in <button class="..."><img/></button> — if we remove the
    // button we lose the image. Unwrap such buttons first.
    clone.querySelectorAll('button').forEach(btn => {
      const img = btn.querySelector('img');
      if (img) {
        // Replace button with the image itself (preserving src/alt)
        btn.replaceWith(img.cloneNode(true));
      } else {
        btn.remove();
      }
    });

    // Now safe to remove other UI chrome (no buttons left wrapping images)
    clone.querySelectorAll('.sr-only, [aria-hidden="true"], svg, .copy-code-btn, [class*="copy-button"]')
      .forEach(n => n.remove());
    clone.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      const txt = h.textContent.trim();
      if (/^(Tú dijiste|You said|ChatGPT)/i.test(txt)) h.remove();
    });

    // Strip data-* attrs that bloat the HTML but keep src/alt/href/class
    clone.querySelectorAll('*').forEach(node => {
      Array.from(node.attributes).forEach(attr => {
        if (attr.name.startsWith('data-') ||
            attr.name.startsWith('aria-') ||
            attr.name === 'tabindex' ||
            attr.name === 'role' ||
            attr.name === 'contenteditable') {
          node.removeAttribute(attr.name);
        }
      });
    });

    // Make image src absolute (ChatGPT uses absolute URLs already, but
    // be defensive against any relative paths)
    clone.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('http') && !src.startsWith('data:')) {
        try {
          img.src = new URL(src, location.origin).href;
        } catch {}
      }
      // Add inline max-width for print
      if (!img.style.maxWidth) img.style.maxWidth = '100%';
    });

    return clone.innerHTML;
  }

  // ── Export Builders ───────────────────────────────────────────────

  function buildTXT(messages) {
    const lines = [];
    const sep = '─'.repeat(60);
    const exportDate = new Date().toLocaleString();
    lines.push(t('exportTitle'));
    lines.push(t('exportDate') + ': ' + exportDate);
    lines.push(t('exportMsgCount') + ': ' + messages.length);
    lines.push('');
    messages.forEach((msg, i) => {
      const roleLabel = msg.role === 'user' ? t('roleUser')
                      : msg.role === 'assistant' ? t('roleAssistant')
                      : t('roleUnknown');
      const ts = formatTimestamp(msg.createTime);
      const tsSuffix = ts ? '  ·  ' + ts : '';
      lines.push(sep);
      lines.push(t('messageNum', [String(i + 1)]) + ' — ' + roleLabel + tsSuffix);
      lines.push(sep);
      lines.push('');
      lines.push(msg.text);
      msg.codeBlocks.forEach(block => {
        lines.push('');
        lines.push('```' + (block.lang || ''));
        lines.push(block.code);
        lines.push('```');
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  function buildHTML(messages, forWord) {
    const wordNs = forWord
      ? ` xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"`
      : '';

    const css = `
      @page { margin: 2cm; }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #111;
        max-width: 800px;
        margin: 0 auto;
        padding: 20px;
      }
      h1 { font-size: 22px; margin-bottom: 4px; color: #111; }
      .meta { font-size: 12px; color: #6b7280; margin-bottom: 24px; }
      .turn { margin-bottom: 24px; page-break-inside: avoid; }
      .turn-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
      .ts { font-size: 11px; color: #9ca3af; font-weight: 400; text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums; }
      .role-user     { font-weight: 700; color: #0f766e; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
      .role-assistant{ font-weight: 700; color: #1d4ed8; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
      .turn-content { margin-left: 0; }
      .turn-content p { margin: 8px 0; }
      .sep { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
      pre { background: #f3f4f6; border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 13px; }
      pre code { font-family: 'Courier New', Consolas, monospace; }
      code { font-family: 'Courier New', Consolas, monospace; background: #f3f4f6; padding: 2px 4px; border-radius: 3px; }
      table { border-collapse: collapse; width: 100%; margin: 12px 0; }
      td, th { border: 1px solid #d1d5db; padding: 6px 12px; text-align: left; }
      th { background: #f9fafb; font-weight: 600; }
      img { max-width: 100%; height: auto; }
      ul, ol { margin: 8px 0; padding-left: 24px; }
      blockquote { border-left: 3px solid #d1d5db; padding-left: 12px; color: #4b5563; margin: 12px 0; }
    `;

    const turnsHtml = messages.map((msg, i) => {
      const roleLabel = msg.role === 'user' ? t('roleUser')
                       : msg.role === 'assistant' ? t('roleAssistant')
                       : t('roleUnknown');
      const roleClass = msg.role === 'user' ? 'role-user' : 'role-assistant';
      const num = i + 1;
      const ts = formatTimestamp(msg.createTime);
      const tsHtml = ts ? `<span class="ts">${escapeHtml(ts)}</span>` : '';
      const numLabel = t('messageNum', [String(num)]);
      return `<div class="turn">
  <div class="turn-header">
    <span class="${roleClass}">${escapeHtml(numLabel)} &mdash; ${escapeHtml(roleLabel)}</span>
    ${tsHtml}
  </div>
  <div class="turn-content">${msg.html || escapeHtml(msg.text)}</div>
</div>
<hr class="sep">`;
    }).join('\n');

    const exportDate = new Date().toLocaleString();
    const title = t('exportTitle');
    return `<!DOCTYPE html>
<html${wordNs}>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">${escapeHtml(t('exportDate'))}: ${exportDate} &middot; ${messages.length} ${escapeHtml(t('exportMsgCount'))}</p>
  ${turnsHtml}
</body>
</html>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\n/g, '<br>');
  }

  // ── Download / Print Triggers ─────────────────────────────────────
  // Strategy: create a Blob, then a blob: URL, then either trigger an
  // <a download> click (for TXT/Word) or window.open (for PDF print).
  // This works in BOTH Chrome and Firefox without going through the
  // background service worker (which Firefox MV3 blocks for data: URLs
  // via downloads.download).

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    // Clean up after the click is processed
    setTimeout(() => {
      try { a.remove(); } catch {}
      try { URL.revokeObjectURL(url); } catch {}
    }, 1000);
    return { success: true };
  }

  function triggerTXTDownload(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    return downloadBlob(blob, filename);
  }

  function triggerDocDownload(htmlString, filename) {
    const blob = new Blob([htmlString], { type: 'application/msword' });
    return downloadBlob(blob, filename);
  }

  function triggerPDFPrint(htmlString) {
    // Use a blob: URL so the new window loads the HTML directly via
    // standard navigation, instead of about:blank + document.write
    // (which is unreliable in Firefox and gets flagged "Insecure").
    const blob = new Blob([htmlString], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank', 'width=900,height=700');
    if (!w) {
      // Pop-up blocked — fall back to a download so the user can open it
      try { URL.revokeObjectURL(url); } catch {}
      const fallback = new Blob([htmlString], { type: 'text/html;charset=utf-8' });
      downloadBlob(fallback, 'chatgpt-conversation.html');
      return { success: true, fallback: 'html_download' };
    }
    // Trigger print after the new window finishes loading the blob
    const tryPrint = () => {
      try {
        if (w.closed) return;
        if (w.document && w.document.readyState === 'complete') {
          try { w.focus(); w.print(); } catch {}
        } else {
          setTimeout(tryPrint, 150);
        }
      } catch {
        // Cross-origin guard tripped — give up gracefully
      }
    };
    setTimeout(tryPrint, 400);
    // Keep the blob URL alive long enough for the print dialog to use it
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60000);
    return { success: true };
  }

  // ── Master Export Handler ─────────────────────────────────────────

  async function handleExport(format, onlySelected) {
    // If ChatGPT has virtualized (unmounted) any turn we intend to export,
    // collect them first by scrolling the thread. Otherwise use the fast,
    // fully-synchronous path — which keeps the user gesture intact for PDF
    // (no await runs before triggerPDFPrint's window.open).
    let messages;
    const gaps = countExportableGaps(onlySelected);
    if (gaps.missing > 0) {
      showExportProgress();
      try {
        messages = await collectConversation(onlySelected);
      } finally {
        hideExportProgress();
      }
    } else {
      messages = extractConversation(onlySelected);
    }

    if (messages.length === 0) {
      return { error: 'no_messages' };
    }

    const date = new Date().toISOString().slice(0, 10);
    const suffix = onlySelected ? 'selection' : 'all';
    const baseName = `chatgpt-${date}-${suffix}`;

    log('Exporting', messages.length, 'messages as', format);

    if (format === 'pdf') {
      const html = buildHTML(messages, false);
      return triggerPDFPrint(html);
    }

    if (format === 'word') {
      const html = buildHTML(messages, true);
      // Async but we don't await — return immediately and the download fires later
      triggerDocDownload(html, baseName + '.doc');
      return { success: true };
    }

    if (format === 'txt') {
      const text = buildTXT(messages);
      triggerTXTDownload(text, baseName + '.txt');
      return { success: true };
    }

    if (format === 'md') {
      const text = buildMD(messages);
      triggerMDDownload(text, baseName + '.md');
      return { success: true };
    }

    if (format === 'json') {
      const payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        messageCount: messages.length,
        messages
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
      return downloadBlob(blob, baseName + '.json');
    }

    return { error: 'unknown_format' };
  }

  // ── Teardown ──────────────────────────────────────────────────────

  function teardown() {
    removeLoadingIndicator();
    // Different chat → clear all selection state (testIds won't match)
    if (selectionMode) toggleSelectionMode(false);
    selectedIds.clear();
    // Disconnect the new-message observer (re-created on next init) so it
    // doesn't leak across SPA navigations, and cancel any pending debounce.
    clearTimeout(mutationDebounce);
    if (newMsgObs) { newMsgObs.disconnect(); newMsgObs = null; }
    // Clear the visibility tag (turns render normally without it now)
    ensureStyleTag().textContent = '';
    // Detach the Navigator scroll listener bound to the old chat's scroller; it
    // re-attaches on the next init via onChatReady().
    detachNavScroll();
    // Drop accumulated Hide-Thinking uuids — the next chat has different ones.
    resetHideThinkingForNewChat();
    scrollContainer = null;
    chatContainer = null;
    totalTurns = 0;
    isInitialized = false;
  }

  // ── Loading Indicator (shown during chat switch) ──────────────────

  function showLoadingIndicator() {
    removeLoadingIndicator();
    // The [class*="react-scroll-to-bottom"] container no longer exists in
    // ChatGPT's DOM — dropped from the chain.
    const container = document.querySelector('main div[class*="overflow"]')
      || document.querySelector('main')?.firstElementChild;
    if (!container) return;

    const loader = document.createElement('div');
    loader.id = 'relai-chat-loader';
    loader.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:14px;opacity:0;transition:opacity 300ms;';
    loader.innerHTML =
      '<div class="relai-spinner" style="display:block;width:22px;height:22px;"></div>' +
      '<span style="font-size:13px;color:#8e8ea0;font-family:ui-sans-serif,system-ui,sans-serif;"></span>';
    loader.querySelector('span').textContent = t('loadingConversation');

    container.prepend(loader);
    requestAnimationFrame(() => { loader.style.opacity = '1'; });
  }

  function removeLoadingIndicator() {
    document.getElementById('relai-chat-loader')?.remove();
  }

  // ── Initialization ────────────────────────────────────────────────

  function init() {
    const turns = getTurns();
    if (turns.length === 0) return false;

    removeLoadingIndicator();

    totalTurns = turns.length;
    scrollContainer = findScrollContainer(turns[0]);
    // Observe the element the turn WRAPPERS are children of, not turns[0]'s
    // immediate parent (which, in the current DOM, is a 1-child wrapper).
    chatContainer = findChatContainer(turns[0]);

    log('Found', totalTurns, 'turns');

    setupMutationObserver();
    isInitialized = true;

    // Always reveal every turn — ChatGPT virtualizes off-screen on its own.
    applyVisibility();

    // Rebind per-chat listeners for tools (Navigator scroll, scans).
    onChatReady();

    return true;
  }

  // ── Main World Bridge ─────────────────────────────────────────────
  // Inject main-world.js as a <script src="chrome-extension://..."> tag.
  // This bypasses ChatGPT's CSP (extension scripts are privileged) AND
  // runs in the page's MAIN JS world, where __reactFiber* is accessible.
  // The injected helper listens for 'relai-extract-ts' CustomEvents from
  // this isolated content script and replies via DOM attribute.

  function injectMainWorldHelper() {
    if (document.documentElement.getAttribute('data-relai-mw-ready') === '1') return;
    if (document.getElementById('relai-mw-script')) return;
    try {
      const s = document.createElement('script');
      s.id = 'relai-mw-script';
      s.src = chrome.runtime.getURL('main-world.js');
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      log('Failed to inject main-world helper:', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Tools & Widgets — Conversation Navigator, Session Stats, Smart Clean,
  // Hide Thinking, Manual Images, and Quick Open.
  // All tools are available to every user; heavier options remain opt-in.
  // ══════════════════════════════════════════════════════════════════

  const TOOL_DEFAULTS = {
    navigatorEnabled: true,   // Conversation Navigator, default ON
    hudEnabled: false,        // Session Stats chip
    cleanMemorySmart: false,  // smart memory reset (read live in interceptChatLinks)
    hideThinking: false,      // hide reasoning-only rows
    clickToLoadImg: false,    // Manual Images
    prefetchNav: false        // Quick Open; Chrome Speculation Rules on hover
    // blockTrackersNet is handled by background (DNR) — no content-side effect.
  };
  const TOOL_KEYS = Object.keys(TOOL_DEFAULTS);
  let toolPrefs = { ...TOOL_DEFAULTS };

  // Effective on/off state for features driven by the shared scan.
  const toolActive = { navigator: false, hideThinking: false, clickToLoadImg: false };

  // ── Small helpers ─────────────────────────────────────────────────
  const mb = (bytes) => Math.round((bytes || 0) / (1024 * 1024));
  function pageUsesLightTheme() {
    const candidates = [document.querySelector('main'), document.body, document.documentElement].filter(Boolean);
    for (const el of candidates) {
      try {
        const match = getComputedStyle(el).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
        if (!match || (match[4] !== undefined && Number(match[4]) < 0.1)) continue;
        const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
        return ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) > 150;
      } catch (_) {}
    }
    return false;
  }
  function syncInjectedTheme(el) {
    if (el) el.classList.toggle('relai-light', pageUsesLightTheme());
  }

  // The per-turn wrapper: in the current DOM each <section> turn lives inside a
  // [data-turn-id-container] wrapper DIV that keeps its height even when the turn
  // is virtualized. NOTE: the <section> ITSELF now also carries
  // data-turn-id-container, so closest() from the turn would return the section
  // (height 0 while virtualized). Start from the parent to land on the real
  // wrapper DIV (also marked data-is-intersecting). Fall back to the turn itself
  // for older DOMs where turns were direct siblings with no wrapper.
  function getTurnWrapper(turn) {
    const p = turn.parentElement;
    if (p && p !== turn &&
        (p.hasAttribute('data-turn-id-container') || p.hasAttribute('data-is-intersecting'))) {
      return p;
    }
    return turn;
  }

  // Find the element the turn WRAPPERS are direct children of, so our
  // MutationObservers see new turns arrive. Current DOM: each turn sits in a
  // 1-child wrapper, so the real list container is the wrapper's parent. Old
  // DOM: turns are direct siblings, so the parent is already the container.
  function findChatContainer(firstTurn) {
    if (!firstTurn) return null;
    const parent = firstTurn.parentElement;
    if (!parent) return null;
    const isWrapper = parent.hasAttribute('data-turn-id-container')
      || (parent.children.length === 1 && parent.querySelector(':scope > ' + TURN_SELECTOR));
    if (isWrapper && parent.parentElement) return parent.parentElement;
    return parent;
  }

  // ── Shared feature-scan observer ──────────────────────────────────
  // A SINGLE MutationObserver drives every DOM-scanning tool (Navigator refresh,
  // Hide Thinking and Manual Images) so we never stack up one
  // observer per feature. Passes are debounced (1s) with a 3s starvation cap so
  // continuous streaming mutations can't starve a scan forever.
  let toolScanObs = null;
  let toolScanDebounce = null;
  let toolScanLastRun = 0;

  function toolScanNeeded() {
    return toolActive.navigator || toolActive.hideThinking || toolActive.clickToLoadImg;
  }
  function scheduleToolScan() {
    clearTimeout(toolScanDebounce);
    const wait = (Date.now() - toolScanLastRun) > 3000 ? 0 : 1000;
    toolScanDebounce = setTimeout(runToolScan, wait);
  }
  function runToolScan() {
    toolScanLastRun = Date.now();
    if (toolActive.navigator) refreshNavigator();
    if (toolActive.hideThinking) scanHideThinking();
    if (toolActive.clickToLoadImg) scanClickToLoadImg();
  }
  function updateToolScanObserver() {
    if (toolScanNeeded()) {
      if (!toolScanObs) {
        toolScanObs = new MutationObserver(scheduleToolScan);
        toolScanObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      }
      runToolScan(); // immediate pass so toggling takes effect at once
    } else if (toolScanObs) {
      toolScanObs.disconnect();
      toolScanObs = null;
      clearTimeout(toolScanDebounce);
    }
  }

  // Orchestrator — apply each tool from its stored preference.
  function applyToolFeatures() {
    const eff = (key) => toolPrefs[key];
    applyNavigator(eff('navigatorEnabled'));
    applySessionStats(eff('hudEnabled'));
    applyHideThinking(eff('hideThinking'));
    applyClickToLoadImg(eff('clickToLoadImg'));
    applyPrefetch(eff('prefetchNav'));
    // cleanMemorySmart has no widget — interceptChatLinks reads it live.
    updateToolScanObserver();
  }

  // A fresh chat just mounted (called from init) — rebind per-chat listeners
  // and run one scan against the new DOM.
  function onChatReady() {
    if (toolActive.navigator) { attachNavScroll(); refreshNavigator(); }
    if (toolScanNeeded()) runToolScan();
  }

  // ── Conversation Navigator ────────────────────────────────────────
  let navWidget = null;
  let navScrollHandler = null;
  let navScrollTarget = null;
  let navScrollThrottle = null;
  let navDragging = false;

  function getUserTurns() {
    // data-turn="user" persists on the <section> even when virtualized.
    return Array.from(document.querySelectorAll(TURN_SELECTOR + '[data-turn="user"]'));
  }

  function ensureNavigator() {
    if (navWidget) return;
    navWidget = document.createElement('div');
    navWidget.id = 'relai-nav';
    navWidget.className = 'relai-nav';
    navWidget.tabIndex = 0;
    navWidget.setAttribute('role', 'slider');
    navWidget.setAttribute('aria-label', t('turnNavigator'));
    navWidget.setAttribute('aria-orientation', 'vertical');
    syncInjectedTheme(navWidget);
    navWidget.innerHTML =
      '<div class="relai-nav-track" aria-hidden="true">' +
        '<span class="relai-nav-progress"></span>' +
        '<span class="relai-nav-thumb"></span>' +
      '</div>' +
      '<span class="relai-nav-count" aria-hidden="true">1 / 1</span>';
    navWidget.addEventListener('pointerdown', onNavPointerDown);
    navWidget.addEventListener('pointermove', onNavPointerMove);
    navWidget.addEventListener('pointerup', onNavPointerUp);
    navWidget.addEventListener('pointercancel', onNavPointerUp);
    navWidget.addEventListener('keydown', onNavKeyDown);
    (document.body || document.documentElement).appendChild(navWidget);
  }
  function removeNavigator() {
    navDragging = false;
    if (navWidget) { navWidget.remove(); navWidget = null; }
  }
  function navIndexFromClientY(clientY, users) {
    if (!navWidget || !users.length) return 0;
    const track = navWidget.querySelector('.relai-nav-track');
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return Math.round(ratio * (users.length - 1));
  }
  function jumpToUserIndex(index, users) {
    if (!users.length) return;
    const next = Math.max(0, Math.min(users.length - 1, index));
    scrollToTurnWrapper(users[next]);
    setNavPosition(next, users.length);
  }
  function onNavPointerDown(e) {
    if (e.button !== 0) return;
    const users = getUserTurns();
    if (users.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    navDragging = true;
    navWidget.classList.add('relai-nav-dragging');
    try { navWidget.setPointerCapture(e.pointerId); } catch (_) {}
    jumpToUserIndex(navIndexFromClientY(e.clientY, users), users);
  }
  function onNavPointerMove(e) {
    if (!navDragging) return;
    e.preventDefault();
    const users = getUserTurns();
    jumpToUserIndex(navIndexFromClientY(e.clientY, users), users);
  }
  function onNavPointerUp(e) {
    if (!navDragging) return;
    navDragging = false;
    navWidget?.classList.remove('relai-nav-dragging');
    try { navWidget?.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  function onNavKeyDown(e) {
    const users = getUserTurns();
    if (users.length < 2) return;
    let next = currentUserIndex(users);
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next -= 1;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next += 1;
    else if (e.key === 'PageUp') next -= 5;
    else if (e.key === 'PageDown') next += 5;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = users.length - 1;
    else return;
    e.preventDefault();
    jumpToUserIndex(next, users);
  }
  function scrollToTurnWrapper(turn) {
    if (!turn) return;
    getTurnWrapper(turn).scrollIntoView({ block: 'start' });
  }
  // Index of the last user turn whose wrapper top is at/above 80px below the
  // scroller's top edge (i.e. the one currently in view).
  function currentUserIndex(users) {
    const sc = scrollContainer || findScrollContainer(users[0]);
    const scTop = sc ? sc.getBoundingClientRect().top : 0;
    let idx = 0;
    for (let i = 0; i < users.length; i++) {
      const rect = getTurnWrapper(users[i]).getBoundingClientRect();
      if (rect.top - scTop <= 80) idx = i;
      else break;
    }
    return idx;
  }
  function setNavPosition(index, total) {
    if (!navWidget || total < 1) return;
    const ratio = total > 1 ? index / (total - 1) : 0;
    const pct = Math.round(ratio * 10000) / 100;
    const count = navWidget.querySelector('.relai-nav-count');
    const progress = navWidget.querySelector('.relai-nav-progress');
    const thumb = navWidget.querySelector('.relai-nav-thumb');
    if (count) {
      count.textContent = (index + 1) + ' / ' + total;
      count.style.top = Math.max(7, Math.min(93, pct)) + '%';
    }
    if (progress) progress.style.height = pct + '%';
    if (thumb) thumb.style.top = pct + '%';
    navWidget.setAttribute('aria-valuemin', '1');
    navWidget.setAttribute('aria-valuemax', String(total));
    navWidget.setAttribute('aria-valuenow', String(index + 1));
    navWidget.setAttribute('aria-valuetext', (index + 1) + ' of ' + total);
  }
  function refreshNavigator() {
    if (!navWidget) return;
    syncInjectedTheme(navWidget);
    const users = getUserTurns();
    if (users.length < 2) { navWidget.style.display = 'none'; return; }
    navWidget.style.display = '';
    setNavPosition(currentUserIndex(users), users.length);
  }
  function attachNavScroll() {
    detachNavScroll();
    const sc = scrollContainer || findScrollContainer(getTurns()[0]);
    if (!sc) return;
    navScrollTarget = sc;
    navScrollHandler = () => {
      if (navScrollThrottle) return;
      navScrollThrottle = setTimeout(() => {
        navScrollThrottle = null;
        const users = getUserTurns();
        if (users.length >= 2) setNavPosition(currentUserIndex(users), users.length);
      }, 250);
    };
    sc.addEventListener('scroll', navScrollHandler, { passive: true });
  }
  function detachNavScroll() {
    if (navScrollTarget && navScrollHandler) navScrollTarget.removeEventListener('scroll', navScrollHandler);
    navScrollHandler = null;
    navScrollTarget = null;
    if (navScrollThrottle) { clearTimeout(navScrollThrottle); navScrollThrottle = null; }
  }
  function applyNavigator(on) {
    toolActive.navigator = on;
    if (on) { ensureNavigator(); attachNavScroll(); refreshNavigator(); }
    else { detachNavScroll(); removeNavigator(); }
  }

  // ── Session Stats ─────────────────────────────────────────────────
  let sessionStatsEl = null;
  let sessionStatsTimer = null;
  let sessionStatsVisHandler = null;
  let sessionStatsDocHandler = null;
  let sessionRafId = null;
  let sessionFrameCount = 0;
  let sessionFps = 0;
  let sessionFpsWindowStart = 0;
  let sessionLongTaskObs = null;
  let sessionLongTasks = [];

  function ensureSessionStats() {
    if (sessionStatsEl) return;
    sessionStatsEl = document.createElement('div');
    sessionStatsEl.id = 'relai-session-stats';
    sessionStatsEl.className = 'relai-session-stats';
    syncInjectedTheme(sessionStatsEl);
    sessionStatsEl.innerHTML =
      '<button type="button" class="relai-session-chip" aria-expanded="false"></button>' +
      '<div class="relai-session-popover" hidden>' +
        '<div class="relai-session-title"></div>' +
        '<div class="relai-session-rows"></div>' +
      '</div>';
    sessionStatsEl.querySelector('.relai-session-title').textContent = t('perfHud');
    const rows = [
      ['mem', t('hudMemory')],
      ['nodes', t('hudNodes')],
      ['turns', t('hudTurns')],
      ['fps', t('hudFps')],
      ['lag', t('hudLag')],
      ['clean', t('hudLastClean')]
    ];
    const body = sessionStatsEl.querySelector('.relai-session-rows');
    for (const [id, label] of rows) {
      const row = document.createElement('div');
      row.className = 'relai-session-row';
      row.dataset.row = id;
      row.innerHTML = '<span class="relai-session-key"></span><span class="relai-session-value">—</span>';
      row.querySelector('.relai-session-key').textContent = label;
      body.appendChild(row);
    }
    const chip = sessionStatsEl.querySelector('.relai-session-chip');
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSessionStatsOpen(chip.getAttribute('aria-expanded') !== 'true');
    });
    sessionStatsDocHandler = (e) => {
      if (sessionStatsEl && !sessionStatsEl.contains(e.target)) setSessionStatsOpen(false);
    };
    document.addEventListener('pointerdown', sessionStatsDocHandler, true);
    document.addEventListener('keydown', onSessionStatsKeyDown, true);
    (document.body || document.documentElement).appendChild(sessionStatsEl);
  }
  function onSessionStatsKeyDown(e) {
    if (e.key === 'Escape') setSessionStatsOpen(false);
  }
  function setSessionStatsOpen(open) {
    if (!sessionStatsEl) return;
    const chip = sessionStatsEl.querySelector('.relai-session-chip');
    const panel = sessionStatsEl.querySelector('.relai-session-popover');
    if (!chip || !panel) return;
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
    if (open) {
      startSessionFpsCounter();
      startSessionLongTaskObserver();
      updateSessionStats();
    } else {
      stopSessionFpsCounter();
      stopSessionLongTaskObserver();
    }
  }
  function setSessionRow(id, value, show = true) {
    const row = sessionStatsEl?.querySelector('.relai-session-row[data-row="' + id + '"]');
    if (!row) return;
    row.style.display = show ? '' : 'none';
    if (show) row.querySelector('.relai-session-value').textContent = value;
  }
  function updateSessionStats() {
    if (!sessionStatsEl || document.visibilityState !== 'visible') return;
    syncInjectedTheme(sessionStatsEl);
    const mem = performance.memory;
    const chip = sessionStatsEl.querySelector('.relai-session-chip');
    if (chip) chip.textContent = mem ? (t('hudMemory') + ' ' + mb(mem.usedJSHeapSize) + ' MB') : t('perfHud');
    const panel = sessionStatsEl.querySelector('.relai-session-popover');
    if (!panel || panel.hidden) return;
    setSessionRow('mem', mem ? (mb(mem.usedJSHeapSize) + ' / ' + mb(mem.totalJSHeapSize) + ' MB') : '', !!mem);
    setSessionRow('nodes', String(document.getElementsByTagName('*').length));
    const total = getTurns().length;
    const mounted = document.querySelectorAll(TURN_SELECTOR + ' [data-message-author-role]').length;
    setSessionRow('turns', mounted + ' / ' + total);
    setSessionRow('fps', String(sessionFps));
    setSessionRow('lag', currentSessionLag() + ' ms', longTaskSupported());
    chrome.storage.local.get(['relaiCleanStats'], (d) => {
      const s = d && d.relaiCleanStats;
      setSessionRow('clean', (s && s.before && s.after) ? (mb(s.before) + ' → ' + mb(s.after) + ' MB') : '—');
    });
  }
  function startSessionStatsTimer() {
    stopSessionStatsTimer();
    sessionStatsTimer = setInterval(updateSessionStats, 2500);
    sessionStatsVisHandler = () => { if (document.visibilityState === 'visible') updateSessionStats(); };
    document.addEventListener('visibilitychange', sessionStatsVisHandler);
    updateSessionStats();
  }
  function stopSessionStatsTimer() {
    if (sessionStatsTimer) { clearInterval(sessionStatsTimer); sessionStatsTimer = null; }
    if (sessionStatsVisHandler) {
      document.removeEventListener('visibilitychange', sessionStatsVisHandler);
      sessionStatsVisHandler = null;
    }
  }
  function startSessionFpsCounter() {
    if (sessionRafId) return;
    sessionFrameCount = 0;
    sessionFpsWindowStart = performance.now();
    const loop = () => {
      sessionFrameCount++;
      const now = performance.now();
      if (now - sessionFpsWindowStart >= 1000) {
        sessionFps = Math.round((sessionFrameCount * 1000) / (now - sessionFpsWindowStart));
        sessionFrameCount = 0;
        sessionFpsWindowStart = now;
      }
      sessionRafId = requestAnimationFrame(loop);
    };
    sessionRafId = requestAnimationFrame(loop);
  }
  function stopSessionFpsCounter() {
    if (sessionRafId) { cancelAnimationFrame(sessionRafId); sessionRafId = null; }
    sessionFps = 0;
  }
  function longTaskSupported() {
    return typeof PerformanceObserver !== 'undefined'
      && Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes('longtask');
  }
  function startSessionLongTaskObserver() {
    if (sessionLongTaskObs || !longTaskSupported()) return;
    try {
      sessionLongTaskObs = new PerformanceObserver((list) => {
        const now = performance.now();
        for (const entry of list.getEntries()) sessionLongTasks.push({ t: now, dur: entry.duration });
      });
      sessionLongTaskObs.observe({ type: 'longtask', buffered: true });
    } catch (_) { sessionLongTaskObs = null; }
  }
  function stopSessionLongTaskObserver() {
    if (sessionLongTaskObs) {
      try { sessionLongTaskObs.disconnect(); } catch (_) {}
      sessionLongTaskObs = null;
    }
    sessionLongTasks = [];
  }
  function currentSessionLag() {
    const cutoff = performance.now() - 5000;
    sessionLongTasks = sessionLongTasks.filter((x) => x.t >= cutoff);
    return Math.round(sessionLongTasks.reduce((sum, item) => sum + item.dur, 0));
  }
  function applySessionStats(on) {
    if (!on) { removeSessionStats(); return; }
    ensureSessionStats();
    startSessionStatsTimer();
  }
  function removeSessionStats() {
    stopSessionStatsTimer();
    stopSessionFpsCounter();
    stopSessionLongTaskObserver();
    if (sessionStatsDocHandler) {
      document.removeEventListener('pointerdown', sessionStatsDocHandler, true);
      document.removeEventListener('keydown', onSessionStatsKeyDown, true);
      sessionStatsDocHandler = null;
    }
    if (sessionStatsEl) { sessionStatsEl.remove(); sessionStatsEl = null; }
  }

  // ── F3. Draft guard + freed-memory stat ───────────────────────────
  function saveDraftBeforeReload() {
    try {
      const composer = document.getElementById('prompt-textarea');
      const text = composer ? (composer.innerText || '').trim() : '';
      if (text) chrome.storage.local.set({ relaiDraft: { path: location.pathname, text, ts: Date.now() } });
    } catch (_) {}
  }
  function restoreDraft() {
    try {
      chrome.storage.local.get(['relaiDraft'], (data) => {
        const d = data && data.relaiDraft;
        if (!d || !d.text) return;
        if (d.path !== location.pathname) return;
        if (Date.now() - (d.ts || 0) > 5 * 60 * 1000) { chrome.storage.local.remove('relaiDraft'); return; }
        let tries = 0;
        const tryRestore = () => {
          const composer = document.getElementById('prompt-textarea');
          if (!composer) { if (tries++ < 20) setTimeout(tryRestore, 300); return; }
          if ((composer.innerText || '').trim()) return; // user already typed something
          composer.focus();
          let ok = false;
          try { ok = document.execCommand('insertText', false, d.text); } catch (_) {}
          if (!ok) {
            // Fallback for contenteditable composers that ignore execCommand.
            try {
              composer.textContent = d.text;
              composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
            } catch (_) {}
          }
          chrome.storage.local.remove('relaiDraft');
        };
        tryRestore();
      });
    } catch (_) {}
  }
  function recordCleanBefore() {
    try {
      const before = performance.memory && performance.memory.usedJSHeapSize;
      if (before) chrome.storage.local.set({ relaiCleanStats: { before, after: null, ts: null } });
    } catch (_) {}
  }
  function completeCleanStats() {
    try {
      chrome.storage.local.get(['relaiCleanStats'], (data) => {
        const s = data && data.relaiCleanStats;
        if (!s || !s.before || s.after) return;
        // Let the freshly-reloaded page settle, then snapshot the freed heap.
        setTimeout(() => {
          try {
            const after = (performance.memory && performance.memory.usedJSHeapSize) || null;
            chrome.storage.local.set({ relaiCleanStats: { before: s.before, after, ts: Date.now() } });
          } catch (_) {}
        }, 3000);
      });
    } catch (_) {}
  }

  // ── Hide Thinking ─────────────────────────────────────────────────
  // A reasoning-only row is a MOUNTED assistant turn that has a <button> (the
  // localized "Thought for Xs" toggle) but renders NO answer content. We detect
  // this structurally (absence of .markdown/.prose/pre/table/img) so it stays
  // i18n-safe — we never match the localized label text.
  //
  // IMPORTANT (root-caused in live QA): we do NOT toggle a class on the wrapper
  // DIV. That DIV is React-owned and React rewrites its className on every
  // re-render — it toggles data-is-intersecting on that DIV as you scroll — so
  // our class is wiped almost immediately and Hide Thinking never hides anything.
  // This is the exact hazard the Clean Memory visibility system already avoids with
  // a <style> tag instead of node classes. So here we accumulate the stable
  // per-turn uuids (data-turn-id-container, which React itself maintains) into a
  // Set and render our OWN <style> tag that selects those wrappers by attribute.
  // That is immune to reconciliation and hides the whole wrapper — including the
  // virtualized spacer's --last-known-height. Detection only works while a turn
  // is mounted, so the Set ACCUMULATES (we never lose an id when the turn
  // unmounts) and is reset per chat (teardown) — a new chat means new uuids.
  const hideThinkingIds = new Set();

  function isThinkingTurn(turn) {
    if (turn.getAttribute('data-turn') !== 'assistant') return false;
    const roleEl = turn.querySelector('[data-message-author-role="assistant"]');
    if (!roleEl) return false;                        // only mounted assistant turns
    if (!turn.querySelector('button')) return false;  // the "Thought for Xs" toggle
    if (roleEl.querySelector('.markdown, .prose, pre, table, img')) return false;
    return true;
  }
  // The stable uuid our <style> selector matches on: the wrapper DIV's
  // data-turn-id-container (fall back to the section's own id for older DOMs).
  function turnUuid(turn) {
    const wrap = getTurnWrapper(turn);
    return (wrap && wrap.getAttribute('data-turn-id-container'))
      || turn.getAttribute('data-turn-id')
      || turn.getAttribute('data-turn-id-container')
      || null;
  }
  function renderHideThinkingStyle() {
    if (!hideThinkingIds.size) { perfStyle('relai-hide-thinking-style', null); return; }
    const sel = [...hideThinkingIds]
      .map((id) => '[data-turn-id-container="' + id + '"]')
      .join(',');
    perfStyle('relai-hide-thinking-style', sel + '{display:none!important}');
  }
  function scanHideThinking() {
    let changed = false;
    for (const turn of getTurns()) {
      if (!isThinkingTurn(turn)) continue;
      const id = turnUuid(turn);
      if (id && !hideThinkingIds.has(id)) { hideThinkingIds.add(id); changed = true; }
    }
    if (changed) renderHideThinkingStyle();
  }
  function revertHideThinking() {
    hideThinkingIds.clear();
    perfStyle('relai-hide-thinking-style', null);
  }
  // New chat = new uuids: drop the accumulated set + style so stale ids can't
  // hide unrelated turns. The next scan repopulates it if still enabled.
  function resetHideThinkingForNewChat() {
    if (hideThinkingIds.size) revertHideThinking();
  }
  function applyHideThinking(on) {
    toolActive.hideThinking = on;
    if (!on) revertHideThinking();
  }

  // ── Manual Images ─────────────────────────────────────────────────
  // Defer only OFF-SCREEN, reasonably large images inside turns. We hide the
  // <img> (keeping its dimensions on a sibling button) rather than reparenting
  // React-owned nodes. Everything reverts cleanly when the feature is disabled.
  //
  // The <img> is React-owned, so a re-render can restore its src / display and
  // (for off-screen images) start loading the very bytes we deferred. The scan
  // therefore RE-ASSERTS the deferred state on every pass (idempotent — no work
  // once it's already correct, so it never self-triggers the shared observer),
  // guards against duplicate loader buttons, and marks user-loaded images with
  // data-relai-loaded so they are never re-deferred after the user opens them.
  function scanClickToLoadImg() {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    document.querySelectorAll(TURN_SELECTOR + ' img').forEach((img) => {
      // Loaded by the user — leave it alone forever.
      if (img.hasAttribute('data-relai-loaded')) return;
      // Already deferred — re-assert in case React restored src/display.
      if (img.hasAttribute('data-relai-src')) {
        if (img.getAttribute('src')) img.removeAttribute('src');
        if (img.getAttribute('srcset')) img.removeAttribute('srcset');
        if (img.style.display !== 'none') img.style.display = 'none';
        if (!isImgLoaderNext(img)) addImgLoader(img);
        return;
      }
      const src = img.getAttribute('src');
      if (!src || !/^https?:/i.test(src)) return;
      const w = img.naturalWidth || img.width || img.offsetWidth || 0;
      const h = img.naturalHeight || img.height || img.offsetHeight || 0;
      if ((w && w < 80) || (h && h < 80)) return; // skip avatars / inline icons
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh) return;     // only defer off-screen images
      img.setAttribute('data-relai-src', src);
      const srcset = img.getAttribute('srcset');
      if (srcset) { img.setAttribute('data-relai-srcset', srcset); img.removeAttribute('srcset'); }
      img.removeAttribute('src');
      img.style.display = 'none';
      addImgLoader(img);
    });
  }
  function isImgLoaderNext(img) {
    const n = img.nextElementSibling;
    return !!(n && n.classList && n.classList.contains('relai-img-load'));
  }
  function addImgLoader(img) {
    if (isImgLoaderNext(img)) return; // never stack duplicate buttons
    const r = img.getBoundingClientRect();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'relai-img-load';
    syncInjectedTheme(btn);
    if (r.width) btn.style.width = Math.round(r.width) + 'px';
    if (r.height) btn.style.height = Math.round(r.height) + 'px';
    btn.setAttribute('aria-label', t('loadImage'));
    const label = document.createElement('span');
    label.className = 'relai-img-label';
    label.textContent = t('imageDeferred');
    const action = document.createElement('span');
    action.className = 'relai-img-action';
    action.textContent = t('loadImage');
    btn.append(label, action);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      restoreDeferredImg(img);
      btn.remove();
    });
    img.insertAdjacentElement('afterend', btn);
  }
  function restoreDeferredImg(img) {
    const src = img.getAttribute('data-relai-src');
    if (src) img.setAttribute('src', src);
    const ss = img.getAttribute('data-relai-srcset');
    if (ss) img.setAttribute('srcset', ss);
    img.removeAttribute('data-relai-src');
    img.removeAttribute('data-relai-srcset');
    img.style.display = '';
    img.setAttribute('data-relai-loaded', '1'); // don't re-defer once the user loads it
  }
  function revertClickToLoadImg() {
    document.querySelectorAll('button.relai-img-load').forEach((b) => b.remove());
    document.querySelectorAll('img[data-relai-src]').forEach(restoreDeferredImg);
    // Clear the loaded marker too, so re-enabling later can defer afresh.
    document.querySelectorAll('img[data-relai-loaded]').forEach((img) => img.removeAttribute('data-relai-loaded'));
  }
  function applyClickToLoadImg(on) {
    toolActive.clickToLoadImg = on;
    if (!on) revertClickToLoadImg();
  }

  // ── Quick Open (Chrome-only) ─────────────────────────────────────
  // Best-effort: injects a single <script type="speculationrules"> to prerender
  // the hovered chat. ChatGPT's CSP may refuse the injected rules and the server
  // can decline to prerender — when it works, switching chats is instant.
  let prefetchHandler = null;
  let prefetchDebounce = null;
  function applyPrefetch(on) {
    if (!on) { disablePrefetch(); return; }
    if (!(typeof HTMLScriptElement !== 'undefined' && HTMLScriptElement.supports
          && HTMLScriptElement.supports('speculationrules'))) return; // Chrome-only
    if (prefetchHandler) return;
    prefetchHandler = (e) => {
      const link = e.target && e.target.closest && e.target.closest('nav a[href^="/c/"]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href === location.pathname) return; // never the current chat
      clearTimeout(prefetchDebounce);
      prefetchDebounce = setTimeout(() => injectSpeculation(href), 150);
    };
    document.addEventListener('mouseover', prefetchHandler, true);
  }
  function disablePrefetch() {
    if (prefetchHandler) { document.removeEventListener('mouseover', prefetchHandler, true); prefetchHandler = null; }
    if (prefetchDebounce) { clearTimeout(prefetchDebounce); prefetchDebounce = null; }
    const s = document.getElementById('relai-speculation');
    if (s) s.remove();
  }
  function injectSpeculation(href) {
    try {
      let s = document.getElementById('relai-speculation');
      if (!s) {
        s = document.createElement('script');
        s.type = 'speculationrules';
        s.id = 'relai-speculation';
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent = JSON.stringify({ prerender: [{ urls: [href] }] });
    } catch (_) {}
  }

  // ── Markdown export + Copy + Metrics (messaging) ──────────────────
  function buildMD(messages) {
    const lines = [];
    lines.push('# ' + t('exportTitle'));
    lines.push('');
    lines.push('_' + t('exportDate') + ': ' + new Date().toLocaleString() +
               ' · ' + messages.length + ' ' + t('exportMsgCount') + '_');
    lines.push('');
    messages.forEach((msg) => {
      const heading = msg.role === 'user' ? '## 👤 ' + t('roleUser')
                    : msg.role === 'assistant' ? '## 🤖 ' + t('roleAssistant')
                    : '## ' + t('roleUnknown');
      const ts = formatTimestamp(msg.createTime);
      lines.push(heading + (ts ? '  \n_' + ts + '_' : ''));
      lines.push('');
      lines.push(msg.text);
      msg.codeBlocks.forEach((block) => {
        lines.push('');
        lines.push('```' + (block.lang || ''));
        lines.push(block.code);
        lines.push('```');
      });
      lines.push('');
    });
    return lines.join('\n');
  }
  function triggerMDDownload(text, filename) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    return downloadBlob(blob, filename);
  }
  // COPY_ALL RETURNS the markdown to the popup instead of writing the clipboard
  // itself. The Clipboard API requires the writing document to be FOCUSED; while
  // the popup is open the ChatGPT tab is not focused, so navigator.clipboard
  // .writeText() from this content script fails ("Document is not focused").
  // The popup (which IS focused) does the writeText with the text we return.
  // Supports markdown and plain text using the same extraction pipeline as export.
  async function handleCopyAll(format = 'md') {
    let messages;
    const gaps = countExportableGaps(false);
    if (gaps.missing > 0) {
      showExportProgress();
      try { messages = await collectConversation(false); }
      finally { hideExportProgress(); }
    } else {
      messages = extractConversation(false);
    }
    if (!messages.length) return { success: false, error: 'no_messages' };
    const text = format === 'txt' ? buildTXT(messages) : buildMD(messages);
    return { success: true, text, chars: text.length, format: format === 'txt' ? 'txt' : 'md' };
  }
  function getPerfMetrics() {
    return new Promise((resolve) => {
      const mem = performance.memory;
      const total = getTurns().length;
      const mounted = document.querySelectorAll(TURN_SELECTOR + ' [data-message-author-role]').length;
      const base = {
        heapUsed: mem ? mem.usedJSHeapSize : null,
        heapTotal: mem ? mem.totalJSHeapSize : null,
        domNodes: document.getElementsByTagName('*').length,
        turnsTotal: total,
        turnsMounted: mounted,
        lastClean: null
      };
      try {
        chrome.storage.local.get(['relaiCleanStats'], (data) => {
          const s = data && data.relaiCleanStats;
          if (s && s.before && s.after) base.lastClean = { before: s.before, after: s.after, ts: s.ts || null };
          resolve(base);
        });
      } catch (_) { resolve(base); }
    });
  }

  // ── Entry ─────────────────────────────────────────────────────────

  async function main() {
    log('Initializing...');

    await loadStoredState();

    // Complete the freed-memory stat if we just came back from a Clean Memory
    // reload, and restore any draft saved before that reload.
    completeCleanStats();
    restoreDraft();

    // Intercept sidebar clicks to force full reload (clears memory)
    interceptChatLinks();

    // Try immediately, fall back to reactive MutationObserver
    if (!init()) {
      waitForTurns();
    }

    // Fallback for non-click navigations (back button, etc.)
    setupSPAObserver();
  }

  // Run as early as possible
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
