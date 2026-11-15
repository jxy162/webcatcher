const KIND_LABELS = {
  transition: 'CSS Transition', animation: 'CSS Animation', waapi: 'Web Animations API',
  'waapi-control': 'Animation Control', style: 'Inline Style', 'class-change': 'Class Change',
  'css-change': 'CSSOM Change', 'css-inject': 'Style Injected', 'view-transition': 'View Transition',
  route: 'Route Change', raf: 'rAF Loop', observer: 'Observer', gsap: 'GSAP', anime: 'anime.js',
  scroll: 'Scroll Motion', snapshot: 'Snapshot', navigation: 'Page Load', library: 'Library',
  'element-animate': 'Element Animation',
};

export function kindLabel(kind) { return KIND_LABELS[kind] || kind; }

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function eventSummary(event) {
  if (event.summary) return event.summary;
  if (event.target?.selector) return event.target.selector;
  if (event.payload?.name) return event.payload.name;
  return event.kind;
}

function fence(code, lang = '') {
  return `~~~${lang}\n${String(code || '').trim()}\n~~~`;
}

function cleanCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 220);
}

export function buildMarkdown(session) {
  const page = session.page || {};
  const events = session.events || [];
  const css = session.analyses?.css || [];
  const js = session.analyses?.js || [];
  const cssItems = css.flatMap((analysis) => analysis.items || []);
  const keyframes = cssItems.filter((item) => item.kind === 'keyframes');
  const transitions = cssItems.filter((item) => item.kind === 'transition' || item.kind === 'animation');
  const started = session.startedAt ? new Date(session.startedAt) : new Date();
  const duration = events.length ? events[events.length - 1].t || 0 : Date.now() - started.getTime();

  const lines = [];
  lines.push('# WebCatcher 动效捕获报告');
  lines.push('');
  lines.push(`- 页面：${page.title || '(未命名)'}`);
  lines.push(`- URL：${page.url || '—'}`);
  lines.push(`- 捕获时间：${started.toLocaleString('zh-CN')}`);
  lines.push(`- 时长：${fmtDuration(duration)}`);
  lines.push(`- 事件：${events.length}`);
  lines.push(`- CSS 动效规则：${cssItems.length}（@keyframes ${keyframes.length}）`);
  lines.push(`- JS 动效脚本：${js.length}`);
  lines.push('');
  lines.push('## 动效时间线');
  lines.push('');
  if (!events.length) {
    lines.push('_尚未捕获事件。_');
  } else {
    lines.push('| 时间 | 类型 | 目标 / 摘要 | 细节 |');
    lines.push('| --- | --- | --- | --- |');
    for (const event of events.slice(-300)) {
      const detail = event.payload?.propertyName || event.payload?.animationName || event.payload?.property || event.payload?.name || '';
      lines.push(`| ${fmtDuration(event.t)} | ${cleanCell(kindLabel(event.kind))} | ${cleanCell(eventSummary(event))} | ${cleanCell(detail)} |`);
    }
  }
  lines.push('');
  lines.push('## CSS 实现');
  lines.push('');
  if (!cssItems.length) {
    lines.push('_没有从样式表中提取到动效规则。_');
  } else {
    for (const item of cssItems.slice(0, 120)) {
      lines.push(`### ${item.kind} · ${item.name || item.selector}`);
      lines.push('');
      lines.push(`来源：${item.sourceUrl || 'inline'}${item.line ? ` · 第 ${item.line} 行` : ''}`);
      lines.push('');
      lines.push(fence(item.text, 'css'));
      lines.push('');
    }
  }
  lines.push('## JS 实现线索');
  lines.push('');
  if (!js.length) {
    lines.push('_没有从脚本中识别到动效关键词。_');
  } else {
    for (const item of js.slice(0, 50)) {
      lines.push(`### ${item.sourceUrl || 'inline script'}`);
      lines.push('');
      lines.push(`评分 ${item.score} · ${item.labels.join('、')} · ${fmtBytes(item.bytes)}`);
      lines.push('');
      for (const snippet of (item.snippets || []).slice(0, 6)) {
        lines.push(`**${snippet.label}** · 第 ${snippet.line} 行`);
        lines.push('');
        lines.push(fence(snippet.code, 'js'));
        lines.push('');
      }
    }
  }
  lines.push('---');
  lines.push('由 WebCatcher 生成。');
  return lines.join('\n');
}

export function buildJson(session) {
  return JSON.stringify({
    generator: 'WebCatcher',
    exportedAt: new Date().toISOString(),
    page: session.page,
    startedAt: session.startedAt,
    events: session.events,
    css: session.analyses?.css,
    js: session.analyses?.js,
    snapshot: session.snapshot,
  }, null, 2);
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
