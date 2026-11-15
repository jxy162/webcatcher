const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8125);
const BROWSER = process.env.BROWSER_BIN
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ARTIFACTS = path.join(__dirname, 'artifacts');

function startServer() {
  const server = http.createServer((request, response) => {
    const relative = request.url === '/' ? '/test/motion-lab.html' : request.url.split('?')[0];
    const file = path.join(ROOT, decodeURIComponent(relative));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const extension = path.extname(file);
    const type = extension === '.html' ? 'text/html' : extension === '.js' ? 'text/javascript' : 'text/css';
    response.writeHead(200, {
      'content-type': `${type}; charset=utf-8`,
      'access-control-allow-origin': '*',
      'access-control-allow-private-network': 'true',
    });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventCount(panel) {
  return panel.evaluate(() => Number(document.querySelector('#eventCount').textContent.replace(/,/g, '')));
}

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const server = await startServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcatcher-e2e-'));
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    userDataDir,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const errors = [];
  try {
    await wait(2200);
    const worker = browser.targets().find((target) => target.type() === 'service_worker');
    assert.ok(worker, 'extension service worker should start');
    const extensionId = new URL(worker.url()).host;

    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/test/motion-lab.html`, { waitUntil: 'networkidle2' });
    await wait(1200);
    await page.click('#animate');
    await page.hover('#card');
    await page.evaluate(() => history.pushState({ motion: true }, '', '/motion-route'));
    await wait(1000);

    const panel = await browser.newPage();
    panel.on('pageerror', (error) => errors.push(`panel: ${error.message}`));
    panel.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await panel.setViewport({ width: 430, height: 980, deviceScaleFactor: 2 });
    await panel.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' });
    await wait(900);
    await panel.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((tab) => tab.url?.includes('127.0.0.1:8125'));
      if (target) await chrome.tabs.update(target.id, { active: true });
    });
    await panel.waitForFunction(() => Number(document.querySelector('#eventCount')?.textContent || 0) >= 5, { timeout: 10000 });
    await wait(1800);

    const counts = await panel.evaluate(() => ({
      events: Number(document.querySelector('#eventCount').textContent.replace(/,/g, '')),
      css: Number(document.querySelector('#cssCount').textContent),
      js: Number(document.querySelector('#jsCount').textContent),
      rows: document.querySelectorAll('.event').length,
      status: document.querySelector('#statusText').textContent,
    }));
    assert.ok(counts.events >= 5, 'runtime events should be captured');
    assert.ok(counts.css >= 5, 'motion CSS should be extracted');
    assert.ok(counts.js >= 2, 'inline and external scripts should be analyzed');
    assert.ok(counts.rows >= 5, 'timeline rows should render');
    assert.equal(counts.status, '已连接');

    const beforePause = await eventCount(panel);
    await panel.evaluate(() => document.querySelector('#recordBtn').click());
    await wait(700);
    const pausedState = await panel.evaluate(() => ({
      active: document.querySelector('#deck').dataset.active,
      label: document.querySelector('#recordingState').textContent,
    }));
    const pausedAt = await eventCount(panel);
    await wait(1500);
    const stillPaused = await eventCount(panel);
    assert.equal(pausedState.active, 'false');
    assert.equal(pausedState.label, '已暂停');
    assert.ok(stillPaused - pausedAt <= 1, 'event count should freeze while paused');

    await panel.evaluate(() => document.querySelector('#recordBtn').click());
    await wait(1800);
    const resumed = await eventCount(panel);
    assert.ok(resumed > stillPaused, 'recording should continue after resume');

    await panel.evaluate(() => document.querySelector('.event')?.click());
    await wait(350);
    const detail = await panel.evaluate(() => ({
      open: document.body.classList.contains('drawer-open'),
      sections: document.querySelectorAll('#detailBody .detail-section').length,
    }));
    assert.equal(detail.open, true);
    assert.ok(detail.sections >= 2);
    await panel.screenshot({ path: path.join(ARTIFACTS, 'detail.png') });
    await panel.evaluate(() => document.querySelector('#detailClose')?.click());
    await panel.evaluate(() => document.querySelector('[data-tab="timeline"]').click());
    await wait(400);
    await panel.screenshot({ path: path.join(ARTIFACTS, 'panel.png') });

    await panel.evaluate(() => document.querySelector('[data-tab="styles"]').click());
    await wait(200);
    const cssGroups = await panel.evaluate(() => document.querySelectorAll('#cssList .source-group').length);
    assert.ok(cssGroups >= 2, 'inline and external CSS source groups should render');

    await panel.evaluate(() => document.querySelector('[data-tab="scripts"]').click());
    await wait(200);
    const scriptGroups = await panel.evaluate(() => document.querySelectorAll('#jsList .source-group').length);
    const scriptTitles = await panel.evaluate(() => [...document.querySelectorAll('#jsList .source-group')].map((group) => ({ title: group.querySelector('.source-title strong')?.textContent, meta: group.querySelector('.source-title small')?.textContent, notice: group.querySelector('.notice')?.textContent })));
    assert.ok(scriptGroups >= 2, 'inline and external script groups should render');

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ extensionId, counts, beforePause, pausedAt, stillPaused, resumed, detail, cssGroups, scriptGroups, scriptTitles }, null, 2));
    console.log('e2e ok');
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
