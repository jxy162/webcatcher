import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCss, simpleHash } from '../lib/css-parser.js';
import { analyzeJs } from '../lib/js-analyzer.js';
import { buildJson, buildMarkdown } from '../lib/export.js';
import { shortUrl } from '../lib/format.js';

const css = `
:root { --ease: cubic-bezier(.2,.8,.2,1); }
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
.card { transition: transform .3s var(--ease), opacity .3s; animation: fadeUp .6s both; }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
::view-transition-old(hero) { animation: fadeOut .3s; }
.scroll-note { animation-timeline: view(); animation-range: entry 0% cover 40%; }
`;

test('CSS analyzer extracts keyframes and motion rules', () => {
  const result = analyzeCss(css, 'https://example.com/app.css');
  assert.ok(result.items.length >= 5);
  const keyframes = result.items.find((item) => item.kind === 'keyframes');
  assert.equal(keyframes.name, 'fadeUp');
  assert.deepEqual(keyframes.steps, ['from', 'to']);
  assert.ok(result.items.some((item) => item.selector.includes('.card') && item.kinds?.includes('transition')));
  assert.ok(result.items.some((item) => item.kind === 'view-transition'));
  assert.ok(result.items.some((item) => item.kind === 'scroll'));
  assert.ok(result.items.every((item) => item.line >= 1));
});

test('CSS analyzer keeps nested media context', () => {
  const result = analyzeCss(css, 'inline.css');
  const mediaRule = result.items.find((item) => item.selector.includes('@media'));
  assert.ok(mediaRule, 'media-scoped rule should be extracted');
  assert.ok(mediaRule.text.includes('@media'));
});

test('JS analyzer finds implementation signals', () => {
  const source = `
    const card = document.querySelector('.card');
    document.startViewTransition(() => render());
    card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    gsap.to('.hero', { y: 0, duration: .6, ease: 'power3.out' });
    new Swup({ containers: ['#swup'] });
    requestAnimationFrame(loop);
  `;
  const result = analyzeJs(source, 'https://example.com/app.js');
  assert.ok(result);
  assert.ok(result.score > 10);
  assert.ok(result.labels.includes('View Transitions API'));
  assert.ok(result.labels.includes('Element.animate()'));
  assert.ok(result.libraries.includes('GSAP'));
  assert.ok(result.libraries.includes('Swup'));
  assert.ok(result.tags.includes('page-transition'));
  assert.ok(result.snippets.some((snippet) => snippet.line === 3));
});

test('JS analyzer ignores unrelated scripts', () => {
  assert.equal(analyzeJs('const value = 1; console.log(value);', 'plain.js'), null);
});

test('export build contains timeline and CSS evidence', () => {
  const session = {
    page: { title: 'Demo', url: 'https://example.com' },
    startedAt: Date.now() - 3000,
    events: [{ t: 1000, kind: 'transition', summary: 'transitionend · transform', target: { selector: '.card' }, payload: { propertyName: 'transform' }, stack: 'at go (app.js:1:1)', matchedRules: [] }],
    analyses: {
      css: [{ sourceUrl: 'inline.css', items: [{ kind: 'keyframes', name: 'fade', selector: '@keyframes fade', text: '@keyframes fade { to { opacity: 0; } }', line: 1 }] }],
      js: [{ sourceUrl: 'app.js', score: 8, labels: ['GSAP'], snippets: [{ label: 'GSAP', line: 4, code: 'gsap.to(...)' }], bytes: 100 }],
    },
    snapshot: null,
  };
  const markdown = buildMarkdown(session);
  assert.match(markdown, /WebCatcher/);
  assert.match(markdown, /@keyframes fade/);
  assert.match(markdown, /transitionend/);
  const json = JSON.parse(buildJson(session));
  assert.equal(json.events.length, 1);
  assert.ok(json.exportedAt);
});

test('hash and URL formatting are stable', () => {
  assert.equal(simpleHash('abc'), simpleHash('abc'));
  assert.notEqual(simpleHash('abc'), simpleHash('abd'));
  assert.match(shortUrl('http://127.0.0.1:8125/test/app.js'), /127\.0\.0\.1:8125/);
});
