#!/usr/bin/env node
/** 安装窗口验收；仅本机新端口静态页，无登录依赖。2026-10-10。
 * OPENCLI_ACCEPT_CLI=/path/dist/src/main.js node live-check.mjs
 * 不在源码检查轮运行：会通过 OpenCLI 操作真实 Chrome。产物默认 /tmp/opencli-live-check。
 * 每次唯一会话；finally 只 close 自己的会话，关闭自己的 HTTP server。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const exec = promisify(execFile);
const session = `live-console-viewport-${randomBytes(6).toString('hex')}`;
const cli = process.env.OPENCLI_ACCEPT_CLI;
const out = resolve(process.env.OPENCLI_LIVE_OUT || '/tmp/opencli-live-check');
const summary = { passed: 0, artifacts: [], session, failures: [] };
let attempted = false;
async function browser(...args) {
  attempted = true;
  const argv = ['browser', session, '--window', 'dedicated', ...args];
  const { stdout } = await exec(cli ? process.execPath : 'opencli', cli ? [cli, ...argv] : argv,
    { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  return stdout;
}
async function evaluate(js) { return JSON.parse(await browser('eval', js)); }
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}.overflow{width:2000px;height:20px;background:red}</style><div class="overflow"></div><button id="click" onclick="this.dataset.clicked='yes'">Click</button><script>console.error('opencli-fixture-console');setTimeout(()=>{throw new Error('opencli-fixture-pageerror')},0)</script>`);
});
try {
  await mkdir(out, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  await browser('open', 'about:blank');
  const baseline = await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
  let restored;
  for (const width of [1440, 390]) {
    const set = JSON.parse(await browser('viewport', 'set', String(width), '900'));
    assert.equal(set.supported, true, 'New extension must acknowledge viewport support');
    const before = Date.now();
    await browser('open', `${url}?width=${width}`);
    const navigationReturnedAt = Date.now();
    await evaluate(`(async()=>{for(let i=0;i<100;i++){if(document.readyState==='complete'&&document.querySelector('#click')){await new Promise(r=>setTimeout(r,100));return {ready:true}}await new Promise(r=>setTimeout(r,50))}throw Error('fixture timed out')})()`);
    const measurements = await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth})');
    assert.equal(measurements.width, width);
    assert.equal(measurements.height, 900);
    assert.equal(measurements.dpr, 1);
    assert(measurements.scrollWidth > width, 'Fixture must expose horizontal overflow');
    await browser('click', '#click');
    assert.deepEqual(await evaluate("({clicked:document.querySelector('#click').dataset.clicked,width:innerWidth})"), { clicked: 'yes', width });
    const capture = JSON.parse(await browser('console', '--level', 'error'));
    assert.equal(capture.captureSupported, true);
    assert(new Date(capture.startedAt).getTime() <= navigationReturnedAt, 'Capture must be active by navigation completion');
    const errors = capture.messages.filter(message => new Date(message.timestamp).getTime() >= before);
    assert(errors.some(message => message.text.includes('opencli-fixture-console')), 'Missing console.error');
    assert(errors.some(message => message.text.includes('opencli-fixture-pageerror')), 'Missing uncaught exception');
    const shot = join(out, `${width}.png`);
    await browser('screenshot', shot);
    const png = await readFile(shot);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), 900);
    assert.deepEqual(await evaluate('({width:innerWidth,height:innerHeight})'), { width, height: 900 });
    // A one-shot screenshot size must restore the session override too.
    await browser('screenshot', join(out, `${width}-temporary.png`), '--width', '600', '--height', '700');
    assert.deepEqual(await evaluate('({width:innerWidth,height:innerHeight})'), { width, height: 900 });
    const reset = JSON.parse(await browser('viewport', 'reset'));
    assert.equal(reset.supported, true);
    assert.equal(reset.viewport, null);
    const natural = await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    assert.deepEqual(natural, baseline, 'Reset must remove emulation and restore the original viewport');
    if (restored) assert.deepEqual(natural, restored, 'Reset must return to the same natural viewport');
    restored = natural;
    const artifact = join(out, `${width}.json`);
    await writeFile(artifact, JSON.stringify({ measurements, capture, restored }, null, 2) + '\n');
    summary.artifacts.push(shot, artifact, join(out, `${width}-temporary.png`));
    summary.passed++;
  }
  await browser('viewport', 'set', '390', '900');
  await browser('close');
  await browser('open', url);
  assert.deepEqual(await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'), restored,
    'Close must discard the session override');
  summary.passed++;
} catch (error) { summary.failures.push(error.message); }
finally {
  if (attempted) {
    try { await browser('close'); } catch (error) { summary.failures.push(`close: ${error.message}`); }
  }
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(summary));
process.exitCode = summary.failures.length ? 1 : 0;
