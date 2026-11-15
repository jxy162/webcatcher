const MOTION_PROP_RE = /(?:^|[;{\s])(?:-webkit-)?(?:transition(?:-[a-z-]+)?|animation(?:-[a-z-]+)?|transform(?:-origin|-style)?|translate|scale|rotate|offset(?:-path|-distance|-rotate|-anchor)?|view-transition-name|will-change|scroll-timeline(?:-[a-z-]+)?|view-timeline(?:-[a-z-]+)?|timeline-scope|perspective(?:-origin)?|filter|backdrop-filter|clip-path)\s*:/i;
const KEYFRAME_AT_RE = /^@(?:-webkit-)?keyframes\s+([^\s{]+)/i;

export function simpleHash(input) {
  let hash = 2166136261;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function skipString(text, i, end) {
  const quote = text[i];
  i += 1;
  while (i < end) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return end;
}

function skipComment(text, i, end) {
  const close = text.indexOf('*/', i + 2);
  return close === -1 || close > end ? end : close + 2;
}

function findClosingBrace(text, open, end) {
  let depth = 1;
  let i = open + 1;
  while (i < end) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i, end);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipComment(text, i, end);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return end;
}

function compact(text, max = 1800) {
  const trimmed = String(text || '').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n/* … truncated … */` : trimmed;
}

function declarationValue(block, prop) {
  const re = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;}`]+)`, 'i');
  return block.match(re)?.[1]?.trim() || '';
}

function classifySelector(selector, block) {
  if (/::view-transition|view-transition-name/i.test(selector)) return 'view-transition';
  if (/animation-timeline|scroll-timeline|view-timeline|animation-range/i.test(block)) return 'scroll';
  if (/animation(?:-name)?\s*:/i.test(block)) return 'animation';
  if (/transition(?:-property)?\s*:/i.test(block)) return 'transition';
  return 'motion';
}

export function analyzeCss(css, sourceUrl = '', options = {}) {
  const maxItems = options.maxItems || 280;
  const text = String(css || '').replace(/^\uFEFF/, '');
  if (!text.trim()) return { items: [], metrics: { keyframes: 0, rules: 0 }, sourceUrl };

  const items = [];
  const seen = new Set();
  const stats = { keyframes: 0, rules: 0, transitions: 0, animations: 0, viewTransitions: 0 };
  const contextStack = [];

  const pushItem = (item) => {
    const id = simpleHash(`${item.kind}|${item.name}|${item.selector}|${item.text}|${sourceUrl}`);
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, sourceUrl, ...item });
    stats.rules += item.kind === 'keyframes' ? 0 : 1;
    if (item.kind === 'keyframes') stats.keyframes += 1;
    if (item.kind === 'transition') stats.transitions += 1;
    if (item.kind === 'animation') stats.animations += 1;
    if (item.kind === 'view-transition') stats.viewTransitions += 1;
  };

  const walk = (start, end) => {
    let i = start;
    let statementStart = start;
    while (i < end) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        i = skipString(text, i, end);
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        i = skipComment(text, i, end);
        continue;
      }
      if (ch === ';') {
        i += 1;
        statementStart = i;
        continue;
      }
      if (ch !== '{') {
        i += 1;
        continue;
      }

      const prelude = text.slice(statementStart, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const close = findClosingBrace(text, i, end);
      const innerStart = i + 1;
      const innerEnd = Math.min(close, end);
      const inner = text.slice(innerStart, innerEnd);
      const context = contextStack.join('\n');
      const fullText = context ? `${context} {\n${text.slice(statementStart, close + 1).trim()}\n}` : text.slice(statementStart, close + 1).trim();
      const line = lineOf(text, statementStart);

      if (!prelude) {
        i = close + 1;
        statementStart = i;
        continue;
      }

      if (/^@(?:media|supports|layer|container|scope|starting-style|document)\b/i.test(prelude)) {
        contextStack.push(`${prelude} {`);
        walk(innerStart, innerEnd);
        contextStack.pop();
      } else if (KEYFRAME_AT_RE.test(prelude)) {
        const name = prelude.match(KEYFRAME_AT_RE)?.[1] || 'anonymous';
        const steps = [...inner.matchAll(/(^|[}\s])((?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*)\s*\{/gi)]
          .map((match) => match[2].replace(/\s+/g, ' ').trim());
        pushItem({
          kind: 'keyframes',
          name: name.replace(/^['"]|['"]$/g, ''),
          selector: `@keyframes ${name}`,
          text: compact(fullText),
          line,
          steps: [...new Set(steps)].slice(0, 24),
          properties: [...new Set([...inner.matchAll(/(?:^|[;{\s])((?:--)?[a-z-]+)\s*:/gi)].map((m) => m[1]))].slice(0, 20),
        });
      } else if (/^@(?:-webkit-)?view-transition\b/i.test(prelude)) {
        pushItem({
          kind: 'view-transition',
          name: prelude,
          selector: prelude,
          text: compact(fullText),
          line,
          properties: [],
        });
        walk(innerStart, innerEnd);
      } else if (/^@property\b/i.test(prelude)) {
        if (/initial-value|syntax/i.test(inner)) {
          pushItem({
            kind: 'custom-property',
            name: prelude.match(/@property\s+([^\s{]+)/i)?.[1] || prelude,
            selector: prelude,
            text: compact(fullText),
            line,
            properties: ['@property'],
          });
        }
      } else if (!prelude.startsWith('@')) {
        if (MOTION_PROP_RE.test(`${prelude}{${inner}}`) || /::view-transition/i.test(prelude)) {
          const selector = `${context ? `${context}\n` : ''}${prelude}`.trim();
          const kind = classifySelector(prelude, inner);
          const name = declarationValue(inner, 'animation-name') || declarationValue(inner, 'transition-property') || prelude.split(',').pop().trim();
          pushItem({
            kind,
            name: name.slice(0, 120),
            selector,
            text: compact(fullText, 2400),
            line,
            properties: [...new Set([...inner.matchAll(/(?:^|[;{\s])((?:--)?[a-z-]+)\s*:/gi)].map((m) => m[1]))].slice(0, 24),
            duration: declarationValue(inner, 'animation-duration') || declarationValue(inner, 'transition-duration'),
            easing: declarationValue(inner, 'animation-timing-function') || declarationValue(inner, 'transition-timing-function'),
          });
        }
        if (inner.includes('{')) {
          contextStack.push(`${prelude} {`);
          walk(innerStart, innerEnd);
          contextStack.pop();
        }
      }

      i = close + 1;
      statementStart = i;
      if (items.length >= maxItems) break;
    }
  };

  walk(0, text.length);
  items.sort((a, b) => {
    const order = { keyframes: 0, 'view-transition': 1, scroll: 2, animation: 3, transition: 4, motion: 5, 'custom-property': 6 };
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
  });

  return {
    items: items.slice(0, maxItems),
    metrics: { ...stats, lines: text.split('\n').length, bytes: text.length },
    sourceUrl,
  };
}
