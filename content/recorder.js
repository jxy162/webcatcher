(() => {
  'use strict';
  if (window.__WEBCATCHER_MAIN__) return;
  try {
    Object.defineProperty(window, '__WEBCATCHER_MAIN__', {
      value: { version: '0.1.0' },
      enumerable: false,
      configurable: false,
    });
  } catch { return; }

  const MAIN_SOURCE = 'webcatcher-main';
  const BRIDGE_SOURCE = 'webcatcher-bridge';
  const MOTION_RE = /(?:transition|animation|transform|translate|scale|rotate|offset-path|view-transition|will-change|scroll-timeline|view-timeline|perspective|filter|clip-path|cubic-bezier)/i;
  const MOTION_INLINE_PROPS = new Set([
    'transform', 'transformOrigin', 'translate', 'scale', 'rotate', 'opacity', 'filter', 'backdropFilter',
    'clipPath', 'offsetPath', 'offsetDistance', 'perspective', 'perspectiveOrigin', 'width', 'height',
    'top', 'left', 'right', 'bottom', 'margin', 'marginTop', 'marginLeft', 'padding', 'borderRadius',
    'boxShadow', 'backgroundPosition', 'backgroundColor', 'color', 'zIndex', 'willChange', 'transition',
    'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay', 'animation',
    'animationName', 'animationDuration', 'animationTimingFunction', 'animationDelay', 'viewTransitionName',
    'animationTimeline', 'scrollBehavior',
  ]);
  const WATCHED_ATTRS = ['style', 'class', 'data-state', 'data-status', 'data-open', 'data-active', 'data-animate', 'data-scroll', 'aria-expanded'];
  const state = {
    active: true,
    settings: { recordRaf: true, captureStyles: true },
    startedAt: Date.now(),
    queue: [],
    flushTimer: 0,
    inventoryTimer: 0,
    snapshotTimer: 0,
    seq: 0,
  };
  const hooks = {};
  const inlineOwners = new WeakMap();
  const inlineStamp = new WeakMap();
  const styleRates = new WeakMap();
  const classStamp = new WeakMap();
  const motionRuleCache = new WeakMap();
  const shadowRoots = new WeakSet();
  const observedRoots = new WeakSet();
  const animationRoots = new WeakSet();
  const styleTextStamp = new WeakMap();
  const rafCallbackStacks = new WeakMap();
  const rafStats = new Map();
  const patchedGlobals = new WeakSet();
  let mutationObserver = null;

  const now = () => Date.now();
  const clampText = (value, max = 900) => {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const cssEscape = (value) => {
    try { return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`); }
    catch { return String(value); }
  };
  const post = (message) => {
    try { window.postMessage({ source: MAIN_SOURCE, ...message }, '*'); } catch { /* ignore */ }
  };

  function flush(force = false) {
    if (!state.queue.length) return;
    const batch = state.queue.splice(0, 140);
    post({ type: 'events', events: batch });
    if (state.queue.length && force) flush(true);
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = 0;
      flush();
    }, 140);
  }

  function emit(kind, data = {}) {
    if (!state.active) return;
    state.seq += 1;
    const event = {
      id: `live-${state.seq}`,
      kind,
      t: Math.max(0, now() - state.startedAt),
      ts: now(),
      url: location.href,
      frame: { top: window === window.top, url: location.href, name: window.name || '' },
      ...data,
    };
    state.queue.push(event);
    if (state.queue.length >= 120) flush();
    else scheduleFlush();
  }

  function getStack() {
    try {
      const raw = new Error().stack || '';
      return raw.split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line && !/webcatcher|content\/recorder|chrome-extension:|extensions::/.test(line))
        .slice(0, 9)
        .join('\n');
    } catch { return ''; }
  }

  function selectorFor(element) {
    if (!element || element.nodeType !== 1) return '';
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.localName || node.nodeName.toLowerCase();
      const classes = [...(node.classList || [])].filter(Boolean).slice(0, 3);
      if (classes.length) part += `.${classes.map(cssEscape).join('.')}`;
      if (node.parentElement) {
        const siblings = [...node.parentElement.children].filter((child) => child.localName === node.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.parentElement && node.parentElement.id) {
        parts.unshift(`#${cssEscape(node.parentElement.id)}`);
        break;
      }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function pickComputed(element) {
    if (!(element instanceof Element) || !state.settings.captureStyles) return {};
    try {
      const style = getComputedStyle(element);
      const keys = [
        'display', 'position', 'transform', 'opacity', 'filter', 'clipPath', 'translate', 'scale', 'rotate',
        'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay',
        'animationName', 'animationDuration', 'animationTimingFunction', 'animationIterationCount',
        'willChange', 'viewTransitionName', 'animationTimeline', 'offsetPath', 'perspective',
      ];
      const result = {};
      for (const key of keys) {
        const value = style[key];
        if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0s') result[key] = value;
      }
      return result;
    } catch { return {}; }
  }

  function describeElement(element, includeHtml = false) {
    if (!element) return null;
    if (element.nodeType === 3) return { tag: '#text', text: clampText(element.data, 90) };
    if (element.nodeType !== 1) return { tag: element.nodeName || 'node' };
    const rect = element.getBoundingClientRect?.();
    const description = {
      tag: element.localName || element.nodeName.toLowerCase(),
      id: element.id || '',
      classes: [...(element.classList || [])].slice(0, 8),
      selector: selectorFor(element),
      text: clampText((element.innerText || element.textContent || '').trim(), 90),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      computed: pickComputed(element),
    };
    if (includeHtml) description.html = clampText(element.outerHTML, 600);
    return description;
  }

  function sanitize(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return clampText(value, 1600);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return String(value);
    if (typeof value !== 'object') return String(value);
    if (depth > 4) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Element) return { __element: selectorFor(value) };
    if (value instanceof Node) return `[${value.nodeName}]`;
    try {
      if (typeof CSSStyleDeclaration !== 'undefined' && value instanceof CSSStyleDeclaration) return clampText(value.cssText, 800);
    } catch { /* ignore */ }
    if (Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection) {
      return [...value].slice(0, 40).map((item) => sanitize(item, depth + 1, seen));
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) return Object.fromEntries([...value.entries()].slice(0, 25).map(([key, item]) => [String(key), sanitize(item, depth + 1, seen)]));
    if (value instanceof Set) return [...value].slice(0, 25).map((item) => sanitize(item, depth + 1, seen));
    const output = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      if (key === 'ownerDocument' || key === 'parentElement' || key === 'parentNode') continue;
      try { output[key] = sanitize(value[key], depth + 1, seen); } catch { output[key] = '[Unserializable]'; }
    }
    return output;
  }

  function describeTarget(target) {
    if (!target) return null;
    if (target instanceof Element) return describeElement(target);
    if (typeof target === 'string') return { selector: target };
    if (Array.isArray(target) || target instanceof NodeList || target instanceof HTMLCollection) {
      return { multiple: true, items: [...target].slice(0, 8).map((item) => item instanceof Element ? describeElement(item) : sanitize(item)) };
    }
    return sanitize(target);
  }

  const MOTION_RULE_RE = /(?:transition|animation|transform|translate|scale|rotate|offset-|view-transition|will-change|scroll-timeline|view-timeline|perspective|filter|clip-path)/i;

  function motionRulesFor(element) {
    if (!state.settings.captureStyles || !(element instanceof Element)) return [];
    const cached = motionRuleCache.get(element);
    if (cached && now() - cached.at < 1000) return cached.rules;
    const rules = [];
    const visit = (ruleList, href) => {
      for (const rule of ruleList) {
        if (rules.length >= 10) return;
        try {
          if (rule.selectorText && MOTION_RULE_RE.test(rule.cssText)) {
            let matches = false;
            try { matches = element.matches(rule.selectorText); } catch { matches = false; }
            if (matches) {
              rules.push({ selector: rule.selectorText, text: clampText(rule.cssText, 1300), source: href || 'inline' });
            }
          }
          if (rule.cssRules) visit(rule.cssRules, href);
        } catch { /* ignore */ }
      }
    };
    try {
      for (const sheet of document.styleSheets) {
        let list;
        try { list = sheet.cssRules; } catch { continue; }
        if (list) visit(list, sheet.href);
        if (rules.length >= 10) break;
      }
    } catch { /* ignore */ }
    motionRuleCache.set(element, { at: now(), rules });
    return rules;
  }

﻿  function emitStyleMutation(element, method, property, value, previous, stack) {
    if (!state.settings.captureStyles) return;
    inlineStamp.set(element, now());
    let rates = styleRates.get(element);
    if (!rates) { rates = new Map(); styleRates.set(element, rates); }
    const rate = rates.get(property) || { last: 0, count: 0 };
    const stamp = now();
    rate.count += 1;
    rates.set(property, rate);
    if (stamp - rate.last < 1000) return;
    const repeat = rate.count;
    rate.last = stamp;
    rate.count = 0;
    emit('style', {
      summary: `${property} → ${clampText(value, 54)}${repeat > 1 ? ` · 合并 ${repeat} 次` : ''}`,
      target: describeElement(element),
      payload: { method, property, value: clampText(value, 1200), previous: clampText(previous, 300), repeat },
      matchedRules: motionRulesFor(element),
      stack,
    });
  }

  function installAnimateHook() {
    const proto = window.Element?.prototype;
    if (!proto?.animate) return;
    const original = proto.animate;
    const wrapped = function animate(keyframes, options) {
      const stack = getStack();
      const result = original.apply(this, arguments);
      try {
        const effect = result?.effect;
        const frames = effect?.getKeyframes?.().slice(0, 36);
        const timing = effect?.getTiming?.();
        emit('waapi', {
          summary: `Element.animate() · ${Array.isArray(frames) ? frames.length : 0} 个关键帧`,
          target: describeElement(this),
          keyframes: frames?.length ? sanitize(frames) : sanitize(keyframes),
          options: sanitize(typeof options === 'number' ? { duration: options } : options),
          timing: sanitize(timing),
          matchedRules: motionRulesFor(this),
          stack,
        });
      } catch { /* never break page animation */ }
      return result;
    };
    try { wrapped.toString = () => original.toString(); } catch { /* ignore */ }
    try { Object.defineProperty(proto, 'animate', { value: wrapped, configurable: true, writable: true }); hooks.animate = true; } catch { /* ignore */ }
  }

  function installAnimationControls() {
    const proto = window.Animation?.prototype;
    if (!proto) return;
    for (const method of ['play', 'pause', 'cancel', 'finish', 'reverse', 'updatePlaybackRate']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      try {
        Object.defineProperty(proto, method, {
          configurable: true,
          writable: true,
          value: function animationControl(...args) {
            const target = this?.effect?.target;
            const result = original.apply(this, args);
            if (state.active && target) {
              emit('waapi-control', {
                summary: `Animation.${method}()`,
                target: describeElement(target),
                payload: { method, args: sanitize(args), playState: this.playState, currentTime: this.currentTime, animationName: this.animationName || this.transitionProperty || '' },
                stack: getStack(),
              });
            }
            return result;
          },
        });
      } catch { /* ignore */ }
    }
  }

  function collectViewTransitionNames() {
    if (!state.settings.captureStyles) return [];
    const names = [];
    try {
      for (const element of document.querySelectorAll('*')) {
        const name = getComputedStyle(element).viewTransitionName;
        if (name && name !== 'none' && !names.includes(name)) names.push(name);
        if (names.length >= 40) break;
      }
    } catch { /* ignore */ }
    return names;
  }

  function installViewTransitionHook() {
    const proto = window.Document?.prototype;
    if (!proto?.startViewTransition) return;
    const original = proto.startViewTransition;
    try {
      Object.defineProperty(proto, 'startViewTransition', {
        configurable: true,
        writable: true,
        value: function startViewTransition(callback) {
          const stack = getStack();
          const names = collectViewTransitionNames();
          const result = original.apply(this, arguments);
          emit('view-transition', {
            summary: `View Transition · ${names.length} 个命名元素`,
            target: { selector: 'document' },
            payload: { names, hasCallback: typeof callback === 'function' },
            matchedRules: [],
            stack,
          });
          try {
            result?.ready?.then(() => {
              if (!state.active) return;
              emit('view-transition', { summary: 'View Transition · ready', target: { selector: 'document' }, payload: { names, phase: 'ready' }, stack: '' });
            }).catch(() => {});
          } catch { /* ignore */ }
          return result;
        },
      });
      hooks.viewTransition = true;
    } catch { /* ignore */ }
  }

  function installHistoryHook() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      try {
        history[method] = function historyChange(...args) {
          const from = location.href;
          const result = original.apply(this, args);
          emit('route', {
            summary: `${method} → ${location.pathname}${location.search}${location.hash}`,
            payload: { method, from, to: location.href, state: sanitize(args[0]) },
            stack: getStack(),
          });
          scheduleInventory(500);
          return result;
        };
      } catch { /* ignore */ }
    }
    window.addEventListener('popstate', () => emit('route', { summary: 'popstate', payload: { method: 'popstate', to: location.href }, stack: '' }), true);
    window.addEventListener('hashchange', () => emit('route', { summary: 'hashchange', payload: { method: 'hashchange', to: location.href }, stack: '' }), true);
    try {
      if (window.navigation?.addEventListener) {
        navigation.addEventListener('navigate', (event) => emit('route', {
          summary: 'Navigation API navigate',
          payload: { method: 'navigation.navigate', to: event.destination?.url || '', type: event.navigationType || '' },
          stack: '',
        }));
      }
    } catch { /* ignore */ }
  }

  function installInlineStyleHooks() {
    for (const constructor of [window.HTMLElement, window.SVGElement, window.MathMLElement]) {
      if (!constructor?.prototype) continue;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, 'style');
      if (!descriptor?.get) continue;
      try {
        Object.defineProperty(constructor.prototype, 'style', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            const declaration = descriptor.get.call(this);
            inlineOwners.set(declaration, this);
            return declaration;
          },
          set: descriptor.set,
        });
      } catch { /* ignore */ }
    }

    const declarationProto = window.CSSStyleDeclaration?.prototype;
    if (!declarationProto) return;

    const originalSetProperty = declarationProto.setProperty;
    if (typeof originalSetProperty === 'function') {
      try {
        declarationProto.setProperty = function setProperty(property, value, priority) {
          const previous = this.getPropertyValue(property);
          const result = originalSetProperty.call(this, property, value, priority);
          if (state.active && (MOTION_INLINE_PROPS.has(property) || property.startsWith('--')) && String(previous) !== String(this.getPropertyValue(property))) {
            const owner = inlineOwners.get(this);
            const stack = getStack();
            if (owner) emitStyleMutation(owner, 'setProperty', property, this.getPropertyValue(property), previous, stack);
            else if (this.parentRule?.selectorText) {
              emit('css-change', {
                summary: `${clampText(this.parentRule.selectorText, 44)} · ${property}`,
                payload: { method: 'setProperty', selector: this.parentRule.selectorText, property, value: clampText(this.getPropertyValue(property), 900), previous: clampText(previous, 300) },
                stack,
              });
            }
          }
          return result;
        };
      } catch { /* ignore */ }
    }

    for (const property of MOTION_INLINE_PROPS) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(declarationProto, property); } catch { descriptor = null; }
      if (!descriptor?.set) continue;
      try {
        Object.defineProperty(declarationProto, property, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {
            const previous = descriptor.get ? descriptor.get.call(this) : this.getPropertyValue(property);
            descriptor.set.call(this, value);
            const current = descriptor.get ? descriptor.get.call(this) : this.getPropertyValue(property);
            if (state.active && String(previous) !== String(current)) {
              const owner = inlineOwners.get(this);
              if (owner) emitStyleMutation(owner, 'property', property, current, previous, getStack());
            }
          },
        });
      } catch { /* ignore */ }
    }

    const cssTextDescriptor = Object.getOwnPropertyDescriptor(declarationProto, 'cssText');
    if (cssTextDescriptor?.set) {
      try {
        Object.defineProperty(declarationProto, 'cssText', {
          configurable: true,
          enumerable: cssTextDescriptor.enumerable,
          get: cssTextDescriptor.get,
          set(value) {
            const previous = cssTextDescriptor.get ? cssTextDescriptor.get.call(this) : '';
            cssTextDescriptor.set.call(this, value);
            if (state.active && MOTION_RE.test(String(value)) && state.settings.captureStyles) {
              const owner = inlineOwners.get(this);
              if (owner) emitStyleMutation(owner, 'cssText', 'cssText', value, previous, getStack());
              else if (this.parentRule?.selectorText) {
                emit('css-change', { summary: `${clampText(this.parentRule.selectorText, 44)} · cssText`, payload: { method: 'cssText', selector: this.parentRule.selectorText, value: clampText(value, 900) }, stack: getStack() });
              }
            }
          },
        });
      } catch { /* ignore */ }
    }

    const removeProperty = declarationProto.removeProperty;
    if (typeof removeProperty === 'function') {
      try {
        declarationProto.removeProperty = function removePropertyWrapped(property) {
          const previous = this.getPropertyValue(property);
          const result = removeProperty.call(this, property);
          if (state.active && MOTION_INLINE_PROPS.has(property)) {
            const owner = inlineOwners.get(this);
            if (owner && previous) emitStyleMutation(owner, 'removeProperty', property, '', previous, getStack());
          }
          return result;
        };
      } catch { /* ignore */ }
    }
  }

  function installCssomHooks() {
    const proto = window.CSSStyleSheet?.prototype;
    if (!proto) return;
    for (const method of ['insertRule', 'deleteRule']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      try {
        proto[method] = function cssomMutation(...args) {
          const result = original.apply(this, args);
          if (state.active && state.settings.captureStyles) {
            const payload = method === 'insertRule' ? { rule: clampText(args[0], 1400), index: args[1] } : { index: args[0] };
            if (method === 'deleteRule' || MOTION_RE.test(String(args[0] || ''))) {
              emit('css-change', { summary: `CSSStyleSheet.${method}()`, payload: { method, ...payload }, stack: getStack() });
              scheduleInventory(500);
            }
          }
          return result;
        };
      } catch { /* ignore */ }
    }

    for (const method of ['replaceSync', 'replace']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      try {
        proto[method] = function replaceStylesheets(...args) {
          const text = String(args[0] || '');
          const result = original.apply(this, args);
          if (state.active && MOTION_RE.test(text)) {
            emit('css-change', { summary: `CSSStyleSheet.${method}()`, payload: { method, text: clampText(text, 2600) }, stack: getStack() });
            scheduleInventory(500);
          }
          return result;
        };
      } catch { /* ignore */ }
    }

    for (const constructor of [window.Document, window.ShadowRoot]) {
      const descriptor = constructor?.prototype && Object.getOwnPropertyDescriptor(constructor.prototype, 'adoptedStyleSheets');
      if (!descriptor?.set) continue;
      try {
        Object.defineProperty(constructor.prototype, 'adoptedStyleSheets', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {
            descriptor.set.call(this, value);
            if (state.active) {
              emit('css-change', {
                summary: `adoptedStyleSheets · ${value?.length || 0} 张表`,
                payload: { method: 'adoptedStyleSheets', count: value?.length || 0, sheets: [...(value || [])].slice(0, 8).map((sheet) => [...(sheet.cssRules || [])].slice(0, 20).map((rule) => rule.cssText).join('\n')) },
                stack: getStack(),
              });
              scheduleInventory(500);
            }
          },
        });
      } catch { /* ignore */ }
    }
  }

  function installRafHook() {
    const original = window.requestAnimationFrame;
    if (typeof original !== 'function') return;
    window.requestAnimationFrame = function requestAnimationFrame(callback) {
      if (typeof callback !== 'function') return original.call(this, callback);
      let stack = rafCallbackStacks.get(callback);
      if (stack == null) {
        stack = getStack();
        rafCallbackStacks.set(callback, stack);
      }
      const wrapped = (time) => {
        const start = performance.now();
        try { return callback(time); }
        finally { trackRaf(stack, performance.now() - start); }
      };
      return original.call(this, wrapped);
    };
    hooks.raf = true;
  }

  function trackRaf(stack, duration) {
    if (!state.active || !state.settings.recordRaf) return;
    const key = stack || 'anonymous rAF';
    let entry = rafStats.get(key);
    if (!entry) {
      if (rafStats.size > 60) return;
      entry = { count: 0, total: 0, max: 0, lastEmit: now(), firstAt: now() };
      rafStats.set(key, entry);
    }
    entry.count += 1;
    entry.total += duration;
    entry.max = Math.max(entry.max, duration);
    if (now() - entry.lastEmit >= 1200 && entry.count >= 2) {
      emit('raf', {
        summary: `rAF 循环 · ${entry.count} 帧 / 1.2s`,
        target: { selector: `rAF ${stack.split('\n')[0] || 'anonymous'}` },
        payload: { frames: entry.count, avgMs: Math.round((entry.total / entry.count) * 100) / 100, maxMs: Math.round(entry.max * 100) / 100, windowMs: now() - entry.lastEmit },
        stack,
      });
      entry.count = 0;
      entry.total = 0;
      entry.max = 0;
      entry.lastEmit = now();
    }
  }

  function installObserverHooks() {
    const OriginalIO = window.IntersectionObserver;
    if (typeof OriginalIO === 'function') {
      try {
        window.IntersectionObserver = new Proxy(OriginalIO, {
          construct(target, args, newTarget) {
            if (state.active) emit('observer', { summary: 'IntersectionObserver', payload: { options: sanitize(args[1]) }, stack: getStack() });
            return Reflect.construct(target, args, newTarget);
          },
        });
      } catch { /* ignore */ }
    }
    for (const name of ['ScrollTimeline', 'ViewTimeline']) {
      const Original = window[name];
      if (typeof Original !== 'function') continue;
      try {
        window[name] = new Proxy(Original, {
          construct(target, args, newTarget) {
            if (state.active) emit('scroll', { summary: `${name}`, payload: { options: sanitize(args[0]) }, stack: getStack() });
            return Reflect.construct(target, args, newTarget);
          },
        });
      } catch { /* ignore */ }
    }
  }

  function installScrollHooks() {
    const wrapScroll = (owner, method, label) => {
      const original = owner?.[method];
      if (typeof original !== 'function') return;
      try {
        owner[method] = function smoothScroll(...args) {
          const options = args[0];
          const smooth = options && typeof options === 'object' && options.behavior === 'smooth';
          if (smooth && state.active) {
            emit('scroll', { summary: `${label} · smooth`, payload: { method: label, args: sanitize(args) }, stack: getStack() });
          }
          return original.apply(this, args);
        };
      } catch { /* ignore */ }
    };
    wrapScroll(window, 'scrollTo', 'window.scrollTo');
    wrapScroll(window, 'scrollBy', 'window.scrollBy');
    for (const protoName of ['HTMLElement', 'Element']) {
      const proto = window[protoName]?.prototype;
      wrapScroll(proto, 'scrollTo', `${protoName}.scrollTo`);
      wrapScroll(proto, 'scrollBy', `${protoName}.scrollBy`);
      wrapScroll(proto, 'scrollIntoView', `${protoName}.scrollIntoView`);
    }
  }

  function annotateGlobal(value, label) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || patchedGlobals.has(value)) return;
    patchedGlobals.add(value);
    try { Object.defineProperty(value, '__webcatcherGlobal', { value: label, configurable: true }); } catch { /* ignore */ }
  }

  function patchGsap(gsap) {
    if (!gsap || (typeof gsap !== 'object' && typeof gsap !== 'function') || gsap.__webcatcherPatched) return;
    annotateGlobal(gsap, 'gsap');
    try {
      for (const method of ['to', 'from', 'fromTo', 'set', 'quickTo', 'quickSetter', 'timeline']) {
        const original = gsap[method];
        if (typeof original !== 'function') continue;
        gsap[method] = function gsapMethod(target, ...rest) {
          const result = original.apply(this, [target, ...rest]);
          if (state.active) {
            const vars = method === 'fromTo' ? rest[1] : rest[0];
            const payload = {
              method,
              target: describeTarget(target),
              vars: sanitize(vars),
              duration: vars?.duration,
              ease: vars?.ease,
              stagger: sanitize(vars?.stagger),
              scrollTrigger: sanitize(vars?.scrollTrigger),
            };
            emit('gsap', { summary: `gsap.${method}()`, target: describeTarget(target), payload, stack: getStack() });
          }
          return result;
        };
      }
      const timelineProto = gsap.core?.Timeline?.prototype;
      if (timelineProto) {
        for (const method of ['to', 'from', 'fromTo', 'set', 'add']) {
          const original = timelineProto[method];
          if (typeof original !== 'function' || original.__webcatcherPatched) continue;
          const wrapped = function timelineMethod(target, ...rest) {
            const result = original.apply(this, [target, ...rest]);
            if (state.active) {
              const vars = method === 'fromTo' ? rest[1] : rest[0];
              emit('gsap', { summary: `timeline.${method}()`, target: describeTarget(target), payload: { method: `timeline.${method}`, target: describeTarget(target), vars: sanitize(vars), duration: vars?.duration, ease: vars?.ease, scrollTrigger: sanitize(vars?.scrollTrigger) }, stack: getStack() });
            }
            return result;
          };
          wrapped.__webcatcherPatched = true;
          timelineProto[method] = wrapped;
        }
      }
      gsap.__webcatcherPatched = true;
    } catch { /* ignore */ }
  }

  function patchAnime(anime) {
    if (typeof anime !== 'function' || anime.__webcatcherPatched) return;
    const original = anime;
    const wrapped = function animeAnimation(...args) {
      if (state.active) emit('anime', { summary: 'anime()', payload: { args: sanitize(args) }, stack: getStack() });
      return original.apply(this, args);
    };
    for (const key of Object.keys(original)) {
      try { wrapped[key] = original[key]; } catch { /* ignore */ }
    }
    wrapped.__webcatcherPatched = true;
    try { window.anime = wrapped; } catch { /* ignore */ }
  }

  function patchLottie(lottie) {
    if (!lottie || lottie.__webcatcherPatched) return;
    try {
      for (const method of ['loadAnimation', 'play', 'stop']) {
        const original = lottie[method];
        if (typeof original !== 'function') continue;
        lottie[method] = function lottieMethod(...args) {
          if (state.active && method === 'loadAnimation') {
            emit('library', { summary: 'lottie.loadAnimation()', payload: { method, args: sanitize(args) }, stack: getStack() });
          }
          return original.apply(this, args);
        };
      }
      lottie.__webcatcherPatched = true;
    } catch { /* ignore */ }
  }

  function watchGlobal(name, patcher) {
    let current;
    try { current = window[name]; } catch { /* ignore */ }
    if (current) {
      try { patcher(current); } catch { /* ignore */ }
    }
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(window, name); } catch { descriptor = null; }
    if (!descriptor || descriptor.configurable) {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get() { return current; },
          set(value) {
            current = value;
            if (value) {
              try { patcher(value); } catch { /* ignore */ }
              scheduleInventory(300);
            }
          },
        });
      } catch { /* ignore */ }
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      let value;
      try { value = window[name]; } catch { value = null; }
      if (value && value !== current) {
        current = value;
        try { patcher(value); } catch { /* ignore */ }
        scheduleInventory(300);
      }
      if (attempts > 40 || (value && value.__webcatcherPatched)) clearInterval(timer);
    }, 400);
  }

  function installLibraryHooks() {
    watchGlobal('gsap', patchGsap);
    watchGlobal('anime', patchAnime);
    watchGlobal('lottie', patchLottie);
    watchGlobal('bodymovin', patchLottie);
    try {
      if (window.ScrollTrigger) annotateGlobal(window.ScrollTrigger, 'ScrollTrigger');
    } catch { /* ignore */ }
  }

  function handleClassMutation(element, oldValue) {
    if (!(element instanceof Element)) return;
    const nowValue = element.className;
    if (String(oldValue) === String(nowValue)) return;
    const nowStamp = now();
    const last = classStamp.get(element) || 0;
    if (nowStamp - last < 80) return;
    let computed;
    try { computed = getComputedStyle(element); } catch { return; }
    const hasMotion = computed.animationName !== 'none' || computed.transitionProperty !== 'none';
    const rules = motionRulesFor(element);
    if (!hasMotion && !rules.length) return;
    classStamp.set(element, nowStamp);
    const before = new Set(String(oldValue || '').split(/\s+/).filter(Boolean));
    const after = new Set(String(nowValue || '').split(/\s+/).filter(Boolean));
    const changed = [...after].filter((c) => !before.has(c)).concat([...before].filter((c) => !after.has(c))).slice(0, 3);
    emit('class-change', {
      summary: `${after.size > before.size ? '+' : '-'}${changed.join(' ')}`,
      target: describeElement(element),
      payload: {
        from: oldValue || '',
        to: nowValue || '',
        added: [...after].filter((c) => !before.has(c)).slice(0, 12),
        removed: [...before].filter((c) => !after.has(c)).slice(0, 12),
        transition: { property: computed.transitionProperty, duration: computed.transitionDuration, easing: computed.transitionTimingFunction },
        animation: { name: computed.animationName, duration: computed.animationDuration, easing: computed.animationTimingFunction },
      },
      matchedRules: rules,
      stack: '',
    });
  }

  function handleAttributeMutation(record) {
    const element = record.target;
    if (!(element instanceof Element)) return;
    if (record.attributeName === 'style') {
      const last = inlineStamp.get(element) || 0;
      if (now() - last < 50) return;
      const value = element.getAttribute('style') || '';
      if (!value || !MOTION_RE.test(value)) return;
      emitStyleMutation(element, 'setAttribute', 'style', value, record.oldValue || '', '');
      return;
    }
    if (record.attributeName === 'class') {
      handleClassMutation(element, record.oldValue || '');
      return;
    }
    const value = element.getAttribute(record.attributeName) || '';
    if (!value || value === record.oldValue) return;
    const rules = motionRulesFor(element);
    if (!rules.length) return;
    emit('class-change', {
      summary: `${record.attributeName}="${clampText(value, 30)}"`,
      target: describeElement(element),
      payload: { attribute: record.attributeName, from: record.oldValue || '', to: value },
      matchedRules: rules,
      stack: '',
    });
  }

  function handleAddedNode(node) {
    if (!(node instanceof Element)) return;
    const candidates = [];
    if (node.matches?.('style,script,link[rel~="stylesheet"]')) candidates.push(node);
    node.querySelectorAll?.('style,script,link[rel~="stylesheet"]').forEach((item) => candidates.push(item));
    for (const item of candidates.slice(0, 12)) {
      if (item.localName === 'style') {
        const text = item.textContent || '';
        emit('css-inject', { summary: `注入 <style> · ${clampText(text.replace(/\s+/g, ' ').trim(), 60)}`, payload: { text: clampText(text, 2400) }, stack: '' });
      } else if (item.localName === 'script') {
        emit('library', { summary: `注入 <script>${item.src ? ` · ${clampText(item.src, 54)}` : ''}`, payload: { src: item.src || '', inline: !item.src, text: item.src ? '' : clampText(item.textContent || '', 600) }, stack: '' });
      } else {
        emit('css-inject', { summary: `注入样式表 · ${clampText(item.href, 54)}`, payload: { href: item.href || '' }, stack: '' });
      }
    }
    scheduleInventory(450);
  }

  function handleMutations(records) {
    for (const record of records) {
      if (record.type === 'attributes') {
        handleAttributeMutation(record);
      } else if (record.type === 'childList') {
        for (const node of record.addedNodes) handleAddedNode(node);
        if (record.addedNodes.length) scheduleInventory(450);
      } else if (record.type === 'characterData' && record.target?.parentElement?.localName === 'style') {
        const styleNode = record.target.parentElement;
        const stamp = styleTextStamp.get(styleNode) || 0;
        if (now() - stamp > 100) {
          styleTextStamp.set(styleNode, now());
          emit('css-inject', { summary: '更新 <style> 内容', payload: { text: clampText(styleNode.textContent || '', 2400) }, stack: '' });
        }
        scheduleInventory(500);
      }
    }
  }

  function startMutationObserver() {
    if (!window.MutationObserver) return;
    mutationObserver = new MutationObserver(handleMutations);
    const options = {
      subtree: true, childList: true, characterData: true, characterDataOldValue: true,
      attributes: true, attributeOldValue: true, attributeFilter: WATCHED_ATTRS,
    };
    try { mutationObserver.observe(document, options); } catch { /* ignore */ }
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root) || !mutationObserver) return;
    observedRoots.add(root);
    try {
      mutationObserver.observe(root, {
        subtree: true, childList: true, characterData: true, characterDataOldValue: true,
        attributes: true, attributeOldValue: true, attributeFilter: WATCHED_ATTRS,
      });
    } catch { /* ignore */ }
  }

  function installShadowHook() {
    const proto = window.Element?.prototype;
    if (!proto?.attachShadow) return;
    const original = proto.attachShadow;
    try {
      proto.attachShadow = function attachShadow(init) {
        const root = original.apply(this, arguments);
        if (root) {
          shadowRoots.add(root);
          observeRoot(root);
          addAnimationEventListeners(root);
        }
        return root;
      };
    } catch { /* ignore */ }
  }

  function addAnimationEventListeners(root) {
    if (!root || animationRoots.has(root)) return;
    animationRoots.add(root);
    const names = ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel', 'animationstart', 'animationiteration', 'animationend', 'animationcancel'];
    for (const name of names) {
      try { root.addEventListener(name, handleAnimationEvent, true); } catch { /* ignore */ }
    }
  }

  function handleAnimationEvent(event) {
    const element = event.target;
    if (!(element instanceof Element)) return;
    if (event.type.startsWith('transition')) {
      emit('transition', {
        summary: `${event.type} · ${event.propertyName || 'transition'}`,
        target: describeElement(element),
        payload: { event: event.type, propertyName: event.propertyName || '', elapsedTime: event.elapsedTime, pseudoElement: event.pseudoElement || '' },
        matchedRules: motionRulesFor(element),
        stack: '',
      });
      return;
    }
    let keyframes = [];
    try {
      const animation = element.getAnimations?.().find((item) => item.animationName === event.animationName);
      keyframes = animation?.effect?.getKeyframes?.().slice(0, 24) || [];
    } catch { /* ignore */ }
    emit('animation', {
      summary: `${event.type} · ${event.animationName || 'animation'}`,
      target: describeElement(element),
      payload: { event: event.type, animationName: event.animationName || '', elapsedTime: event.elapsedTime, pseudoElement: event.pseudoElement || '', keyframes: sanitize(keyframes) },
      matchedRules: motionRulesFor(element),
      stack: '',
    });
  }

  function collectShadowRoots() {
    const roots = [document];
    try {
      const all = document.querySelectorAll('*');
      let count = 0;
      for (const element of all) {
        if (element.shadowRoot) {
          if (!shadowRoots.has(element.shadowRoot)) {
            shadowRoots.add(element.shadowRoot);
            observeRoot(element.shadowRoot);
            addAnimationEventListeners(element.shadowRoot);
          }
          roots.push(element.shadowRoot);
        }
        count += 1;
        if (count > 6000) break;
      }
    } catch { /* ignore */ }
    return roots;
  }

  function serializeSheet(sheet) {
    try { return [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); }
    catch { return ''; }
  }

  function collectInventory() {
    const roots = collectShadowRoots();
    const scripts = [];
    const styles = [];
    const seenScripts = new WeakSet();
    const seenStyles = new WeakSet();
    let totalInline = 0;
    let index = 0;

    for (const root of roots) {
      let scriptNodes = [];
      let styleNodes = [];
      let linkNodes = [];
      try {
        scriptNodes = [...root.querySelectorAll('script')];
        styleNodes = [...root.querySelectorAll('style')];
        linkNodes = [...root.querySelectorAll('link[rel~="stylesheet"]')];
      } catch { /* ignore */ }
      for (const script of scriptNodes) {
        if (seenScripts.has(script)) continue;
        seenScripts.add(script);
        const type = (script.type || '').toLowerCase();
        if (type && !/javascript|ecmascript|module/.test(type)) continue;
        if (script.src) {
          scripts.push({ src: script.src, inline: false });
        } else {
          const text = script.textContent || '';
          if (!text.trim() || totalInline > 1_200_000) continue;
          const clipped = text.slice(0, 260_000);
          totalInline += clipped.length;
          index += 1;
          scripts.push({ inline: true, text: clipped, label: `${location.href.split('#')[0]}#webcatcher-inline-script-${index}` });
        }
      }
      for (const style of styleNodes) {
        if (seenStyles.has(style)) continue;
        seenStyles.add(style);
        const text = style.textContent || serializeSheet(style.sheet);
        if (!text.trim() || totalInline > 1_200_000) continue;
        const clipped = text.slice(0, 220_000);
        totalInline += clipped.length;
        index += 1;
        styles.push({ inline: true, text: clipped, label: `${location.href.split('#')[0]}#webcatcher-inline-style-${index}`, media: style.media || '' });
      }
      for (const link of linkNodes) {
        if (seenStyles.has(link)) continue;
        seenStyles.add(link);
        if (link.href) styles.push({ inline: false, href: link.href, media: link.media || '' });
      }
    }

    try {
      for (const sheet of document.styleSheets) {
        if (sheet.ownerNode && seenStyles.has(sheet.ownerNode)) continue;
        if (sheet.href) {
          if (!styles.some((item) => item.href === sheet.href)) styles.push({ inline: false, href: sheet.href });
        } else if (sheet.ownerNode) {
          const text = serializeSheet(sheet);
          if (text && totalInline < 1_200_000) {
            totalInline += text.length;
            styles.push({ inline: true, text: text.slice(0, 220_000), label: `${location.href.split('#')[0]}#webcatcher-cssom-${styles.length}`, media: sheet.media?.mediaText || '' });
          }
        }
      }
    } catch { /* ignore */ }

﻿    for (const root of roots) {
      try {
        for (const sheet of root.adoptedStyleSheets || []) {
          const text = serializeSheet(sheet);
          if (!text || totalInline > 1_200_000) continue;
          totalInline += text.length;
          styles.push({ inline: true, text: text.slice(0, 220_000), label: location.href.split('#')[0] + '#webcatcher-adopted-style-' + styles.length });
        }
      } catch { /* ignore */ }
    }

    post({
      type: 'inventory',
      inventory: {
        page: { url: location.href, title: document.title || '' },
        scripts: scripts.slice(0, 180),
        styles: styles.slice(0, 120),
        animations: snapshotAnimations(),
      },
    });
  }

  function snapshotAnimations() {
    let animations = [];
    try { animations = document.getAnimations ? document.getAnimations({ subtree: true }) : []; }
    catch {
      try { animations = document.getAnimations ? document.getAnimations() : []; } catch { animations = []; }
    }
    const result = [];
    for (const animation of animations.slice(0, 28)) {
      try {
        const effect = animation.effect;
        const target = effect?.target;
        const timing = effect?.getTiming?.() || {};
        const keyframes = effect?.getKeyframes?.().slice(0, 12) || [];
        result.push({
          kind: animation.constructor?.name || 'Animation',
          animationName: animation.animationName || '',
          transitionProperty: animation.transitionProperty || '',
          playState: animation.playState,
          currentTime: typeof animation.currentTime === 'number' ? Math.round(animation.currentTime) : null,
          startTime: typeof animation.startTime === 'number' ? Math.round(animation.startTime) : null,
          playbackRate: animation.playbackRate,
          pseudoElement: effect?.pseudoElement || '',
          target: describeElement(target, false),
          timing: { duration: timing.duration, iterations: timing.iterations, easing: timing.easing, delay: timing.delay, fill: timing.fill, direction: timing.direction },
          keyframes: sanitize(keyframes),
        });
      } catch { /* ignore */ }
    }
    return result;
  }

  function sendSnapshot() {
    if (!state.active) return;
    post({ type: 'snapshot', snapshot: { animations: snapshotAnimations(), at: now() } });
  }

  function scheduleInventory(delay = 700) {
    if (state.inventoryTimer) clearTimeout(state.inventoryTimer);
    state.inventoryTimer = setTimeout(() => {
      state.inventoryTimer = 0;
      try { collectInventory(); } catch { /* never break page */ }
    }, delay);
  }

  function installAllHooks() {
    const installers = [
      installAnimateHook, installAnimationControls, installViewTransitionHook, installHistoryHook,
      installInlineStyleHooks, installCssomHooks, installRafHook, installObserverHooks,
      installScrollHooks, installLibraryHooks, installShadowHook,
    ];
    for (const install of installers) {
      try { install(); } catch { /* isolate hook failures */ }
    }
    startMutationObserver();
    addAnimationEventListeners(document);
    scheduleInventory(0);
    setTimeout(() => scheduleInventory(0), 600);
    setTimeout(() => scheduleInventory(0), 1800);
    document.addEventListener('DOMContentLoaded', () => scheduleInventory(150), { once: true });
    window.addEventListener('load', () => scheduleInventory(200), { once: true });
    setInterval(sendSnapshot, 2000);
    setInterval(() => scheduleInventory(2500), 8000);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE) return;
    if (data.type === 'state') {
      const wasActive = state.active;
      state.active = data.active !== false;
      if (data.settings) state.settings = { ...state.settings, ...data.settings };
      if (Number.isFinite(data.startedAt)) state.startedAt = data.startedAt;
      if (state.active && !wasActive) {
        sendSnapshot();
        scheduleInventory(50);
      } else if (!state.active && wasActive) {
        flush(true);
      }
    } else if (data.type === 'action') {
      if (data.action === 'rescan') {
        scheduleInventory(0);
        sendSnapshot();
      } else if (data.action === 'clear') {
        state.queue.length = 0;
        state.seq = 0;
        rafStats.clear();
        scheduleInventory(0);
        sendSnapshot();
      } else if (data.action === 'flush') {
        flush(true);
      }
    }
  });

  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
    else sendSnapshot();
  });

  installAllHooks();
})();
