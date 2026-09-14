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
 * loaded. It opens example.com (twice — once `--window isolated`, once with no
 * `--window` flag at all to exercise the current `dedicated` default),
 * example.net (`--window background`, the mode that used to be the default),
 * example.org, plus one `brave search` (public, no login, `--window
 * background`); it closes what it opened, and the adapter tab releases itself
 * on idle.
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

/** Every session lease, straight from the extension's own view. */
async function sessionEntries() {
  const out = await opencli(['browser', 'sessions', '-f', 'json']);
  const start = out.indexOf('[');
  if (start < 0) return [];
  return JSON.parse(out.slice(start));
}

/** Session name → windowId. */
async function sessionWindows() {
  return new Map((await sessionEntries()).map(e => [e.session, e.windowId]));
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

  const sessions = { user: `${RUN}-user`, def: `${RUN}-def`, isoA: `${RUN}-isoA`, isoB: `${RUN}-isoB`, ded: `${RUN}-ded` };

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

    // `background` used to be the implicit default; it is now an explicit,
    // opt-in mode, so ask for it by name to keep testing exactly what these
    // checks were written to test (borrowing the window you're already in).
    await opencli(['browser', sessions.def, '--window', 'background', 'open', 'https://example.net']);
    await opencli(['browser', sessions.isoA, '--window', 'isolated', 'open', 'https://example.com']);
    await opencli(['browser', sessions.isoB, '--window', 'isolated', 'open', 'https://example.org']);

    const win = await sessionWindows();
    const def = win.get(sessions.def);
    const isoA = win.get(sessions.isoA);
    const isoB = win.get(sessions.isoB);

    check('background mode opens in the window you are already using',
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

    // One group per session, named after it — never the pooled group of before.
    const entries = await sessionEntries();
    const groupOf = name => entries.find(e => e.session === name)?.groupTitle;
    check('each browser session sits in its own group named after it',
      groupOf(sessions.def) === `OpenCLI: ${sessions.def}` && groupOf(sessions.isoA) === `OpenCLI: ${sessions.isoA}`,
      `def="${groupOf(sessions.def)}" isoA="${groupOf(sessions.isoA)}"`);
    check('background mode did not have to open a window of its own',
      entries.find(e => e.session === sessions.def)?.windowFallbackReason == null,
      `reason=${entries.find(e => e.session === sessions.def)?.windowFallbackReason ?? 'none'}`);

    // The new default: no `--window` flag at all now means `dedicated`, which
    // promises a window of its own (never the one you're using), that never
    // takes real OS focus, that leaves your own window's standing untouched —
    // and, unlike a plain hidden background tab, still renders `visible`.
    await opencli(['browser', sessions.ded, 'open', 'https://example.com']);
    const dedWindow = (await sessionWindows()).get(sessions.ded);
    check('dedicated (the new default, no --window flag) opens outside your window',
      dedWindow !== undefined && dedWindow !== userWindow, `ded=win${dedWindow} you=win${userWindow}`);

    const dedVisibility = (await opencli(['browser', sessions.ded, 'eval', 'document.visibilityState'])).trim();
    check('dedicated tab reports visibilityState visible',
      dedVisibility === 'visible', `visibilityState=${dedVisibility}`);

    const dedHasFocus = (await opencli(['browser', sessions.ded, 'eval', 'document.hasFocus()'])).trim();
    check('dedicated window does not take real OS focus',
      dedHasFocus === 'false', `document.hasFocus()=${dedHasFocus}`);

    const userWindowAfterDedicated = (await sessionWindows()).get(sessions.user);
    check('opening a dedicated window leaves your focused window unchanged',
      userWindowAfterDedicated === userWindow, `before=win${userWindow} after=win${userWindowAfterDedicated}`);

    // Adapter surface: the same rule. `opencli <site> …` used to spawn a window of
    // its own by design; `--window background` makes it borrow yours and group
    // under the site name, the same explicit-override reasoning as `def` above —
    // the adapter surface now defaults to `dedicated` too.
    // `--keep-tab true` keeps the one-shot lease alive long enough to read it back
    // (the 30s adapter idle timeout releases it on its own afterwards).
    await opencli(['brave', 'search', 'example', '--limit', '1', '--keep-tab', 'true', '--window', 'background']).catch(() => {});
    const adapter = (await sessionEntries()).find(e => e.surface === 'adapter' && String(e.session).startsWith('site:brave'));
    check('adapter command (--window background) opens in the window you are already using',
      adapter !== undefined && adapter.windowId === userWindow,
      adapter ? `adapter=win${adapter.windowId} you=win${userWindow}` : 'no adapter lease found (did `opencli brave search` run?)');
    check('adapter tabs are grouped under the site name',
      adapter?.groupTitle === 'OpenCLI: brave',
      `group="${adapter?.groupTitle}"`);
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
