import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache/ms-playwright');
const { chromium } = await import('playwright');
const runDir = path.join(root, 'test-results', `network-${Date.now()}`);
await mkdir(runDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), runDir,
  networkMode: 'Real HTTPS wire requests to a project-local TLS server; test domains resolve to loopback. No CDP Fetch or Playwright request interception.',
  checks: [], requests: [] };
const cert = path.join(runDir, 'certificate.pem');
const key = path.join(runDir, 'private-key.pem');
const openssl = process.env.PIXIV_TEST_OPENSSL || 'C:/Program Files/Git/mingw64/bin/openssl.exe';
let context, server;
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
try {
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=local-pixiv-fixture',
    '-addext', 'subjectAltName=DNS:i.pximg.net,DNS:ordinary.test'], { stdio: 'pipe' });
  server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    report.requests.push({ url: req.url, method: req.method, host: req.headers.host, headers: req.headers });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', req.url === '/source' ? 'text/html' : 'text/plain');
    res.end(req.url === '/source' ? '<!doctype html><title>Local HTTPS fixture</title>' : 'local-wire-ok');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const extensionPath = path.join(root, 'dist');
  context = await chromium.launchPersistentContext(path.join(runDir, 'profile'), {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--ignore-certificate-errors', '--no-proxy-server', '--disable-background-networking',
      '--host-resolver-rules=MAP i.pximg.net 127.0.0.1, MAP ordinary.test 127.0.0.1, MAP * ~NOTFOUND',
    ],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  report.extensionId = extensionId;
  const setup = context.pages()[0] || await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/panel.html`);
  for (let i = 0; i < 100; i++) {
    report.rules = await setup.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    if (report.rules.length) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(report.rules.length, 'Expected production DNR rules to be installed');
  await setup.evaluate(() => chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'], justification: '本地 HTTPS 请求头验收' }));
  const cdp = await context.newCDPSession(setup);
  let offscreen;
  for (let i = 0; i < 100; i++) {
    offscreen = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${extensionId}/offscreen.html`);
    if (offscreen) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(offscreen, 'Expected actual extension offscreen target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: offscreen.targetId, flatten: false });
  let nextId = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message);
    const callback = pending.get(response.id);
    if (!callback) return;
    pending.delete(response.id);
    if (response.error) callback.reject(new Error(response.error.message));
    else callback.resolve(response.result);
  });
  const command = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
  const resourceUrl = `https://i.pximg.net:${port}/offscreen-probe`;
  const result = await command('Runtime.evaluate', { expression: `fetch(${JSON.stringify(resourceUrl)}).then(r => r.text())`, awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  assert.equal(result.result.value, 'local-wire-ok');
  const extensionRequest = report.requests.find(r => r.url === '/offscreen-probe');
  assert.ok(extensionRequest, 'Local server received offscreen request');
  assert.equal(extensionRequest.headers.referer, 'https://www.pixiv.net/');
  check('Actual extension offscreen fetch sends Pixiv Referer on the HTTPS wire');

  const page = await context.newPage();
  const sourceUrl = `https://ordinary.test:${port}/source`;
  await page.goto(sourceUrl);
  assert.equal(await page.evaluate(async url => (await fetch(url, { referrerPolicy: 'unsafe-url' })).text(), `https://i.pximg.net:${port}/ordinary-probe`), 'local-wire-ok');
  const ordinaryRequest = report.requests.find(r => r.url === '/ordinary-probe');
  assert.ok(ordinaryRequest, 'Local server received ordinary website request');
  assert.equal(ordinaryRequest.headers.referer, sourceUrl);
  check('Ordinary website fetch retains its own Referer and is not rewritten');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack || String(error); process.exitCode = 1;
  console.error(error);
} finally {
  await context?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(runDir, 'report.json')}`);
}
