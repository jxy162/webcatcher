(() => {
  'use strict';
  const MAIN_SOURCE = 'webcatcher-main';
  const BRIDGE_SOURCE = 'webcatcher-bridge';
  let active = true;
  let panelOpen = false;
  let settings = { recordRaf: true, captureStyles: true };
  let startedAt = Date.now();
  let helloDone = false;

  const toMain = (message) => {
    try {
      window.postMessage({ source: BRIDGE_SOURCE, ...message }, '*');
    } catch { /* ignore */ }
  };

  const send = (message) => {
    try { return chrome.runtime.sendMessage(message); }
    catch { return Promise.resolve(null); }
  };

  const announceState = (response) => {
    if (!response) return;
    if (typeof response.active === 'boolean') active = response.active;
    if (response.settings) settings = response.settings;
    if (Number.isFinite(response.startedAt)) startedAt = response.startedAt;
    if (typeof response.panelOpen === 'boolean') panelOpen = response.panelOpen;
    toMain({ type: 'state', active, settings, startedAt, panelOpen });
  };

  const hello = () => {
    if (helloDone) return;
    helloDone = true;
    Promise.resolve(send({
      type: 'recorder:hello',
      page: { url: location.href, title: document.title || '' },
    })).then(announceState).catch(() => {});
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MAIN_SOURCE) return;
    if (data.type === 'events' && Array.isArray(data.events) && data.events.length) {
      send({ type: 'recorder:events', events: data.events });
    } else if (data.type === 'inventory' && data.inventory) {
      send({ type: 'recorder:inventory', inventory: data.inventory });
    } else if (data.type === 'snapshot' && data.snapshot) {
      send({ type: 'recorder:snapshot', snapshot: data.snapshot });
    } else if (data.type === 'hello') {
      hello();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'webcatcher:state') {
      if (typeof message.active === 'boolean') active = message.active;
      if (message.settings) settings = message.settings;
      if (typeof message.panelOpen === 'boolean') panelOpen = message.panelOpen;
      toMain({ type: 'state', active, settings, startedAt, panelOpen });
      sendResponse?.({ ok: true });
    } else if (message.type === 'webcatcher:action') {
      toMain({ type: 'action', action: message.action });
      sendResponse?.({ ok: true });
    }
    return false;
  });

  hello();
  setTimeout(() => toMain({ type: 'hello' }), 0);
  setTimeout(hello, 1200);
  window.addEventListener('pagehide', () => toMain({ type: 'action', action: 'flush' }));
})();
