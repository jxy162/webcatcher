import { buildMarkdown, buildJson, downloadText, kindLabel, fmtBytes } from './lib/export.js';
import { escapeHtml, shortUrl, formatClock, timeAgo } from './lib/format.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  conn: $('#connState'),
  settingsBtn: $('#settingsBtn'),
  pageTitle: $('#pageTitle'),
  pageUrl: $('#pageUrl'),
  pageMark: $('#pageMark'),
  deck: $('#deck'),
  recordBtn: $('#recordBtn'),
  recordingState: $('#recordingState'),
  eventCount: $('#eventCount'),
  sessionClock: $('#sessionClock'),
  rescanBtn: $('#rescanBtn'),
  clearBtn: $('#clearBtn'),
  exportBtn: $('#exportBtn'),
  tapeTicks: $('#tapeTicks'),
  liveCount: $('#liveCount'),
  timelineCount: $('#timelineCount'),
  cssCount: $('#cssCount'),
  jsCount: $('#jsCount'),
  tabs: $('#tabs'),
  timelineList: $('#timelineList'),
  timelineEmpty: $('#timelineEmpty'),
  timelineFilters: $('#timelineFilters'),
  timelineSearch: $('#timelineSearch'),
  newEventsBtn: $('#newEventsBtn'),
  cssList: $('#cssList'),
  cssEmpty: $('#cssEmpty'),
  cssSummary: $('#cssSummary'),
  cssFilters: $('#cssFilters'),
  cssSearch: $('#cssSearch'),
  jsList: $('#jsList'),
  jsEmpty: $('#jsEmpty'),
  jsSummary: $('#jsSummary'),
  jsFilters: $('#jsFilters'),
  jsSearch: $('#jsSearch'),
  liveList: $('#liveList'),
  liveEmpty: $('#liveEmpty'),
  liveTotal: $('#liveTotal'),
  liveUpdated: $('#liveUpdated'),
  refreshLiveBtn: $('#refreshLiveBtn'),
  detailDrawer: $('#detailDrawer'),
  detailKind: $('#detailKind'),
  detailTitle: $('#detailTitle'),
  detailBody: $('#detailBody'),
  detailClose: $('#detailClose'),
  exportMenu: $('#exportMenu'),
  settingsDialog: $('#settingsDialog'),
  settingRaf: $('#settingRaf'),
  settingStyles: $('#settingStyles'),
  saveSettingsBtn: $('#saveSettingsBtn'),
  helpDialog: $('#helpDialog'),
  helpBtn: $('#helpBtn'),
  clearDialog: $('#clearDialog'),
  confirmClearBtn: $('#confirmClearBtn'),
  toast: $('#toast'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
};

const state = {
  tabId: null,
  port: null,
  reconnectTimer: null,
  connected: false,
  restricted: false,
  page: { url: '', title: '' },
  startedAt: Date.now(),
  events: [],
  css: new Map(),
  js: new Map(),
  snapshot: null,
  active: true,
  settings: { recordRaf: true, captureStyles: true },
  activeTab: 'timeline',
  timelineFilter: 'all',
  cssFilter: 'all',
  jsFilter: 'all',
  timelineQuery: '',
  cssQuery: '',
  jsQuery: '',
  pinned: true,
  pendingNew: 0,
  renderedSeq: 0,
  newSeqs: new Set(),
  collapsedSources: new Set(),
  seenSources: new Set(),
  copyStore: new Map(),
  detailEvent: null,
  toastTimer: 0,
  timelineRaf: 0,
  lastSnapshotAt: 0,
};

const KIND_GROUPS = {
  motion: new Set(['transition', 'animation', 'waapi', 'waapi-control', 'view-transition']),
  style: new Set(['style', 'class-change', 'css-change', 'css-inject']),
  route: new Set(['route', 'navigation']),
  loop: new Set(['raf', 'observer', 'scroll', 'gsap', 'anime', 'library']),
  waapi: new Set(['waapi', 'waapi-control']),
};

function groupOf(kind) {
  for (const [group, set] of Object.entries(KIND_GROUPS)) {
    if (set.has(kind)) return group;
  }
  return 'other';
}

function isRestricted(url) {
  return /^(chrome|edge|about|devtools|chrome-extension|moz-extension):/i.test(url || '');
}

function safe(value) { return escapeHtml(value); }
function attr(value) { return escapeHtml(value).replace(/\n/g, ' '); }
function pretty(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function rememberCopy(text) {
  const key = `copy-${state.copyStore.size + 1}`;
  state.copyStore.set(key, String(text ?? ''));
  return key;
}
function displaySource(url) {
  if (!url) return 'inline';
  const script = String(url).match(/#webcatcher-inline-script-(\d+)/);
  if (script) return `inline <script> #${script[1]}`;
  const style = String(url).match(/#webcatcher-inline-style-(\d+)/);
  if (style) return `inline <style> #${style[1]}`;
  const cssom = String(url).match(/#webcatcher-cssom-(\d+)/);
  if (cssom) return `CSSOM style #${cssom[1]}`;
  const adopted = String(url).match(/#webcatcher-adopted-style-(\d+)/);
  if (adopted) return `adopted stylesheet #${adopted[1]}`;
  return shortUrl(url, 58);
}

function fileHost() {
  try { return new URL(state.page.url).hostname.replace(/^www\./, '') || 'page'; } catch { return 'page'; }
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    showToast('已复制到剪贴板');
  } catch {
    const area = document.createElement('textarea');
    area.value = String(text ?? '');
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); showToast('已复制到剪贴板'); }
    catch { showToast('复制失败'); }
    area.remove();
  }
}

function setConnection(mode, text) {
  els.conn.classList.remove('connected', 'error');
  els.statusDot.classList.remove('off', 'paused');
  if (mode === 'connected') els.conn.classList.add('connected');
  if (mode === 'error') { els.conn.classList.add('error'); els.statusDot.classList.add('off'); }
  if (mode === 'paused') { els.conn.classList.add('connected'); els.statusDot.classList.add('paused'); }
  els.conn.querySelector('span').textContent = text;
  els.statusText.textContent = text;
}

function updateRecordingUI() {
  els.deck.dataset.active = String(state.active);
  els.recordBtn.setAttribute('aria-pressed', String(state.active));
  els.recordingState.textContent = state.active ? '正在录制' : '已暂停';
  els.recordBtn.title = state.active ? '暂停录制（Alt+Shift+R）' : '继续录制（Alt+Shift+R）';
  els.statusDot.classList.toggle('paused', !state.active && !state.restricted);
  if (!state.restricted) setConnection(state.active ? 'connected' : 'paused', state.active ? '已连接' : '已暂停');
}

function updatePage() {
  const title = state.page.title || (state.page.url ? shortUrl(state.page.url, 60) : '等待页面');
  els.pageTitle.textContent = title;
  els.pageUrl.textContent = state.page.url || '打开一个网页开始捕获';
  let mark = 'W';
  try { mark = new URL(state.page.url).hostname.replace(/^www\./, '').charAt(0) || 'W'; } catch { /* ignore */ }
  els.pageMark.textContent = mark.toUpperCase();
  els.pageMark.title = state.page.title || '';
}

function send(message) {
  if (!state.port) return false;
  try { state.port.postMessage(message); return true; }
  catch { return false; }
}

async function findActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

function resetLocal() {
  state.events = [];
  state.css.clear();
  state.js.clear();
  state.snapshot = null;
  state.pendingNew = 0;
  state.pinned = true;
  state.newSeqs.clear();
  state.detailEvent = null;
  document.body.classList.remove('drawer-open');
  els.detailDrawer.setAttribute('aria-hidden', 'true');
}

function ingestSession(session) {
  if (!session) return;
  resetLocal();
  state.startedAt = session.startedAt || Date.now();
  state.page = session.page || { url: '', title: '' };
  state.active = session.active !== false;
  state.settings = session.settings || state.settings;
  state.events = Array.isArray(session.events) ? session.events : [];
  for (const analysis of session.analyses?.css || []) state.css.set(analysis.id || analysis.sourceUrl, analysis);
  for (const analysis of session.analyses?.js || []) state.js.set(analysis.id || analysis.sourceUrl, analysis);
  state.snapshot = session.snapshot || null;
  state.restricted = isRestricted(state.page.url);
  state.connected = true;
  updatePage();
  updateRecordingUI();
  updateCounts();
  updateTape();
  renderTimeline(true);
  renderStyles();
  renderScripts();
  renderLive();
  if (state.restricted) {
    setConnection('error', '此页面不可捕获');
    els.timelineEmpty.hidden = false;
    els.timelineEmpty.querySelector('h2').textContent = '浏览器内部页面无法捕获';
    els.timelineEmpty.querySelector('p').textContent = '请切换到普通的 http 或 https 网页，再打开侧边栏。';
  } else {
    setConnection(state.active ? 'connected' : 'paused', state.active ? '已连接' : '已暂停');
  }
}

function connect(tabId) {
  clearTimeout(state.reconnectTimer);
  if (state.port) {
    try { state.port.disconnect(); } catch { /* ignore */ }
  }
  state.connected = false;
  setConnection('connected', '连接中');
  let port;
  try { port = chrome.runtime.connect({ name: 'webcatcher-panel' }); }
  catch { setConnection('error', '连接失败'); return; }
  state.port = port;
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    if (state.port !== port) return;
    state.connected = false;
    if (state.restricted) return;
    setConnection('error', '正在重连');
    state.reconnectTimer = setTimeout(() => {
      if (state.tabId) connect(state.tabId);
    }, 650);
  });
  port.postMessage({ type: 'hello', tabId });
}

async function watchActiveTab() {
  const tab = await findActiveTab();
  if (!tab?.id) {
    setConnection('error', '没有活动标签页');
    return;
  }
  if (tab.id === state.tabId) {
    if (tab.url) state.page.url = tab.url;
    if (tab.title) state.page.title = tab.title;
    state.restricted = isRestricted(state.page.url);
    updatePage();
    return;
  }
  state.tabId = tab.id;
  state.page = { url: tab.url || '', title: tab.title || '' };
  state.restricted = isRestricted(tab.url);
  updatePage();
  if (state.restricted) {
    resetLocal();
    updateCounts();
    setConnection('error', '此页面不可捕获');
  }
  connect(tab.id);
  send({ type: 'action', action: 'watch', tabId: tab.id });
}

function handlePortMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'session') {
    ingestSession(message.session);
    return;
  }
  if (message.type === 'events') {
    const incoming = Array.isArray(message.events) ? message.events : [];
    for (const event of incoming) {
      state.events.push(event);
      state.newSeqs.add(event.seq);
    }
    setTimeout(() => state.newSeqs.clear(), 1200);
    if (state.events.length > 4200) state.events.splice(0, state.events.length - 4200);
    state.startedAt = state.startedAt || Date.now();
    updateCounts();
    updateTape();
    if (!state.pinned) {
      state.pendingNew += incoming.length;
      els.newEventsBtn.hidden = false;
      els.newEventsBtn.textContent = `${state.pendingNew} 条新事件`;
    } else {
      scheduleTimelineRender();
    }
    if (state.activeTab === 'live') renderLive();
    return;
  }
  if (message.type === 'analysis:patch') {
    for (const analysis of message.css || []) state.css.set(analysis.id || analysis.sourceUrl, analysis);
    for (const analysis of message.js || []) state.js.set(analysis.id || analysis.sourceUrl, analysis);
    updateCounts();
    renderStyles();
    renderScripts();
    return;
  }
  if (message.type === 'snapshot') {
    state.snapshot = message.snapshot || null;
    state.lastSnapshotAt = Date.now();
    renderLive();
    updateCounts();
    return;
  }
  if (message.type === 'state') {
    state.active = message.active !== false;
    if (message.settings) state.settings = message.settings;
    updateRecordingUI();
    updateTape();
    return;
  }
  if (message.type === 'settings') {
    state.settings = { ...state.settings, ...(message.settings || {}) };
    return;
  }
  if (message.type === 'page') {
    state.page = message.page || state.page;
    state.restricted = isRestricted(state.page.url);
    updatePage();
    return;
  }
  if (message.type === 'session:reset') {
    ingestSession(message.session);
    showToast('已清空本次捕获');
    return;
  }
  if (message.type === 'toast') {
    showToast(message.message || '完成');
  }
}

function updateCounts() {
  const totalEvents = state.events.length;
  const cssTotal = [...state.css.values()].reduce((sum, analysis) => sum + (analysis.items?.length || 0), 0);
  els.eventCount.textContent = totalEvents.toLocaleString('zh-CN');
  els.timelineCount.textContent = totalEvents > 999 ? '999+' : String(totalEvents);
  els.cssCount.textContent = cssTotal > 999 ? '999+' : String(cssTotal);
  els.jsCount.textContent = String(state.js.size);
  els.liveCount.textContent = String(state.snapshot?.animations?.length || 0);
  els.liveTotal.textContent = String(state.snapshot?.animations?.length || 0);
}

function updateTape() {
  const now = Date.now();
  const windowMs = 60000;
  const recent = state.events.filter((event) => Number.isFinite(event.ts) && now - event.ts <= windowMs).slice(-160);
  const ticks = recent.map((event) => {
    const left = Math.max(0, Math.min(99.5, 100 - ((now - event.ts) / windowMs) * 100));
    const group = groupOf(event.kind);
    const className = group === 'loop' ? 'js' : group;
    const height = 5 + ((event.seq || 0) % 5) * 3;
    const fresh = state.newSeqs.has(event.seq) ? ' is-new' : '';
    return `<i class="tape-tick k-${className}${fresh}" style="left:${left.toFixed(2)}%;height:${height}px"></i>`;
  }).join('');
  els.tapeTicks.innerHTML = ticks;
}

function tickClock() {
  const elapsed = state.active ? Date.now() - state.startedAt : (state.events.at(-1)?.t || 0);
  els.sessionClock.textContent = formatClock(Math.max(0, elapsed));
  updateTape();
  if (state.snapshot?.at) els.liveUpdated.textContent = `上次采样 · ${timeAgo(state.snapshot.at)}`;
}

function eventMatches(event) {
  const group = groupOf(event.kind);
  if (state.timelineFilter !== 'all' && group !== state.timelineFilter) return false;
  const query = state.timelineQuery.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    kindLabel(event.kind), event.summary, event.target?.selector, event.target?.text,
    event.payload?.propertyName, event.payload?.animationName, event.payload?.property,
    event.payload?.name, event.stack, event.url,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function eventMeta(event) {
  const pieces = [];
  const property = event.payload?.propertyName || event.payload?.property || event.payload?.animationName || event.payload?.name || '';
  if (property) pieces.push(`<code>${safe(property)}</code>`);
  const duration = event.payload?.elapsedTime;
  if (Number.isFinite(duration)) pieces.push(`<code>@${duration.toFixed(2)}s</code>`);
  if (event.stack) pieces.push('<span class="badge stack">JS</span>');
  if (event.matchedRules?.length) pieces.push(`<span class="badge css">CSS ${event.matchedRules.length}</span>`);
  if (event.frame && !event.frame.top) pieces.push('<span class="badge">iframe</span>');
  if (event.payload?.method) pieces.push(`<span class="badge">${safe(event.payload.method)}</span>`);
  if (event.payload?.repeat > 1) pieces.push(`<span class="badge">x${event.payload.repeat}</span>`);
  return pieces.join('');
}

function eventRow(event) {
  const target = event.target?.selector || event.target?.tag || event.payload?.selector || 'document';
  return `<button class="event ${state.newSeqs.has(event.seq) ? 'is-new' : ''}" data-seq="${event.seq}">
    <span class="event-rail"><i class="event-dot k-${safe(event.kind)}"></i>${formatClock(event.t)}</span>
    <span class="event-main">
      <span class="event-line"><span class="event-kind">${safe(kindLabel(event.kind))}</span><span class="event-target">${safe(target)}</span></span>
      <span class="event-summary">${safe(event.summary || target)}</span>
      <span class="event-meta">${eventMeta(event)}</span>
    </span>
    <span class="event-chevron">›</span>
  </button>`;
}

function scheduleTimelineRender() {
  if (state.timelineRaf) return;
  state.timelineRaf = requestAnimationFrame(() => {
    state.timelineRaf = 0;
    renderTimeline();
  });
}

function renderTimeline(force = false) {
  if (!force && !state.pinned) return;
  const filtered = state.events.filter(eventMatches);
  const shown = filtered.slice(-260).reverse();
  els.timelineList.innerHTML = shown.map(eventRow).join('');
  const isEmpty = shown.length === 0;
  els.timelineEmpty.hidden = !isEmpty;
  els.timelineList.hidden = isEmpty;
  if (isEmpty && !state.restricted) {
    els.timelineEmpty.querySelector('h2').textContent = state.events.length ? '没有匹配的事件' : '等待动效发生';
    els.timelineEmpty.querySelector('p').textContent = state.events.length
      ? '换一个筛选条件或搜索词。原始事件仍然保留在捕获会话中。'
      : '在页面上悬停、点击、滚动或切换路由。加载动画需要刷新页面后重新捕获。';
  }
  if (force) {
    state.pinned = true;
    els.newEventsBtn.hidden = true;
    state.pendingNew = 0;
  }
  if (shown.length) state.renderedSeq = shown[0].seq || state.renderedSeq;
}

function cssItems() {
  return [...state.css.values()].flatMap((analysis) => (analysis.items || []).map((item) => ({ ...item, analysis })));
}

function cssMatches(item) {
  if (state.cssFilter !== 'all' && item.kind !== state.cssFilter && !(item.kinds || []).includes(state.cssFilter)) return false;
  const query = state.cssQuery.trim().toLowerCase();
  if (!query) return true;
  return `${item.name || ''} ${item.selector || ''} ${item.text || ''} ${item.sourceUrl || ''}`.toLowerCase().includes(query);
}

function scriptMatches(analysis) {
  if (state.jsFilter !== 'all') {
    if (state.jsFilter === 'library' && !(analysis.libraries?.length || analysis.tags?.includes('library'))) return false;
    if (state.jsFilter !== 'library' && !analysis.tags?.includes(state.jsFilter)) return false;
  }
  const query = state.jsQuery.trim().toLowerCase();
  if (!query) return true;
  return `${analysis.sourceUrl || ''} ${analysis.labels?.join(' ') || ''} ${analysis.libraries?.join(' ') || ''} ${(analysis.snippets || []).map((item) => item.code).join(' ')}`.toLowerCase().includes(query);
}

function renderStyles() {
  const all = cssItems();
  const filtered = all.filter(cssMatches);
  const sources = new Map();
  for (const item of filtered) {
    const key = item.sourceUrl || 'inline';
    if (!sources.has(key)) sources.set(key, []);
    sources.get(key).push(item);
  }
  const groups = [...sources.entries()].sort((a, b) => b[1].length - a[1].length);
  const keyframes = all.filter((item) => item.kind === 'keyframes').length;
  els.cssSummary.hidden = all.length === 0;
  els.cssSummary.innerHTML = `<div class="summary-stat"><strong>${keyframes}</strong><span>@keyframes</span></div><div class="summary-stat"><strong>${all.length}</strong><span>动效规则</span></div><div class="summary-stat"><strong>${state.css.size}</strong><span>样式来源</span></div>`;
  els.cssEmpty.hidden = groups.length > 0;
  els.cssList.hidden = groups.length === 0;
  if (!groups.length) {
    if (all.length) {
      els.cssEmpty.querySelector('h2').textContent = '没有匹配的样式';
      els.cssEmpty.querySelector('p').textContent = '换一个类型或搜索词。已提取的 CSS 仍然保留。';
    }
    return;
  }
  els.cssList.innerHTML = groups.map(([sourceUrl, items], index) => {
    if (!state.seenSources.has(sourceUrl)) {
      state.seenSources.add(sourceUrl);
      if (index > 2) state.collapsedSources.add(sourceUrl);
    }
    const collapsed = state.collapsedSources.has(sourceUrl);
    return `<section class="source-group ${collapsed ? 'collapsed' : ''}" data-source="${attr(sourceUrl)}">
      <button class="source-head" data-toggle-source="${attr(sourceUrl)}">
        <span class="source-icon">CSS</span>
        <span class="source-title"><strong>${safe(displaySource(sourceUrl))}</strong><small>${items.length} 条动效规则</small></span>
        <span class="source-count">${items.length}</span>
      </button>
      <div class="source-body">${items.map(cssItemHtml).join('')}</div>
    </section>`;
  }).join('');
}

function cssItemHtml(item) {
  const copyKey = rememberCopy(item.text || '');
  const kind = item.kind || 'motion';
  return `<details class="css-item">
    <summary>
      <span class="kind-pill ${safe(kind)}">${safe(kind === 'keyframes' ? '@KF' : kind)}</span>
      <span class="css-name"><strong>${safe(item.name || item.selector || '未命名规则')}</strong><small>${safe(item.selector || '')}</small></span>
      ${item.line ? `<span class="line-badge">L${item.line}</span>` : ''}
    </summary>
    <div class="code-wrap">
      <pre class="code-block css">${safe(item.text || '')}</pre>
      <div class="code-actions">
        <button class="mini-btn" data-copy-key="${copyKey}">复制规则</button>
        ${item.sourceUrl && item.analysis?.sourceKind !== 'inline' && /^https?:/i.test(item.sourceUrl) ? `<button class="mini-btn" data-open-url="${attr(item.sourceUrl)}">打开源码</button>` : ''}
      </div>
    </div>
  </details>`;
}

function renderScripts() {
  const all = [...state.js.values()];
  const filtered = all.filter(scriptMatches).sort((a, b) => (b.score || 0) - (a.score || 0));
  const libraries = new Set(all.flatMap((analysis) => analysis.libraries || []));
  const best = all.reduce((max, item) => Math.max(max, item.score || 0), 0);
  els.jsSummary.hidden = all.length === 0;
  els.jsSummary.innerHTML = `<div class="summary-stat"><strong>${all.length}</strong><span>动效脚本</span></div><div class="summary-stat"><strong>${libraries.size}</strong><span>识别库</span></div><div class="summary-stat"><strong>${best ? best.toFixed(1) : '—'}</strong><span>最高评分</span></div>`;
  els.jsEmpty.hidden = filtered.length > 0;
  els.jsList.hidden = filtered.length === 0;
  if (!filtered.length) {
    if (all.length) {
      els.jsEmpty.querySelector('h2').textContent = '没有匹配的脚本';
      els.jsEmpty.querySelector('p').textContent = '换一个筛选条件或搜索词。已分析的脚本仍然保留。';
    }
    return;
  }
  els.jsList.innerHTML = filtered.map(scriptGroupHtml).join('');
}

function scriptGroupHtml(analysis) {
  const source = analysis.sourceUrl || 'inline-script';
  const score = Math.max(0, Math.min(10, analysis.score || 0));
  const labels = [...(analysis.libraries || []), ...(analysis.labels || [])].slice(0, 8);
  const sourceCopy = rememberCopy(source);
  const snippetHtml = (analysis.snippets || []).map((snippet) => {
    const key = rememberCopy(snippet.code || '');
    return `<div class="snippet">
      <div class="snippet-head"><strong>${safe(snippet.label || '命中')}</strong><span>第 ${snippet.line || '?'} 行</span></div>
      <pre class="code-block js">${safe(snippet.code || '')}</pre>
      <div class="code-actions"><button class="mini-btn" data-copy-key="${key}">复制片段</button></div>
    </div>`;
  }).join('');
  const fullSource = analysis.source ? `<button class="mini-btn" data-copy-key="${rememberCopy(analysis.source)}">复制完整源码</button>` : '';
  return `<section class="source-group">
    <button class="source-head" data-toggle-source="js:${attr(analysis.id || source)}">
      <span class="source-icon js">&lt;/&gt;</span>
      <span class="source-title"><strong>${safe(displaySource(source))}</strong><small>${analysis.sourceKind === 'inline' ? '内联脚本' : '外部脚本'} · ${fmtBytes(analysis.bytes || 0)} · ${analysis.lines || 0} 行</small></span>
      <span class="script-score"><span class="score-track"><i class="score-fill" style="width:${score * 10}%"></i></span><span class="score-num">${score.toFixed(1)}</span></span>
    </button>
    <div class="source-body">
      ${analysis.error ? `<div class="notice">无法读取此脚本：${safe(analysis.error)}</div>` : ''}
      <div class="tag-row">${labels.map((label, index) => `<span class="tag ${index < (analysis.libraries?.length || 0) ? 'hot' : ''}">${safe(label)}</span>`).join('')}</div>
      ${snippetHtml || (analysis.error ? '' : '<div class="notice">没有可展示的代码片段。</div>')}
      <div class="code-actions" style="padding:0 10px 10px">
        <button class="mini-btn" data-copy-key="${sourceCopy}">复制地址</button>
        ${fullSource}
        ${analysis.sourceKind !== 'inline' && /^https?:/i.test(source) ? `<button class="mini-btn" data-open-url="${attr(source)}">打开脚本</button>` : ''}
      </div>
    </div>
  </section>`;
}

function renderLive() {
  const animations = state.snapshot?.animations || [];
  els.liveTotal.textContent = String(animations.length);
  els.liveCount.textContent = String(animations.length);
  els.liveUpdated.textContent = state.snapshot?.at ? `上次采样 · ${timeAgo(state.snapshot.at)}` : '等待快照';
  els.liveEmpty.hidden = animations.length > 0;
  els.liveList.hidden = animations.length === 0;
  els.liveList.innerHTML = animations.map((animation) => {
    const name = animation.animationName || animation.transitionProperty || animation.kind || 'Animation';
    const target = animation.target?.selector || animation.target?.tag || 'document';
    const duration = Number(animation.timing?.duration);
    const current = Number(animation.currentTime);
    const progress = Number.isFinite(duration) && duration > 0 && Number.isFinite(current) ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
    const kindClass = String(animation.kind || '').toLowerCase().includes('css') ? 'css' : 'waapi';
    const frames = Array.isArray(animation.keyframes) ? animation.keyframes : [];
    const keyframeText = frames.slice(0, 5).map((frame) => {
      const keys = Object.keys(frame || {}).filter((key) => key !== 'offset' && key !== 'computedOffset' && key !== 'easing' && key !== 'composite').slice(0, 4);
      return `${frame.offset ?? '?'}  ${keys.join(' · ') || '—'}`;
    }).join('\n');
    return `<article class="anim-card">
      <div class="anim-top"><span class="anim-kind ${kindClass}">${safe(animation.kind || 'Animation')}</span><span class="anim-name">${safe(name)}</span><span class="anim-state">${safe(animation.playState || '')}</span></div>
      <div class="anim-target">${safe(target)}${animation.pseudoElement ? ` · ${safe(animation.pseudoElement)}` : ''}</div>
      <div class="anim-progress"><i style="width:${progress.toFixed(1)}%"></i></div>
      <div class="anim-meta">
        <span>当前时间<b>${Number.isFinite(current) ? `${Math.round(current)}ms` : '—'}</b></span>
        <span>时长<b>${Number.isFinite(duration) ? `${Math.round(duration)}ms` : safe(String(animation.timing?.duration || '—'))}</b></span>
        <span>迭代<b>${safe(String(animation.timing?.iterations ?? '—'))}</b></span>
      </div>
      ${keyframeText ? `<pre class="anim-kf">${safe(keyframeText)}</pre>` : ''}
    </article>`;
  }).join('');
}

function detailSection(title, content) {
  return `<section class="detail-section"><h3>${safe(title)}</h3>${content}</section>`;
}

function detailGrid(rows) {
  return `<div class="detail-grid">${rows.map(([label, value]) => `<div class="detail-cell"><span>${safe(label)}</span><strong title="${attr(value)}">${safe(value)}</strong></div>`).join('')}</div>`;
}

function openDetail(event) {
  if (!event) return;
  state.detailEvent = event;
  const target = event.target?.selector || event.target?.tag || 'document';
  els.detailKind.textContent = kindLabel(event.kind);
  els.detailTitle.textContent = event.summary || target;
  const copyAllKey = rememberCopy(pretty(event));
  const computed = event.target?.computed || {};
  const computedRows = Object.entries(computed).map(([key, value]) => [key, String(value)]);
  const ruleHtml = (event.matchedRules || []).map((rule) => `<details class="css-item"><summary><span class="kind-pill">CSS</span><span class="css-name"><strong>${safe(rule.selector)}</strong><small>${safe(shortUrl(rule.source, 48))}</small></span></summary><div class="code-wrap"><pre class="code-block css">${safe(rule.text)}</pre><div class="code-actions"><button class="mini-btn" data-copy-key="${rememberCopy(rule.text)}">复制规则</button></div></div></details>`).join('');
  const stack = event.stack || '';
  const payload = event.payload && Object.keys(event.payload).length ? pretty(event.payload) : '';
  const keyframes = event.keyframes?.length ? pretty(event.keyframes) : (event.payload?.keyframes?.length ? pretty(event.payload.keyframes) : '');
  const sections = [];
  sections.push(detailSection('事件概览', `${detailGrid([
    ['时间', formatClock(event.t)],
    ['类型', kindLabel(event.kind)],
    ['目标', target],
    ['页面', event.url || state.page.url || '—'],
  ])}<div class="code-actions"><button class="mini-btn accent" data-copy-key="${copyAllKey}">复制事件 JSON</button></div>`));
  if (event.target) {
    const targetBits = [];
    if (event.target.tag) targetBits.push(['元素', `<${event.target.tag}>`]);
    if (event.target.id) targetBits.push(['id', event.target.id]);
    if (event.target.classes?.length) targetBits.push(['class', event.target.classes.join(' ')]);
    if (event.target.rect) targetBits.push(['位置', `${event.target.rect.x}, ${event.target.rect.y} · ${event.target.rect.w}×${event.target.rect.h}`]);
    if (event.target.text) targetBits.push(['文本', event.target.text]);
    sections.push(detailSection('目标元素', detailGrid(targetBits.map(([key, value]) => [key, String(value)]))));
  }
  if (computedRows.length) {
    sections.push(detailSection('计算样式快照', detailGrid(computedRows)));
  }
  if (payload) {
    const key = rememberCopy(payload);
    sections.push(detailSection('事件载荷', `<pre class="code-block">${safe(payload)}</pre><div class="code-actions"><button class="mini-btn" data-copy-key="${key}">复制载荷</button></div>`));
  }
  if (keyframes) {
    const key = rememberCopy(keyframes);
    sections.push(detailSection('关键帧', `<pre class="code-block">${safe(keyframes)}</pre><div class="code-actions"><button class="mini-btn" data-copy-key="${key}">复制关键帧</button></div>`));
  }
  if (ruleHtml) sections.push(detailSection(`匹配的 CSS 规则 · ${event.matchedRules.length}`, ruleHtml));
  if (stack) {
    const key = rememberCopy(stack);
    sections.push(detailSection('调用栈', `<pre class="code-block stack">${safe(stack)}</pre><div class="code-actions"><button class="mini-btn" data-copy-key="${key}">复制调用栈</button></div>`));
  } else {
    sections.push(detailSection('调用栈', '<div class="detail-empty">浏览器原生事件没有可用的 JS 调用栈。可以对照时间线中相邻的样式或类名变化。</div>'));
  }
  els.detailBody.innerHTML = sections.join('');
  document.body.classList.add('drawer-open');
  els.detailDrawer.setAttribute('aria-hidden', 'false');
}

function closeDetail() {
  document.body.classList.remove('drawer-open');
  els.detailDrawer.setAttribute('aria-hidden', 'true');
}

function switchTab(tab) {
  state.activeTab = tab;
  $$('#tabs button').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${tab}`));
  if (tab === 'timeline') renderTimeline(true);
  if (tab === 'styles') renderStyles();
  if (tab === 'scripts') renderScripts();
  if (tab === 'live') renderLive();
}

function setActiveFilter(container, filter) {
  $$('button', container).forEach((button) => button.classList.toggle('active', button.dataset.filter === filter));
}

function exportSession(kind) {
  const session = {
    page: state.page,
    startedAt: state.startedAt,
    events: state.events,
    analyses: { css: [...state.css.values()], js: [...state.js.values()] },
    snapshot: state.snapshot,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (kind === 'json') {
    downloadText(`webcatcher-${fileHost()}-${stamp}.json`, buildJson(session), 'application/json');
    showToast('已导出 JSON');
  } else {
    downloadText(`webcatcher-${fileHost()}-${stamp}.md`, buildMarkdown(session), 'text/markdown');
    showToast('已导出 Markdown 报告');
  }
  els.exportMenu.hidden = true;
}

els.recordBtn.addEventListener('click', () => {
  send({ type: 'action', action: 'toggle', tabId: state.tabId });
});

els.rescanBtn.addEventListener('click', () => {
  send({ type: 'action', action: 'rescan', tabId: state.tabId });
  showToast('正在重新扫描页面');
});

els.clearBtn.addEventListener('click', () => {
  els.clearDialog.showModal();
});

els.confirmClearBtn.addEventListener('click', () => {
  send({ type: 'action', action: 'clear', tabId: state.tabId });
});

els.exportBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  els.exportMenu.hidden = !els.exportMenu.hidden;
});

els.exportMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-export]');
  if (!button) return;
  exportSession(button.dataset.export);
});

document.addEventListener('click', (event) => {
  if (!els.exportMenu.hidden && !event.target.closest('#exportMenu') && !event.target.closest('#exportBtn')) els.exportMenu.hidden = true;
});

els.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) switchTab(button.dataset.tab);
});

els.timelineFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.timelineFilter = button.dataset.filter;
  setActiveFilter(els.timelineFilters, state.timelineFilter);
  renderTimeline(true);
});

els.timelineSearch.addEventListener('input', () => {
  state.timelineQuery = els.timelineSearch.value;
  renderTimeline(true);
});

els.timelineList.addEventListener('click', (event) => {
  const row = event.target.closest('.event');
  if (!row) return;
  const seq = Number(row.dataset.seq);
  const found = state.events.find((item) => item.seq === seq);
  if (found) openDetail(found);
});

els.timelineList.addEventListener('scroll', () => {
  state.pinned = els.timelineList.scrollTop < 24;
  if (state.pinned && state.pendingNew) {
    state.pendingNew = 0;
    els.newEventsBtn.hidden = true;
    renderTimeline();
  }
});

els.newEventsBtn.addEventListener('click', () => {
  els.timelineList.scrollTop = 0;
  state.pinned = true;
  state.pendingNew = 0;
  els.newEventsBtn.hidden = true;
  renderTimeline(true);
});

// The timeline itself scrolls inside .view, so mirror its scroll state.
$('#view-timeline').addEventListener('scroll', (event) => {
  state.pinned = event.currentTarget.scrollTop < 30;
  if (state.pinned && state.pendingNew) {
    state.pendingNew = 0;
    els.newEventsBtn.hidden = true;
    renderTimeline();
  }
});

els.cssFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.cssFilter = button.dataset.filter;
  setActiveFilter(els.cssFilters, state.cssFilter);
  renderStyles();
});

els.cssSearch.addEventListener('input', () => {
  state.cssQuery = els.cssSearch.value;
  renderStyles();
});

els.jsFilters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  state.jsFilter = button.dataset.filter;
  setActiveFilter(els.jsFilters, state.jsFilter);
  renderScripts();
});

els.jsSearch.addEventListener('input', () => {
  state.jsQuery = els.jsSearch.value;
  renderScripts();
});

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle-source]');
  if (toggle) {
    const group = toggle.closest('.source-group');
    const key = toggle.dataset.toggleSource;
    group.classList.toggle('collapsed');
    if (group.classList.contains('collapsed')) state.collapsedSources.add(key);
    else state.collapsedSources.delete(key);
    return;
  }
  const copyButton = event.target.closest('[data-copy-key]');
  if (copyButton) {
    copyText(state.copyStore.get(copyButton.dataset.copyKey) || '');
    return;
  }
  const openButton = event.target.closest('[data-open-url]');
  if (openButton) {
    const url = openButton.dataset.openUrl;
    if (/^https?:/i.test(url)) chrome.tabs.create({ url });
  }
});

els.detailClose.addEventListener('click', closeDetail);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDetail();
});

els.settingsBtn.addEventListener('click', () => {
  els.settingRaf.checked = state.settings.recordRaf !== false;
  els.settingStyles.checked = state.settings.captureStyles !== false;
  els.settingsDialog.showModal();
});

els.saveSettingsBtn.addEventListener('click', () => {
  const settings = { recordRaf: els.settingRaf.checked, captureStyles: els.settingStyles.checked };
  state.settings = { ...state.settings, ...settings };
  send({ type: 'action', action: 'settings', tabId: state.tabId, settings });
  showToast('捕获设置已更新');
});

els.helpBtn.addEventListener('click', () => els.helpDialog.showModal());
els.refreshLiveBtn.addEventListener('click', () => {
  send({ type: 'action', action: 'rescan', tabId: state.tabId });
  showToast('正在重新采样动画');
});

chrome.tabs.onActivated.addListener(() => { watchActiveTab().catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== state.tabId) return;
  if (changeInfo.url || changeInfo.title) {
    state.page = { url: tab.url || state.page.url, title: tab.title || state.page.title };
    state.restricted = isRestricted(state.page.url);
    updatePage();
    if (state.restricted) setConnection('error', '此页面不可捕获');
  }
});

setInterval(tickClock, 500);
setInterval(() => {
  if (state.snapshot?.at) els.liveUpdated.textContent = `上次采样 · ${timeAgo(state.snapshot.at)}`;
}, 5000);

watchActiveTab().catch(() => setConnection('error', '无法读取标签页'));
tickClock();
updateRecordingUI();
