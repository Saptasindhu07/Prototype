import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve('work/ui-qa');
const profile = path.join(root, `browser-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const browser = spawn(process.env.AI_UI_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--no-sandbox', '--in-process-gpu', '--disable-gpu', '--disable-software-rasterizer', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise(resolve => setTimeout(resolve, 200));
const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const errors = [];
let requestMode = 'unavailable';
let heldRequest = null;
let lastRequest = null;
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const handlers = pending.get(message.id); pending.delete(message.id);
    message.error ? handlers.reject(message.error) : handlers.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  else if (message.method === 'Fetch.requestPaused') handleRequest(message).catch(error => {
    if (error.code !== -32602 || error.message !== 'Invalid InterceptionId.') errors.push({ interception: error });
  });
};
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function fulfill(requestId, sessionId, status, data) {
  await call('Fetch.fulfillRequest', { requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(data)).toString('base64') }, sessionId);
}
async function handleRequest(message) {
  const { requestId, request } = message.params;
  if (request.url.includes('/api/recommendations')) {
    lastRequest = JSON.parse(request.postData);
    if (requestMode === 'hold') { heldRequest = { requestId, sessionId: message.sessionId }; return; }
    if (requestMode === 'unavailable') return fulfill(requestId, message.sessionId, 503, { error: { message: 'AI recommendations are being prepared. Your search results are still available.' } });
    return fulfill(requestId, message.sessionId, 200, { data: { query: lastRequest.query, recommendations: [] } });
  }
  const result = request.url.includes('/summary')
    ? { data: { researchers: 0, publications: 0, departments: [], years: [] } }
    : { data: [], total: 0, page: 1, limit: 6, pages: 0, search: { duplicatesCollapsed: 0 } };
  return fulfill(requestId, message.sessionId, 200, result);
}

const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
await call('Page.enable', {}, sessionId);
await call('Runtime.enable', {}, sessionId);
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
async function screenshot(name) {
  const result = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(root, name), Buffer.from(result.data, 'base64'));
}

try {
  await call('Page.navigate', { url: 'http://127.0.0.1:5174/?demo=1&q=software' }, sessionId);
  await waitFor("document.querySelector('.ai-recommendation-trigger:not(:disabled)')", 'AI button');
  await evaluate("document.querySelector('.ai-recommendation-trigger').click()");
  await waitFor("document.querySelectorAll('.ai-professor-card').length===3", 'three sample profiles');
  await evaluate("document.querySelectorAll('.ai-professor-card')[1].click()");
  await waitFor("document.querySelector('.ai-reason h3')?.textContent==='Jamie Chen'", 'selected professor evidence');
  await evaluate("document.querySelector('.ai-paper summary').click()");
  assert.equal(await evaluate("document.querySelector('.ai-paper').open"), true);
  const fit = await evaluate("(()=>{const r=document.querySelector('.ai-trail').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.top>=0})()");
  assert.ok(fit, 'desktop panel fits');
  await screenshot('paper-trail-desktop.png');
  await evaluate("document.querySelector('.ai-paper-actions button').click()");
  await waitFor("document.querySelector('dialog:modal') && !document.querySelector('.ai-trail')", 'paper details open in existing dialog');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await waitFor("!document.querySelector('dialog:modal')", 'record dialog closes');
  await evaluate("document.querySelector('.ai-recommendation-trigger').click()");
  await waitFor("document.querySelectorAll('.ai-professor-card').length===3", 'panel reopens');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(await evaluate("(()=>{const d=document.querySelector('.ai-trail'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.top>=0&&d.scrollWidth<=d.clientWidth})()"), 'mobile panel fits without horizontal overflow');
  await screenshot('paper-trail-mobile.png');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await waitFor("!document.querySelector('.ai-trail')", 'Escape closes floating panel');
  assert.ok(await evaluate("document.activeElement===document.querySelector('.ai-recommendation-trigger')"), 'focus restored');
  console.log('Sample interaction, paper details, desktop/mobile bounds and keyboard focus passed.');

  await call('Fetch.enable', { patterns: [{ urlPattern: '*://127.0.0.1:5174/api/*' }] }, sessionId);
  await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await call('Page.navigate', { url: 'http://127.0.0.1:5174/?q=brain%20MRI' }, sessionId);
  await waitFor("document.querySelector('.ai-recommendation-trigger:not(:disabled)')", 'live-mode trigger');
  requestMode = 'hold';
  await evaluate("document.querySelector('.ai-recommendation-trigger').click()");
  await waitFor("document.querySelector('.ai-loading')", 'loading state');
  while (!heldRequest) await new Promise(resolve => setTimeout(resolve, 50));
  await fulfill(heldRequest.requestId, heldRequest.sessionId, 503, { error: { message: 'AI recommendations are being prepared.' } });
  heldRequest = null;
  await waitFor("document.querySelector('.ai-feedback[role=alert]')", 'unavailable state');
  assert.equal(lastRequest.query, 'brain MRI');
  await screenshot('paper-trail-unavailable.png');
  requestMode = 'empty';
  await evaluate("document.querySelector('.ai-feedback button').click()");
  await waitFor("document.querySelector('.ai-feedback[role=status]')", 'empty state');
  await evaluate("document.querySelector('#research-search').focus();document.querySelector('#research-search').select()");
  await call('Input.insertText', { text: 'genomics' }, sessionId);
  await evaluate("document.querySelector('form.search-bar').requestSubmit()");
  await waitFor("!document.querySelector('.ai-trail') && location.search.includes('genomics')", 'new query closes stale panel');
  await evaluate("document.querySelector('.ai-recommendation-trigger').click()");
  await waitFor("document.querySelector('.ai-feedback[role=status]')", 'new query request');
  assert.equal(lastRequest.query, 'genomics');
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  console.log('Loading, unavailable, retry, empty state, and stale-query cancellation passed.');
  fs.writeFileSync(path.join(root, 'ui-checks.json'), JSON.stringify({ status: 'passed', checks: ['sample', 'selection', 'papers', 'desktop', 'mobile', 'keyboard', 'loading', 'unavailable', 'retry', 'empty', 'query-change'], runtimeErrors: errors }, null, 2));
} catch (error) {
  console.error('UI check failed:', error);
  await screenshot('paper-trail-failure.png').catch(() => {});
  throw error;
} finally {
  await Promise.race([call('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
  socket.close();
  browser.kill();
}
