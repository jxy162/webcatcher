import { analyzeCss, simpleHash } from './lib/css-parser.js';
import { analyzeJs } from './lib/js-analyzer.js';

const SESSION_PREFIX = 'webcatcher:session:';
const MAX_EVENTS = 1600;
const LITE_MAX_EVENTS = 250;
const MAX_CSS_ANALYSES = 80;
const MAX_JS_ANALYSES = 60;
const MAX_SEEN_SCRIPTS = 160;
const MAX_SEEN_STYLES = 100;
const PANEL_PORT = 'webcatcher-panel';

const sessions = new Map();
const loadingSessions = new Map();
const saveTimers = new Map();
const panelPorts = new Map();
const sourceCache = new Map();
const analysisCache = new Map();
let sourceCacheBytes = 0;
let analysisCacheBytes = 0;
const SOURCE_CACHE_LIMIT = 8 * 1024 * 1024;
const ANALYSIS_CACHE_LIMIT = 14 * 1024 * 1024;
let fetchActive = 0;
const fetchQueue = [];
const badgeTimers = new Map();

function makeSession(tabId) {
  const now = Date.now();
  return {
    tabId,
    createdAt: now,
    startedAt: now,
    active: true,
    page: { url: '', title: '' },
    events: [],
    eventSeq: 0,
    dropped: 0,
    analyses: { css: [], js: [] },
    snapshot: null,
    inventory: {
      seenScripts: [],
      seenStyles: [],
      lastScanAt: 0,
      errors: [],
    },
    settings: { recordRaf: true, captureStyles: true },
  };
}

function storageKey(tabId) { return `${SESSION_PREFIX}${tabId}`; }

async function loadSession(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  if (loadingSessions.has(tabId)) return loadingSessions.get(tabId);
  const pending = (async () => {
    const key = storageKey(tabId);
    let stored = null;
    try {
      stored = (await chrome.storage.session.get(key))[key];
    } catch (error) {
      console.warn('[WebCatcher] session restore failed', error);
    }
    const session = stored || makeSession(tabId);
    if (!session.inventory) session.inventory = makeSession(tabId).inventory;
    if (!session.settings) session.settings = { recordRaf: true, captureStyles: true };
    sessions.set(tabId, session);
    return session;
  })();
  loadingSessions.set(tabId, pending);
  try {
    return await pending;
  } finally {
    loadingSessions.delete(tabId);
  }
}

function scheduleSave(session) {
  clearTimeout(saveTimers.get(session.tabId));
  saveTimers.set(session.tabId, setTimeout(() => persistSession(session), 1500));
}

async function persistSession(session) {
  saveTimers.delete(session.tabId);
  const key = storageKey(session.tabId);
  const storedEvents = session.events.slice(-700).map((event) => {
    const copy = { ...event };
    compactEvent(copy, true);
    return copy;
  });
  const compact = {
    ...session,
    events: storedEvents,
    analyses: {
      css: session.analyses.css.slice(-40).map((item) => ({ ...item, source: undefined })),
      js: session.analyses.js.slice(-40).map((item) => ({ ...item, source: undefined })),
    },
  };
  try {
    await chrome.storage.session.set({ [key]: compact });
  } catch (error) {
    console.warn('[WebCatcher] session quota reached, trimming', error);
    compact.events = compact.events.slice(-250);
    compact.analyses.css = compact.analyses.css.slice(-20);
    compact.analyses.js = compact.analyses.js.slice(-20);
    compact.analyses.css.forEach((item) => { delete item.source; });
    compact.analyses.js.forEach((item) => { delete item.source; });
    try { await chrome.storage.session.set({ [key]: compact }); } catch (again) { console.warn('[WebCatcher] session persist failed', again); }
  }
}

async function deleteSession(tabId) {
  sessions.delete(tabId);
  loadingSessions.delete(tabId);
  clearTimeout(saveTimers.get(tabId));
  saveTimers.delete(tabId);
  try { await chrome.storage.session.remove(storageKey(tabId)); } catch { /* ignore */ }
}

function broadcast(tabId, message) {
  for (const [port, info] of panelPorts) {
    if (info.tabId !== tabId) continue;
    try { port.postMessage(message); } catch { panelPorts.delete(port); }
  }
}

function hasPanel(tabId) {
  for (const info of panelPorts.values()) {
    if (info.tabId === tabId) return true;
  }
  return false;
}

async function sendStateToTab(tabId) {
  const session = await loadSession(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'webcatcher:state',
      active: session.active,
      settings: session.settings,
      panelOpen: hasPanel(tabId),
    });
  } catch { /* restricted tab */ }
}

function publicSession(session) {
  return {
    tabId: session.tabId,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    active: session.active,
    page: session.page,
    events: session.events,
    eventSeq: session.eventSeq,
    dropped: session.dropped,
    analyses: session.analyses,
    snapshot: session.snapshot,
    settings: session.settings,
  };
}

function scheduleBadge(tabId, session) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(() => {
    badgeTimers.delete(tabId);
    updateBadge(tabId, session);
  }, 120));
}

async function updateBadge(tabId, session) {
  if (!session) return;
  const count = session.events.length;
  const text = session.active ? (count ? (count > 999 ? '999+' : String(count)) : 'REC') : 'Ⅱ';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: session.active ? '#FF5F3D' : '#5B6472' });
    await chrome.action.setTitle({
      tabId,
      title: session.active ? `WebCatcher · 正在录制（${count} 个事件）` : 'WebCatcher · 已暂停',
    });
  } catch { /* tab may be gone */ }
}

async function setActive(tabId, active) {
  const session = await loadSession(tabId);
  session.active = Boolean(active);
  if (session.active) session.resumedAt = Date.now();
  else session.pausedAt = Date.now();
  scheduleSave(session);
  scheduleBadge(tabId, session);
  const panelOpen = hasPanel(tabId);
  broadcast(tabId, { type: 'state', active: session.active, settings: session.settings, panelOpen });
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'webcatcher:state', active: session.active, settings: session.settings, panelOpen });
  } catch { /* restricted tab */ }
  return session;
}

async function clearSession(tabId) {
  const session = await loadSession(tabId);
  const page = session.page;
  const settings = session.settings;
  const active = session.active;
  Object.assign(session, makeSession(tabId), { page, settings, active });
  broadcast(tabId, { type: 'session:reset', session: publicSession(session) });
  scheduleSave(session);
  scheduleBadge(tabId, session);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'webcatcher:action', action: 'clear' });
  } catch { /* restricted tab */ }
  return session;
}

function compactEvent(event, hard = false) {
  if (!event || event._compact) return;
  event._compact = true;
  if (event.stack) {
    event.stack = event.stack.split('\n').slice(0, hard ? 2 : 3).join('\n');
  }
  if (Array.isArray(event.matchedRules)) {
    if (hard) delete event.matchedRules;
    else event.matchedRules = event.matchedRules.slice(0, 1).map((rule) => ({ ...rule, text: String(rule.text || '').slice(0, 600) }));
  }
  if (Array.isArray(event.keyframes)) event.keyframes = event.keyframes.slice(0, hard ? 3 : 6);
  if (event.target) {
    event.target = { ...event.target, computed: hard ? {} : event.target.computed };
    delete event.target.html;
  }
  if (event.payload) {
    event.payload = { ...event.payload };
    if (Array.isArray(event.payload.keyframes)) event.payload.keyframes = event.payload.keyframes.slice(0, 4);
    if (event.payload.sheets) delete event.payload.sheets;
    if (event.payload.args && JSON.stringify(event.payload.args).length > 1000) event.payload.args = '[large payload omitted]';
    if (hard) delete event.payload.text;
  }
}

function addEvent(session, event) {
  if (!event || typeof event !== 'object') return;
  session.eventSeq += 1;
  const eventTs = Number.isFinite(event.ts) ? event.ts : Date.now();
  const normalized = {
    ...event,
    id: event.id || `evt-${session.eventSeq}`,
    seq: session.eventSeq,
    t: Math.max(0, eventTs - session.startedAt),
    ts: eventTs,
  };
  if (typeof normalized.stack === 'string' && normalized.stack.length > 4000) normalized.stack = `${normalized.stack.slice(0, 4000)}\n…`;
  session.events.push(normalized);
  const panelOpen = hasPanel(session.tabId);
  const fullDetail = panelOpen && event.frame?.top !== false;
  const maxEvents = fullDetail ? MAX_EVENTS : LITE_MAX_EVENTS;
  if (session.events.length > maxEvents) {
    const overflow = session.events.length - maxEvents;
    session.events.splice(0, overflow);
    session.dropped += overflow;
  }
  const keepFull = fullDetail ? 500 : 80;
  if (session.events.length > keepFull + 140 && session.events.length % 50 === 0) {
    const cutoff = session.events.length - keepFull;
    for (let i = 0; i < cutoff; i += 1) compactEvent(session.events[i]);
  }
  return normalized;
}


function normalizeUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://invalid.local/');
    url.hash = '';
    return url.href;
  } catch { return String(raw).split('#')[0]; }
}

function canFetch(url) {
  return /^https?:/i.test(url) || /^file:/i.test(url);
}

async function fetchText(url, maxBytes = 1_800_000) {
  const key = normalizeUrl(url);
  if (sourceCache.has(key)) return sourceCache.get(key);
  if (!canFetch(key)) throw new Error('unsupported URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(key, { signal: controller.signal, credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) {
      const text = await response.text();
      const result = { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
      rememberSource(key, result);
      return result;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const capacity = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(capacity);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(merged);
    const result = { text, truncated };
    rememberSource(key, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function rememberSource(key, result) {
  const previous = sourceCache.get(key);
  if (previous) sourceCacheBytes -= previous.text.length;
  sourceCache.set(key, result);
  sourceCacheBytes += result.text.length;
  while (sourceCache.size > 40 || sourceCacheBytes > SOURCE_CACHE_LIMIT) {
    const oldest = sourceCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = sourceCache.get(oldest);
    sourceCache.delete(oldest);
    sourceCacheBytes -= evicted?.text?.length || 0;
  }
}

function rememberAnalysis(key, value) {
  const roughBytes = (value.items || []).reduce((sum, item) => sum + (item.text?.length || 0), 0)
    + (value.snippets || []).reduce((sum, item) => sum + (item.code?.length || 0), 0)
    + (value.source?.length || 0);
  const previous = analysisCache.get(key);
  if (previous) analysisCacheBytes -= previous._bytes || 0;
  value._bytes = roughBytes;
  analysisCache.set(key, value);
  analysisCacheBytes += roughBytes;
  while (analysisCache.size > 100 || analysisCacheBytes > ANALYSIS_CACHE_LIMIT) {
    const oldest = analysisCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = analysisCache.get(oldest);
    analysisCache.delete(oldest);
    analysisCacheBytes -= evicted?._bytes || 0;
  }
}


function enqueueFetch(task) {
  return new Promise((resolve, reject) => {
    fetchQueue.push({ task, resolve, reject });
    drainFetchQueue();
  });
}

function drainFetchQueue() {
  while (fetchActive < 4 && fetchQueue.length) {
    const job = fetchQueue.shift();
    fetchActive += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        fetchActive -= 1;
        drainFetchQueue();
      });
  }
}

function analysisForCss(url, text, sourceKind) {
  const cacheKey = `css:${sourceKind}:${url}:${text.length}:${simpleHash(text.slice(0, 3000))}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) return cached;
  const result = analyzeCss(text, url, { maxItems: 220 });
  const analysis = {
    id: simpleHash(cacheKey),
    sourceUrl: url,
    sourceKind,
    items: result.items,
    metrics: result.metrics,
    truncated: text.length >= 1_800_000,
  };
  rememberAnalysis(cacheKey, analysis);
  return analysis;
}

function analysisForJs(item, text) {
  const sourceUrl = item.src || item.label || 'inline-script';
  const cacheKey = `js:${item.inline ? 'inline' : 'external'}:${sourceUrl}:${text.length}:${simpleHash(text.slice(0, 3000))}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) return cached;
  const result = analyzeJs(text, sourceUrl, {
    inline: Boolean(item.inline),
    keepSource: Boolean(item.inline),
    maxBytes: 2_400_000,
  });
  if (!result) return null;
  result.id = simpleHash(cacheKey);
  result.truncated = text.length >= 2_400_000;
  rememberAnalysis(cacheKey, result);
  return result;
}

function addInventoryError(session, url, message) {
  session.inventory.errors.unshift({ url, message, at: Date.now() });
  session.inventory.errors = session.inventory.errors.slice(0, 30);
}

function forgetSeen(session, listName, key) {
  const list = session.inventory[listName];
  const index = list.indexOf(key);
  if (index >= 0) list.splice(index, 1);
}

async function processInventory(tabId, inventory, sender) {
  if (!Number.isInteger(tabId) || !hasPanel(tabId)) return;
  const session = await loadSession(tabId);
  if (!inventory || typeof inventory !== 'object') return;
  session.inventory.lastScanAt = Date.now();
  if (inventory.page) {
    session.page = {
      url: inventory.page.url || sender?.tab?.url || session.page.url,
      title: inventory.page.title || sender?.tab?.title || session.page.title,
    };
  }

  const newCss = [];
  const newJs = [];
  const errorsBefore = session.inventory.errors.length;
  const cssJobs = [];
  const jsJobs = [];
  const seenScripts = new Set(session.inventory.seenScripts);
  const seenStyles = new Set(session.inventory.seenStyles);

  for (const style of (inventory.styles || []).slice(0, 80)) {
    const key = style.inline
      ? `inline:${style.label || ''}:${simpleHash(style.text || '')}`
      : normalizeUrl(style.href);
    if (!key || seenStyles.has(key)) continue;
    if (style.inline && !style.text?.trim()) continue;
    seenStyles.add(key);
    session.inventory.seenStyles.push(key);
    const url = style.href || style.label || 'inline-style';
    if (style.inline) {
      try {
        const analysis = analysisForCss(url, style.text || '', 'inline');
        if (analysis?.items?.length) newCss.push(analysis);
      } catch (error) { addInventoryError(session, url, error.message); }
    } else if (canFetch(url)) {
      cssJobs.push(async () => {
        try {
          const fetched = await enqueueFetch(() => fetchText(url));
          const analysis = analysisForCss(normalizeUrl(url), fetched.text, 'external');
          if (analysis?.items?.length) newCss.push(analysis);
        } catch (error) { addInventoryError(session, url, error.message); forgetSeen(session, 'seenStyles', key); }
      });
    }
  }

  for (const script of (inventory.scripts || []).slice(0, 120)) {
    const key = script.inline
      ? `inline:${script.label || ''}:${simpleHash(script.text || '')}`
      : normalizeUrl(script.src);
    if (!key || seenScripts.has(key)) continue;
    if (script.inline && !script.text?.trim()) continue;
    seenScripts.add(key);
    session.inventory.seenScripts.push(key);
    const url = script.src || script.label || 'inline-script';
    if (script.inline) {
      try {
        const analysis = analysisForJs(script, script.text || '');
        if (analysis) newJs.push(analysis);
      } catch (error) { addInventoryError(session, url, error.message); }
    } else if (canFetch(url) && !/(analytics|gtag|googletagmanager|doubleclick|sentry|hotjar|clarity|segment|mixpanel)/i.test(url)) {
      jsJobs.push(async () => {
        try {
          const fetched = await enqueueFetch(() => fetchText(url, 2_400_000));
          const analysis = analysisForJs(script, fetched.text);
          if (analysis) newJs.push(analysis);
        } catch (error) {
          addInventoryError(session, url, error.message);
          forgetSeen(session, 'seenScripts', key);
          newJs.push({
            id: simpleHash(`error:${url}`), sourceUrl: url, sourceKind: 'external', error: error.message,
            score: 0, labels: [], tags: [], libraries: [], snippets: [], bytes: 0, lines: 0,
          });
        }
      });
    }
  }

  session.inventory.seenScripts = session.inventory.seenScripts.slice(-MAX_SEEN_SCRIPTS);
  session.inventory.seenStyles = session.inventory.seenStyles.slice(-MAX_SEEN_STYLES);

  await Promise.all([...cssJobs, ...jsJobs].map((job) => job()));
  if (!hasPanel(tabId)) return;

  const uniqueCss = [];
  const cssIds = new Set(session.analyses.css.map((item) => item.id));
  for (const item of newCss) {
    if (!item || cssIds.has(item.id)) continue;
    cssIds.add(item.id);
    uniqueCss.push(item);
  }
  const uniqueJs = [];
  const jsIds = new Set(session.analyses.js.map((item) => item.id));
  for (const item of newJs) {
    if (!item || jsIds.has(item.id)) continue;
    jsIds.add(item.id);
    uniqueJs.push(item);
  }
  session.analyses.css.push(...uniqueCss);
  session.analyses.js.push(...uniqueJs);
  if (uniqueJs.length) {
    const recovered = new Set(uniqueJs.map((item) => item.sourceUrl));
    session.analyses.js = session.analyses.js.filter((item) => !(item.error && recovered.has(item.sourceUrl)));
  }
  session.analyses.css = session.analyses.css.slice(-MAX_CSS_ANALYSES);
  session.analyses.js = session.analyses.js.slice(-MAX_JS_ANALYSES);

  if (inventory.animations) session.snapshot = { animations: inventory.animations, at: Date.now() };
  if (uniqueCss.length || uniqueJs.length) {
    broadcast(tabId, { type: 'analysis:patch', css: uniqueCss, js: uniqueJs });
  }
  if (inventory.animations) {
    broadcast(tabId, { type: 'snapshot', snapshot: session.snapshot });
  }
  if (session.inventory.errors.length > errorsBefore) {
    broadcast(tabId, { type: 'toast', message: '部分样式或脚本无法读取，稍后会自动重试' });
  }
  scheduleSave(session);
}

async function handleRecorderHello(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false };
  const session = await loadSession(tabId);
  const tab = sender.tab;
  const previousUrl = session.page?.url;
  const nextUrl = message.page?.url || tab?.url || session.page?.url || '';
  if (nextUrl && previousUrl && nextUrl !== previousUrl) {
    const event = addEvent(session, {
      kind: 'navigation',
      summary: '页面导航',
      url: nextUrl,
      frame: { top: sender.frameId === 0, url: nextUrl },
      payload: { from: previousUrl, to: nextUrl },
      t: Date.now() - session.startedAt,
      ts: Date.now(),
    });
    broadcast(tabId, { type: 'events', events: [event] });
  }
  session.page = { url: nextUrl, title: message.page?.title || tab?.title || session.page?.title || '' };
  scheduleSave(session);
  scheduleBadge(tabId, session);
  return { ok: true, active: session.active, settings: session.settings, tabId, startedAt: session.startedAt, panelOpen: hasPanel(tabId) };
}

async function handleRecorderEvents(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return;
  const session = await loadSession(tabId);
  const incoming = Array.isArray(message.events) ? message.events.slice(0, 300) : [];
  if (!incoming.length) return;
  const added = [];
  for (const event of incoming) {
    if (!session.active) continue;
    const stored = addEvent(session, event);
    if (stored) added.push(stored);
  }
  if (!added.length) return;
  scheduleSave(session);
  scheduleBadge(tabId, session);
  broadcast(tabId, { type: 'events', events: added });
}

async function handleSnapshot(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || !hasPanel(tabId)) return;
  const session = await loadSession(tabId);
  session.snapshot = { animations: message.snapshot?.animations || [], at: Date.now() };
  broadcast(tabId, { type: 'snapshot', snapshot: session.snapshot });
  scheduleSave(session);
}

async function handlePanelHello(port, message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return;
  const previous = panelPorts.get(port);
  if (previous) panelPorts.delete(port);
  panelPorts.set(port, { tabId, at: Date.now() });
  const session = await loadSession(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.title) session.page.title = tab.title;
    if (tab?.url) session.page.url = tab.url;
  } catch { /* ignore */ }
  try {
    port.postMessage({ type: 'session', session: publicSession(session) });
  } catch { /* port closed */ }
  scheduleBadge(tabId, session);
  await sendStateToTab(tabId);
  chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: true }).catch(() => {});
}

async function handlePanelAction(port, message) {
  const info = panelPorts.get(port);
  const tabId = Number(message.tabId ?? info?.tabId);
  if (!Number.isInteger(tabId)) return;
  switch (message.action) {
    case 'pause':
    case 'resume': {
      const session = await setActive(tabId, message.action === 'resume');
      port.postMessage({ type: 'state', active: session.active, settings: session.settings, panelOpen: hasPanel(tabId) });
      break;
    }
    case 'toggle': {
      const session = await loadSession(tabId);
      const updated = await setActive(tabId, !session.active);
      port.postMessage({ type: 'state', active: updated.active, settings: updated.settings, panelOpen: hasPanel(tabId) });
      break;
    }
    case 'clear':
      await clearSession(tabId);
      break;
    case 'rescan': {
      try { await chrome.tabs.sendMessage(tabId, { type: 'webcatcher:action', action: 'rescan' }); } catch { /* ignore */ }
      const session = await loadSession(tabId);
      port.postMessage({ type: 'toast', message: '已请求页面重新扫描' });
      scheduleBadge(tabId, session);
      break;
    }
    case 'settings': {
      const session = await loadSession(tabId);
      session.settings = { ...session.settings, ...(message.settings || {}) };
      scheduleSave(session);
      try { await chrome.tabs.sendMessage(tabId, { type: 'webcatcher:state', active: session.active, settings: session.settings, panelOpen: hasPanel(tabId) }); } catch { /* ignore */ }
      broadcast(tabId, { type: 'settings', settings: session.settings });
      break;
    }
    case 'watch': {
      panelPorts.set(port, { tabId, at: Date.now() });
      const session = await loadSession(tabId);
      port.postMessage({ type: 'session', session: publicSession(session) });
      scheduleBadge(tabId, session);
      await sendStateToTab(tabId);
      break;
    }
    default:
      break;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'recorder:hello') {
    handleRecorderHello(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'recorder:events') {
    handleRecorderEvents(message, sender).catch((error) => console.warn('[WebCatcher] events', error));
    return false;
  }
  if (message.type === 'recorder:inventory') {
    processInventory(sender?.tab?.id, message.inventory, sender).catch((error) => console.warn('[WebCatcher] inventory', error));
    return false;
  }
  if (message.type === 'recorder:snapshot') {
    handleSnapshot(message, sender).catch((error) => console.warn('[WebCatcher] snapshot', error));
    return false;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') {
      handlePanelHello(port, message).catch((error) => console.warn('[WebCatcher] panel hello', error));
    } else if (message.type === 'action') {
      handlePanelAction(port, message).catch((error) => console.warn('[WebCatcher] panel action', error));
    }
  });
  port.onDisconnect.addListener(() => {
    const info = panelPorts.get(port);
    panelPorts.delete(port);
    if (info && !hasPanel(info.tabId)) sendStateToTab(info.tabId).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  deleteSession(tabId);
  for (const [port, info] of panelPorts) {
    if (info.tabId === tabId) panelPorts.delete(port);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const session = await loadSession(tabId);
    const tab = await chrome.tabs.get(tabId);
    if (tab?.title) session.page.title = tab.title;
    if (tab?.url) session.page.url = tab.url;
    scheduleBadge(tabId, session);
  } catch { /* ignore */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.title && !changeInfo.url) return;
  loadSession(tabId).then((session) => {
    if (changeInfo.title) session.page.title = changeInfo.title;
    if (changeInfo.url) session.page.url = changeInfo.url;
    scheduleSave(session);
    broadcast(tabId, { type: 'page', page: session.page });
  }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const session = await loadSession(tab.id);
    await setActive(tab.id, !session.active);
  } catch (error) { console.warn('[WebCatcher] command', error); }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
