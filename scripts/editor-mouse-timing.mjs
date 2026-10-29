// Diagnostic only: run after the sole browser runner has released all leases.
// Never print CLI output, URLs, session names, mouse parameters, or raw daemon logs.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);
const marker = /^\[opencli-mouse-timing\] (window|target|guard|attach|cdp|identity) (start|end) (\d+\.\d{3})$/;
const orderedStages = ['window', 'target', 'attach', 'cdp', 'identity'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function batchWithInput(cli, session, commands) {
  return new Promise((resolve, reject) => {
    const child = execFile(cli, ['browser', session, '--window', 'dedicated', 'batch', '--stop-on-error'],
      { maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(commands));
  });
}

export function extractTimings(before, after, expected, complete = true) {
  const equal = (a, b) => a.ts === b.ts && a.msg === b.msg && a.level === b.level;
  let overlap = Math.min(before.length, after.length);
  while (overlap && !before.slice(-overlap).every((entry, index) => equal(entry, after[index]))) overlap--;
  if (before.length && !overlap) return null; // ring rotated: correlation is unknowable
  const events = after.slice(overlap).flatMap(entry => {
    const match = typeof entry.msg === 'string' && marker.exec(entry.msg);
    return match ? [{ stage: match[1], state: match[2], elapsedMs: Number(match[3]) }] : [];
  });
  const groups = [];
  for (const event of events) {
    if (event.stage === 'window' && event.state === 'start') groups.push([]);
    if (!groups.length) return null;
    groups.at(-1).push(event);
  }
  if (groups.length > expected || (complete && groups.length !== expected)) return null;
  if (groups.length > 1 && !complete) return null;
  for (const group of groups) {
    const actual = group.filter(event => event.stage !== 'guard');
    const wanted = orderedStages.flatMap(stage => [`${stage}:start`, `${stage}:end`]);
    const observed = actual.map(e => `${e.stage}:${e.state}`);
    if (observed.some((value, i) => value !== wanted[i])) return null;
    if (complete && observed.length !== wanted.length) return null;
    if (group.some((e, i) => e.stage === 'guard' && (e.state !== 'end'
      || i <= group.findIndex(item => item.stage === 'target' && item.state === 'start')
      || group.slice(0, i).some(item => item.stage === 'target' && item.state === 'end')))) return null;
  }
  return groups;
}

async function logs() {
  const response = await fetch('http://127.0.0.1:19825/logs', {
    headers: { 'X-OpenCLI': '1' }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('logs-unavailable');
  const body = await response.json();
  if (!Array.isArray(body.logs)) throw new Error('logs-unavailable');
  return body.logs;
}

const step = (type, x, y, button, buttons) => ({
  cmd: 'cdp', args: { method: 'Input.dispatchMouseEvent',
    params: { type, x, y, button, buttons, opencliMouseTiming: true } },
});

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--drag') || process.argv.slice(2).length > 1) throw new Error('usage');
  const drag = process.argv.includes('--drag');
  const session = `mouse-timing-${randomBytes(8).toString('hex')}`;
  const cli = '/Users/kcsx/.nvm/versions/node/v26.12.1/bin/opencli';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>Mouse timing fixture</title><style>html,body{margin:0;width:100%;height:100%}</style>');
  });
  const output = { fixture: 'local-owned', runs: [], released: false };
  let opened = false;
  let unknown = false;
  if (!process.stdin.isTTY) {
    console.error('diagnostic requires a terminal for safe unknown-outcome cleanup');
    process.exitCode = 1;
    return;
  }
  async function browser(...args) {
    return exec(cli, ['browser', session, '--window', 'dedicated', ...args], { maxBuffer: 2 * 1024 * 1024 });
  }
  async function runBatch(commands, count) {
    const before = await logs(); // If unavailable, do not dispatch.
    const started = performance.now();
    let result;
    let latest = null;
    let lastPrinted = '';
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        try {
          const partial = extractTimings(before, await logs(), count, false);
          if (partial?.length) {
            latest = partial;
            const line = JSON.stringify({ state: 'observing', stages: partial });
            if (line !== lastPrinted) { console.log(line); lastPrinted = line; }
          }
        } catch { /* Keep observing. */ }
        await sleep(1000);
      }
    })();
    try {
      const { stdout } = await batchWithInput(cli, session, commands);
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed) || parsed.length !== commands.length || parsed.some(r => r.ok !== true)) throw new Error('batch-not-returned');
      result = { state: 'returned', elapsedMs: +(performance.now() - started).toFixed(3) };
    } catch {
      // The CLI/transport may have delivered input even if its result was lost.
      unknown = true;
      result = { state: 'unknown', elapsedMs: +(performance.now() - started).toFixed(3) };
    }
    watching = false;
    await watcher;
    try { result.stages = extractTimings(before, await logs(), count); }
    catch { result.stages = null; }
    if (!result.stages && latest && result.state === 'unknown') result.partialStages = latest;
    output.runs.push(result);
    return result.state === 'returned' && result.stages !== null;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    // An unsuccessful open can also have an unknown outcome: do not close blindly.
    unknown = true;
    await browser('open', `http://127.0.0.1:${server.address().port}/`);
    opened = true;
    unknown = false;
    const first = await runBatch([step('mouseMoved', 30, 30, 'none', 0)], 1);
    if (drag && first) {
      await runBatch([
        step('mousePressed', 30, 30, 'left', 1),
        step('mouseMoved', 40, 40, 'left', 1),
        step('mouseMoved', 50, 50, 'left', 1),
        { cmd: 'wait', args: { seconds: 0.2 } },
        step('mouseReleased', 50, 50, 'left', 0),
      ], 4);
    }
  } catch { output.error = unknown ? 'unknown-outcome' : 'setup-failed'; }
  finally {
    if (opened && !unknown) {
      try {
        await browser('close');
        const { stdout } = await browser('sessions', '-f', 'json');
        const sessions = JSON.parse(stdout);
        output.released = Array.isArray(sessions) && !sessions.some(item => item.session === session);
      } catch { output.error = 'cleanup-unconfirmed'; }
    }
    output.state = unknown ? 'unknown-stop-no-retry' : output.error ? 'failed' : 'finished';
    console.log(JSON.stringify(output));
    if (unknown) {
      // Retain this owned target until the runner verifies pending=0 and explicitly
      // authorizes closing this same session; no input is ever resent.
      console.error('unknown-stop: verify pending=0, then enter close to release this owned fixture');
      const input = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise(resolve => {
        input.once('close', () => resolve(''));
        input.question('> ', resolve);
      });
      input.close();
      if (answer === 'close') {
        try {
          await browser('close');
          const { stdout } = await browser('sessions', '-f', 'json');
          const sessions = JSON.parse(stdout);
          output.released = Array.isArray(sessions) && !sessions.some(item => item.session === session);
        } catch { /* Report only the fixed cleanup status. */ }
        console.log(JSON.stringify({ state: 'unknown-cleanup', released: output.released }));
      }
      if (!output.released) console.error('cleanup-unconfirmed: owned fixture retained');
      else {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      process.exitCode = 1;
    } else {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (output.error || !output.released || output.runs.some(r => r.state !== 'returned' || r.stages === null)) process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('diagnostic-failed'); process.exitCode = 1; });
}
