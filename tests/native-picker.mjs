import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache/ms-playwright');
const { chromium } = await import('playwright');
const runDir = path.join(root, 'test-results', `native-picker-${Date.now()}`);
const folder = path.join(runDir, 'chosen');
const extension = path.join(runDir, 'extension');
const report = { startedAt: new Date().toISOString(), runDir, folder, mode: 'Real native directory picker, isolated headed project Chromium; no picker or permission overrides.', checks: [], errors: [] };
const save = () => writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let context;
async function check(name, data = {}) { report.checks.push({ name, ...data }); await save(); console.log(`PASS ${name}`); }
await mkdir(folder, { recursive: true });
await cp(path.join(root, 'dist'), extension, { recursive: true });
// This unchanged source copy only exposes the production storage/writer module
// to the test's offscreen evaluation; packaged application code is unmodified.
await cp(path.join(root, 'src/destination.js'), path.join(extension, 'native-destination.js'));
await save();
await writeFile(path.join(root, 'test-results/native-picker-active.json'), JSON.stringify({ runDir, folder }, null, 2));
try {
  context = await chromium.launchPersistentContext(path.join(runDir, 'profile'), {
    channel: 'chromium', headless: false, viewport: { width: 1080, height: 760 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check'],
  });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  report.extensionId = extensionId;
  const panel = context.pages()[0] || await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.locator('#choose').waitFor({ state: 'visible' });
  const chooserPromise = context.waitForEvent('page');
  await panel.locator('#choose').click();
  const chooser = await chooserPromise;
  await chooser.waitForLoadState('domcontentloaded');
  await chooser.locator('#pick-directory:enabled').waitFor();
  assert.ok(new URL(chooser.url()).searchParams.get('token'));
  await check('OPEN_CHOOSER issued token-bound native picker page', { chooserUrl: chooser.url() });
  console.log(`NATIVE_PICKER_FOLDER=${folder}`);
  // An external native UI operator selects exactly the folder printed above.
  // The real application event handler calls showDirectoryPicker({mode:readwrite}).
  await chooser.locator('#pick-directory').click();
  report.stage = 'awaiting-native-selection'; await save();
  await chooser.waitForFunction(() => document.querySelector('#chosen-directory').textContent.startsWith('已选择：'), null, { timeout: 180_000 });
  const selection = await panel.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'CONTEXT' });
    if (!result?.ok) throw new Error(result?.error || 'CONTEXT failed');
    return result.destination;
  });
  assert.equal(selection.name, 'chosen'); assert.equal(selection.granted, true);
  await check('Native selected external directory persisted and granted in service worker', { selection });
  const png = await chooser.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 2; c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2); return c.toDataURL('image/png').split(',')[1];
  });
  await worker.evaluate(async () => {
    if (!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS', 'WORKERS'], justification: 'Native selected-folder smoke test of production writer' });
  });
  const cdp = await context.newCDPSession(panel);
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${extensionId}/offscreen.html`);
  assert.ok(target, 'actual offscreen document exists');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let commandId = 0; const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return; const message = JSON.parse(event.message);
    if (!message.id) return; const p = pending.get(message.id); pending.delete(message.id);
    if (message.error) p?.reject(new Error(message.error.message)); else p?.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++commandId; pending.set(id, { resolve, reject });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
  };
  const write = await evaluate(`(async()=>{const m=await import('./native-destination.js'); const h=await m.getDirectory(${JSON.stringify(selection.id)}); const bytes=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0)); const permission=await h.queryPermission({mode:'readwrite'}); const name=await m.writeOriginalFile(h,'native-smoke.png',new Blob([bytes],{type:'image/png'})); return {name,permission,kind:h.kind,isExternal:!(await h.isSameEntry(await navigator.storage.getDirectory()))};})()`);
  assert.equal(write.isExternal, true); assert.equal(write.permission, 'granted');
  assert.deepEqual(await readFile(path.join(folder, write.name)), Buffer.from(png, 'base64'));
  await check('Actual offscreen document read stored external handle and wrote byte-exact PNG through production module', write);
  await chooser.close();
  await panel.goto('about:blank');
  await wait(8000);
  const afterClosing = await evaluate(`(async()=>{const m=await import('./native-destination.js');const h=await m.getDirectory(${JSON.stringify(selection.id)});return {permission:await h.queryPermission({mode:'readwrite'}),name:h.name};})()`);
  await check('Observed permission after closing all top-level extension pages while offscreen stays open', afterClosing);
  report.stage = 'complete';
} catch (error) {
  report.stage = 'incomplete'; report.errors.push(String(error.stack || error)); console.error(String(error)); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await save();
  await writeFile(path.join(root, 'test-results/native-picker-latest.json'), JSON.stringify(report, null, 2));
  await context?.close(); console.log(`REPORT=${path.join(runDir, 'report.json')}`);
}
