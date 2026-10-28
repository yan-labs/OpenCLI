# Browser input and acceptance through the extension

Use a unique session in the user's logged-in Chrome. All commands below use the
existing daemon and extension; no remote-debugging port or second browser is needed.

```sh
opencli browser editor-check-unique --window dedicated open http://127.0.0.1:PORT/
opencli browser editor-check-unique state
opencli browser editor-check-unique click '#editor'
opencli browser editor-check-unique type '#editor' 'hello'
opencli browser editor-check-unique keys ArrowLeft
opencli browser editor-check-unique cdp Input.imeSetComposition '{"text":"中","selectionStart":1,"selectionEnd":1}'
opencli browser editor-check-unique cdp Input.insertText '{"text":"中文"}'
opencli browser editor-check-unique drag '#source' '#target'
opencli browser editor-check-unique cdp Performance.enable
opencli browser editor-check-unique cdp Performance.getMetrics
opencli browser editor-check-unique cdp Runtime.getHeapUsage
opencli browser editor-check-unique cdp Performance.disable
opencli browser editor-check-unique close
```

`cdp <method> [params]` accepts a JSON object (default `{}`). It shares the session,
write arbitration, error handling and extension allowlist of the existing page
bridge. Unsupported methods fail rather than using a synthetic event fallback.
New extension allowlist entries require loading the matching extension build.

- Keyboard: `keys` uses `Input.dispatchKeyEvent`; `type` inserts Unicode through
  `Input.insertText`. Text insertion is not a sequence of physical key presses.
- Composition: `Input.imeSetComposition` followed by `Input.insertText` exercises
  Chromium's composition path, matching `imeWord` in the editor's original
  `integration/apps/web-pc/e2e/user-cases/perf.ts:610–651`: successive composition
  updates followed by a text commit. That contract has no `compositionend.isTrusted`
  gate. The fixture checks start/update/end and exact committed text, and records
  every observed event's `isTrusted` value without making it an extra IME gate.
  In the checked Chrome, start/update are trusted and end is untrusted.
  This does not operate or test a physical OS IME candidate window.
  The fixture only checks bridge capabilities; editor acceptance must still run
  the original `caretBehind`, `lostComposition`, `rollbacks` and three-way
  consistency assertions unchanged. Passing this fixture does not pass those gates.
- Pointer: `click` and `drag` try trusted CDP input. A strict check must reject
  `click_method` other than `cdp`, `native_drag_dropped:true`, and untrusted events.
- Clipboard: `clipboard` reads plain text. This check does not write the shared
  clipboard or exercise paste; never persist user clipboard contents as evidence.
- Network faults: `Network.enable`, `Network.setBlockedURLs` (`urls` array), and
  `Network.emulateNetworkConditions` (`offline`, `latency`, `downloadThroughput`,
  `uploadThroughput`) affect only the leased target. Clear blocked URLs and restore
  online settings in `finally`, or close the owned tab. Arbitrary response bodies,
  request reordering and Fetch interception are not exposed by this change.
- Performance: `Performance.enable/getMetrics/disable` and `Runtime.getHeapUsage`
  provide target-level counters and heap samples. They do not reproduce a separate
  machine's performance baseline, DevTools tracing, or a forced-GC benchmark.

Run the loopback fixture check (opens and closes its own dedicated session):

```sh
NODE_USE_ENV_PROXY=1 node scripts/live-input-check.mjs
```

`OPENCLI_LIVE_OUT` selects the evidence directory; `OPENCLI_ACCEPT_CLI` selects a
built CLI entry file. The script asserts trusted keyboard and pointer input, the
CDP composition lifecycle and committed text, clipboard readability,
blocked/offline/restored fetches, metrics and final lease release. It does not visit business pages. Output contains no clipboard
contents or metadata belonging to other sessions.
