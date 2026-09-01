// Rel.AI Companion — background service worker

const DEFAULT_PREFS = {
  cleanMemoryEnabled: true,
  hideNotifications: false,
  // Performance features — curated safe defaults.
  perfResourceHints: true,
  perfReduceAnim: true,
  perfOptimizeDom: true,
  perfFontSwap: true,
  perfLazyImg: true,
  perfBlockTrackers: false,
  perfKeepSession: false,
  perfDeferScripts: false,
  // Workspace tools — read by content.js from GET_PREFS / PREFS_UPDATED.
  navigatorEnabled: true,   // Turn Navigator widget, ON by default
  hudEnabled: false,        // Performance HUD
  cleanMemorySmart: false,  // smart Clean Memory (only reload when heavy)
  collapseCode: false,      // collapse tall code blocks
  hideThinking: false,      // hide reasoning ("Thought for Xs") rows
  clickToLoadImg: false,    // load images on demand
  prefetchNav: false,       // Chrome-only — Speculation Rules on hover
  // Chrome-only DNR network block. Owned by setTrackerBlocking() /
  // reconcileTrackerBlocking(): it needs the optional tracker host permissions,
  // so it is never written through SET_PREFS (see the message router).
  blockTrackersNet: false
};

// --- Content Script Communication ---

async function notifyContentScript(prefs) {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
  });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { action: 'PREFS_UPDATED', prefs }).catch(() => {});
  }
}

async function queryContentScript(action) {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    active: true,
    currentWindow: true
  });
  if (tabs.length === 0) {
    return { error: 'no_chatgpt_tab' };
  }
  return chrome.tabs.sendMessage(tabs[0].id, { action });
}

// --- Install Handler ---

// Use startup event instead of onInstalled to avoid race conditions
// with unpacked extension reloads
chrome.runtime.onStartup.addListener(() => {
  // Dynamic rules survive restarts; make sure they still match the pref + perms.
  reconcileTrackerBlocking();
});

// Only set defaults if truly first install (no installedAt exists)
(async () => {
  const data = await chrome.storage.local.get(['installedAt']);
  if (!data.installedAt) {
    console.log('[Rel.AI Companion] First install, setting defaults');
    await chrome.storage.local.set({
      installedAt: Date.now(),
      ...DEFAULT_PREFS
    });
  }
})();

// --- Network Tracker Blocking (declarativeNetRequestWithHostAccess) ---
//
// Chrome-only feature.
//
// Permission model: Chrome does NOT support `declarativeNetRequest` as an
// optional permission. We declare `declarativeNetRequestWithHostAccess` as a
// required permission and ship the four
// tracker origins as `optional_host_permissions`, requested at runtime from a
// user gesture in the popup. Plain `declarativeNetRequest` must NEVER be added
// to `permissions`: it triggers the "Block content on any page" warning, which
// would disable the extension for the whole installed base until re-approved.
//
// WithHostAccess only lets a rule act on a request when we hold host access to
// BOTH the request URL and its initiator. The initiator (chatgpt.com /
// chat.openai.com) is already in host_permissions; the tracker origins are the
// optional half — without them the rules exist but do nothing, which is why the
// background treats "hosts granted" as part of the effective state.
//
// Rules are deliberately conservative: a short allow-list of third-party
// analytics/ads endpoints, scoped to requests initiated from ChatGPT. We NEVER
// touch Statsig (feature flags), oaistatic or oaiusercontent — blocking those
// breaks the app. Fixed rule IDs 9001-9004 so enabling/disabling is idempotent.
//
// Note: `browser-intake-datadoghq.com` is a separate registrable domain, not a
// subdomain of `datadoghq.com` (hyphen, not dot), so rule 9001 is NOT redundant
// with 9002 — both are required.

const TRACKER_RULE_IDS = [9001, 9002, 9003, 9004];

const TRACKER_ORIGINS = [
  '*://*.browser-intake-datadoghq.com/*',
  '*://*.datadoghq.com/*',
  '*://*.google-analytics.com/*',
  '*://*.doubleclick.net/*'
];

function buildTrackerRules() {
  const targets = [
    [9001, 'browser-intake-datadoghq.com'],
    [9002, 'datadoghq.com'],
    [9003, 'google-analytics.com'],
    [9004, 'doubleclick.net']
  ];
  return targets.map(([id, domain]) => ({
    id,
    priority: 1,
    action: { type: 'block' },
    condition: {
      requestDomains: [domain],
      initiatorDomains: ['chatgpt.com', 'chat.openai.com'],
      resourceTypes: [
        'script', 'xmlhttprequest', 'image', 'ping',
        'media', 'websocket', 'font', 'other'
      ]
    }
  }));
}

// A "pending intent" is the popup saying «the user pushed the switch, I asked
// Chrome for the hosts and I may be killed before the answer arrives». It is
// only meaningful for a few minutes: after that, a later host grant (for any
// other reason) must NOT silently switch network blocking on.
const TRACKER_PENDING_TTL = 5 * 60 * 1000;

// Every tracker mutation runs through this single promise chain.
//
// setTrackerBlocking() and reconcileTrackerBlocking() both do read-pref →
// read-rules → write. Interleaved they corrupt each other: reconcile reads the
// pref BEFORE setTrackerBlocking(true) stores it, then reads the rules AFTER
// they landed, computes wanted=false and deletes the rules the user just
// enabled. Serializing removes the window entirely.
//
// The chain never rejects (`then(fn, fn)` runs the next op whatever happened to
// the previous one, and the stored tail swallows failures), so one bad op can
// not wedge the queue. Ops queued here must NOT call queueTrackerOp()
// themselves — they would wait on a link placed behind their own — which is
// why the bodies live in *Inner() functions that call each other directly.
let trackerOpChain = Promise.resolve();

function queueTrackerOp(fn) {
  const next = trackerOpChain.then(fn, fn);
  trackerOpChain = next.catch(() => {});
  return next;
}

function trackerApiAvailable() {
  return !!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules);
}

// Do we hold the optional host permissions for the tracker origins?
async function hasTrackerHosts() {
  try {
    return await chrome.permissions.contains({ origins: TRACKER_ORIGINS });
  } catch (_) {
    return false;
  }
}

// Are all four dynamic rules currently installed?
async function trackerRulesActive() {
  if (!trackerApiAvailable() || !chrome.declarativeNetRequest.getDynamicRules) return false;
  try {
    // No `filter` argument on purpose — it is not available on every Chrome
    // version we support; filtering in JS behaves the same everywhere.
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = new Set(rules.map(r => r.id));
    return TRACKER_RULE_IDS.every(id => ids.has(id));
  } catch (_) {
    return false;
  }
}

// The background is the single source of truth; the popup only paints this.
//
// `reason` is the explicit, machine-readable explanation of WHY the row is not
// in the state the user asked for. The popup maps it 1:1 to an i18n key — it
// never has to re-derive the situation from the other booleans (which is how
// the "silent revoke" bug happened: the derived condition `pref && !effective`
// could not be true because the pref had already been wiped).
//
//   'revoked'  the tracker host permissions are gone. Either as a ONE-SHOT
//              notice left by the revoke handler (`trackerNotice`, reported
//              whatever the pref says), or derived from pref on + no hosts.
//   'denied'   pref off, a fresh pending intent exists and hosts were not granted
//              (i.e. the user pushed the switch and then denied Chrome's dialog)
//   'error'    pref on, hosts fine, yet the rules are not installed
//   null       coherent — nothing to explain
//
// Priority, highest first:
//   revoked (notice) → revoked (pref, no hosts) → error → denied → null
async function getTrackerState() {
  const supported = trackerApiAvailable();
  const hasPermission = await hasTrackerHosts();
  const stored = await chrome.storage.local.get([
    'blockTrackersNet', 'trackerPending', 'trackerPendingAt', 'trackerNotice'
  ]);
  const rulesActive = await trackerRulesActive();
  const pref = stored.blockTrackersNet === true;
  const pendingFresh = stored.trackerPending === true &&
    (Date.now() - (stored.trackerPendingAt || 0)) <= TRACKER_PENDING_TTL;

  // The one-shot revoke notice is checked independently of the pref, because
  // the revoke handler already wrote the pref back to false: without it the
  // popup would flip the row off with no explanation at all.
  let reason = null;
  if (stored.trackerNotice === 'revoked') {
    reason = 'revoked';
  } else if (pref && !hasPermission) {
    reason = 'revoked';
  } else if (pref && !rulesActive) {
    reason = 'error';
  } else if (!pref && pendingFresh && !hasPermission) {
    reason = 'denied';
  }

  return {
    supported,
    hasPermission,
    pref,
    rulesActive,
    effective: hasPermission && rulesActive,
    reason
  };
}

// Serialized entry point — see queueTrackerOp(). The response shape is
// unchanged; callers still get { success, error?, state }.
function setTrackerBlocking(enabled) {
  return queueTrackerOp(() => setTrackerBlockingInner(enabled));
}

async function setTrackerBlockingInner(enabled) {
  if (enabled && !(await hasTrackerHosts())) {
    // Host access is missing (never granted, or revoked from chrome://extensions).
    return { success: false, error: 'permission_missing', state: await getTrackerState() };
  }
  if (!trackerApiAvailable()) {
    return { success: false, error: 'dnr_unavailable', state: await getTrackerState() };
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: TRACKER_RULE_IDS,               // clear stale rules first (idempotent)
      addRules: enabled ? buildTrackerRules() : []   // disable = remove only
    });
  } catch (err) {
    return { success: false, error: err.message || 'dnr_error', state: await getTrackerState() };
  }
  // Persist the intent only after the rules actually landed. The pending intent
  // has now been consumed either way, so it is cleared together with its stamp.
  // An explicit, successful toggle also supersedes any pending one-shot notice:
  // re-enabling the feature is exactly the answer to "site access was revoked".
  await chrome.storage.local.set({
    blockTrackersNet: !!enabled,
    trackerPending: false,
    trackerPendingAt: 0,
    trackerNotice: null
  });
  await notifyContentScript({ blockTrackersNet: !!enabled });
  return { success: true, state: await getTrackerState() };
}

// Self-healing. Safe to call on every startup, permission change and popup
// open. Three invariants:
//
//  1. Rules are installed IFF hosts are granted AND the pref is on.
//  2. Truly idempotent: `updateDynamicRules` is only called when the desired
//     state differs from the installed one, because reconciliation can happen
//     on several worker wake-up paths and rewriting rules would be wasteful.
//  3. The user's INTENT (`blockTrackersNet`) is never destroyed here. Removing
//     the rules is enough to stop the blocking; keeping the pref lets
//     getTrackerState() report 'revoked' so the popup can explain itself, and
//     lets the feature come back by itself once the hosts are re-granted. (The
//     one-shot revoke notice is written by handleTrackerHostsRevoked(), not here.)
//
// Serialized entry point — see queueTrackerOp().
function reconcileTrackerBlocking() {
  return queueTrackerOp(reconcileTrackerBlockingInner);
}

async function reconcileTrackerBlockingInner() {
  if (!trackerApiAvailable()) return;
  try {
    const granted = await hasTrackerHosts();
    const stored = await chrome.storage.local.get([
      'blockTrackersNet', 'trackerPending', 'trackerPendingAt'
    ]);
    let pref = stored.blockTrackersNet === true;

    // Honour a still-fresh pending intent here, not only from permissions.onAdded.
    // Waking up on that event re-runs this file's top level, so the reconcile it
    // schedules can win the race and retire the intent before the listener reads
    // it — which would silently drop the very grant the user just approved.
    // Doing it in the serialized reconcile makes the outcome order-independent.
    const pendingFresh = stored.trackerPending === true &&
      (Date.now() - (stored.trackerPendingAt || 0)) <= TRACKER_PENDING_TTL;
    if (pendingFresh && granted && !pref) {
      pref = true;
      await chrome.storage.local.set({ blockTrackersNet: true, trackerNotice: null });
    }

    const wanted = granted && pref;

    if (wanted !== (await trackerRulesActive())) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: TRACKER_RULE_IDS,
        addRules: wanted ? buildTrackerRules() : []
      });
      // The content script only cares about the EFFECTIVE state, so it is told
      // about the change even though the stored pref stays as the user left it.
      await notifyContentScript({ blockTrackersNet: wanted });
    }

    // A pending intent is only worth keeping while it is still fresh AND still
    // unfulfilled. Once the hosts are there it has been consumed; once it has
    // expired it is noise that permissions.onAdded must not honour later.
    const pendingStale = stored.trackerPending === true &&
      (granted || Date.now() - (stored.trackerPendingAt || 0) > TRACKER_PENDING_TTL);
    if (pendingStale) {
      await chrome.storage.local.set({ trackerPending: false, trackerPendingAt: 0 });
    }
  } catch (err) {
    console.warn('[Rel.AI Companion] Tracker reconcile failed:', err && err.message);
  }
}

// MV3 requires these to be registered synchronously at the top level.
//
// permissions.onAdded is the safety net for crbug 40721470: Chrome's permission
// prompt steals focus and destroys the popup, so the popup's continuation after
// `await permissions.request()` may never run. If the popup left a pending
// intent behind, we finish the job here.
// Reconcile is the ONE path that finishes the job: it reads the pending intent,
// installs the rules, all inside the serialized queue.
// Doing the same work here as well used to race with the reconcile that this
// file's own top level schedules when the event wakes the worker up — whichever
// ran second found the intent already retired and quietly dropped the grant.
chrome.permissions.onAdded.addListener(() => {
  reconcileTrackerBlocking();
});

// Losing the tracker hosts (revoked from chrome://extensions) kills the feature
// until the user grants them again, and the popup has no gesture that means
// "turn it off and stop telling me": the switch is already OFF, so a click there
// means turn ON. Keeping the pref at true would therefore paint the red "site
// access was revoked" line on every single open, forever.
//
// So a revoke is recorded as a ONE-SHOT notice: rules out, pref back to false,
// and `trackerNotice` carries the explanation for exactly one popup open (the
// popup clears it via CLEAR_TRACKER_PENDING after painting it).
async function handleTrackerHostsRevoked() {
  try {
    const granted = await hasTrackerHosts();
    const stored = await chrome.storage.local.get(['blockTrackersNet']);
    if (!granted && stored.blockTrackersNet === true) {
      if (trackerApiAvailable()) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: TRACKER_RULE_IDS,
          addRules: []
        });
      }
      await chrome.storage.local.set({
        blockTrackersNet: false,
        trackerNotice: 'revoked'
      });
      await notifyContentScript({ blockTrackersNet: false });
      return;
    }
  } catch (err) {
    console.warn('[Rel.AI Companion] Tracker revoke handling failed:', err && err.message);
  }
  // Some other optional permission went away — fall back to plain reconcile.
  // Called directly (not queued) because we are already inside the queue.
  return reconcileTrackerBlockingInner();
}

chrome.permissions.onRemoved.addListener(() => {
  queueTrackerOp(handleTrackerHostsRevoked);
});

chrome.runtime.onInstalled.addListener(() => {
  reconcileTrackerBlocking();
});

// --- Message Router ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message || 'unknown_error' });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'GET_PREFS': {
      const prefs = await chrome.storage.local.get(Object.keys(DEFAULT_PREFS));
      return { ...DEFAULT_PREFS, ...prefs };
    }

    case 'SET_PREFS': {
      const newPrefs = {};
      for (const key of Object.keys(DEFAULT_PREFS)) {
        // blockTrackersNet depends on optional host permissions + dynamic rules,
        // so it is only ever written by setTrackerBlocking()/reconcile.
        if (key === 'blockTrackersNet') continue;
        if (msg.prefs && key in msg.prefs) {
          newPrefs[key] = msg.prefs[key];
        }
      }
      await chrome.storage.local.set(newPrefs);
      await notifyContentScript(newPrefs);
      return { success: true };
    }

    case 'GET_STATS': {
      return queryContentScript('GET_STATS');
    }

    case 'SET_TRACKER_BLOCKING': {
      // The popup requests the optional tracker hosts (user gesture) first;
      // we re-check here because that request can be denied or killed.
      return setTrackerBlocking(!!msg.enabled);
    }

    case 'GET_TRACKER_STATE': {
      return getTrackerState();
    }

    case 'CLEAR_TRACKER_PENDING': {
      // Called by the popup once it has painted a one-shot explanation, so the
      // message does not reappear on every open. That covers both the 'denied'
      // intent (switch pushed, Chrome's dialog refused) and the 'revoked'
      // notice left behind by handleTrackerHostsRevoked().
      const cleared = {
        trackerPending: false,
        trackerPendingAt: 0,
        trackerNotice: null
      };
      // A 'revoked' explanation means the stored intent can no longer be
      // honoured (the host access is gone). Retire it as well, otherwise
      // getTrackerState() keeps deriving reason='revoked' from the pref alone
      // and the warning comes back on every open with no way to dismiss it.
      if (msg.reason === 'revoked' && !(await hasTrackerHosts())) {
        cleared.blockTrackersNet = false;
      }
      await chrome.storage.local.set(cleared);
      return { success: true };
    }

    case 'DOWNLOAD_FILE': {
      try {
        await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          saveAs: false
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    default:
      return { error: 'unknown_action' };
  }
}

// --- Badge: show "ON" when on ChatGPT ---

const CHATGPT_PATTERNS = ['chatgpt.com', 'chat.openai.com'];

function isChatGPTUrl(url) {
  if (!url) return false;
  return CHATGPT_PATTERNS.some(p => url.includes(p));
}

async function updateBadge(tabId, url) {
  try {
    if (isChatGPTUrl(url)) {
      await chrome.action.setBadgeText({ text: 'ON', tabId });
      await chrome.action.setBadgeBackgroundColor({ color: '#10a37f', tabId });
    } else {
      await chrome.action.setBadgeText({ text: '', tabId });
    }
  } catch (_) {
    // Tab may have closed or have no action — ignore (avoids unhandled rejection)
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadge(tabId, tab.url);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    await updateBadge(tabId, tab.url);
  }
});

// Dynamic DNR rules outlive the service worker, so they can drift out of sync
// while nothing is running, so every worker wake-up re-checks the invariants.
// Idempotent: reconcile only
// writes when the desired state differs from the installed one.
reconcileTrackerBlocking();

// URL-filtered query works via host_permissions (no "tabs" permission needed)
// and only returns ChatGPT tabs with a readable url.
chrome.tabs.query({
  url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
}, (tabs) => {
  for (const tab of tabs) {
    updateBadge(tab.id, tab.url);
  }
});
