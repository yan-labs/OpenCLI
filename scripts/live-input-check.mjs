#!/usr/bin/env node
/** Real user-Chrome input/IME/network/metrics check through OpenCLI only.
 * Run: NODE_USE_ENV_PROXY=1 node scripts/live-input-check.mjs
 * Optional: OPENCLI_LIVE_OUT, OPENCLI_ACCEPT_CLI. Uses an ephemeral loopback fixture,
 * never writes the clipboard; CDP composition is not a physical OS IME candidate UI.
 * Verified: 2026-10-28. All owned leases close in finally.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
const session = `editor-bridge-input-${randomBytes(6).toString('hex')}`;
const out = resolve(process.env.OPENCLI_LIVE_OUT || '/tmp/ee-fix-opencli-bridge');
const summary = { session, checks: {}, failures: [], released: false };
const receipts = [];
const cli = process.env.OPENCLI_ACCEPT_CLI;
async function browser(...args) {
  const argv = ['browser', session, '--window', 'dedicated', ...args];
  try {
    const { stdout } = await exec(cli ? process.execPath : 'opencli', cli ? [cli, ...argv] : argv,
      { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    // Clipboard contents remain in process memory and never enter evidence/logs.
    if (!['clipboard', 'sessions'].includes(args[0])) receipts.push({ command: args[0], stdout });
    return stdout;
  } catch (error) {
    throw new Error(`${args[0]} failed (${error.code || 'unknown'}): ${String(error.stderr || '').slice(0, 1000)}`);
  }
}
const evaluate = async js => JSON.parse(await browser('eval', `(async()=>JSON.stringify(await (${js})))()`));
const cdp = async (method, params = {}) => JSON.parse(await browser('cdp', method, JSON.stringify(params)));
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url.startsWith('/probe')) { res.end('ok'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>OpenCLI input fixture</title><style>input{display:block;margin:20px;width:300px}#source,#target{display:inline-block;margin:20px;width:100px;height:80px;background:#ddd;touch-action:none}</style><input id="editor" aria-label="Editor"><div id="source">Drag from</div><div id="target">Drag to</div><script>
  window.events=[];window.dragged=false;let down=false;
  for(const type of ['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend','pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{events.push({type:e.type,trusted:e.isTrusted,key:e.key,data:e.data,inputType:e.inputType,buttons:e.buttons});if(events.length>200)events.shift()},true);
  source.addEventListener('pointerdown',()=>{down=true});document.addEventListener('pointerup',e=>{if(down&&e.target===target)window.dragged=true;down=false});
  </script>`);
});
let opened = false;
try {
  await mkdir(out, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  opened = true;
  await browser('open', url);
  const state = await browser('state');
  assert(state.includes('OpenCLI input fixture'));
  summary.checks.openState = true;
  const click = JSON.parse(await browser('click', '#editor'));
  assert.equal(click.click_method, 'cdp');
  await browser('type', '#editor', 'bridge');
  await browser('keys', 'ArrowLeft');
  let evidence = await evaluate(`({value:editor.value,events:events.slice()})`);
  assert.equal(evidence.value, 'bridge');
  assert(evidence.events.some(e => e.type === 'keydown' && e.key === 'ArrowLeft' && e.trusted));
  assert(evidence.events.some(e => e.type === 'input' && e.trusted));
  summary.checks.keyboard = evidence;
  await browser('keys', 'End');
  for (const text of ['z', 'zhong', 'zhongwen']) {
    await cdp('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp('Input.insertText', { text: '中文' });
  evidence = await evaluate(`({value:editor.value,events:events.slice()})`);
  // Match the original CDP IME contract; isTrusted is evidence, not an extra IME gate.
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
    assert(evidence.events.some(e => e.type === type), `Missing ${type}`);
  }
  assert.equal(evidence.value, 'bridge中文');
  summary.checks.composition = evidence;
  await evaluate('(()=>{events.length=0;return true})()');
  const drag = JSON.parse(await browser('drag', '#source', '#target'));
  assert(!drag.native_drag_dropped, 'Synthetic drag fallback is not acceptance');
  evidence = await evaluate(`({dragged,events:events.filter(e=>e.type.startsWith('pointer'))})`);
  assert(evidence.dragged);
  assert(evidence.events.some(e=>e.type==='pointerdown'&&e.trusted));
  assert(evidence.events.some(e=>e.type==='pointerup'&&e.trusted));
  assert(evidence.events.every(e=>e.trusted));
  summary.checks.pointerDrag = evidence;
  const clipboard = await browser('clipboard');
  assert.equal(typeof clipboard, 'string');
  summary.checks.clipboardRead = { supported: true }; // Do not persist contents or their length.
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['*/probe-blocked*'] });
  assert.equal(await evaluate(`fetch('/probe-blocked').then(()=>false,()=>true)`), true);
  await cdp('Network.setBlockedURLs', { urls: [] });
  assert.equal(await evaluate(`fetch('/probe-restored').then(r=>r.text())`), 'ok');
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.equal(await evaluate(`fetch('/probe-offline').then(()=>false,()=>true)`), true);
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.equal(await evaluate(`fetch('/probe-online').then(r=>r.text())`), 'ok');
  summary.checks.networkFaults = { blocked: true, offline: true, restored: true };
  await cdp('Performance.enable');
  const metrics = await cdp('Performance.getMetrics');
  const heap = await cdp('Runtime.getHeapUsage');
  assert(metrics.metrics.some(m => m.name === 'TaskDuration' && Number.isFinite(m.value)));
  assert(heap.usedSize > 0);
  await cdp('Performance.disable');
  summary.checks.performance = { metrics, heap };
} catch (error) { summary.failures.push(error.message); }
finally {
  if (opened) {
    try {
      await browser('close');
      const sessions = JSON.parse(await browser('sessions', '-f', 'json'));
      // Do not record other tasks' session metadata.
      summary.released = !sessions.some(s=>s.session===session);
      assert(summary.released, 'Owned session still listed');
    } catch (error) { summary.failures.push(`cleanup: ${error.message}`); }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'input-check.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(out, 'input-receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
}
console.log(JSON.stringify({ session, checks: Object.keys(summary.checks), failures: summary.failures, released: summary.released, out }));
process.exitCode = summary.failures.length ? 1 : 0;
