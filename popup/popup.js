/* Rel.AI Companion — compact popup */
(() => {
  'use strict';

  const runtime = globalThis.chrome?.runtime;
  const storage = globalThis.chrome?.storage?.local;
  const $ = id => document.getElementById(id);

  const DEFAULT_PREFS = {
    cleanMemoryEnabled: true,
    hideNotifications: false,
    perfResourceHints: true,
    perfReduceAnim: true,
    perfOptimizeDom: true,
    perfFontSwap: true,
    perfLazyImg: true,
    perfBlockTrackers: false,
    perfKeepSession: false,
    perfDeferScripts: false,
    navigatorEnabled: true,
    hudEnabled: false,
    cleanMemorySmart: false,
    collapseCode: false,
    hideThinking: false,
    clickToLoadImg: false,
    prefetchNav: false,
    blockTrackersNet: false
  };

  const TRACKER_ORIGINS = [
    '*://*.browser-intake-datadoghq.com/*',
    '*://*.datadoghq.com/*',
    '*://*.google-analytics.com/*',
    '*://*.doubleclick.net/*'
  ];

  const I18N = window.RELAI_I18N;
  const prefControls = Array.from(document.querySelectorAll('[data-pref]'));
  const exportButtons = Array.from(document.querySelectorAll('[data-export-format]'));
  const selectedExportButtons = Array.from(document.querySelectorAll('[data-selected-export]'));

  const connectionBadge = $('connectionBadge');
  const connectionText = $('connectionText');
  const homeStatusText = $('homeStatusText');
  const openChatBtn = $('openChatBtn');
  const summarySection = $('summarySection');
  const statsRow = $('statsRow');
  const noStats = $('noStats');
  const statTotal = $('statTotal');
  const statRendered = $('statRendered');
  const statMemory = $('statMemory');
  const lastCleanStat = $('lastCleanStat');
  const lastCleanValue = $('lastCleanValue');
  const exportConnectionText = $('exportConnectionText');

  const trackerToggle = $('trackerToggle');
  const trackerMsg = $('trackerMsg');
  const selModeToggle = $('selModeToggle');
  const exportSelRow = $('exportSelRow');
  const selCount = $('selCount');
  const copyMdBtn = $('copyMdBtn');
  const copyTxtBtn = $('copyTxtBtn');

  const langSelect = $('langSelect');
  const exportSettingsBtn = $('exportSettingsBtn');
  const importSettingsBtn = $('importSettingsBtn');
  const resetSettingsBtn = $('resetSettingsBtn');
  const resetSettingsHint = $('resetSettingsHint');
  const settingsFileInput = $('settingsFileInput');
  const versionText = $('versionText');

  const diagRuntime = $('diagRuntime');
  const diagChatTab = $('diagChatTab');
  const diagContent = $('diagContent');
  const diagTracker = $('diagTracker');
  const diagBrowser = $('diagBrowser');
  const refreshDiagnosticsBtn = $('refreshDiagnosticsBtn');
  const copyDiagnosticsBtn = $('copyDiagnosticsBtn');

  const githubBtn = $('githubBtn');
  const websiteBtn = $('websiteBtn');
  const toast = $('toast');
  const toastText = $('toastText');

  let currentPrefs = { ...DEFAULT_PREFS };
  let currentLang = 'auto';
  let cachedChatTab = null;
  let liveTimer = null;
  let toastTimer = null;
  let trackerBusy = false;
  let resetArmed = false;
  let resetTimer = null;
  let lastDiagnostics = null;

  function t(key, subs) {
    if (!I18N) return key;
    return I18N.t(key, subs, currentLang === 'auto' ? null : currentLang);
  }

  function showToast(message, tone = 'info', duration = 3000) {
    if (!toast || !toastText) return;
    clearTimeout(toastTimer);
    toast.dataset.tone = tone;
    toastText.textContent = message;
    toast.hidden = false;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
  }

  function controlsFor(key) {
    return prefControls.filter(control => control.dataset.pref === key);
  }

  function paintControl(control, enabled) {
    control.dataset.state = enabled ? 'on' : 'off';
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-checked', String(enabled));
    control.querySelectorAll('[data-state-label]').forEach(label => { label.textContent = enabled ? 'On' : 'Off'; });
  }

  function paintPref(key, enabled) {
    controlsFor(key).forEach(control => paintControl(control, enabled));
  }

  function applyPrefs(prefs) {
    currentPrefs = { ...DEFAULT_PREFS, ...(prefs || {}) };
    Object.keys(DEFAULT_PREFS).forEach(key => {
      if (key !== 'blockTrackersNet') paintPref(key, !!currentPrefs[key]);
    });
  }

  async function savePrefs(prefs, { quiet = true } = {}) {
    try {
      const result = await runtime?.sendMessage({ action: 'SET_PREFS', prefs });
      if (result?.error) throw new Error(result.error);
      applyPrefs({ ...currentPrefs, ...prefs });
      if (!quiet) showToast('Settings saved', 'success');
      return true;
    } catch {
      applyPrefs(currentPrefs);
      showToast('Could not save settings', 'error', 4200);
      return false;
    }
  }

  prefControls.forEach(control => {
    control.addEventListener('click', async () => {
      const key = control.dataset.pref;
      if (!key || key === 'blockTrackersNet') return;
      await savePrefs({ [key]: !currentPrefs[key] });
    });
  });

  function trackerReasonText(reason) {
    const key = reason === 'revoked' ? 'trackerPermMissing'
      : reason === 'denied' ? 'trackerPermDenied'
      : reason === 'error' ? 'trackerBlockError' : null;
    return key ? t(key) : '';
  }

  function showTrackerMessage(message) {
    trackerMsg.textContent = message || '';
    trackerMsg.hidden = !message;
  }

  async function askTrackerState() {
    try { return await runtime?.sendMessage({ action: 'GET_TRACKER_STATE' }); }
    catch { return null; }
  }

  async function refreshTracker() {
    const state = await askTrackerState();
    if (!state || typeof state.effective !== 'boolean') {
      trackerToggle.disabled = true;
      paintControl(trackerToggle, false);
      showTrackerMessage(t('trackerStateUnknown'));
      return null;
    }
    trackerToggle.disabled = false;
    currentPrefs.blockTrackersNet = state.effective;
    paintControl(trackerToggle, state.effective);
    showTrackerMessage(trackerReasonText(state.reason));
    if (state.reason === 'denied' || state.reason === 'revoked') {
      runtime?.sendMessage({ action: 'CLEAR_TRACKER_PENDING', reason: state.reason }).catch(() => {});
    }
    return state;
  }

  trackerToggle.addEventListener('click', async () => {
    if (trackerBusy || trackerToggle.disabled) return;
    trackerBusy = true;
    const wantEnabled = !currentPrefs.blockTrackersNet;
    showTrackerMessage('');
    try {
      if (wantEnabled) {
        await storage?.set({ trackerPending: true, trackerPendingAt: Date.now() });
        let granted = false;
        try { granted = await globalThis.chrome?.permissions?.request({ origins: TRACKER_ORIGINS }); } catch {}
        if (!granted) {
          await storage?.set({ trackerPending: false, trackerPendingAt: 0 });
          showTrackerMessage(t('trackerPermDenied'));
          showToast(t('trackerPermDenied'), 'warning', 4500);
          return;
        }
      }
      const result = await runtime?.sendMessage({ action: 'SET_TRACKER_BLOCKING', enabled: wantEnabled });
      if (!result?.success) {
        const message = trackerReasonText(result?.state?.reason) || t('trackerBlockError');
        showTrackerMessage(message);
        showToast(message, 'error', 4500);
      } else {
        await refreshTracker();
        showToast(wantEnabled ? 'Network blocking enabled' : 'Network blocking disabled', 'success');
      }
    } catch {
      await refreshTracker();
      showToast(t('trackerBlockError'), 'error', 4500);
    } finally {
      trackerBusy = false;
    }
  });

  function setConnectedUI(connected) {
    connectionBadge.dataset.state = connected ? 'connected' : 'idle';
    connectionText.textContent = connected ? 'Connected to ChatGPT' : 'ChatGPT not open';
    homeStatusText.textContent = connected
      ? 'Conversation tools are ready for the active ChatGPT tab.'
      : 'Open ChatGPT to use conversation tools.';
    openChatBtn.textContent = connected ? 'Export' : 'Open ChatGPT';
    openChatBtn.dataset.connected = String(connected);
    exportConnectionText.textContent = connected
      ? 'Export or copy the active conversation.'
      : 'Open a ChatGPT conversation to export it.';
    exportButtons.forEach(button => { button.disabled = !connected; });
    copyMdBtn.disabled = !connected;
    copyTxtBtn.disabled = !connected;
    selModeToggle.disabled = !connected;
  }

  openChatBtn.addEventListener('click', () => {
    if (cachedChatTab) {
      document.getElementById('exportSection')?.scrollIntoView({ block: 'start' });
      return;
    }
    try { globalThis.chrome.tabs.create({ url: 'https://chatgpt.com/' }); }
    catch { window.open('https://chatgpt.com/', '_blank', 'noopener'); }
  });

  function showEmptyStats() {
    summarySection.hidden = true;
    statsRow.hidden = true;
    noStats.hidden = true;
  }

  function renderStats(stats) {
    if (!stats || typeof stats.total !== 'number') return showEmptyStats();
    summarySection.hidden = false;
    statsRow.hidden = false;
    noStats.hidden = true;
    statTotal.textContent = stats.total;
    statRendered.textContent = stats.rendered ?? stats.total;
    statMemory.textContent = stats.cleanMemory ? 'On' : 'Off';
  }

  function renderLastClean(lastClean) {
    if (!lastClean || typeof lastClean.before !== 'number' || typeof lastClean.after !== 'number') {
      lastCleanStat.hidden = true;
      return;
    }
    const mb = bytes => Math.round(bytes / 1048576);
    lastCleanValue.textContent = `${mb(lastClean.before)} → ${mb(lastClean.after)} MB`;
    lastCleanStat.hidden = false;
  }

  async function refreshLiveData() {
    if (!cachedChatTab || document.hidden) return;
    const tasks = [
      globalThis.chrome.tabs.sendMessage(cachedChatTab.id, { action: 'GET_STATS' }).then(renderStats).catch(showEmptyStats),
      globalThis.chrome.tabs.sendMessage(cachedChatTab.id, { action: 'GET_PERF_METRICS' }).then(metrics => {
        if (metrics && !metrics.error) renderLastClean(metrics.lastClean);
      }).catch(() => {})
    ];
    if (selModeToggle.getAttribute('aria-checked') === 'true') {
      tasks.push(globalThis.chrome.tabs.sendMessage(cachedChatTab.id, { action: 'GET_SEL_COUNT' }).then(result => {
        if (typeof result?.count === 'number') updateSelectionCount(result.count);
      }).catch(() => {}));
    }
    await Promise.all(tasks);
  }

  async function sendExport(format, selectedOnly) {
    if (!cachedChatTab) return showToast('Open a ChatGPT conversation first', 'warning');
    const button = selectedOnly
      ? selectedExportButtons.find(item => item.dataset.selectedExport === format)
      : exportButtons.find(item => item.dataset.exportFormat === format);
    if (button) button.disabled = true;
    try {
      const result = await globalThis.chrome.tabs.sendMessage(cachedChatTab.id, {
        action: selectedOnly ? 'EXPORT_SEL' : 'EXPORT_ALL', format
      });
      if (result?.error === 'no_messages') showToast(t('noMessages'), 'warning');
      else if (result?.error) showToast(t('exportError'), 'error');
      else showToast(`${format.toUpperCase()} export started`, 'success');
    } catch {
      showToast(t('exportError'), 'error');
    } finally {
      if (button) button.disabled = selectedOnly ? Number(selCount.dataset.count || 0) <= 0 : false;
    }
  }

  exportButtons.forEach(button => button.addEventListener('click', () => sendExport(button.dataset.exportFormat, false)));
  selectedExportButtons.forEach(button => button.addEventListener('click', () => sendExport(button.dataset.selectedExport, true)));

  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch { return false; }
    }
  }

  async function copyConversation(format, button) {
    if (!cachedChatTab) return showToast('Open a ChatGPT conversation first', 'warning');
    button.disabled = true;
    try {
      const result = await globalThis.chrome.tabs.sendMessage(cachedChatTab.id, { action: 'COPY_ALL', format });
      if (!result?.success || typeof result.text !== 'string') throw new Error(result?.error || 'copy_failed');
      const copied = await writeClipboard(result.text);
      if (!copied) throw new Error('clipboard_failed');
      showToast(format === 'txt' ? 'Plain text copied' : 'Markdown copied', 'success');
    } catch (error) {
      showToast(error.message === 'no_messages' ? t('noMessages') : 'Could not copy conversation', 'error');
    } finally { button.disabled = false; }
  }

  copyMdBtn.addEventListener('click', () => copyConversation('md', copyMdBtn));
  copyTxtBtn.addEventListener('click', () => copyConversation('txt', copyTxtBtn));

  function updateSelectionCount(count) {
    selCount.dataset.count = String(count);
    selCount.textContent = t('selSelected', [String(count)]);
    selectedExportButtons.forEach(button => { button.disabled = count <= 0; });
  }

  function paintSelectionMode(enabled) {
    selModeToggle.setAttribute('aria-checked', String(enabled));
    selModeToggle.querySelector('[data-state-label]').textContent = enabled ? 'On' : 'Off';
    exportSelRow.hidden = !enabled;
    if (!enabled) updateSelectionCount(0);
  }

  selModeToggle.addEventListener('click', async () => {
    if (!cachedChatTab || selModeToggle.disabled) return;
    const enabled = selModeToggle.getAttribute('aria-checked') !== 'true';
    paintSelectionMode(enabled);
    try { await globalThis.chrome.tabs.sendMessage(cachedChatTab.id, { action: 'TOGGLE_SEL_MODE', enabled }); }
    catch { showToast('Could not change selection mode', 'error'); }
  });

  function sanitizeImportedPrefs(input) {
    const output = {};
    for (const [key, defaultValue] of Object.entries(DEFAULT_PREFS)) {
      if (!(key in input) || key === 'blockTrackersNet') continue;
      if (typeof input[key] === typeof defaultValue) output[key] = input[key];
    }
    return output;
  }

  async function exportSettings() {
    try {
      const tracker = await askTrackerState();
      const payload = {
        schema: 'relai-companion-settings',
        schemaVersion: 1,
        extensionVersion: runtime?.getManifest?.().version || '1.0.0',
        exportedAt: new Date().toISOString(),
        preferences: { ...currentPrefs, blockTrackersNet: !!tracker?.effective },
        uiLang: currentLang
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'relai-companion-settings-v1.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Settings backup exported', 'success');
    } catch { showToast('Could not export settings', 'error'); }
  }

  async function importSettings(file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.schema !== 'relai-companion-settings' || typeof parsed.preferences !== 'object') throw new Error('invalid');
      const prefs = sanitizeImportedPrefs(parsed.preferences);
      if (!(await savePrefs(prefs))) return;
      if (typeof parsed.uiLang === 'string' && Array.from(langSelect.options).some(option => option.value === parsed.uiLang)) {
        currentLang = parsed.uiLang;
        langSelect.value = currentLang;
        await storage?.set({ uiLang: currentLang });
      }
      if (parsed.preferences.blockTrackersNet === false) {
        await runtime?.sendMessage({ action: 'SET_TRACKER_BLOCKING', enabled: false }).catch(() => {});
      }
      await refreshTracker();
      showToast(parsed.preferences.blockTrackersNet ? 'Settings restored. Re-enable network blocking manually.' : 'Settings restored', 'success', 4200);
    } catch { showToast('That settings file is not valid', 'error', 4200); }
    finally { settingsFileInput.value = ''; }
  }

  exportSettingsBtn.addEventListener('click', exportSettings);
  importSettingsBtn.addEventListener('click', () => settingsFileInput.click());
  settingsFileInput.addEventListener('change', () => {
    const file = settingsFileInput.files?.[0];
    if (file) importSettings(file);
  });

  resetSettingsBtn.addEventListener('click', async () => {
    if (!resetArmed) {
      resetArmed = true;
      resetSettingsHint.textContent = 'Click again to confirm';
      showToast('Click Reset again to confirm', 'warning', 4000);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        resetArmed = false;
        resetSettingsHint.textContent = 'Restore v1 defaults';
      }, 4000);
      return;
    }
    resetArmed = false;
    clearTimeout(resetTimer);
    resetSettingsHint.textContent = 'Restore v1 defaults';
    const prefs = { ...DEFAULT_PREFS };
    delete prefs.blockTrackersNet;
    if (!(await savePrefs(prefs))) return;
    await runtime?.sendMessage({ action: 'SET_TRACKER_BLOCKING', enabled: false }).catch(() => {});
    await storage?.remove(['relaiDraft', 'relaiCleanStats', 'relaiHudCollapsed', 'relaiSwitchCount']);
    await refreshTracker();
    renderLastClean(null);
    showToast('Local Rel.AI settings reset', 'success');
  });

  langSelect.addEventListener('change', async () => {
    currentLang = langSelect.value;
    await storage?.set({ uiLang: currentLang });
    updateSelectionCount(Number(selCount.dataset.count || 0));
  });

  function browserLabel() {
    const ua = navigator.userAgent;
    const edge = ua.match(/Edg\/(\d+)/); if (edge) return `Edge ${edge[1]}`;
    const chrome = ua.match(/Chrome\/(\d+)/); if (chrome) return `Chrome ${chrome[1]}`;
    const firefox = ua.match(/Firefox\/(\d+)/); if (firefox) return `Firefox ${firefox[1]}`;
    return navigator.userAgentData?.brands?.[0]?.brand || 'Browser';
  }

  function setDiagnostic(element, text, tone) {
    element.textContent = text;
    element.dataset.tone = tone;
  }

  async function collectDiagnostics() {
    const version = runtime?.getManifest?.().version || 'unknown';
    let tab = null;
    try { [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
    const isChat = !!tab && /https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '');
    let stats = null;
    let metrics = null;
    if (isChat) {
      try { stats = await globalThis.chrome.tabs.sendMessage(tab.id, { action: 'GET_STATS' }); } catch {}
      try { metrics = await globalThis.chrome.tabs.sendMessage(tab.id, { action: 'GET_PERF_METRICS' }); } catch {}
    }
    const tracker = await askTrackerState();
    return {
      generatedAt: new Date().toISOString(), extensionVersion: version, browser: browserLabel(),
      chatgptTab: isChat, contentBridge: !!stats && typeof stats.total === 'number',
      conversation: stats && !stats.error ? stats : null,
      performance: metrics && !metrics.error ? metrics : null,
      tracker: tracker ? { supported: tracker.supported, effective: tracker.effective, hasPermission: tracker.hasPermission, reason: tracker.reason || null } : null
    };
  }

  async function refreshDiagnostics() {
    [diagRuntime, diagChatTab, diagContent, diagTracker].forEach(el => setDiagnostic(el, 'Checking', 'muted'));
    setDiagnostic(diagBrowser, browserLabel(), 'ok');
    const diagnostics = await collectDiagnostics();
    lastDiagnostics = diagnostics;
    setDiagnostic(diagRuntime, diagnostics.extensionVersion === 'unknown' ? 'Unavailable' : `v${diagnostics.extensionVersion}`, diagnostics.extensionVersion === 'unknown' ? 'bad' : 'ok');
    setDiagnostic(diagChatTab, diagnostics.chatgptTab ? 'Connected' : 'Not open', diagnostics.chatgptTab ? 'ok' : 'warn');
    setDiagnostic(diagContent, diagnostics.contentBridge ? 'Working' : diagnostics.chatgptTab ? 'Unavailable' : 'Waiting', diagnostics.contentBridge ? 'ok' : 'warn');
    const trackerText = !diagnostics.tracker ? 'Unavailable' : !diagnostics.tracker.supported ? 'Unsupported' : diagnostics.tracker.effective ? 'Active' : 'Off';
    setDiagnostic(diagTracker, trackerText, diagnostics.tracker?.effective ? 'ok' : 'muted');
  }

  refreshDiagnosticsBtn.addEventListener('click', async () => { await refreshDiagnostics(); showToast('Diagnostics refreshed', 'success'); });
  copyDiagnosticsBtn.addEventListener('click', async () => {
    if (!lastDiagnostics) await refreshDiagnostics();
    const ok = await writeClipboard(JSON.stringify(lastDiagnostics, null, 2));
    showToast(ok ? 'Diagnostics copied' : 'Could not copy diagnostics', ok ? 'success' : 'error');
  });

  function openExternal(url) {
    try { globalThis.chrome.tabs.create({ url }); }
    catch { window.open(url, '_blank', 'noopener'); }
  }
  githubBtn.addEventListener('click', () => openExternal('https://github.com/Kyne0328/chatgpt-performance-optimizer-web-extension'));
  websiteBtn.addEventListener('click', () => openExternal('https://kyne.is-a.dev/'));

  async function init() {
    try {
      const stored = await storage?.get(['uiLang']);
      currentLang = stored?.uiLang || 'auto';
      langSelect.value = currentLang;
    } catch {}

    versionText.textContent = `v${runtime?.getManifest?.().version || '1.0.0'}`;

    try {
      const prefs = await runtime?.sendMessage({ action: 'GET_PREFS' });
      applyPrefs(prefs && !prefs.error ? prefs : DEFAULT_PREFS);
    } catch { applyPrefs(DEFAULT_PREFS); }
    await refreshTracker();

    try {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && /https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) cachedChatTab = tab;
    } catch {}

    setConnectedUI(!!cachedChatTab);
    updateSelectionCount(0);

    if (cachedChatTab) {
      try {
        const state = await globalThis.chrome.tabs.sendMessage(cachedChatTab.id, { action: 'GET_SEL_MODE_STATE' });
        paintSelectionMode(!!state?.enabled);
        if (state?.enabled) updateSelectionCount(Number(state.count || 0));
      } catch { paintSelectionMode(false); }
      await refreshLiveData();
      liveTimer = setInterval(refreshLiveData, 2500);
    } else {
      showEmptyStats();
      paintSelectionMode(false);
    }

    refreshDiagnostics();
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLiveData(); });
  window.addEventListener('pagehide', () => {
    clearInterval(liveTimer); clearTimeout(toastTimer); clearTimeout(resetTimer);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
