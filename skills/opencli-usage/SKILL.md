---
name: opencli-usage
description: Use at the start of any OpenCLI session — this is the top-level map of what `opencli` can do, how to discover adapters, what flags and output formats are universal, and which specialized skill to load next. Point here when an agent asks "what can opencli do?" or "how do I find the right command?".
allowed-tools: Bash(opencli:*), Read
---

# opencli-usage

OpenCLI turns websites and Electron desktop apps into a uniform `opencli <site> <command>` surface that agents can drive without screen-scraping. This skill is the orientation layer — once you know what you want to do, load one of the specialized skills below.

## Main capabilities

- **Adapter commands** — `opencli <site> <command> [...]`. Built-in adapters live in `clis/`, user adapters in `~/.opencli/clis/`. Each is backed by a strategy (`PUBLIC | COOKIE | INTERCEPT | UI | LOCAL`) that tells you whether a Chrome session is needed.
- **Browser driving** — `opencli browser <session> <command>` for ad-hoc interaction when no adapter covers the task. Full subcommand list: `analyze`, `back`, `batch`, `bind`, `check`, `click`, `close`, `console`, `dblclick`, `dialog`, `drag`, `eval`, `extract`, `fill`, `find`, `focus`, `frames`, `get`, `hover`, `init`, `keys`, `network`, `open`, `screenshot`, `scroll`, `select`, `state`, `tab`, `type`, `unbind`, `uncheck`, `upload`, `verify`, `wait`. See `opencli-browser`.
- **Current-tab binding** — `opencli browser <session> bind` attaches the Chrome tab the user already opened/logged into to that browser session. Follow-up commands use `opencli browser <session> ...`. See `opencli-browser` before using it; bound sessions still block tab mutation.

## Install

```bash
# npm global
npm install -g @jackwener/opencli          # binary: opencli, requires Node >= 20.18.1
opencli doctor                              # run before browser-dependent work (see below)

# From source
git clone git@github.com:jackwener/OpenCLI.git
cd OpenCLI && npm install
npx tsx src/main.ts <command>               # same surface, no global install
```

`opencli doctor` prints a structured `DoctorReport` — daemon status, extension connection, version checks, and a live browser connectivity probe. Scope is narrow: it diagnoses the **browser bridge** (daemon + extension + Chrome wiring). `PUBLIC` / `LOCAL` adapters, `opencli list`, `validate`, `verify`, and plugin commands don't need it to be green — only `COOKIE` / `INTERCEPT` / `UI` adapters and the `opencli browser *` subcommands do. Flag: `-v` (verbose).

## Prerequisites by command type

| Strategy tag on `opencli list` | What it needs |
|--------------------------------|---------------|
| `PUBLIC` | Nothing — pure HTTP, no browser. |
| `COOKIE` | Chrome logged into the target site + **OpenCLI** extension installed from the [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk). Command captures the credential from your live session — no re-login. |
| `INTERCEPT` | Same as COOKIE, plus opencli opens an automation window to capture a signed request. |
| `UI` | Same as COOKIE, full DOM interaction. |
| `LOCAL` | No browser; talks to a local/dev endpoint. |

Electron desktop apps (antigravity, chatgpt-app, chatwise, codex, cursor, discord-app, doubao-app, qoder, trae-cn, trae-solo) route through CDP against the running app — same cookie-less flow as a logged-in browser. Make sure the app is running before invoking.

## Discover what's installed — don't read this file, run a command

```bash
opencli list                    # table, grouped by site
opencli list -f json            # machine-readable; pipe to jq or your agent
opencli list | grep -i twitter  # find commands for a specific site
opencli <site> --help           # see that site's commands + flags
opencli <site> <command> --help # see positional args and command-specific flags
```

Do not hard-code adapter lists — there are 160+ sites (plus 10 app adapters and 13 external CLIs) and the count moves every week. `opencli list -f json` is the source of truth; it emits one entry per command with `{site, name, aliases, description, strategy, browser, args, columns, ...}`. For an agent, that is always better than grepping a doc.

Before falling back to raw `opencli browser` commands on high-change authenticated sites, check whether a site adapter already exposes the workflow. For example, ChatGPT web has higher-level commands for conversation reads and Deep Research result extraction; discover the current surface with `opencli chatgpt --help` or `opencli list -f json`.

## Universal flags (work on every adapter command)

| flag | effect |
|------|--------|
| `-f, --format <fmt>` | `table` (default in TTY) · `yaml` (default in non-TTY) · `json` · `plain` · `md` · `csv`. Pass explicitly when you want a specific shape; agents almost always want `-f json`. |
| `--trace <mode>` | `off` (default) · `on` · `retain-on-failure`. Captures browser state for debugging; `retain-on-failure` keeps the trace only when the command errors (used by `opencli-autofix`). |
| `-v, --verbose` | Debug logs + stack traces on failure; also sets `OPENCLI_VERBOSE=1` for the process. |

### Browser common flags (adapter commands with `browser: true`)

These appear on any adapter that talks to Chrome, plus all `opencli browser` subcommands:

| flag | effect |
|------|--------|
| `--window <mode>` | `dedicated` (default), `background`, `active`, `foreground`, or `isolated`. **`dedicated` needs no flag for most agent work** — it opens the session in a pooled, off-screen OpenCLI-owned automation window, created unfocused and never raised, that still renders `visible` (auto-select makes the tab that window's active tab before each command). `background` instead borrows whichever window you are currently using and drops the tab into a labelled group there, following you if you switch windows — it never raises or selects, so `visibilityState` stays `hidden`; reach for it only when you deliberately want the tab inside the user's own window. `active` makes the tab the active tab of its own window without raising that window (`visibilityState` is `visible` only while the window isn't fully covered by another app). `foreground` raises the window to the OS foreground — interrupts the user; required for the confirmed sites that only render for a truly frontmost window (PageSpeed Insights, Google Trends chart rendering, AITDK's cross-origin iframe panel), otherwise reserve it for when they need to watch. `isolated` is `background` in its own separate window. None of these are headless: `navigator.webdriver` is `false` and plugins are present regardless of mode. Override globally with `OPENCLI_WINDOW=<mode>`. See "Window modes: dedicated by default" below. |
| `--site-session <mode>` | `ephemeral` (default) or `persistent`. Persistent keeps the browser session tab alive after the command finishes; ephemeral releases it. |
| `--keep-tab <bool>` | `true` or `false`. Keep the browser tab lease after the command finishes. |

Command-specific flags (`--limit`, `--tab`, `--filter`, …) are not universal — consult `<site> <command> --help`.

## Output formats

- `json` — pretty-printed, 2-space indent. Default choice for agents.
- `plain` — prints a single primary field for chat-style commands (`response`/`content`/`text`/`value`). Useful for piping to another tool.
- `yaml` — fallback when output is not a TTY and `-f` is not explicit.
- `table` — color-coded, site-grouped; meant for humans.
- `md`, `csv` — straightforward tabular dumps.

A few commands override the default via `cmd.defaultFormat` (e.g. chat commands default to `plain`), so don't assume without reading `--help`.

## Window modes: dedicated by default

Both `opencli browser <session> <cmd>` and every site-adapter command default to `dedicated` mode — no flag needed. `dedicated` opens the session in a pooled, off-screen OpenCLI-owned automation window that is created unfocused and never raised, so plain calls never disturb the window you're using or steal your desktop focus:

```bash
opencli browser work open "https://..."     # dedicated by default
opencli google search "test"                # same for adapter commands
```

`dedicated` is **not** headless — it uses the real logged-in Chrome with all cookies and plugins, and `navigator.webdriver` is `false`. Auto-select (on by default) makes the session's tab that window's active tab before every page-scoped command, so `visibilityState` reads `visible` on a window that never reaches the OS foreground.

Reach for the other modes only when you deliberately want something different:

- **`background`** — borrows whichever window you are currently using and drops the session's tab into a labelled tab group there, following you if you switch windows. It never raises anything and never selects the tab, so `visibilityState` stays `hidden` — use it only when you want the tab to live inside the user's own window instead of a separate one.
- **`active`** — selects the tab within its own window without raising that window. `visibilityState` is `visible` only while the window isn't fully covered by another app; once something else fully occludes it, Chrome marks even the active tab `hidden` after a few seconds (a non-active tab is always `hidden`), which can stall lazy-loaded content or a `requestAnimationFrame` loop that depends on staying visible. `dedicated`'s own tiling (see below) avoids this by construction.
- **`foreground`** — raises the window to real OS focus. Interrupts the user — use it when they explicitly want to watch, or for the confirmed handful of sites that only render for a truly frontmost window: **PageSpeed Insights** (pagespeed.web.dev), **Google Trends** chart rendering, and **AITDK**'s cross-origin iframe panel. Callers driving those sites must keep passing `--window foreground` explicitly; that's expected, not a bug.
- **`isolated`** — `background` in its own separate window (one shared window for every isolated session, unlike `dedicated`'s per-lease pool).

```bash
opencli browser work --window background open "https://..."                    # borrow the user's window instead
opencli browser work --window foreground open "https://pagespeed.web.dev/..."  # sites that need real OS focus
```

The `--window` flag sits **between the session name and the subcommand** for `opencli browser`:
```bash
opencli browser <session> --window background <command>   # correct
opencli browser <session> <command> --window background   # also works
```

### Dedicated windows: pool, layout, and capacity

`dedicated` windows are pooled, not one-per-session: anonymous `pool-1`, `pool-2`, … windows are borrowed for the duration of a command's lease and returned to the pool when it ends, so ten one-shot commands in a row reuse one window instead of piling up ten. Pass `--window-slot <name>` to pin a named window instead of drawing from the pool, for a caller that wants a stable, addressable window across calls.

Window size is dynamic and non-overlapping: tiles are computed from the automation display's work area and however many automation windows are live right now — one window gets 1280×900, more windows get progressively smaller tiles down to a 900×620 floor, never a fixed grid that wraps around and stacks windows on top of each other. This matters because Chrome reports a fully covered window as `hidden` regardless of its actual tab state, which used to corrupt scrapes silently.

Capacity is finite and honest: when the automation display cannot fit another window without overlapping one already there, the command fails closed with an error starting `dedicated-pool-exhausted:` telling you to wait for a task to finish or free a slot — it will never stack an unseeable window while claiming success.

Idle windows are reaped automatically: an automation window with no live lease is closed by the extension after an idle TTL (default 15 minutes), overridable via `OPENCLI_DEDICATED_IDLE_MS` (milliseconds, sent with each `dedicated` command). No manual cleanup is needed.

With no `--window-display` / `OPENCLI_WINDOW_DISPLAY` / `--window-bounds`, the extension auto-picks the automation display: a secondary display when one exists (preferring a non-internal one — an external or virtual screen — over the built-in panel), else the only display. Automation windows are always created unfocused and never raised.

Inspect and manage the pool directly:

```bash
opencli browser <session> window list                          # every automation window: busy/idle, tile, pool capacity/live/idle/free, idle TTL
opencli browser <session> window close                         # close every automation window not held by a live lease
opencli browser <session> window close --slot pool-2           # close one window by slot
opencli browser <session> window close --slot pool-2 --force   # close it even if a live lease still holds it
opencli browser <session> window status                        # per-slot status
opencli browser <session> window ensure --slot mine --display "<pattern>"  # create/move a pinned slot
```

## Environment variables

| variable | default | purpose |
|----------|---------|---------|
| `OPENCLI_BROWSER_CONNECT_TIMEOUT` | `45` | Seconds to wait for the browser bridge. |
| `OPENCLI_BROWSER_COMMAND_TIMEOUT` | `60` | Per-command timeout. |
| `OPENCLI_CDP_ENDPOINT` | — | Manual CDP endpoint override (dev / remote Chrome / Electron). |
| `OPENCLI_CACHE_DIR` | `~/.opencli/cache` | Network capture + browser-state cache. |
| `OPENCLI_WINDOW` | `dedicated` | `foreground`, `active`, `background`, `isolated`, or `dedicated` browser window mode. |
| `OPENCLI_WINDOW_SLOT` | — (drawn from the pool) | Pin a named `dedicated`-mode window instead of borrowing one from the pool; use a different slot per session that needs a stable, concurrently-visible window. |
| `OPENCLI_WINDOW_BOUNDS` | — | `x,y,w,h` integers; explicit placement for the dedicated window. |
| `OPENCLI_WINDOW_DISPLAY` | — (auto-picked) | Display-name pattern (`/re/flags` or substring); tiles the dedicated window onto the matching display. Unset, the extension prefers a secondary, non-internal display. |
| `OPENCLI_WINDOW_AUTOSELECT` | `on` | `1/0/true/false/on/off`; `dedicated` mode only — whether the session's tab is made the window's active tab before every page-scoped command. |
| `OPENCLI_DEDICATED_FOREIGN_TABS` | `evict` | `evict` or `tolerate`; how a dedicated window handles a tab that wasn't opened by OpenCLI. |
| `OPENCLI_DEDICATED_IDLE_MS` | `900000` (15 min) | Milliseconds of no live lease before the extension closes an idle `dedicated` window. Sent with each `dedicated` command. |
| `OPENCLI_VERBOSE` | `false` | Verbose logging (also triggered by `-v`). |

## Browser batch — multiple operations in one call

`opencli browser <session> batch` sends an array of browser subcommands and returns a JSON results array, avoiding one round-trip per step:

```bash
opencli browser work batch --commands '[
  {"cmd": "open", "args": ["https://example.com"]},
  {"cmd": "wait", "args": ["selector", ".loaded"]},
  {"cmd": "click", "args": ["3"]},
  {"cmd": "state", "args": []}
]'
```

| flag | effect |
|------|--------|
| `--commands <json>` | JSON array of `{cmd, args}` objects. Each `cmd` is a browser subcommand name; `args` is an array of positional arguments. |
| `--stop-on-error` | Stop on first error instead of continuing (default: `false`). |
| `--tab <targetId>` | Target a specific tab returned by `open`, `tab new`, or `tab list`. |

## Management commands

Top-level commands for managing the OpenCLI installation itself:

```bash
# Adapter overrides — eject an official adapter for local editing
opencli adapter status                    # show which sites have local overrides
opencli adapter eject <site>              # copy official adapter to ~/.opencli/clis/
opencli adapter reset [site]              # remove local override, restore official

# Chrome profile management (Browser Bridge)
opencli profile list                      # list connected Chrome profiles
opencli profile rename <contextId> <alias>  # assign a local alias
opencli profile use <profile>             # set default profile for future commands

# Daemon management
opencli daemon status                     # show daemon status
opencli daemon stop                       # stop the daemon
opencli daemon restart                    # restart the daemon

# Auth status — check and refresh site login sessions
opencli auth status                       # show login status for sites with auth adapters
opencli auth refresh                      # touch logged-in sessions to keep auth fresh

# Bundled skills
opencli skills list                       # list bundled opencli-* skills
opencli skills read <skill> [path]        # print a skill's SKILL.md or reference

# Convention audit
opencli convention-audit [target]         # scan adapters for agent-native convention violations
opencli convention-audit --site <site>    # limit to one site
opencli convention-audit --strict         # exit non-zero on violations
```

## Self-repair

When an adapter command fails because the site changed (selectors drifted, API rotated, response schema shifted), re-run with `--trace retain-on-failure`. The error envelope includes a `trace` block pointing at `summary.md`; patch only the `adapterSourcePath` from that summary and retry. Max 3 repair rounds. The full flow is in `opencli-autofix`.

## Writing your own adapter

Two-path storage:

- **Private**: `~/.opencli/clis/<site>/<command>.js` — no build step, hot-available, not visible in the public package.
- **Public / PR**: `clis/<site>/<command>.js` — for upstream contribution; requires build.

Scaffolding & verification:

```bash
opencli browser init <site>/<command>   # generates a skeleton
opencli validate [target]               # semantic checks on the loaded registry (description, domain, pipeline step names, func|pipeline|_lazy presence, arg duplicates) — no network, no browser
opencli verify [target] [--smoke]       # run the command with synthetic args
opencli browser verify <site>/<command> # end-to-end smoke inside the bridge
```

Adapters import only `@jackwener/opencli/registry` and `@jackwener/opencli/errors`. `columns` must align 1:1 (in name and order) with keys of the object returned by `func`. For the full workflow see `opencli-adapter-author`.

## Plugins

Plugins are third-party extensions pulled from git, separate from the main adapter registry:

```bash
opencli plugin install github:user/repo    # install
opencli plugin list [-f json]              # see installed
opencli plugin update [name] | --all       # keep current
opencli plugin uninstall <name>
opencli plugin create <name>               # scaffold a new plugin
```

## Shell completion

```bash
opencli completion bash   # also: zsh, fish
# -> script on stdout; source or save per your shell's convention
```

## Where to go next

| If you're about to… | Load this skill |
|---------------------|-----------------|
| Drive a live browser ad-hoc (no adapter available, or prototyping) | `opencli-browser` |
| Write a new adapter, or add a command to an existing site | `opencli-adapter-author` |
| Fix a broken adapter after a command failure | `opencli-autofix` |
| Route a search / lookup / research request to the right adapter | `smart-search` |

## Commands that used to exist

The following were removed in the PR #1094 consolidation — don't try to invoke them:

- `opencli explore <url>` — superseded by `opencli browser network` + `opencli browser find` for live API discovery, and by the `opencli-adapter-author` workflow for capture.
- `opencli record <url>` — removed; manual capture now lives in `opencli browser network --detail`.
- `opencli web read` / `opencli desktop *` as top-level groups — folded into their respective adapters (`opencli web read` still exists as the `web` adapter's `read` command, but there is no standalone `web` / `desktop` top-level group command).

## Don't

- Don't paste this skill's command list into your plan; it will rot. Call `opencli list -f json` at the start of a task instead.
- Don't assume every adapter needs a browser — strategy `PUBLIC` and `LOCAL` don't. Check the `strategy` field.
- Don't silently fall back from a failing adapter to a hand-rolled `fetch` — `--trace retain-on-failure` gives you the browser evidence and adapter source path. Do that first.
