/**
 * Rel.AI Companion — page bridge
 * Reads message metadata from ChatGPT's page context and returns it to the
 * isolated content script through a synchronous DOM event bridge.
 */
(() => {
  'use strict';

  function findMessageProps(el) {
    if (!el) return null;
    try {
      const fiberKey = Object.keys(el).find(key => key.startsWith('__reactFiber'));
      if (!fiberKey) return null;
      let fiber = el[fiberKey];
      for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
        const message = fiber.memoizedProps?.message;
        if (!message || typeof message !== 'object' || message.create_time == null) continue;
        return {
          create_time: parseFloat(message.create_time) || null,
          update_time: parseFloat(message.update_time) || null,
          id: message.id || null
        };
      }
    } catch {}
    return null;
  }

  function extractAllTimestamps() {
    const result = {};
    try {
      document.querySelectorAll('[data-testid^="conversation-turn-"]').forEach(turn => {
        const testId = turn.getAttribute('data-testid');
        if (!testId) return;
        const meta = findMessageProps(turn.querySelector('[data-message-author-role]'));
        if (meta) result[testId] = meta;
      });
    } catch {}
    document.documentElement.setAttribute('data-relai-ts-payload', JSON.stringify(result));
  }

  document.addEventListener('relai-extract-ts', extractAllTimestamps);
  document.documentElement.setAttribute('data-relai-mw-ready', '1');
})();
