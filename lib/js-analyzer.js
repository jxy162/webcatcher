import { simpleHash } from './css-parser.js';

const SIGNALS = [
  { key: 'view-transition-api', label: 'View Transitions API', re: /\bstartViewTransition\s*\(/g, weight: 10, tag: 'page-transition' },
  { key: 'view-transition-css', label: 'View Transition CSS', re: /::view-transition|view-transition-name|view-transition-class/g, weight: 8, tag: 'page-transition' },
  { key: 'swup', label: 'Swup page transitions', re: /\bSwup\b|\bswup\b/g, weight: 7, tag: 'page-transition' },
  { key: 'barba', label: 'Barba.js page transitions', re: /\bbarba\b/g, weight: 7, tag: 'page-transition' },
  { key: 'turbo', label: 'Turbo navigation', re: /\bTurbo\b|turbo:(?:load|render|visit)/g, weight: 4, tag: 'page-transition' },
  { key: 'astro-transition', label: 'Astro page transitions', re: /astro:(?:page-load|after-swap|before-swap)/g, weight: 5, tag: 'page-transition' },
  { key: 'waapi-animate', label: 'Element.animate()', re: /\.(?:animate|animateTo)\s*\(/g, weight: 8, tag: 'waapi' },
  { key: 'keyframe-effect', label: 'KeyframeEffect', re: /\bKeyframeEffect\b/g, weight: 7, tag: 'waapi' },
  { key: 'keyframes-js', label: '@keyframes in JS', re: /@(?:-webkit-)?keyframes/g, weight: 7, tag: 'css-in-js' },
  { key: 'gsap', label: 'GSAP', re: /\b(?:gsap|TweenMax|TweenLite|TimelineMax|TimelineLite|ScrollTrigger)\b/g, weight: 8, tag: 'library' },
  { key: 'anime', label: 'anime.js', re: /\banime\s*[.(]/g, weight: 7, tag: 'library' },
  { key: 'motion', label: 'Motion / Framer Motion', re: /\b(?:framer-motion|motion\.div|motion\.svg|MotionValue|useAnimate|animate\s*\(\s*motion)/g, weight: 7, tag: 'library' },
  { key: 'lottie', label: 'Lottie', re: /\b(?:lottie|bodymovin)\b/gi, weight: 7, tag: 'library' },
  { key: 'three', label: 'Three.js motion', re: /\bTHREE\.(?:AnimationMixer|Clock|Vector3)\b/g, weight: 4, tag: 'library' },
  { key: 'raf', label: 'requestAnimationFrame loop', re: /\brequestAnimationFrame\s*\(/g, weight: 4, tag: 'js-loop' },
  { key: 'transitions', label: 'transition property', re: /\btransition(?:Property|Duration|TimingFunction|Delay)?\b|transition\s*:/g, weight: 4, tag: 'css' },
  { key: 'animations', label: 'animation property', re: /\banimation(?:Name|Duration|TimingFunction|Delay|IterationCount|Direction|FillMode|PlayState)?\b|animation\s*:/g, weight: 4, tag: 'css' },
  { key: 'transform', label: 'transform / translate', re: /\b(?:transform|translate3d|translateX|translateY|scale|rotate)\b/g, weight: 2, tag: 'motion' },
  { key: 'easing', label: 'easing curve', re: /\b(?:cubic-bezier|spring|easeInOut|easeOut|easeIn|back\.out|elastic)\b/g, weight: 3, tag: 'motion' },
  { key: 'scroll-timeline', label: 'Scroll-driven animation', re: /\b(?:scroll-timeline|view-timeline|animation-timeline|animation-range|ScrollTrigger)\b/g, weight: 6, tag: 'scroll' },
  { key: 'intersection', label: 'IntersectionObserver', re: /\bIntersectionObserver\b/g, weight: 3, tag: 'scroll' },
  { key: 'will-change', label: 'will-change', re: /\bwill-change\b/g, weight: 2, tag: 'performance' },
  { key: 'smooth-scroll', label: 'smooth scrolling', re: /\bbehavior\s*:\s*['"]smooth['"]/g, weight: 3, tag: 'scroll' },
  { key: 'animation-events', label: 'animation events', re: /\b(?:animationend|animationstart|transitionend|transitionstart)\b/g, weight: 2, tag: 'events' },
];

const LIBRARY_SIGNALS = [
  ['GSAP', /\b(?:gsap|TweenMax|TimelineMax|ScrollTrigger)\b/],
  ['anime.js', /\banime\s*[.(]/],
  ['Motion', /\b(?:framer-motion|motion\.div|MotionValue)\b/],
  ['Lottie', /\b(?:lottie|bodymovin)\b/i],
  ['Three.js', /\bTHREE\./],
  ['ScrollReveal', /\bScrollReveal\b/],
  ['AOS', /\bAOS\.init\b/],
  ['Lenis', /\bLenis\b/],
  ['Swup', /\bSwup\b|\bswup\b/],
  ['Barba.js', /\bbarba\b/],
  ['Turbo', /\bTurbo\b|turbo:(?:load|render|visit)/],
  ['Astro View Transitions', /astro:(?:page-load|after-swap|before-swap)/],
];

function sourceExcerpt(text, index, matchText) {
  const lineStart = Math.max(0, text.lastIndexOf('\n', index - 1) + 1);
  const lineEndRaw = text.indexOf('\n', index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const lineNumber = text.slice(0, index).split('\n').length;
  let start = Math.max(0, index - 110);
  let end = Math.min(text.length, index + Math.max(180, matchText.length * 2));
  if (start < lineStart) start = lineStart;
  if (end > lineEnd) end = lineEnd;
  let code = text.slice(start, end).replace(/\t/g, '  ');
  if (start > 0) code = `… ${code}`;
  if (end < text.length) code = `${code} …`;
  return { line: lineNumber, column: index - lineStart + 1, code: code.slice(0, 520) };
}

export function analyzeJs(source, sourceUrl = '', options = {}) {
  const text = String(source || '').slice(0, options.maxBytes || 2_500_000);
  if (!text.trim()) return null;

  const labels = new Set();
  const tags = new Set();
  const snippets = [];
  const seenSnippetKeys = new Set();
  let score = 0;

  for (const signal of SIGNALS) {
    signal.re.lastIndex = 0;
    const match = signal.re.exec(text);
    if (!match) continue;
    labels.add(signal.label);
    tags.add(signal.tag);
    const extra = signal.re.global ? (text.match(signal.re)?.length || 1) : 1;
    score += signal.weight + Math.min(5, Math.log2(extra + 1));
    const snippetKey = `${signal.key}:${match.index}`;
    if (!seenSnippetKeys.has(snippetKey) && snippets.length < 14) {
      seenSnippetKeys.add(snippetKey);
      snippets.push({ label: signal.label, ...sourceExcerpt(text, match.index, match[0]) });
    }
  }

  const libraries = LIBRARY_SIGNALS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (libraries.length === 0 && score < 5) return null;

  return {
    id: simpleHash(`${sourceUrl}|${text.slice(0, 4000)}|${text.length}`),
    sourceUrl,
    sourceKind: options.inline ? 'inline' : 'external',
    score: Math.round(score * 10) / 10,
    labels: [...labels].slice(0, 12),
    tags: [...tags],
    libraries,
    snippets: snippets.slice(0, 10),
    bytes: text.length,
    lines: text.split('\n').length,
    source: options.keepSource && text.length <= 500_000 ? text : undefined,
  };
}
