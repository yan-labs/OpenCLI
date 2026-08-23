#!/usr/bin/env node
/**
 * End-to-end check for where automation puts its tabs.
 *
 * Everything this covers lives in the extension, so unit tests cannot see it:
 * they mock `chrome.*` and will happily agree with a build that misbehaves in a
 * real browser. Four separate window/focus bugs got through that gap, each one
 * found by hand — open some sessions, read the window ids, squint. This script
 * is that loop, written down.
 *
 *   node scripts/e2e-window-modes.mjs
 *
 * Needs a live browser: `opencli doctor` green, and the yan-labs extension
 * loaded. It only opens example.com/.org/.net and closes what it opened.
 *
 * Exit code 0 = all checks passed, 1 = a check failed, 2 = could not run.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RUN = `e2e${Date.now().toString(36).slice(-5)}`;
const checks = [];

async function opencli(args) {
  const { stdout } = await execFileAsync('opencli', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Session name → windowId, straight from the extension's own view. */
async function sessionWindows() {
  const out = await opencli(['browser', 'sessions', '-f', 'json']);
  const start = out.indexOf('[');
  if (start < 0) return new Map();
  const entries = JSON.parse(out.slice(start));
  return new Map(entries.map(e => [e.session, e.windowId]));
}

function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  process.stdout.write(`${passed ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function main() {
  try {
    const doctor = await opencli(['doctor']).catch(err => String(err.stdout ?? err));
    if (!/Extension: connected/.test(doctor)) {
      process.stderr.write('Browser bridge is not connected. Run `opencli doctor` and fix it first.\n');
      process.exit(2);
    }
    if (/older than the yan-labs build/.test(doctor)) {
      process.stderr.write('The loaded extension predates this build — reload it in chrome://extensions first.\n');
      process.exit(2);
    }
  } catch {
    process.stderr.write('Could not run `opencli doctor`. Is opencli installed?\n');
    process.exit(2);
  }

  const sessions = { user: `${RUN}-user`, def: `${RUN}-def`, isoA: `${RUN}-isoA`, isoB: `${RUN}-isoB` };

  try {
    // The person's own window, learned by binding whatever tab they are on.
    // Every other assertion is relative to this, so it has to come first.
    await opencli(['browser', sessions.user, 'bind']);
    const userWindow = (await sessionWindows()).get(sessions.user);
    if (userWindow === undefined || userWindow === null) {
      process.stderr.write('Could not read the window of the active tab. Is a normal page open?\n');
      process.exit(2);
    }
    process.stdout.write(`\nyour window: win${userWindow}\n\n`);

    await opencli(['browser', sessions.def, 'open', 'https://example.net']);
    await opencli(['browser', sessions.isoA, '--window', 'isolated', 'open', 'https://example.com']);
    await opencli(['browser', sessions.isoB, '--window', 'isolated', 'open', 'https://example.org']);

    const win = await sessionWindows();
    const def = win.get(sessions.def);
    const isoA = win.get(sessions.isoA);
    const isoB = win.get(sessions.isoB);

    check('default mode opens in the window you are already using',
      def === userWindow, `def=win${def} you=win${userWindow}`);
    check('isolated stays out of your window',
      isoA !== undefined && isoA !== userWindow, `isoA=win${isoA}`);
    check('two isolated sessions share one dedicated window',
      isoA !== undefined && isoA === isoB, `isoA=win${isoA} isoB=win${isoB}`);
    // The regression that started this: opening a normal session merged the
    // groups, emptied the dedicated window, and Chrome closed it — taking every
    // session inside with it. Survival is the assertion that matters.
    check('every session survives the others',
      [def, isoA, isoB].every(v => v !== undefined),
      `alive=[${[...win.keys()].filter(k => k.startsWith(RUN)).join(', ')}]`);
  } finally {
    for (const name of Object.values(sessions)) {
      await opencli(['browser', name, 'close']).catch(() => {});
      await opencli(['browser', name, 'unbind']).catch(() => {});
    }
  }

  const leftovers = [...(await sessionWindows()).keys()].filter(k => k.startsWith(RUN));
  check('cleans up after itself', leftovers.length === 0, leftovers.join(', ') || 'no sessions left');

  const failed = checks.filter(c => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
