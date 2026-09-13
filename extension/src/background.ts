/**
 * OpenCLI — Service Worker (background script).
 *
 * Connects to the opencli daemon via WebSocket, receives commands,
 * dispatches them to Chrome APIs (debugger/tabs/cookies), returns results.
 */

declare const __OPENCLI_COMPAT_RANGE__: string;

import type { Command, Result } from './protocol';
import { DAEMON_HOST, DAEMON_PORT, DAEMON_WS_URL, DAEMON_PING_URL } from './protocol';
import * as executor from './cdp';
import * as identity from './identity';
import { executeWithJournal } from './journal';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const CONTEXT_ID_KEY = 'opencli_context_id_v1';
let currentContextId = 'default';
let contextIdPromise: Promise<string> | null = null;
let connectInFlight: Promise<void> | null = null;
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
// Startup readiness gate. A MV3 service worker can be woken by an event
// (alarm, window/tab removal) before initialize()'s recovery chain has
// rehydrated in-memory lease/container state from storage. Event handlers that
// persist state must `await workerReady` first, or an empty snapshot overwrites
// the persisted registry (wiping self-heal pointers and lease records).
// initialize() replaces this with the real recovery promise; it always
// resolves (never rejects) so gated handlers can never wedge permanently.
let workerReady: Promise<void> = Promise.resolve();
// Synchronous mirror of workerReady's settled state. Lets connect() skip the
// `await workerReady` microtask hop once recovery is done, so the steady-state
// (post-recovery) connect path is byte-for-byte the original — only the
// pre-recovery wake is gated.
let workerRecovered = true;

async function getCurrentContextId(): Promise<string> {
  if (contextIdPromise) return contextIdPromise;
  contextIdPromise = (async () => {
    try {
      const local = chrome.storage?.local;
      if (!local) return currentContextId;
      const raw = await local.get(CONTEXT_ID_KEY) as Record<string, unknown>;
      const existing = raw[CONTEXT_ID_KEY];
      if (typeof existing === 'string' && existing.trim()) {
        currentContextId = existing.trim();
        return currentContextId;
      }
      const generated = generateContextId();
      await local.set({ [CONTEXT_ID_KEY]: generated });
      currentContextId = generated;
      return currentContextId;
    } catch {
      return currentContextId;
    }
  })();
  return contextIdPromise;
}

function generateContextId(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length;
  let id = '';
  while (id.length < 8) {
    const bytes = new Uint8Array(8);
    try {
      crypto.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (const byte of bytes) {
      if (byte >= maxUnbiasedByte) continue;
      id += alphabet[byte % alphabet.length];
      if (id.length === 8) break;
    }
  }
  return id;
}

// ─── Console log forwarding ──────────────────────────────────────────
// Hook console.log/warn/error to forward logs to daemon via WebSocket.

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    safeSend(ws, { type: 'log', level, msg, ts: Date.now() });
  } catch { /* don't recurse */ }
}

function safeSend(socket: WebSocket | null | undefined, payload: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

console.log = (...args: unknown[]) => { _origLog(...args); forwardLog('info', args); };
console.warn = (...args: unknown[]) => { _origWarn(...args); forwardLog('warn', args); };
console.error = (...args: unknown[]) => { _origError(...args); forwardLog('error', args); };

// ─── WebSocket connection ────────────────────────────────────────────

function isDaemonSocketActive(socket: WebSocket | null | undefined = ws): boolean {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;
}

/**
 * Probe the daemon via its /ping HTTP endpoint before attempting a WebSocket
 * connection.  fetch() failures are silently catchable; new WebSocket() is not
 * — Chrome logs ERR_CONNECTION_REFUSED to the extension error page before any
 * JS handler can intercept it.  By keeping the probe inside connect() every
 * call site remains unchanged and the guard can never be accidentally skipped.
 */
function connect(): Promise<void> {
  if (isDaemonSocketActive()) return Promise.resolve();
  if (connectInFlight) return connectInFlight;
  // Gate on startup recovery so a keepalive/reconnect wake never opens the
  // socket into an un-rehydrated worker (daemon commands would then run against
  // empty lease state). Once recovered, skip straight to connectAttempt so the
  // steady-state path adds no extra tick. connectInFlight is set synchronously
  // either way, so concurrent callers still coalesce; workerReady excludes
  // connect itself, so no deadlock.
  const attempt = workerRecovered ? connectAttempt() : workerReady.then(() => connectAttempt());
  connectInFlight = attempt.finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}

async function connectAttempt(): Promise<void> {
  if (isDaemonSocketActive()) return;

  try {
    // omit credentials so the browser doesn't attach the localhost cookie jar —
    // a large jar can push the request past Node's default header limit and make
    // the daemon answer 431, silently wedging the connect loop forever.
    const res = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(1000),
      credentials: 'omit',
    });
    if (!res.ok) {
      console.warn(`[opencli] daemon ping failed: HTTP ${res.status}`);
      scheduleReconnect();
      return; // unexpected response — not our daemon, but keep polling.
    }
    // Daemon is reachable — proceed straight to the WebSocket below.
    reconnectAttempts = 0;
  } catch {
    // Daemon not running is the expected idle state — keep the probe silent to
    // avoid per-poll service-worker noise (see connect() docstring). The 431
    // wedge this fixes is surfaced in the !res.ok branch above.
    scheduleReconnect();
    return; // daemon not running — keep polling until the next daemon spawn.
  }
  if (isDaemonSocketActive()) return;

  let thisWs: WebSocket;
  try {
    const contextId = await getCurrentContextId();
    if (isDaemonSocketActive()) return;
    thisWs = new WebSocket(DAEMON_WS_URL);
    ws = thisWs;
    currentContextId = contextId;
  } catch {
    scheduleReconnect();
    return;
  }

  if (handshakeTimer) clearTimeout(handshakeTimer);
  handshakeTimer = setTimeout(() => {
    if (ws !== thisWs || thisWs.readyState !== WebSocket.CONNECTING) return;
    console.warn('[opencli] Daemon WebSocket handshake timed out; reconnecting');
    // Release the guard before close: Chrome may delay the close event too.
    ws = null;
    thisWs.close();
    scheduleReconnect();
  }, 10_000);

  thisWs.onopen = () => {
    if (ws !== thisWs) return;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    console.log('[opencli] Connected to daemon');
    reconnectAttempts = 0; // Reset on successful connection
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Send version + compatibility range so the daemon can report mismatches to the CLI
    safeSend(thisWs, {
      type: 'hello',
      contextId: currentContextId,
      version: chrome.runtime.getManifest().version,
      compatRange: __OPENCLI_COMPAT_RANGE__,
    });
    // Application-level keepalive. Chrome (116+) extends the service worker's
    // lifetime on WebSocket ACTIVITY — an idle OPEN socket does not count, so
    // without this the worker lives on a knife-edge between the 30s idle kill
    // and the 30s keepalive alarm. The daemon ignores `ping` messages.
    startWsKeepalive(thisWs);
  };

  thisWs.onmessage = async (event) => {
    if (ws !== thisWs) return;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const command = JSON.parse(event.data as string) as Command;
      let stage = 'journal storage';
      stallTimer = setTimeout(() => {
        console.warn(`[opencli] Command ${command.id} action=${command.action} still waiting at ${stage} after 5s`);
      }, 5_000);
      const result = await executeWithJournal(command, (cmd) => {
        stage = 'Chrome API handler';
        return handleCommand(cmd);
      });
      // The socket may have been replaced while a long command ran. Deliver
      // the result on the freshest open socket — the daemon correlates by id,
      // and the journal replays it if this delivery is lost too.
      const target = ws && ws.readyState === WebSocket.OPEN ? ws : thisWs;
      safeSend(target, result);
    } catch (err) {
      console.error('[opencli] Message handling error:', err);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  };

  thisWs.onclose = () => {
    stopWsKeepalive(thisWs);
    if (ws !== thisWs) return;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    console.log('[opencli] Disconnected from daemon');
    ws = null;
    scheduleReconnect();
  };

  thisWs.onerror = () => {
    thisWs.close();
  };
}

// ─── WebSocket keepalive ─────────────────────────────────────────────

const WS_KEEPALIVE_INTERVAL_MS = 20_000;
let wsKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
let wsKeepaliveSocket: WebSocket | null = null;

function startWsKeepalive(socket: WebSocket): void {
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveSocket = socket;
  wsKeepaliveTimer = setInterval(() => {
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
      stopWsKeepalive(socket);
      return;
    }
    safeSend(socket, { type: 'ping', ts: Date.now() });
  }, WS_KEEPALIVE_INTERVAL_MS);
}

function stopWsKeepalive(socket: WebSocket): void {
  if (wsKeepaliveSocket !== socket) return;
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveTimer = null;
  wsKeepaliveSocket = null;
}

/**
 * Reconnect cadence: plain exponential backoff with jitter, never giving up
 * while Chrome keeps the service worker alive. 1s → 2s → 4s → … capped at 15s
 * (+0-500ms jitter); attempts reset on a successful WS open. The durable wake
 * path is chrome.alarms: production Chrome enforces a ~30s minimum alarm
 * interval, so alarms wake the worker after idle eviction while setTimeout
 * provides the faster path only when the worker remains alive.
 */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

function nextReconnectDelayMs(): number {
  const exp = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempts, 6));
  return exp + Math.floor(Math.random() * 500);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = nextReconnectDelayMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

// ─── Browser target leases ───────────────────────────────────────────
// A browser session owns or borrows a tab lease. Owned leases live in either
// the interactive browser window or the background adapter window; bound leases
// point at user-owned tabs. Lease behavior is stored as metadata instead of
// encoded in session-name prefixes.

type BrowserContextId = string;
type LeaseOwnership = 'owned' | 'borrowed';
type LeaseLifecycle = 'ephemeral' | 'persistent' | 'pinned';
type WindowRole = 'interactive' | 'automation' | 'borrowed-user';
type OwnedWindowRole = Exclude<WindowRole, 'borrowed-user'>;
// foreground — raise the window AND select the tab (opt-in, interrupts the person by
//              stealing macOS-level focus; use only when a human needs to see it, e.g.
//              a CAPTCHA or an OS-level dialog)
// active     — select the tab within its window ONLY; never touches OS-level window
//              focus. Chromium's rAF/timer throttling keys off whether a tab is the
//              active tab of a visible (non-minimized) window, not off which app has
//              macOS focus — so this is enough to keep a tab's own render loop
//              (e.g. a page polling `requestAnimationFrame`) from being throttled,
//              without ever yanking the person's attention to another app.
// background — do not raise, do not select; reuse the window they are already in
// isolated   — background, but keep automation in its own separate window
// dedicated  — OpenCLI's own named window (slot), created unfocused, optionally placed
//              on a display; session tabs never enter the person's windows, foreign
//              tabs are sent back, and the session tab is made the window's active tab
//              before each command so it renders (see "Dedicated automation windows")
//
// The list and the type are one declaration on purpose. They used to be two, and the
// runtime check fell behind the union: `isolated` type-checked everywhere, parsed on
// the CLI, reached the extension, and was then dropped by a hardcoded two-value guard.
// Nothing errored — the flag just did nothing, which is the hardest kind of broken.
const WINDOW_MODES = ['foreground', 'active', 'background', 'isolated', 'dedicated'] as const;
type WindowMode = typeof WINDOW_MODES[number];

function isWindowMode(value: unknown): value is WindowMode {
  return typeof value === 'string' && (WINDOW_MODES as readonly string[]).includes(value);
}
type BrowserSurface = 'browser' | 'adapter';
type LeaseKind = 'owned' | 'bound';

type TargetLease = {
  session: string;
  surface: BrowserSurface;
  kind: LeaseKind;
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
  owned: boolean;
  preferredTabId: number | null;
  contextId: BrowserContextId;
  ownership: LeaseOwnership;
  lifecycle: LeaseLifecycle;
  windowRole: WindowRole;
};

const automationSessions = new Map<string, TargetLease>();
const IDLE_TIMEOUT_DEFAULT = 30_000;      // 30s — adapter-driven automation
const IDLE_TIMEOUT_INTERACTIVE = 600_000; // 10min — human-paced browser:* / operate:*
const IDLE_TIMEOUT_NONE = -1;             // borrowed bound tabs stay bound until unbound/closed
const REGISTRY_KEY = 'opencli_target_lease_registry_v2';
const LEASE_IDLE_ALARM_PREFIX = 'opencli:lease-idle:';
// Every session gets its own tab group, titled after the session — one group per
// lease key, on both surfaces. `opencli browser recon …` lands in "OpenCLI: recon",
// `opencli reddit …` in "OpenCLI: reddit". The earlier design pooled every browser
// session into one "OpenCLI Browser" group (with a comma-joined title) and left
// adapter tabs ungrouped in a window of their own; both were the same complaint
// from the person at the keyboard — "where did that tab come from, and whose is
// it" — and per-session groups answer it directly.
const OWNED_TAB_GROUP_TITLE_PREFIX = 'OpenCLI: ';
const OWNED_TAB_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'orange';
// Why the container could not borrow one of the person's own windows and had to
// create one instead. Surfaced through `browser <s> sessions` so "why did a new
// window open" is answerable without guessing.
type WindowFallbackReason = 'no-normal-window' | 'all-incognito' | 'all-owned' | 'query-failed';
let leaseMutationQueue: Promise<void> = Promise.resolve();
const ownedContainers: Record<OwnedWindowRole, {
  windowId: number | null;
  // leaseKey → group id. A cache over the ledger below; repopulated on demand.
  groups: Map<string, number>;
  // True when `windowId` is a window the person opened and we are borrowing a tab
  // in, rather than a window we created. Borrowed windows must never be treated as
  // ours: we do not leave placeholder tabs in them, and `--window isolated` refuses
  // to reuse them.
  borrowed: boolean;
  // Set when `windowId` is a window we created because no window of the person's
  // could be borrowed; null when the container is borrowed or was asked for
  // explicitly via `--window isolated`.
  windowFallbackReason: WindowFallbackReason | null;
  promise: Promise<{ windowId: number; initialTabId?: number }> | null;
  groupPromise: Promise<OwnedContainerGroup | null> | null;
}> = {
  interactive: { windowId: null, groups: new Map(), borrowed: false, windowFallbackReason: null, promise: null, groupPromise: null },
  automation: { windowId: null, groups: new Map(), borrowed: false, windowFallbackReason: null, promise: null, groupPromise: null },
};

// Dedicated automation windows, one per slot (see "Dedicated automation windows").
// Kept apart from `ownedContainers` on purpose: a role container flips between a
// borrowed window and an isolated one, while a dedicated window is only ever ours.
const DEFAULT_DEDICATED_SLOT = 'default';
const DEDICATED_REGISTRY_KEY = 'opencli_dedicated_windows_v1';
const dedicatedSlots = new Map<string, DedicatedSlotState>();
// Tabs we moved ourselves (so onAttached does not read them as the person dragging).
const selfMovingTabIds = new Map<number, number>();
// One queue for every slot: cell allocation must see the other slots' in-flight windows.
let dedicatedEnsureQueue: Promise<unknown> = Promise.resolve();
// Releases inside dedicated windows run one at a time, so "is this the last tab" is answered truthfully.
let dedicatedReleaseQueue: Promise<unknown> = Promise.resolve();
// Tabs we created in a dedicated window (so onCreated does not read them as foreign).
const selfCreatedTabIds = new Set<number>();
// Lease creations/relocations in progress; foreign-tab checks wait for them.
let dedicatedTabCreatesInFlight = 0;
// Grace period before judging a new/attached tab in a dedicated window.
let foreignTabSettleMs = 1500;

// Ledger of every group id we have created or adopted in the CURRENT browser
// session, mapped to the lease key it belongs to, kept so an orphan group
// (created by `chrome.tabs.group` but never titled because the worker died
// before the `tabGroups.update`) stays discoverable even when the cached
// `groups` and lease/title layers can't see it. A `null` lease key is a group
// id restored from a registry written by an older build that did not record
// ownership; it is never adopted for a session and only kept so it gets pruned.
// Persisted as part of the session registry (see StoredRegistry) and restored
// by reconcileTargetLeaseRegistry().
const ownedGroupLedger = new Map<number, string | null>();

type StoredLease = Omit<TargetLease, 'idleTimer' | 'idleDeadlineAt'> & {
  idleDeadlineAt: number;
  updatedAt: number;
};

// The registry lives in chrome.storage.session, never chrome.storage.local:
// every id it carries (window, tab, group) is a Chrome runtime number that is
// only valid within one browser session. Persisting them across a browser
// restart never enabled real recovery — a recycled id could instead collide
// with a user-created window/tab/group and let the restore path claim it.
// storage.session survives MV3 service-worker restarts (the case recovery
// exists for) and is cleared exactly when the ids die. initialize() also
// best-effort removes the legacy storage.local copy older versions wrote.
// Boundary: storage.session is also cleared on extension disable/reload/update
// and on browser restart — recovery is only promised across service-worker
// restarts within one browser session. Old leases are NOT recovered after an
// extension reload/update, and no durable-id logic should be added for that.
type StoredContainer = {
  windowId: number | null;
  borrowed?: boolean;
  windowFallbackReason?: WindowFallbackReason | null;
  // group id (as a string key) → lease key. Both roles carry one now.
  groups?: Record<string, string>;
  // Legacy (pre per-session groups): bare interactive group ids with no owner.
  groupIds?: number[];
};
type StoredRegistry = {
  version: 2;
  contextId: BrowserContextId;
  ownedContainers: {
    interactive: StoredContainer;
    automation: StoredContainer;
  };
  leases: Record<string, StoredLease>;
};

class CommandFailure extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) {
    super(message);
    this.name = 'CommandFailure';
  }
}

/**
 * Per-session overrides set via command fields (idleTimeout / windowMode /
 * siteSession). One record per lease key — a single map so create/clear
 * stay in lockstep.
 */
type SessionOverrides = {
  idleTimeoutMs?: number;
  windowMode?: WindowMode;
  lifecycle?: LeaseLifecycle;
  // `dedicated` only (set from the command by applyDedicatedCommandFields).
  windowSlot?: string;
  windowBounds?: { left: number; top: number; width: number; height: number };
  windowDisplay?: string;
  autoSelect?: boolean;
};
const sessionOverrides = new Map<string, SessionOverrides>();

function setSessionOverride(key: string, patch: SessionOverrides): void {
  sessionOverrides.set(key, { ...sessionOverrides.get(key), ...patch });
}

/** Commands currently executing per lease — idle release is deferred while > 0. */
const activeCommandCounts = new Map<string, number>();
const LEASE_KEY_SEPARATOR = '\u0000';

function getLeaseKey(session: string, surface: BrowserSurface): string {
  return `${surface}${LEASE_KEY_SEPARATOR}${encodeURIComponent(session)}`;
}

function getSessionName(session?: string): string {
  const raw = session?.trim();
  if (!raw) throw new CommandFailure(
    'session_required',
    'Browser session is required.',
    'Pass a browser session name, e.g. opencli browser <session> <command>.',
  );
  return raw;
}

function getCommandSurface(cmd: Pick<Command, 'surface' | 'session'>): BrowserSurface {
  return cmd.surface === 'adapter' ? 'adapter' : 'browser';
}

function getSurfaceFromKey(key: string): BrowserSurface {
  return key.split(LEASE_KEY_SEPARATOR, 1)[0] === 'adapter' ? 'adapter' : 'browser';
}

function getSessionFromKey(key: string): string {
  const idx = key.indexOf(LEASE_KEY_SEPARATOR);
  if (idx === -1) return key;
  try {
    return decodeURIComponent(key.slice(idx + 1));
  } catch {
    return key.slice(idx + 1);
  }
}

function getIdleTimeout(key: string): number {
  const session = automationSessions.get(key);
  if (session?.kind === 'bound') return IDLE_TIMEOUT_NONE;
  const overrides = sessionOverrides.get(key);
  const adapterPersistent = getSurfaceFromKey(key) === 'adapter'
    && (session?.lifecycle === 'persistent' || overrides?.lifecycle === 'persistent');
  if (adapterPersistent) return IDLE_TIMEOUT_NONE;
  if (overrides?.idleTimeoutMs !== undefined) return overrides.idleTimeoutMs;
  return getSurfaceFromKey(key) === 'browser' ? IDLE_TIMEOUT_INTERACTIVE : IDLE_TIMEOUT_DEFAULT;
}

function getLeaseLifecycle(key: string, kind: LeaseKind): LeaseLifecycle {
  if (kind === 'bound') return 'pinned';
  const override = sessionOverrides.get(key)?.lifecycle;
  if (override) return override;
  return getSurfaceFromKey(key) === 'browser' ? 'persistent' : 'ephemeral';
}

function getOwnedWindowRole(key: string): OwnedWindowRole {
  return getSurfaceFromKey(key) === 'browser' ? 'interactive' : 'automation';
}

function getWindowRole(key: string, ownership: LeaseOwnership): WindowRole {
  return ownership === 'borrowed' ? 'borrowed-user' : getOwnedWindowRole(key);
}

// Both surfaces default to background. Raising a window or switching the active
// tab is a visible interruption of whatever the person is doing, and nothing about
// automation needs it: background windows are not throttled, `visibilityState` stays
// `visible`, and every headless tell reads negative. Foreground is opt-in via
// `--window foreground` / `OPENCLI_WINDOW=foreground`, for the rare flow that
// genuinely needs the window up front (OS-level dialogs, clipboard, a human
// finishing a CAPTCHA).
function getWindowMode(key: string): WindowMode {
  return sessionOverrides.get(key)?.windowMode ?? 'background';
}

function makeAlarmName(leaseKey: string): string {
  return `${LEASE_IDLE_ALARM_PREFIX}${encodeURIComponent(leaseKey)}`;
}

function leaseKeyFromAlarmName(name: string): string | null {
  if (!name.startsWith(LEASE_IDLE_ALARM_PREFIX)) return null;
  try {
    return decodeURIComponent(name.slice(LEASE_IDLE_ALARM_PREFIX.length));
  } catch {
    return null;
  }
}

function withLeaseMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = leaseMutationQueue.then(fn, fn);
  leaseMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function makeSession(
  key: string,
  session: Omit<TargetLease, 'idleTimer' | 'idleDeadlineAt' | 'contextId' | 'ownership' | 'lifecycle' | 'windowRole'>,
): Omit<TargetLease, 'idleTimer' | 'idleDeadlineAt'> {
  const ownership = session.owned ? 'owned' : 'borrowed';
  return {
    ...session,
    contextId: currentContextId,
    ownership,
    lifecycle: getLeaseLifecycle(key, session.kind),
    windowRole: getWindowRole(key, ownership),
  };
}

const WINDOW_FALLBACK_REASONS: readonly WindowFallbackReason[] = ['no-normal-window', 'all-incognito', 'all-owned', 'query-failed'];

function snapshotContainer(role: OwnedWindowRole): StoredContainer {
  const groups: Record<string, string> = {};
  for (const [groupId, leaseKey] of ownedGroupLedger.entries()) {
    if (leaseKey !== null && getOwnedWindowRole(leaseKey) === role) groups[String(groupId)] = leaseKey;
  }
  return {
    windowId: ownedContainers[role].windowId,
    borrowed: ownedContainers[role].borrowed,
    windowFallbackReason: ownedContainers[role].windowFallbackReason,
    groups,
  };
}

function emptyRegistry(): StoredRegistry {
  return {
    version: 2,
    contextId: currentContextId,
    ownedContainers: {
      interactive: snapshotContainer('interactive'),
      automation: snapshotContainer('automation'),
    },
    leases: {},
  };
}

function coerceStoredContainer(raw: Partial<StoredContainer> | undefined): StoredContainer {
  const groups: Record<string, string> = {};
  if (raw?.groups && typeof raw.groups === 'object') {
    for (const [groupId, leaseKey] of Object.entries(raw.groups)) {
      if (/^\d+$/.test(groupId) && typeof leaseKey === 'string') groups[groupId] = leaseKey;
    }
  }
  return {
    windowId: typeof raw?.windowId === 'number' ? raw.windowId : null,
    borrowed: raw?.borrowed === true,
    windowFallbackReason: (WINDOW_FALLBACK_REASONS as readonly unknown[]).includes(raw?.windowFallbackReason)
      ? raw!.windowFallbackReason as WindowFallbackReason
      : null,
    groups,
    groupIds: Array.isArray(raw?.groupIds)
      ? raw!.groupIds.filter((id): id is number => typeof id === 'number')
      : [],
  };
}

async function readRegistry(): Promise<StoredRegistry> {
  try {
    const session = chrome.storage?.session;
    if (!session) return emptyRegistry(); // no session storage — degrade to memory-only
    const raw = await session.get(REGISTRY_KEY) as Record<string, unknown>;
    const stored = raw[REGISTRY_KEY] as Partial<StoredRegistry> | undefined;
    if (!stored || stored.version !== 2 || typeof stored.leases !== 'object') return emptyRegistry();
    const storedContainers = stored.ownedContainers && typeof stored.ownedContainers === 'object'
      ? stored.ownedContainers
      : emptyRegistry().ownedContainers;
    return {
      version: 2,
      contextId: currentContextId,
      ownedContainers: {
        interactive: coerceStoredContainer(storedContainers.interactive),
        automation: coerceStoredContainer(storedContainers.automation),
      },
      leases: stored.leases as Record<string, StoredLease>,
    };
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistry(registry: StoredRegistry): Promise<void> {
  try {
    await chrome.storage?.session?.set({ [REGISTRY_KEY]: registry });
  } catch {
    // Registry persistence is a recovery aid; command execution should not fail on storage errors.
  }
}

async function persistRuntimeState(): Promise<void> {
  const leases: Record<string, StoredLease> = {};
  for (const [leaseKey, session] of automationSessions.entries()) {
    leases[leaseKey] = {
      session: session.session,
      surface: session.surface,
      kind: session.kind,
      windowId: session.windowId,
      owned: session.owned,
      preferredTabId: session.preferredTabId,
      contextId: session.contextId,
      ownership: session.ownership,
      lifecycle: session.lifecycle,
      windowRole: session.windowRole,
      idleDeadlineAt: session.idleDeadlineAt,
      updatedAt: Date.now(),
    };
  }
  await writeRegistry({
    version: 2,
    contextId: currentContextId,
    ownedContainers: {
      interactive: snapshotContainer('interactive'),
      automation: snapshotContainer('automation'),
    },
    leases,
  });
}

function scheduleIdleAlarm(leaseKey: string, timeout: number): void {
  const alarmName = makeAlarmName(leaseKey);
  try {
    if (timeout > 0) {
      chrome.alarms?.create?.(alarmName, { when: Date.now() + timeout });
    } else {
      chrome.alarms?.clear?.(alarmName);
    }
  } catch {
    // setTimeout remains the in-process fast path; alarms are the MV3 restart recovery path.
  }
}

async function safeDetach(tabId: number): Promise<void> {
  try {
    const detach = (executor as unknown as { detach?: (tabId: number) => Promise<void> }).detach;
    if (typeof detach === 'function') await detach(tabId);
  } catch {
    // Detach is best-effort during cleanup.
  }
}

async function removeLeaseSession(leaseKey: string): Promise<void> {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.delete(leaseKey);
  sessionOverrides.delete(leaseKey);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
  await persistRuntimeState();
}

// `remainingMs` lets the caller honor an already-elapsed deadline (e.g. after a
// service-worker restart) instead of granting a fresh full timeout. When given,
// the timer/alarm fire after the clamped remaining lifetime; when omitted, a
// full idle timeout is started.
function resetWindowIdleTimer(leaseKey: string, remainingMs?: number): void {
  const session = automationSessions.get(leaseKey);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  if (timeout <= 0) {
    scheduleIdleAlarm(leaseKey, timeout);
    session.idleTimer = null;
    session.idleDeadlineAt = 0;
    void persistRuntimeState();
    return;
  }
  const interval = remainingMs === undefined
    ? timeout
    : Math.max(0, Math.min(remainingMs, timeout));
  scheduleIdleAlarm(leaseKey, interval);
  session.idleDeadlineAt = Date.now() + interval;
  void persistRuntimeState();
  session.idleTimer = setTimeout(async () => {
    if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) {
      // A command is still executing on this lease — never tear the tab down
      // from under it. Its completion re-arms the timer.
      return;
    }
    await releaseLease(leaseKey, 'idle timeout');
  }, interval);
}

/**
 * The title of the group a lease's tabs live in: `OpenCLI: <session>`. The
 * session part is whatever the person named the session — `recon` for
 * `opencli browser recon …`. Adapter sessions are named by the CLI runtime as
 * `site:<site>` (persistent) or `site:<site>:<uuid>` (one-shot); the person
 * typed `opencli reddit …`, so the group says `OpenCLI: reddit`, not the
 * machine name.
 */
function getOwnedGroupTitle(leaseKey: string): string {
  const session = getSessionFromKey(leaseKey);
  if (getSurfaceFromKey(leaseKey) === 'adapter') {
    const site = /^site:([^:]+)(?::[0-9a-f-]{36})?$/i.exec(session)?.[1];
    if (site) return `${OWNED_TAB_GROUP_TITLE_PREFIX}${site}`;
  }
  return `${OWNED_TAB_GROUP_TITLE_PREFIX}${session}`;
}

/** Tab ids that belong to an owned lease OTHER than `leaseKey`. */
function otherOwnedPreferredTabIds(leaseKey: string): Set<number> {
  const ids = new Set<number>();
  for (const [key, session] of automationSessions.entries()) {
    if (key === leaseKey || !session.owned || session.preferredTabId === null) continue;
    ids.add(session.preferredTabId);
  }
  return ids;
}

type OwnedContainerGroup = {
  id: number;
  windowId: number;
  title?: string;
};

type OwnedContainerGroupCandidate = OwnedContainerGroup & {
  focused: boolean;
  hasReusableTab: boolean;
};

// `active` deliberately does NOT reach this function's `focused: true` call — that is
// the one that steals macOS-level window focus. Only `foreground` does that.
function wantsActiveTab(mode: WindowMode): boolean {
  return mode === 'foreground' || mode === 'active';
}

async function focusOwnedWindowIfRequested(windowId: number, mode: WindowMode): Promise<void> {
  if (mode !== 'foreground') return;
  const updateWindow = (chrome.windows as unknown as { update?: (windowId: number, updateInfo: { focused?: boolean }) => Promise<unknown> }).update;
  if (typeof updateWindow === 'function') await updateWindow(windowId, { focused: true }).catch(() => {});
}

async function toOwnedContainerGroupCandidate(group: chrome.tabGroups.TabGroup): Promise<OwnedContainerGroupCandidate | null> {
  try {
    const chromeWindow = await chrome.windows.get(group.windowId);
    const reusableTabId = await findReusableOwnedContainerTab(group.windowId, group.id);
    return {
      id: group.id,
      windowId: group.windowId,
      title: group.title,
      focused: !!chromeWindow.focused,
      hasReusableTab: reusableTabId !== undefined,
    };
  } catch {
    // Ignore stale browser-session group/window state and keep looking.
    return null;
  }
}

function selectOwnedContainerGroupCandidate(candidates: OwnedContainerGroupCandidate[]): OwnedContainerGroupCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    if (a.hasReusableTab !== b.hasReusableTab) return a.hasReusableTab ? -1 : 1;
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.id - b.id;
  })[0];
}

/**
 * Drop ledger entries whose group no longer exists (closed, or converged away)
 * so the ledger stays bounded and never resurrects a dead id. Returns the
 * groups that are still alive, keyed by id.
 */
async function pruneOwnedGroupLedger(): Promise<Map<number, chrome.tabGroups.TabGroup>> {
  const alive = new Map<number, chrome.tabGroups.TabGroup>();
  let pruned = false;
  for (const groupId of [...ownedGroupLedger.keys()]) {
    try {
      alive.set(groupId, await chrome.tabGroups.get(groupId));
    } catch {
      ownedGroupLedger.delete(groupId);
      for (const container of Object.values(ownedContainers)) {
        for (const [key, id] of [...container.groups.entries()]) {
          if (id === groupId) container.groups.delete(key);
        }
      }
      pruned = true;
    }
  }
  if (pruned) await persistRuntimeState();
  return alive;
}

/**
 * Every group that could be THIS lease's group. Four layers, all scoped to the
 * one lease key — a group belonging to any other session is never a candidate,
 * so convergence can only ever merge a session with itself:
 *
 *  1. the cached id in `ownedContainers[role].groups`
 *  2. the ledger (ids we created/adopted this browser session for this lease)
 *  3. the title `OpenCLI: <session>`
 *  4. the group the lease's own tab currently sits in, titled or not
 *
 * Layer 4 is what catches the orphan left when the worker died between
 * `chrome.tabs.group` returning and the title update landing. It is hijack-safe
 * because the only signal is "contains this lease's own tab": a group the person
 * built never satisfies it. Layer 3 is filtered the same way in reverse — a
 * group carrying our title but holding another session's tab (a `browser` and
 * an `adapter` session can share a name) is theirs, not ours.
 */
async function collectOwnedGroupCandidates(role: OwnedWindowRole, leaseKey: string): Promise<OwnedContainerGroupCandidate[]> {
  const container = ownedContainers[role];
  const groupsById = new Map<number, chrome.tabGroups.TabGroup>();
  const foreignTabIds = otherOwnedPreferredTabIds(leaseKey);
  const claimedByOther = (groupId: number): boolean => {
    const owner = ownedGroupLedger.get(groupId);
    return owner !== undefined && owner !== null && owner !== leaseKey;
  };

  const cachedGroupId = container.groups.get(leaseKey);
  if (cachedGroupId !== undefined) {
    try {
      const group = await chrome.tabGroups.get(cachedGroupId);
      groupsById.set(group.id, group);
    } catch {
      container.groups.delete(leaseKey);
    }
  }

  // Ledger layer. Every entry is checked (not just this lease's) so pruning
  // happens regardless of which session is being ensured.
  for (const [groupId, group] of await pruneOwnedGroupLedger()) {
    if (ownedGroupLedger.get(groupId) === leaseKey && !groupsById.has(groupId)) groupsById.set(groupId, group);
  }

  try {
    const titled = await chrome.tabGroups.query({ title: getOwnedGroupTitle(leaseKey) });
    for (const group of titled) {
      if (groupsById.has(group.id) || claimedByOther(group.id)) continue;
      const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
      if (tabsInGroup.some((tab) => tab.id !== undefined && foreignTabIds.has(tab.id))) continue;
      groupsById.set(group.id, group);
    }
  } catch {
    // Transient query failure: convergence proceeds with the other layers.
  }

  const session = automationSessions.get(leaseKey);
  if (session?.owned && session.preferredTabId !== null) {
    try {
      const tab = await chrome.tabs.get(session.preferredTabId);
      const groupId = tab.groupId;
      if (typeof groupId === 'number' && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !claimedByOther(groupId)) {
        const group = await chrome.tabGroups.get(groupId);
        groupsById.set(group.id, group);
      }
    } catch {
      // Lease tabs and browser-session groups can disappear independently.
    }
  }

  const candidates = await Promise.all([...groupsById.values()].map(toOwnedContainerGroupCandidate));
  return candidates.filter((candidate): candidate is OwnedContainerGroupCandidate => candidate !== null);
}

function updateOwnedSessionWindowForTabs(role: OwnedWindowRole, tabIds: number[], windowId: number): void {
  const moved = new Set(tabIds);
  for (const [leaseKey, session] of automationSessions.entries()) {
    if (!session.owned || getOwnedWindowRole(leaseKey) !== role) continue;
    if (session.preferredTabId !== null && moved.has(session.preferredTabId)) {
      session.windowId = windowId;
    }
  }
}

async function ensureTabsInWindow(tabIds: number[], windowId: number): Promise<number[]> {
  const movedIds: number[] = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== windowId) {
        await moveTabSelf(tabId, windowId);
        movedIds.push(tabId);
      }
    } catch {
      // The caller may be cleaning stale session state. Missing tabs are ignored here.
    }
  }
  return movedIds;
}

async function ensureCanonicalGroupTitle(leaseKey: string, group: OwnedContainerGroup): Promise<OwnedContainerGroup> {
  const title = getOwnedGroupTitle(leaseKey);
  if (group.title === title) return group;
  const updated = await chrome.tabGroups.update(group.id, {
    title,
    color: OWNED_TAB_GROUP_COLOR,
  });
  return { id: updated.id, windowId: updated.windowId, title: updated.title };
}

/**
 * Fold duplicate groups of ONE lease into its canonical group. `candidates`
 * already came through `collectOwnedGroupCandidates(role, leaseKey)`, so every
 * group here is this session's; the per-tab check below is belt-and-braces
 * against a tab of another session that landed in one of them.
 */
async function convergeOwnedGroupDuplicates(
  role: OwnedWindowRole,
  leaseKey: string,
  canonical: OwnedContainerGroup,
  candidates: OwnedContainerGroup[],
): Promise<OwnedContainerGroup> {
  const foreignTabIds = otherOwnedPreferredTabIds(leaseKey);
  for (const duplicate of candidates) {
    if (duplicate.id === canonical.id) continue;
    const tabs = await chrome.tabs.query({ groupId: duplicate.id });
    const tabIds = tabs
      .map((tab) => tab.id)
      .filter((id): id is number => id !== undefined && !foreignTabIds.has(id));
    if (tabIds.length === 0) continue;
    await ensureTabsInWindow(tabIds, canonical.windowId);
    await chrome.tabs.group({ groupId: canonical.id, tabIds });
    updateOwnedSessionWindowForTabs(role, tabIds, canonical.windowId);
  }
  return canonical;
}

async function attachTabsToOwnedGroup(
  role: OwnedWindowRole,
  group: OwnedContainerGroup,
  ids: number[],
): Promise<OwnedContainerGroup> {
  if (ids.length === 0) return group;
  await ensureTabsInWindow(ids, group.windowId);
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  const missing = tabs
    .filter((tab): tab is chrome.tabs.Tab => tab !== null && tab.id !== undefined && tab.groupId !== group.id)
    .map((tab) => tab.id!);
  if (missing.length > 0) await chrome.tabs.group({ groupId: group.id, tabIds: missing });
  updateOwnedSessionWindowForTabs(role, ids, group.windowId);
  return group;
}

async function createOwnedGroup(
  role: OwnedWindowRole,
  leaseKey: string,
  windowId: number,
  ids: number[],
): Promise<OwnedContainerGroup> {
  if (ids.length === 0) throw new Error(`Cannot create ${role} tab group without tabs`);
  await ensureTabsInWindow(ids, windowId);
  const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
  ownedContainers[role].groups.set(leaseKey, groupId);
  // A dedicated window is never a role container; recording it there would let
  // default-mode sessions and `isolated` treat it as theirs.
  if (!isDedicatedWindow(windowId)) ownedContainers[role].windowId = windowId;
  // Record in the ledger and persist BEFORE the title/color update lands so a
  // worker crash between the two API calls can self-heal on resume:
  // `ensureCanonicalGroupTitle` repairs the title on the next ensure cycle
  // once the ledger surfaces the untitled orphan. We must not `tabs.ungroup`
  // on failure or the recorded id dangles.
  ownedGroupLedger.set(groupId, leaseKey);
  await persistRuntimeState();
  const group = await chrome.tabGroups.update(groupId, {
    color: OWNED_TAB_GROUP_COLOR,
    title: getOwnedGroupTitle(leaseKey),
    collapsed: false,
  });
  updateOwnedSessionWindowForTabs(role, ids, group.windowId);
  return { id: group.id, windowId: group.windowId, title: group.title };
}

async function ensureOwnedContainerGroup(
  role: OwnedWindowRole,
  leaseKey: string,
  fallbackWindowId: number | null,
  tabIds: Array<number | undefined>,
  // The group must live in THIS window. Defaults to `fallbackWindowId`, and that
  // default is the point: convergence walks to the canonical group wherever it
  // happens to be and MOVES tabs there, so every call that knew its window but
  // forgot to say so was a door for relocating tabs across windows. Emptying a
  // window that way makes Chrome close it, which killed every session inside.
  // Four separate bugs came through four different unpinned calls before this
  // stopped being a per-call-site decision.
  //
  // Cross-window adoption is now only possible where it is meaningful: the
  // discovery call that passes `fallbackWindowId: null` because it does not yet
  // know which window it wants.
  pinWindowId?: number,
): Promise<OwnedContainerGroup | null> {
  const ids = [...new Set(tabIds.filter((id): id is number => id !== undefined))];

  // One queue per role, not per lease: the ledger is shared across leases and
  // two sessions grouping at once must not interleave their pruning/persisting.
  const container = ownedContainers[role];
  const previousGroupPromise = container.groupPromise ?? Promise.resolve(null);
  const nextGroupPromise = previousGroupPromise
    .catch(() => null)
    .then(() => ensureOwnedContainerGroupUnlocked(
      role,
      leaseKey,
      fallbackWindowId,
      ids,
      pinWindowId ?? (fallbackWindowId ?? undefined),
    ));
  const trackedGroupPromise = nextGroupPromise.finally(() => {
    if (container.groupPromise === trackedGroupPromise) container.groupPromise = null;
  });
  container.groupPromise = trackedGroupPromise;
  return trackedGroupPromise;
}

async function ensureOwnedContainerGroupUnlocked(
  role: OwnedWindowRole,
  leaseKey: string,
  fallbackWindowId: number | null,
  ids: number[],
  pinWindowId?: number,
): Promise<OwnedContainerGroup | null> {
  try {
    const allCandidates = await collectOwnedGroupCandidates(role, leaseKey);
    const candidates = pinWindowId === undefined
      ? allCandidates
      : allCandidates.filter(candidate => candidate.windowId === pinWindowId);
    const selected = selectOwnedContainerGroupCandidate(candidates);
    let canonical: OwnedContainerGroup | null = selected
      ? { id: selected.id, windowId: selected.windowId, title: selected.title }
      : null;

    if (canonical) {
      canonical = await convergeOwnedGroupDuplicates(role, leaseKey, canonical, candidates);
      canonical = await ensureCanonicalGroupTitle(leaseKey, canonical);
      canonical = await attachTabsToOwnedGroup(role, canonical, ids);
    } else if (fallbackWindowId !== null && ids.length > 0) {
      canonical = await createOwnedGroup(role, leaseKey, fallbackWindowId, ids);
    }

    const container = ownedContainers[role];
    if (canonical) {
      // Adopting a group tells us where it lives but not who owns that window.
      // Anything other than a window we created is borrowed until proven otherwise.
      if (!isDedicatedWindow(canonical.windowId)) {
        if (container.windowId !== canonical.windowId) {
          container.borrowed = true;
          container.windowFallbackReason = null;
        }
        container.windowId = canonical.windowId;
      }
      container.groups.set(leaseKey, canonical.id);
      // Adopt into the session ledger — covers canonicals found via the
      // title/lease layers that createOwnedGroup never recorded.
      if (ownedGroupLedger.get(canonical.id) !== leaseKey) {
        ownedGroupLedger.set(canonical.id, leaseKey);
        await persistRuntimeState();
      }
    } else {
      container.groups.delete(leaseKey);
    }
    return canonical;
  } catch (err) {
    console.warn(`[opencli] Failed to ensure ${role} tab group for ${getSessionFromKey(leaseKey)}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Ensure the owned window for the requested role exists.
 *
 * First-principles model:
 * - BrowserContext is the user's default Chrome profile.
 * - Session identity maps to a TargetLease (usually a tab), not a window.
 * - Both roles default to borrowing the window the person is already in, each
 *   session in its own labelled tab group. `--window isolated` opts a session
 *   out into a window of our own.
 */
async function ensureOwnedContainerWindow(
  role: OwnedWindowRole,
  leaseKey: string,
  initialUrl?: string,
  mode: WindowMode = 'background',
): Promise<{ windowId: number; initialTabId?: number }> {
  const container = ownedContainers[role];
  if (container.promise) return container.promise;
  container.promise = ensureOwnedContainerWindowUnlocked(role, leaseKey, initialUrl, mode)
    .finally(() => {
      container.promise = null;
    });
  return container.promise;
}

/**
 * Is the container window one we created, or one we are borrowing?
 *
 * The `borrowed` flag alone is not enough to answer this: a container adopted
 * through a stray tab group, or restored from a registry written by an older
 * build, carries no flag at all and would read as dedicated. So confirm against
 * the window itself — a window of ours holds nothing but our own tabs. Any tab
 * outside the owned group means the window belongs to the person.
 */
async function containerWindowIsDedicated(role: OwnedWindowRole): Promise<boolean> {
  const container = ownedContainers[role];
  if (container.windowId === null) return false;
  if (container.borrowed) return false;
  // `isolated` keeps its own window; it never moves into a dedicated slot window.
  if (isDedicatedWindow(container.windowId)) return false;
  // Ownership has to be PROVEN, and the only proof is: we know our group ids, and
  // every tab in the window belongs to one of them. Anything short of that — no
  // group recorded, a tab outside our groups, a query that throws — is answered
  // "borrowed". Guessing from tab URLs was tried and misfires: a window holding
  // nothing but chrome://newtab is a perfectly ordinary window someone just
  // opened, and reading it as ours is how `--window isolated` silently kept
  // landing in it. Being wrong in this direction costs one extra window, which
  // is what the caller asked for anyway; being wrong the other way ignores the
  // flag entirely.
  const ours = new Set<number>();
  for (const [groupId, owner] of ownedGroupLedger.entries()) {
    if (owner !== null && getOwnedWindowRole(owner) === role) ours.add(groupId);
  }
  for (const groupId of container.groups.values()) ours.add(groupId);
  if (ours.size === 0) return false;
  try {
    const tabs = await chrome.tabs.query({ windowId: container.windowId });
    if (tabs.length === 0) return true;
    return tabs.every(tab => typeof tab.groupId === 'number' && ours.has(tab.groupId));
  } catch {
    return false;
  }
}

function forgetContainerWindow(role: OwnedWindowRole): void {
  const container = ownedContainers[role];
  container.windowId = null;
  container.groups.clear();
  container.borrowed = false;
  container.windowFallbackReason = null;
}

async function ensureOwnedContainerWindowUnlocked(
  role: OwnedWindowRole,
  leaseKey: string,
  initialUrl?: string,
  mode: WindowMode = 'background',
): Promise<{ windowId: number; initialTabId?: number }> {
  const container = ownedContainers[role];
  // `isolated` asks for a window of our own. A container currently borrowing the
  // person's window does not satisfy that, so drop it and fall through to create one.
  const wantsDedicated = mode === 'isolated';
  if (wantsDedicated && !(await containerWindowIsDedicated(role))) {
    forgetContainerWindow(role);
  }
  // Where is the person right now? Ask on every non-isolated session, and move
  // the container if the answer changed. Two different ways this goes wrong
  // without it, and the role only has one container slot to express both:
  //
  //  - a window we borrowed once is not ours to keep coming back to. The person
  //    moves on, and piling every later session into the window they were in an
  //    hour ago is the same complaint as opening a new one, just quieter.
  //  - a dedicated window created for `--window isolated` would otherwise
  //    capture every later default-mode session too, silently sending work the
  //    person asked to see into the window they cannot see.
  //
  // `findHostWindowForContainer` skips our own container windows, so this only
  // ever moves toward a real window of theirs. No such window (every window is
  // ours) leaves the container alone rather than spawning another one.
  //
  // This used to be interactive-only; adapter runs got a window of their own by
  // design. That design is gone: a second Chrome window is the interruption, no
  // matter which surface opened it.
  if (!wantsDedicated && container.windowId !== null) {
    // A borrowed container is one of the person's own windows, so it stays a
    // legitimate candidate — otherwise we would move away from it every time.
    // A dedicated one must not be: keeping it eligible is exactly how default
    // sessions got captured by the isolated window.
    const current = await findHostWindowForContainer(container.borrowed ? container.windowId : undefined);
    if (current.windowId !== undefined && current.windowId !== container.windowId) {
      forgetContainerWindow(role);
    }
  }
  if (container.windowId !== null) {
    try {
      await chrome.windows.get(container.windowId);
      // Pin here too, not just on the create path. Without it, a second
      // `--window isolated` session takes the reuse branch, convergence adopts
      // the canonical group wherever it lives — usually the person's window —
      // and the flag is silently ignored while the first isolated session loses
      // its container. Reuse is exactly where a dedicated window is easiest to
      // lose, because nothing is being created to pin.
      const group = await ensureOwnedContainerGroup(
        role,
        leaseKey,
        container.windowId,
        [],
        wantsDedicated ? container.windowId : undefined,
      );
      if (group) {
        await focusOwnedWindowIfRequested(group.windowId, mode);
        const initialTabId = await findReusableOwnedContainerTab(group.windowId, group.id);
        return {
          windowId: group.windowId,
          initialTabId,
        };
      }
      await focusOwnedWindowIfRequested(container.windowId, mode);
      const initialTabId = await findReusableOwnedContainerTab(container.windowId, null);
      const createdGroup = await ensureOwnedContainerGroup(
        role,
        leaseKey,
        container.windowId,
        [initialTabId],
        wantsDedicated ? container.windowId : undefined,
      );
      if (createdGroup) {
        return {
          windowId: createdGroup.windowId,
          initialTabId,
        };
      }
      return {
        windowId: container.windowId,
        initialTabId,
      };
    } catch {
      forgetContainerWindow(role);
    }
  }

  // Adopting a stray group would land us right back in whatever window it lives in,
  // which is the thing `isolated` exists to avoid.
  // Decide the destination BEFORE adopting a group. Group convergence walks to
  // the canonical group wherever it lives, so adopting first quietly overrides
  // everything decided above — that is how the third variant of this bug worked:
  // the container was correctly moved off the isolated window, and then the
  // group sitting in that window pulled it straight back.
  const host = wantsDedicated ? { windowId: undefined, reason: undefined } : await findHostWindowForContainer();
  const hostWindowId = host.windowId;
  const existingGroup = wantsDedicated
    ? null
    : await ensureOwnedContainerGroup(role, leaseKey, null, [], hostWindowId);
  if (existingGroup) {
    await focusOwnedWindowIfRequested(existingGroup.windowId, mode);
    const initialTabId = await findReusableOwnedContainerTab(existingGroup.windowId, existingGroup.id);
    await persistRuntimeState();
    return {
      windowId: existingGroup.windowId,
      initialTabId,
    };
  }

  const startUrl = (initialUrl && isSafeNavigationUrl(initialUrl)) ? initialUrl : BLANK_PAGE;

  // hostWindowId was resolved above, before group adoption could override it.
  let initialTabId: number | undefined;

  if (hostWindowId !== undefined) {
    const hostTab = await chrome.tabs.create({
      windowId: hostWindowId,
      url: startUrl,
      active: wantsActiveTab(mode),
    });
    container.windowId = hostWindowId;
    container.borrowed = true;
    container.windowFallbackReason = null;
    initialTabId = hostTab.id;
    await persistRuntimeState();
    console.log(`[opencli] Using existing window ${hostWindowId} for ${role} container (start=${startUrl})`);
    await focusOwnedWindowIfRequested(hostWindowId, mode);
  } else {
    // Note: Do NOT set `state` parameter here. Chrome 146+ rejects 'normal' as an invalid
    // state value for windows.create(). The window defaults to 'normal' state anyway.
    const win = await chrome.windows.create({
      url: startUrl,
      focused: mode === 'foreground',
      width: 1280,
      height: 900,
      type: 'normal',
    });
    container.windowId = win.id!;
    container.borrowed = false;
    // Remember WHY a window was created rather than borrowed. `isolated` is the
    // person's own choice and needs no explanation; every other path here is a
    // fallback they will want to see the reason for in `sessions`.
    container.windowFallbackReason = wantsDedicated ? null : (host.reason ?? 'no-normal-window');
    // Persist windowId before any further awaits so a worker crash between
    // `windows.create` returning and the subsequent `tabs.group` call still
    // lets the next ensure cycle reuse this window instead of spawning a
    // second owned window in `chrome.windows.create`.
    await persistRuntimeState();
    console.log(`[opencli] Created owned ${role} window ${container.windowId} (start=${startUrl}${container.windowFallbackReason ? `, reason=${container.windowFallbackReason}` : ''})`);

    // Wait for the initial tab to finish loading instead of a fixed 200ms sleep.
    const winTabs = await chrome.tabs.query({ windowId: win.id! });
    initialTabId = winTabs[0]?.id;
  }

  const tabs = initialTabId !== undefined ? [await chrome.tabs.get(initialTabId).catch(() => undefined)].filter(Boolean) as chrome.tabs.Tab[] : [];
  if (initialTabId) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 500); // fallback cap
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === initialTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      // Check if already complete before listening
      if (tabs[0]?.status === 'complete') {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  }
  // Always pin: by this point the window is decided — created, or borrowed from
  // the person — and convergence must not relocate the tab we just put there.
  // Pinning only for `isolated` was not enough: a default-mode session created
  // its tab in the right window and then got dragged into whichever window held
  // the canonical group, which after any isolated run was the dedicated one.
  const group = await ensureOwnedContainerGroup(
    role,
    leaseKey,
    container.windowId,
    [initialTabId],
    container.windowId ?? undefined,
  );
  await persistRuntimeState();
  return { windowId: group?.windowId ?? container.windowId, initialTabId };
}

type HostWindowLookup = { windowId?: number; reason?: WindowFallbackReason };

/**
 * Pick the window the person is already working in, so automation opens a tab
 * there instead of spawning a second Chrome window.
 *
 * Both surfaces borrow. The person asked for this, they are looking at Chrome
 * right now, and a brand-new 1280x900 window landing on top of their layout is
 * a worse interruption than the tab itself — for an adapter run just as much as
 * for a `browser` command. Every session's tabs are grouped and labelled with
 * the session name, so they stay identifiable inside the shared window.
 *
 * Excludes windows we created ourselves (a dedicated container is never a host) and incognito
 * windows (different context; the session cookies would not be the user's).
 * Returns no `windowId` when there is no usable window, with a `reason` the
 * caller records so `sessions` can explain the window it then creates.
 */
async function findHostWindowForContainer(excludeWindowId?: number): Promise<HostWindowLookup> {
  const usable = (win: chrome.windows.Window | undefined): win is chrome.windows.Window =>
    win !== undefined && win.id !== undefined && win.type === 'normal' && !win.incognito;
  // Only windows we CREATED are off limits. A window a container is borrowing is
  // one of the person's, and the other role is as welcome in it as the first.
  const owned = new Set(
    Object.values(ownedContainers)
      .filter(container => !container.borrowed)
      .map(container => container.windowId)
      .filter((id): id is number => id !== null && id !== excludeWindowId),
  );
  // Dedicated windows are never a host, whatever the caller excludes.
  for (const id of dedicatedWindowIds()) owned.add(id);
  const eligible = (win: chrome.windows.Window) => usable(win) && !owned.has(win.id!);

  // `getLastFocused` is the right question: "which window was the person last in".
  // `getAll().find(w => w.focused)` is NOT — `focused` is false for every window
  // whenever Chrome itself is not the frontmost app, which is the normal state while
  // an agent drives it from a terminal. That fallback then picked an arbitrary window
  // (last in the list), which is how automation kept landing somewhere the person
  // was not looking.
  try {
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (eligible(lastFocused)) return { windowId: lastFocused.id };
  } catch { /* fall through to the full scan */ }

  let reason: WindowFallbackReason;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const normal = windows.filter(win => win !== undefined && win.id !== undefined && win.type === 'normal');
    const notIncognito = normal.filter(win => !win.incognito);
    const candidates = notIncognito.filter(eligible);
    if (candidates.length > 0) {
      return { windowId: (candidates.find(win => win.focused) ?? candidates[candidates.length - 1])!.id };
    }
    reason = normal.length === 0 ? 'no-normal-window'
      : notIncognito.length === 0 ? 'all-incognito'
      : 'all-owned';
  } catch {
    reason = 'query-failed';
  }

  // Nothing of the person's to borrow. A window we created only because they
  // had none open is a stand-in for theirs, so the other role shares it rather
  // than opening a second stand-in. A window created for `--window isolated`
  // carries no reason and is never shared this way — the person asked for that
  // one to stay apart.
  for (const container of Object.values(ownedContainers)) {
    if (container.windowId === null || container.windowId === excludeWindowId) continue;
    if (container.borrowed || container.windowFallbackReason === null) continue;
    if (isDedicatedWindow(container.windowId)) continue;
    try {
      const win = await chrome.windows.get(container.windowId);
      if (win && !win.incognito) return { windowId: container.windowId };
    } catch {
      // Gone; the caller will create a fresh one.
    }
  }
  return { reason };
}

async function findReusableOwnedContainerTab(windowId: number, ownedGroupId?: number | null): Promise<number | undefined> {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    // When a canonical owned group lives in a user window (cross-window
    // convergence can land it there), an http(s) tab outside the group is
    // user content and must not be reused. Group members and non-http tabs
    // (about:blank / data: / fresh container) stay eligible. A null group id
    // means no ownership signal exists, so only non-http placeholders qualify —
    // and only ones sitting in a group of ours or in no group at all: a blank
    // tab inside a group the person built is theirs, however blank it is.
    // In a window we merely borrowed there is nothing of ours to recycle (we
    // close placeholders there on release), so an ungrouped blank tab is the
    // person's and stays untouched.
    const borrowedWindow = Object.values(ownedContainers).some(c => c.windowId === windowId && c.borrowed);
    const inOurGroup = (tab: chrome.tabs.Tab): boolean =>
      typeof tab.groupId === 'number' && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && ownedGroupLedger.has(tab.groupId);
    const ungrouped = (tab: chrome.tabs.Tab): boolean =>
      typeof tab.groupId !== 'number' || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE;
    const reusable = tabs.find(tab =>
      tab.id !== undefined &&
      initialTabIsAvailable(tab.id) &&
      isDebuggableUrl(tab.url) &&
      (
        ownedGroupId === undefined ||
        (ownedGroupId !== null && tab.groupId === ownedGroupId) ||
        (!isSafeNavigationUrl(tab.url ?? '') && (inOurGroup(tab) || (ungrouped(tab) && !borrowedWindow)))
      ),
    );
    return reusable?.id;
  } catch {
    return undefined;
  }
}

function initialTabIsAvailable(tabId: number | undefined): tabId is number {
  if (tabId === undefined) return false;
  for (const session of automationSessions.values()) {
    if (session.owned && session.preferredTabId === tabId) return false;
  }
  return true;
}

// ─── Dedicated automation windows (`--window dedicated`) ────────────────
//
// "I use my windows, OpenCLI uses its own." A dedicated window is a normal
// window of the person's own Chrome profile (same cookies, same logins — never a
// separate profile or instance) that OpenCLI creates unfocused, optionally places
// on a given display, and keeps to itself:
//
//  - Lifecycle. One window per *slot* (default slot `default`). Created on the
//    first dedicated command, recreated on demand after it is closed, kept alive
//    between runs by a placeholder tab when its last lease is released. The id
//    lives in chrome.storage.session for the same reason the lease registry does:
//    window ids die with the browser session, and a recycled id must never make a
//    window of the person's look like ours.
//  - Placement. Explicit bounds, else a display-name pattern resolved through
//    chrome.system.display (same coordinate space as chrome.windows), else Chrome's
//    default. Detection lives here rather than in callers: the extension is the one
//    party that sees displays and windows in one coordinate system, and every
//    caller (CLI, scripts) gets it for free. Moving a window never passes `focused`.
//  - Ownership is decided by what OpenCLI itself recorded (lease tabs, placeholders,
//    our tab groups, tabs opened by our tabs) — never by "does the window contain
//    anything foreign". A foreign tab therefore cannot demote the window to
//    "borrowed"; it is moved back to the person's last-focused normal window
//    (policy `evict`, the default) or left alone and ignored (`tolerate`).
//    Evicting is the quieter choice: the window is meant to be out of sight, so a
//    tab that landed there (a link opened from another app while it was last
//    focused, Cmd+T, a drag) is lost to the person, and as the active tab it would
//    also hide the automation tab. A lease tab the person drags OUT becomes theirs.
//  - Visibility. Only a window's active tab is visible, so before every
//    page-scoped command the session's tab is made the active tab of its dedicated
//    window (`autoSelect`, default on; `tabs.update({active})` never focuses the
//    window). Sessions that need visibility at the same time use different slots —
//    one window each, tiled on the display — instead of queueing for one window: a
//    cross-process visibility lock would need holders, TTLs and stale-holder
//    recovery, and that is exactly the class of bug this code base keeps paying for.

type Rect = { left: number; top: number; width: number; height: number };
type ForeignTabPolicy = 'evict' | 'tolerate';
type DedicatedPlacement = {
  source: 'bounds' | 'display' | 'none';
  requestedBounds: Rect | null;
  displayPattern: string | null;
  displayName: string | null;
  displayFound: boolean | null;
  cell: number | null;
};
type DedicatedEnsureResult = { windowId: number; initialTabId?: number; created: boolean; moved: boolean };
type DedicatedSlotState = {
  slot: string;
  windowId: number | null;
  placeholderTabIds: Set<number>;
  placement: DedicatedPlacement;
  autoSelect: boolean;
  foreignTabPolicy: ForeignTabPolicy;
  evictedTabs: number;
  promise: Promise<DedicatedEnsureResult> | null;
};
type DisplayInfo = { id: string; name: string; primary: boolean; internal: boolean; bounds: Rect; workArea: Rect | null };
type DedicatedTabOwner = 'lease' | 'placeholder' | 'automation' | 'foreign';
type DedicatedPlacementRequest = { bounds?: Rect; display?: string };

const DEDICATED_SLOT_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
// Placeholder URL carries the slot, so a window orphaned by an extension reload (which
// clears chrome.storage.session) can be recognised and adopted instead of duplicated.
const DEDICATED_PLACEHOLDER_PREFIX = 'about:blank#opencli-dedicated=';
function dedicatedPlaceholderUrl(slot: string): string {
  return `${DEDICATED_PLACEHOLDER_PREFIX}${slot}`;
}
const DEDICATED_CELL = { width: 1280, height: 900, offsetX: 80, offsetY: 60 };
const DEDICATED_CAPABILITIES = ['dedicated-window', 'window-slots', 'window-bounds', 'window-display', 'auto-select', 'foreign-tab-policy'] as const;

function emptyDedicatedPlacement(): DedicatedPlacement {
  return { source: 'none', requestedBounds: null, displayPattern: null, displayName: null, displayFound: null, cell: null };
}

function normalizeDedicatedSlot(raw: unknown): string {
  return typeof raw === 'string' && DEDICATED_SLOT_PATTERN.test(raw) ? raw : DEFAULT_DEDICATED_SLOT;
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const finite = (k: string) => typeof r[k] === 'number' && Number.isFinite(r[k] as number);
  return finite('left') && finite('top') && finite('width') && finite('height')
    && (r.width as number) > 0 && (r.height as number) > 0;
}

function normalizeRect(r: Rect): Rect {
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function rectFromUnknown(value: unknown): Rect {
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k] as number) ? r[k] as number : 0);
  return { left: n('left'), top: n('top'), width: n('width'), height: n('height') };
}

function rectFromWindow(win: chrome.windows.Window | null | undefined): Rect | null {
  if (!win) return null;
  const { left, top, width, height } = win;
  if ([left, top, width, height].some(v => typeof v !== 'number')) return null;
  return { left: left!, top: top!, width: width!, height: height! };
}

function rectCenterInside(rect: Rect, area: Rect): boolean {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx >= area.left && cx < area.left + area.width && cy >= area.top && cy < area.top + area.height;
}

/** `/re/flags` → RegExp; anything else → case-insensitive substring. Same grammar the backlink scripts use. */
function compileDisplayMatcher(pattern: string | null | undefined): RegExp | null {
  const raw = typeof pattern === 'string' ? pattern.trim() : '';
  if (!raw) return null;
  const re = /^\/(.+)\/([a-z]*)$/i.exec(raw);
  if (re) {
    try {
      return new RegExp(re[1], re[2].replace(/[gy]/g, ''));
    } catch {
      // A malformed regex is treated as a literal substring below.
    }
  }
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * Matching non-primary display (the virtual screen, not the one the person looks at).
 * The primary display is used only when it is the ONLY display — e.g. the physical
 * screen went to sleep and the virtual one inherited the global origin — never while a
 * second display exists, however well its name matches.
 */
function pickDisplay(displays: DisplayInfo[] | null, pattern: string | null): DisplayInfo | null {
  const matcher = compileDisplayMatcher(pattern);
  if (!matcher || !displays) return null;
  const usable = (d: DisplayInfo) => d.bounds.width > 0 && d.bounds.height > 0 && matcher.test(d.name);
  const secondary = displays.find(d => !d.primary && usable(d));
  if (secondary) return secondary;
  return displays.length === 1 && usable(displays[0]) ? displays[0] : null;
}

function dedicatedCellGrid(display: Rect): { width: number; height: number; cols: number; rows: number; offsetX: number; offsetY: number } {
  const width = Math.max(1, Math.min(DEDICATED_CELL.width, display.width));
  const height = Math.max(1, Math.min(DEDICATED_CELL.height, display.height));
  const cols = Math.max(1, Math.floor(display.width / width));
  const rows = Math.max(1, Math.floor(display.height / height));
  const offsetX = Math.max(0, Math.min(DEDICATED_CELL.offsetX, Math.floor((display.width - cols * width) / cols)));
  const offsetY = Math.max(0, Math.min(DEDICATED_CELL.offsetY, Math.floor((display.height - rows * height) / rows)));
  return { width, height, cols, rows, offsetX, offsetY };
}

/**
 * Rectangle of tile `cell` on a display: a grid of non-overlapping 1280x900 cells
 * (clipped to the display). Non-overlap matters — a window fully covered by
 * another one is occluded, and occluded windows report `hidden`. Cells beyond the
 * grid wrap around (and then do overlap); `sessions`/`window status` show the cell.
 */
function computeDisplayCell(display: Rect, cell: number): Rect {
  const g = dedicatedCellGrid(display);
  const capacity = g.cols * g.rows;
  const index = ((Math.trunc(cell) % capacity) + capacity) % capacity;
  const col = index % g.cols;
  const row = Math.floor(index / g.cols);
  return {
    left: display.left + g.offsetX + col * (g.width + g.offsetX),
    top: display.top + g.offsetY + row * (g.height + g.offsetY),
    width: g.width,
    height: g.height,
  };
}

async function listDisplays(): Promise<{ displays: DisplayInfo[] | null; error?: string }> {
  const api = (chrome as unknown as { system?: { display?: { getInfo?: (callback: (info: unknown[]) => void) => unknown } } }).system?.display;
  if (typeof api?.getInfo !== 'function') {
    return { displays: null, error: 'chrome.system.display is unavailable (extension lacks the "system.display" permission; reload it)' };
  }
  try {
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      try {
        const maybe = api.getInfo!((info) => {
          const lastError = (chrome as unknown as { runtime?: { lastError?: { message?: string } } }).runtime?.lastError;
          if (lastError) reject(new Error(lastError.message ?? 'system.display.getInfo failed'));
          else resolve(info);
        });
        if (maybe && typeof (maybe as Promise<unknown[]>).then === 'function') (maybe as Promise<unknown[]>).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
    const displays = (Array.isArray(raw) ? raw : []).map((entry): DisplayInfo => {
      const d = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      return {
        id: String(d.id ?? ''),
        name: String(d.name ?? ''),
        primary: d.isPrimary === true,
        internal: d.isInternal === true,
        bounds: rectFromUnknown(d.bounds),
        workArea: d.workArea ? rectFromUnknown(d.workArea) : null,
      };
    });
    return { displays };
  } catch (err) {
    return { displays: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function getDedicatedSlot(slot: string): DedicatedSlotState {
  let state = dedicatedSlots.get(slot);
  if (!state) {
    state = {
      slot,
      windowId: null,
      placeholderTabIds: new Set(),
      placement: emptyDedicatedPlacement(),
      autoSelect: true,
      foreignTabPolicy: 'evict',
      evictedTabs: 0,
      promise: null,
    };
    dedicatedSlots.set(slot, state);
  }
  return state;
}

function dedicatedSlotForWindow(windowId: number | null | undefined): DedicatedSlotState | undefined {
  if (windowId === null || windowId === undefined) return undefined;
  for (const state of dedicatedSlots.values()) {
    if (state.windowId === windowId) return state;
  }
  return undefined;
}

function isDedicatedWindow(windowId: number | null | undefined): boolean {
  return dedicatedSlotForWindow(windowId) !== undefined;
}

function dedicatedWindowIds(): number[] {
  return [...dedicatedSlots.values()].map(s => s.windowId).filter((id): id is number => id !== null);
}

function forgetDedicatedWindow(state: DedicatedSlotState): void {
  state.windowId = null;
  state.placeholderTabIds.clear();
}

async function persistDedicatedState(): Promise<void> {
  const slots: Record<string, unknown> = {};
  for (const state of dedicatedSlots.values()) {
    slots[state.slot] = {
      windowId: state.windowId,
      placeholderTabIds: [...state.placeholderTabIds],
      placement: state.placement,
      autoSelect: state.autoSelect,
      foreignTabPolicy: state.foreignTabPolicy,
      evictedTabs: state.evictedTabs,
    };
  }
  try {
    await chrome.storage?.session?.set({ [DEDICATED_REGISTRY_KEY]: { version: 1, slots } });
  } catch {
    // Recovery aid only, like the lease registry.
  }
}

function coerceDedicatedPlacement(raw: unknown): DedicatedPlacement {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const source = p.source === 'bounds' || p.source === 'display' ? p.source : 'none';
  return {
    source,
    requestedBounds: isRect(p.requestedBounds) ? normalizeRect(p.requestedBounds) : null,
    displayPattern: typeof p.displayPattern === 'string' ? p.displayPattern : null,
    displayName: typeof p.displayName === 'string' ? p.displayName : null,
    displayFound: typeof p.displayFound === 'boolean' ? p.displayFound : null,
    cell: typeof p.cell === 'number' && Number.isInteger(p.cell) ? p.cell : null,
  };
}

/** Restore slot state after a service-worker restart; a window that no longer exists is forgotten. */
async function restoreDedicatedState(): Promise<void> {
  dedicatedSlots.clear();
  let stored: { version?: unknown; slots?: unknown } | undefined;
  try {
    const session = chrome.storage?.session;
    if (!session) return;
    const raw = await (session as unknown as { get(key: string): Promise<Record<string, unknown> | undefined> }).get(DEDICATED_REGISTRY_KEY);
    stored = raw?.[DEDICATED_REGISTRY_KEY] as typeof stored;
  } catch {
    return;
  }
  if (!stored || stored.version !== 1 || !stored.slots || typeof stored.slots !== 'object') return;
  for (const [slot, value] of Object.entries(stored.slots as Record<string, unknown>)) {
    if (!DEDICATED_SLOT_PATTERN.test(slot) || !value || typeof value !== 'object') continue;
    const raw = value as Record<string, unknown>;
    const state = getDedicatedSlot(slot);
    state.autoSelect = raw.autoSelect !== false;
    state.foreignTabPolicy = raw.foreignTabPolicy === 'tolerate' ? 'tolerate' : 'evict';
    state.evictedTabs = typeof raw.evictedTabs === 'number' ? raw.evictedTabs : 0;
    state.placement = coerceDedicatedPlacement(raw.placement);
    if (typeof raw.windowId !== 'number') continue;
    try {
      await chrome.windows.get(raw.windowId);
    } catch {
      continue;
    }
    state.windowId = raw.windowId;
    for (const tabId of Array.isArray(raw.placeholderTabIds) ? raw.placeholderTabIds : []) {
      if (typeof tabId !== 'number') continue;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId === raw.windowId) state.placeholderTabIds.add(tabId);
      } catch {
        // Closed while the worker was asleep.
      }
    }
  }
}

function dedicatedPlacementRequest(leaseKey: string): DedicatedPlacementRequest {
  const overrides = sessionOverrides.get(leaseKey);
  return {
    ...(overrides?.windowBounds ? { bounds: overrides.windowBounds } : {}),
    ...(overrides?.windowDisplay ? { display: overrides.windowDisplay } : {}),
  };
}

function dedicatedSlotNameFor(leaseKey: string): string {
  return normalizeDedicatedSlot(sessionOverrides.get(leaseKey)?.windowSlot);
}

/** Record the dedicated-mode fields a command carries. Slot-level policy is last-writer-wins. */
function applyDedicatedCommandFields(leaseKey: string, cmd: Command): void {
  const slot = normalizeDedicatedSlot(cmd.windowSlot);
  const patch: SessionOverrides = { windowSlot: slot, autoSelect: cmd.autoSelect !== false };
  // Placement is replaced as a whole: bounds and a display pattern never linger from an earlier command.
  if (isRect(cmd.windowBounds)) {
    patch.windowBounds = normalizeRect(cmd.windowBounds);
    patch.windowDisplay = typeof cmd.windowDisplay === 'string' && cmd.windowDisplay.trim() ? cmd.windowDisplay.trim() : undefined;
  } else if (typeof cmd.windowDisplay === 'string' && cmd.windowDisplay.trim()) {
    patch.windowDisplay = cmd.windowDisplay.trim();
    patch.windowBounds = undefined;
  }
  setSessionOverride(leaseKey, patch);
  const state = getDedicatedSlot(slot);
  state.autoSelect = patch.autoSelect !== false;
  if (cmd.foreignTabPolicy === 'evict' || cmd.foreignTabPolicy === 'tolerate') state.foreignTabPolicy = cmd.foreignTabPolicy;
}

function tabActivationFor(leaseKey: string): boolean {
  const mode = getWindowMode(leaseKey);
  if (mode === 'dedicated') return sessionOverrides.get(leaseKey)?.autoSelect !== false;
  return wantsActiveTab(mode);
}

/**
 * Where the slot's window should be. A request replaces the remembered placement;
 * no request reuses it, so a window recreated after being closed lands where the
 * last caller asked. Returns the target rectangle and the area whose containment
 * of the window's centre counts as "already placed" (the requested rectangle, or
 * the whole display — a window the person nudged within the display is left alone).
 */
async function resolveDedicatedTarget(state: DedicatedSlotState, request: DedicatedPlacementRequest): Promise<{ target: Rect | null; area: Rect | null }> {
  const previous = state.placement;
  if (request.bounds) {
    state.placement = { ...emptyDedicatedPlacement(), source: 'bounds', requestedBounds: normalizeRect(request.bounds), displayPattern: request.display ?? null };
  } else if (request.display) {
    state.placement = { ...emptyDedicatedPlacement(), source: 'display', displayPattern: request.display };
  }
  const placement = state.placement;
  if (placement.source === 'bounds' && placement.requestedBounds) {
    return { target: placement.requestedBounds, area: placement.requestedBounds };
  }
  if (placement.source !== 'display' || !placement.displayPattern) return { target: null, area: null };

  const { displays } = await listDisplays();
  const display = pickDisplay(displays, placement.displayPattern);
  if (!display) {
    placement.displayFound = false;
    placement.displayName = null;
    placement.cell = null;
    return { target: null, area: null };
  }
  const grid = dedicatedCellGrid(display.bounds);
  const capacity = grid.cols * grid.rows;
  const used = new Set<number>();
  for (const other of dedicatedSlots.values()) {
    // A slot whose window is being created right now holds its cell too.
    if (other === state || (other.windowId === null && other.promise === null)) continue;
    if (other.placement.source !== 'display' || other.placement.displayName !== display.name || other.placement.cell === null) continue;
    used.add(other.placement.cell % capacity);
  }
  const previousCell = previous.displayName === display.name ? previous.cell : null;
  let cell = previousCell !== null && !used.has(previousCell % capacity) ? previousCell : -1;
  for (let i = 0; cell < 0 && i < capacity; i += 1) if (!used.has(i)) cell = i;
  if (cell < 0) cell = used.size;
  placement.displayFound = true;
  placement.displayName = display.name;
  placement.cell = cell;
  return { target: computeDisplayCell(display.bounds, cell), area: display.bounds };
}

async function ensureDedicatedWindow(
  slot: string,
  request: DedicatedPlacementRequest & { reposition?: boolean; initialUrl?: string } = {},
): Promise<DedicatedEnsureResult> {
  const state = getDedicatedSlot(slot);
  const next = dedicatedEnsureQueue.catch(() => null).then(() => ensureDedicatedWindowUnlocked(state, request));
  const tracked: Promise<DedicatedEnsureResult> = next.finally(() => {
    if (state.promise === tracked) state.promise = null;
  });
  state.promise = tracked;
  dedicatedEnsureQueue = tracked.catch(() => null);
  return tracked;
}

async function ensureDedicatedWindowUnlocked(
  state: DedicatedSlotState,
  request: DedicatedPlacementRequest & { reposition?: boolean; initialUrl?: string },
): Promise<DedicatedEnsureResult> {
  let win: chrome.windows.Window | null = null;
  if (state.windowId !== null) {
    try {
      win = await chrome.windows.get(state.windowId);
    } catch {
      forgetDedicatedWindow(state);
    }
  }
  if (!win) {
    const adopted = await adoptOrphanDedicatedWindow(state);
    if (adopted) win = adopted;
  }
  const { target, area } = await resolveDedicatedTarget(state, request);
  let created = false;
  let moved = false;
  let createdTabId: number | undefined;
  if (!win || state.windowId === null) {
    const startUrl = request.initialUrl && isSafeNavigationUrl(request.initialUrl) ? request.initialUrl : dedicatedPlaceholderUrl(state.slot);
    dedicatedTabCreatesInFlight += 1;
    try {
      // Never focused, never `state` (Chrome 146+ rejects 'normal'), and sized even
      // when unplaced so it matches the other owned windows.
      const newWindow = await chrome.windows.create({
        url: startUrl,
        focused: false,
        type: 'normal',
        ...(target ?? { width: DEDICATED_CELL.width, height: DEDICATED_CELL.height }),
      });
      state.windowId = newWindow.id!;
      state.placeholderTabIds.clear();
      const initialTabs = await chrome.tabs.query({ windowId: state.windowId }).catch(() => [] as chrome.tabs.Tab[]);
      for (const tab of initialTabs) if (tab.id !== undefined) state.placeholderTabIds.add(tab.id);
      // The starter tab may already sit on the caller's URL; it is the lease candidate as-is.
      createdTabId = initialTabs.find(tab => tab.id !== undefined)?.id;
      created = true;
    } finally {
      dedicatedTabCreatesInFlight -= 1;
    }
    console.log(`[opencli] Created dedicated window ${state.windowId} (slot=${state.slot}, placement=${state.placement.source}${state.placement.displayName ? `:${state.placement.displayName}#${state.placement.cell}` : ''})`);
  } else if (request.reposition && target && area && (win.state === undefined || win.state === 'normal')) {
    // Minimized / maximized / fullscreen windows are reported, not moved: resizing one
    // would leave fullscreen (a Space switch on macOS) or un-minimize it.
    const current = rectFromWindow(win);
    if (!current || !rectCenterInside(current, area)) {
      // No `focused` here: moving the window must never raise it.
      const updateWindow = (chrome.windows as unknown as { update?: (id: number, info: Partial<Rect>) => Promise<unknown> }).update;
      if (typeof updateWindow === 'function') {
        try {
          await updateWindow(state.windowId, target);
          moved = true;
        } catch (err) {
          console.warn(`[opencli] Failed to move dedicated window ${state.windowId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  await persistDedicatedState();
  const initialTabId = createdTabId !== undefined && initialTabIsAvailable(createdTabId)
    ? createdTabId
    : await findDedicatedPlaceholder(state);
  return { windowId: state.windowId!, initialTabId, created, moved };
}

/**
 * After an extension reload the slot registry is gone but the window is not. Find a
 * window holding this slot's marked placeholder and take it back.
 */
async function adoptOrphanDedicatedWindow(state: DedicatedSlotState): Promise<chrome.windows.Window | null> {
  let marked: chrome.tabs.Tab[] = [];
  try {
    marked = (await chrome.tabs.query({})).filter(tab => tab.url === dedicatedPlaceholderUrl(state.slot) && tab.id !== undefined);
  } catch {
    return null;
  }
  for (const tab of marked) {
    if (isDedicatedWindow(tab.windowId)) continue;
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.type !== undefined && win.type !== 'normal') continue;
      if (win.incognito) continue;
      state.windowId = tab.windowId;
      state.placeholderTabIds.add(tab.id!);
      console.log(`[opencli] Adopted dedicated window ${tab.windowId} for slot ${state.slot} from its placeholder tab`);
      return win;
    } catch {
      // Gone between query and get.
    }
  }
  return null;
}

function isPlaceholderUrl(url: string | undefined): boolean {
  return !url || url === BLANK_PAGE || url.startsWith(DEDICATED_PLACEHOLDER_PREFIX);
}

/** A placeholder tab of this slot that no lease holds. Foreign tabs are never candidates. */
async function findDedicatedPlaceholder(state: DedicatedSlotState): Promise<number | undefined> {
  for (const tabId of [...state.placeholderTabIds]) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Someone typed a URL into the placeholder: it is their tab now, not ours to overwrite.
      if (!isPlaceholderUrl(tab.url)) {
        state.placeholderTabIds.delete(tabId);
        continue;
      }
      if (tab.windowId === state.windowId && initialTabIsAvailable(tabId)) return tabId;
      if (tab.windowId !== state.windowId) state.placeholderTabIds.delete(tabId);
    } catch {
      state.placeholderTabIds.delete(tabId);
    }
  }
  return undefined;
}

function ownedLeaseForTab(tabId: number): [string, TargetLease] | undefined {
  for (const entry of automationSessions.entries()) {
    if (entry[1].owned && entry[1].preferredTabId === tabId) return entry;
  }
  return undefined;
}

function isOpenCliTabId(tabId: number): boolean {
  if (ownedLeaseForTab(tabId)) return true;
  if (selfCreatedTabIds.has(tabId)) return true;
  for (const state of dedicatedSlots.values()) if (state.placeholderTabIds.has(tabId)) return true;
  return false;
}

function classifyDedicatedTab(state: DedicatedSlotState, tab: chrome.tabs.Tab): DedicatedTabOwner {
  if (tab.id === undefined) return 'foreign';
  if (ownedLeaseForTab(tab.id)) return 'lease';
  if (state.placeholderTabIds.has(tab.id)) return isPlaceholderUrl(tab.url) ? 'placeholder' : 'foreign';
  if (selfCreatedTabIds.has(tab.id)) return 'automation';
  // Opened by one of our tabs (target=_blank, window.open into a tab): automation's own doing.
  // Recorded so the ownership carries down an opener chain (SSO → OAuth → callback).
  const inOurGroup = typeof tab.groupId === 'number' && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && ownedGroupLedger.has(tab.groupId);
  if (inOurGroup || (typeof tab.openerTabId === 'number' && isOpenCliTabId(tab.openerTabId))) {
    selfCreatedTabIds.add(tab.id);
    return 'automation';
  }
  return 'foreign';
}

async function moveTabSelf(tabId: number, windowId: number): Promise<void> {
  // Our own moves must not read as the person dragging a tab.
  selfMovingTabIds.set(tabId, (selfMovingTabIds.get(tabId) ?? 0) + 1);
  try {
    await chrome.tabs.move(tabId, { windowId, index: -1 });
  } finally {
    setTimeout(() => {
      const left = (selfMovingTabIds.get(tabId) ?? 1) - 1;
      if (left <= 0) selfMovingTabIds.delete(tabId);
      else selfMovingTabIds.set(tabId, left);
    }, 2000);
  }
}

/** The person's window to send a foreign tab back to: last focused normal window that is not one of ours. */
async function findEvictionWindow(tab: chrome.tabs.Tab): Promise<number | undefined> {
  const created = new Set(
    Object.values(ownedContainers)
      .filter(container => !container.borrowed)
      .map(container => container.windowId)
      .filter((id): id is number => id !== null),
  );
  const eligible = (win: chrome.windows.Window | undefined): win is chrome.windows.Window =>
    !!win && win.id !== undefined && win.type === 'normal' && !!win.incognito === !!tab.incognito
    && win.id !== tab.windowId && !isDedicatedWindow(win.id) && !created.has(win.id);
  try {
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (eligible(lastFocused)) return lastFocused.id;
  } catch { /* fall through */ }
  try {
    const candidates = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(eligible);
    if (candidates.length > 0) return (candidates.find(win => win.focused) ?? candidates[candidates.length - 1]).id;
  } catch { /* no window to evict to */ }
  return undefined;
}

type ForeignTabCheck = 'evicted' | 'tolerated' | 'ours' | 'not-dedicated' | 'gone' | 'deferred' | 'stranded';

async function checkDedicatedForeignTab(tabId: number, attempt = 0): Promise<ForeignTabCheck> {
  await workerReady;
  // A lease being created or relocated may not have recorded its tab yet.
  if (dedicatedTabCreatesInFlight > 0 && attempt < 10) {
    setTimeout(() => { void checkDedicatedForeignTab(tabId, attempt + 1); }, Math.max(200, foreignTabSettleMs));
    return 'deferred';
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  }
  const state = dedicatedSlotForWindow(tab.windowId);
  if (!state) return 'not-dedicated';
  if (classifyDedicatedTab(state, tab) !== 'foreign') return 'ours';
  if (state.foreignTabPolicy === 'tolerate') return 'tolerated';
  const target = await findEvictionWindow(tab);
  if (target === undefined) {
    console.warn(`[opencli] Foreign tab ${tabId} in dedicated window ${state.windowId} (slot=${state.slot}) has no window of yours to go back to; leaving it`);
    return 'stranded';
  }
  try {
    await chrome.tabs.move(tabId, { windowId: target, index: -1 });
    // Shown where it went (it was opened or dragged by the person); the window itself is not focused.
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    state.evictedTabs += 1;
    await persistDedicatedState();
    console.log(`[opencli] Moved foreign tab ${tabId} out of dedicated window ${state.windowId} into window ${target}`);
    return 'evicted';
  } catch {
    return 'stranded';
  }
}

function scheduleForeignTabCheck(tabId: number): void {
  setTimeout(() => { void checkDedicatedForeignTab(tabId); }, foreignTabSettleMs);
}

async function handleTabAttached(tabId: number, info: { newWindowId: number }): Promise<void> {
  await workerReady;
  if (selfMovingTabIds.has(tabId)) return;
  let changed = false;
  for (const state of dedicatedSlots.values()) {
    if (state.windowId !== info.newWindowId && state.placeholderTabIds.delete(tabId)) changed = true;
  }
  if (isDedicatedWindow(info.newWindowId)) {
    if (changed) await persistDedicatedState();
    scheduleForeignTabCheck(tabId);
    return;
  }
  const owned = ownedLeaseForTab(tabId);
  if (owned && isDedicatedWindow(owned[1].windowId)) {
    // The person dragged a lease tab out of the dedicated window: it is theirs now.
    const [leaseKey, lease] = owned;
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    automationSessions.delete(leaseKey);
    sessionOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    await safeDetach(tabId);
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {
      // Dragging a tab out of its group usually ungroups it already.
    }
    console.log(`[opencli] Session ${lease.session} gave up tab ${tabId}: it was dragged out of its dedicated window`);
    await persistRuntimeState();
  }
  if (changed) await persistDedicatedState();
}

async function closeRedundantPlaceholders(state: DedicatedSlotState): Promise<void> {
  if (state.windowId === null || state.placeholderTabIds.size === 0) return;
  const hasLease = [...automationSessions.values()].some(s => s.owned && s.windowId === state.windowId && s.preferredTabId !== null);
  if (!hasLease) return;
  for (const tabId of [...state.placeholderTabIds]) {
    if (!initialTabIsAvailable(tabId)) continue;
    state.placeholderTabIds.delete(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // Only an untouched placeholder is ours to close.
    if (tab && isPlaceholderUrl(tab.url)) await chrome.tabs.remove(tabId).catch(() => {});
  }
  await persistDedicatedState();
}

async function createDedicatedTabLease(leaseKey: string, targetUrl: string): Promise<ResolvedTab> {
  const slot = dedicatedSlotNameFor(leaseKey);
  const state = getDedicatedSlot(slot);
  const role = getOwnedWindowRole(leaseKey);
  const active = tabActivationFor(leaseKey);
  dedicatedTabCreatesInFlight += 1;
  try {
    const { windowId, initialTabId } = await ensureDedicatedWindow(slot, {
      ...dedicatedPlacementRequest(leaseKey),
      reposition: true,
      initialUrl: targetUrl,
    });
    let tab: chrome.tabs.Tab;
    if (initialTabId !== undefined) {
      state.placeholderTabIds.delete(initialTabId);
      tab = await chrome.tabs.get(initialTabId);
      if (!isTargetUrl(tab.url, targetUrl)) {
        tab = await chrome.tabs.update(initialTabId, { url: targetUrl });
        await new Promise(resolve => setTimeout(resolve, 300));
        tab = await chrome.tabs.get(initialTabId);
      }
    } else {
      tab = await chrome.tabs.create({ windowId, url: targetUrl, active });
    }
    const tabId = tab.id;
    if (!tabId) throw new Error('Failed to create tab lease in dedicated window');
    selfCreatedTabIds.add(tabId);
    const group = await ensureOwnedContainerGroup(role, leaseKey, windowId, [tabId], windowId);
    if (active && !tab.active) tab = (await chrome.tabs.update(tabId, { active: true })) ?? tab;
    if (tab.windowId !== windowId) tab = await chrome.tabs.get(tabId);
    setLeaseSession(leaseKey, {
      session: getSessionFromKey(leaseKey),
      surface: getSurfaceFromKey(leaseKey),
      kind: 'owned',
      windowId: group?.windowId ?? windowId,
      owned: true,
      preferredTabId: tabId,
    });
    resetWindowIdleTimer(leaseKey);
    await persistDedicatedState();
    return { tabId, tab };
  } finally {
    dedicatedTabCreatesInFlight -= 1;
  }
}

/**
 * Per-command dedicated policy: a lease tab found outside its slot window (created
 * earlier in another mode, or the window was recreated) is moved in, then made the
 * window's active tab so it is the one that renders.
 */
async function applyDedicatedSessionPolicy(leaseKey: string, resolved: ResolvedTab): Promise<ResolvedTab> {
  const lease = automationSessions.get(leaseKey);
  if (!lease?.owned || lease.preferredTabId !== resolved.tabId) return resolved;
  const slot = dedicatedSlotNameFor(leaseKey);
  const state = getDedicatedSlot(slot);
  let tab = resolved.tab ?? await chrome.tabs.get(resolved.tabId);
  if (state.windowId === null || tab.windowId !== state.windowId) {
    dedicatedTabCreatesInFlight += 1;
    try {
      const { windowId } = await ensureDedicatedWindow(slot, { ...dedicatedPlacementRequest(leaseKey), reposition: true });
      if (tab.windowId !== windowId) {
        // Point the lease at its new window BEFORE moving: if the move empties the old
        // window, Chrome closes it and onRemoved must not take this lease with it.
        lease.windowId = windowId;
        await moveTabSelf(resolved.tabId, windowId);
        const group = await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, windowId, [resolved.tabId], windowId);
        lease.windowId = group?.windowId ?? windowId;
        console.log(`[opencli] Moved session ${lease.session} tab ${resolved.tabId} into dedicated window ${windowId} (slot=${slot})`);
        await closeRedundantPlaceholders(state);
        await persistRuntimeState();
      }
      tab = await chrome.tabs.get(resolved.tabId);
    } finally {
      dedicatedTabCreatesInFlight -= 1;
    }
  }
  if (sessionOverrides.get(leaseKey)?.autoSelect !== false && !tab.active) {
    tab = (await chrome.tabs.update(resolved.tabId, { active: true })) ?? tab;
  }
  return { tabId: resolved.tabId, tab };
}

/** Release of the lease tab inside a dedicated window: keep the window alive with one placeholder. */
async function releaseDedicatedLeaseTab(state: DedicatedSlotState, tabId: number): Promise<'removed' | 'placeholder'> {
  const run = dedicatedReleaseQueue.catch(() => null).then(() => releaseDedicatedLeaseTabUnlocked(state, tabId));
  dedicatedReleaseQueue = run.catch(() => null);
  return run;
}

async function releaseDedicatedLeaseTabUnlocked(state: DedicatedSlotState, tabId: number): Promise<'removed' | 'placeholder'> {
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'removed';
  }
  // Asked of the window itself, not of the lease table: two releases racing each other
  // must not both conclude "someone else keeps the window".
  let keepsWindow = tab.windowId !== state.windowId;
  if (!keepsWindow && state.windowId !== null) {
    const others = (await chrome.tabs.query({ windowId: state.windowId }).catch(() => [] as chrome.tabs.Tab[]))
      .filter(other => other.id !== undefined && other.id !== tabId);
    keepsWindow = others.some(other => classifyDedicatedTab(state, other) !== 'foreign');
  }
  if (keepsWindow) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return 'removed';
  }
  try {
    await chrome.tabs.update(tabId, { url: dedicatedPlaceholderUrl(state.slot) });
    await chrome.tabs.ungroup(tabId).catch(() => {});
    state.placeholderTabIds.add(tabId);
    await persistDedicatedState();
    return 'placeholder';
  } catch {
    await chrome.tabs.remove(tabId).catch(() => {});
    return 'removed';
  }
}

type DedicatedWindowInfo = {
  slot: string;
  windowId: number | null;
  exists: boolean;
  state: string | null;
  bounds: Rect | null;
  placement: DedicatedPlacement;
  onDisplay: boolean | null;
  activeTab: { tabId: number; owner: DedicatedTabOwner; session: string | null; url?: string; title?: string } | null;
  tabs: { total: number; leases: number; placeholders: number; automation: number; foreign: number };
  sessions: string[];
  autoSelect: boolean;
  foreignTabPolicy: ForeignTabPolicy;
  evictedTabs: number;
};

async function describeDedicatedSlot(state: DedicatedSlotState, displays: DisplayInfo[] | null): Promise<DedicatedWindowInfo> {
  let win: chrome.windows.Window | null = null;
  if (state.windowId !== null) {
    try {
      win = await chrome.windows.get(state.windowId);
    } catch {
      forgetDedicatedWindow(state);
    }
  }
  const bounds = rectFromWindow(win);
  let onDisplay: boolean | null = null;
  if (state.placement.displayPattern && displays) {
    const display = pickDisplay(displays, state.placement.displayPattern);
    onDisplay = display && bounds ? rectCenterInside(bounds, display.bounds) : false;
  }
  const counts = { total: 0, leases: 0, placeholders: 0, automation: 0, foreign: 0 };
  let activeTab: DedicatedWindowInfo['activeTab'] = null;
  const sessions: string[] = [];
  if (win && state.windowId !== null) {
    const tabs = await chrome.tabs.query({ windowId: state.windowId }).catch(() => [] as chrome.tabs.Tab[]);
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const owner = classifyDedicatedTab(state, tab);
      counts.total += 1;
      if (owner === 'lease') counts.leases += 1;
      else if (owner === 'placeholder') counts.placeholders += 1;
      else if (owner === 'automation') counts.automation += 1;
      else counts.foreign += 1;
      const lease = ownedLeaseForTab(tab.id);
      if (lease && !sessions.includes(lease[1].session)) sessions.push(lease[1].session);
      if (tab.active) {
        activeTab = {
          tabId: tab.id,
          owner,
          session: lease ? lease[1].session : null,
          // Foreign tabs are the person's: never echo their URL or title.
          ...(owner === 'foreign' ? {} : { url: tab.url, title: tab.title }),
        };
      }
    }
  }
  return {
    slot: state.slot,
    windowId: win ? state.windowId : null,
    exists: !!win,
    state: win?.state ?? null,
    bounds,
    placement: { ...state.placement },
    onDisplay: win ? onDisplay : null,
    activeTab,
    tabs: counts,
    sessions,
    autoSelect: state.autoSelect,
    foreignTabPolicy: state.foreignTabPolicy,
    evictedTabs: state.evictedTabs,
  };
}

async function handleDedicatedWindowOp(cmd: Command): Promise<Result> {
  if (cmd.op === 'window-ensure') {
    const slot = normalizeDedicatedSlot(cmd.windowSlot);
    const state = getDedicatedSlot(slot);
    if (cmd.foreignTabPolicy === 'evict' || cmd.foreignTabPolicy === 'tolerate') state.foreignTabPolicy = cmd.foreignTabPolicy;
    if (typeof cmd.autoSelect === 'boolean') state.autoSelect = cmd.autoSelect;
    const result = await ensureDedicatedWindow(slot, {
      ...(isRect(cmd.windowBounds) ? { bounds: normalizeRect(cmd.windowBounds) } : {}),
      ...(typeof cmd.windowDisplay === 'string' && cmd.windowDisplay.trim() ? { display: cmd.windowDisplay.trim() } : {}),
      reposition: true,
    });
    const { displays } = await listDisplays();
    return { id: cmd.id, ok: true, data: { ...(await describeDedicatedSlot(state, displays)), created: result.created, moved: result.moved } };
  }
  const { displays, error } = await listDisplays();
  const filter = typeof cmd.windowSlot === 'string' && cmd.windowSlot ? cmd.windowSlot : null;
  const windows: DedicatedWindowInfo[] = [];
  for (const state of [...dedicatedSlots.values()].sort((a, b) => a.slot.localeCompare(b.slot))) {
    if (filter && state.slot !== filter) continue;
    windows.push(await describeDedicatedSlot(state, displays));
  }
  return {
    id: cmd.id,
    ok: true,
    data: {
      supported: true,
      protocol: 1,
      capabilities: [...DEDICATED_CAPABILITIES],
      displays,
      ...(displays === null ? { displaysError: error } : {}),
      windows,
    },
  };
}

async function createOwnedTabLease(leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  return withLeaseMutation(() => createOwnedTabLeaseUnlocked(leaseKey, initialUrl));
}

async function createOwnedTabLeaseUnlocked(leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  const targetUrl = (initialUrl && isSafeNavigationUrl(initialUrl)) ? initialUrl : BLANK_PAGE;
  const role = getOwnedWindowRole(leaseKey);
  const mode = getWindowMode(leaseKey);
  if (mode === 'dedicated') return createDedicatedTabLease(leaseKey, targetUrl);
  const { windowId, initialTabId } = await ensureOwnedContainerWindow(role, leaseKey, targetUrl, mode);
  let tab: chrome.tabs.Tab;

  if (initialTabIsAvailable(initialTabId)) {
    tab = await chrome.tabs.get(initialTabId);
    if (!isTargetUrl(tab.url, targetUrl)) {
      tab = await chrome.tabs.update(initialTabId, { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 300));
      tab = await chrome.tabs.get(initialTabId);
    }
  } else {
    // Selecting the tab inside its window yanks the view away from whatever tab the
    // user was reading in that same window, so only do it when `foreground` or the
    // lighter `active` mode was explicitly asked for. Neither of those two touches
    // OS-level window focus here — that only happens via focusOwnedWindowIfRequested,
    // which is gated to `foreground` alone.
    tab = await chrome.tabs.create({ windowId, url: targetUrl, active: wantsActiveTab(mode) });
  }
  const tabId = tab.id;
  if (!tabId) throw new Error('Failed to create tab lease in automation container');
  // Same pinning as the container: an `isolated` lease must not be converged back
  // into a group living in the person's window.
  const group = await ensureOwnedContainerGroup(
    role,
    leaseKey,
    windowId,
    [tabId],
    mode === 'isolated' ? windowId : undefined,
  );
  const sessionWindowId = group?.windowId ?? tab.windowId;
  if (tab.windowId !== sessionWindowId) tab = await chrome.tabs.get(tabId);

  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: 'owned',
    windowId: sessionWindowId,
    owned: true,
    preferredTabId: tabId,
  });
  resetWindowIdleTimer(leaseKey);
  return { tabId, tab };
}

/** Get or create the container window for this lease (borrowed from the person by default).
 *  This compatibility helper returns the shared owned container. Leases
 *  lease tabs inside it instead of owning separate windows.
 */
async function getAutomationWindow(leaseKey: string, initialUrl?: string): Promise<number> {
  // Check if our window is still alive.
  const existing = automationSessions.get(leaseKey);
  if (existing) {
    if (!existing.owned) {
      throw new CommandFailure(
        'bound_window_operation_blocked',
        `Session "${existing.session}" is bound to a user tab and does not own an OpenCLI tab lease.`,
        'Use page commands on the bound tab, or unbind the session first.',
      );
    }
    try {
      const tabId = existing.preferredTabId;
      if (tabId !== null) {
        const tab = await chrome.tabs.get(tabId);
        if (isDebuggableUrl(tab.url)) return tab.windowId;
      }
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      // Tab/window was closed by user
      await removeLeaseSession(leaseKey);
    }
  }

  if (getWindowMode(leaseKey) === 'dedicated') {
    return (await ensureDedicatedWindow(dedicatedSlotNameFor(leaseKey), {
      ...dedicatedPlacementRequest(leaseKey),
      reposition: true,
      initialUrl,
    })).windowId;
  }
  const role = getOwnedWindowRole(leaseKey);
  return (await ensureOwnedContainerWindow(role, leaseKey, initialUrl, getWindowMode(leaseKey))).windowId;
}

// Clean up when an owned container window is closed
chrome.windows.onRemoved.addListener(async (windowId) => {
  // A window-close event can wake the worker before recovery; persisting the
  // empty pre-recovery snapshot here would wipe the registry.
  await workerReady;
  for (const role of Object.keys(ownedContainers) as OwnedWindowRole[]) {
    if (ownedContainers[role].windowId === windowId) forgetContainerWindow(role);
  }
  const dedicated = dedicatedSlotForWindow(windowId);
  if (dedicated) {
    // Recreated on demand by the next dedicated command, with the same placement.
    console.log(`[opencli] Dedicated window ${windowId} closed (slot=${dedicated.slot})`);
    forgetDedicatedWindow(dedicated);
    await persistDedicatedState();
  }
  for (const [leaseKey, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[opencli] ${session.surface} container closed (session=${session.session})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(leaseKey);
      sessionOverrides.delete(leaseKey);
      scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    }
  }
  await persistRuntimeState();
});

// Evict identity mappings when tabs are closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Same wake-before-recovery hazard as windows.onRemoved.
  await workerReady;
  identity.evictTab(tabId);
  selfCreatedTabIds.delete(tabId);
  let placeholderGone = false;
  for (const state of dedicatedSlots.values()) {
    if (state.placeholderTabIds.delete(tabId)) placeholderGone = true;
  }
  if (placeholderGone) await persistDedicatedState();
  for (const [leaseKey, session] of automationSessions.entries()) {
    if (session.preferredTabId === tabId) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(leaseKey);
      sessionOverrides.delete(leaseKey);
      scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
      console.log(`[opencli] Session ${session.session} detached from tab ${tabId} (tab closed)`);
    }
  }
  await persistRuntimeState();
});

// Dedicated windows: judge tabs that appear in them (created there, or attached by a
// drag / a link opened from another app), and let a lease tab dragged out go.
// Optional-chained: older test harnesses and Chrome builds may lack these events.
chrome.tabs.onCreated?.addListener?.((tab: chrome.tabs.Tab) => {
  void (async () => {
    await workerReady;
    if (tab.id === undefined) return;
    // The opener may be closed by the time the settle check runs; decide ownership now.
    if (typeof tab.openerTabId === 'number' && isOpenCliTabId(tab.openerTabId)) selfCreatedTabIds.add(tab.id);
    if (isDedicatedWindow(tab.windowId)) scheduleForeignTabCheck(tab.id);
  })();
});
chrome.tabs.onAttached?.addListener?.((tabId: number, info: chrome.tabs.TabAttachInfo) => {
  void handleTabAttached(tabId, info);
});

// ─── Lifecycle events ────────────────────────────────────────────────

let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); // Chrome production minimum: 30 seconds
  executor.registerListeners();
  try {
    const registerFrameTracking = (executor as { registerFrameTracking?: () => void }).registerFrameTracking;
    registerFrameTracking?.();
  } catch {
    // Some focused tests mock only the cdp functions they exercise.
  }
  // Migration cleanup: older versions persisted the registry in
  // chrome.storage.local, where its browser-session-scoped ids go stale after
  // a browser restart (see StoredRegistry). Remove that one legacy key —
  // nothing else in local — so it can never be trusted again. Fire-and-forget:
  // nothing reads the local copy anymore, so ordering does not matter.
  try {
    void chrome.storage?.local?.remove?.(REGISTRY_KEY)?.catch?.(() => {});
  } catch {
    // Best-effort cleanup.
  }
  // Rehydrate context + lease/container state before any event handler that
  // persists is allowed to run (see workerReady). connect() is deliberately
  // outside this promise — it awaits workerReady on its own, so keeping it out
  // avoids a self-wait while still ordering the socket after recovery.
  workerRecovered = false;
  workerReady = (async () => {
    await getCurrentContextId();
    await reconcileTargetLeaseRegistry();
  })().catch((err) => {
    // Never leave workerReady rejected/pending: a wedged gate would freeze
    // every gated handler for the life of the worker.
    console.warn(`[opencli] Startup recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => {
    workerRecovered = true;
  });
  void workerReady.then(() => connect());
  console.log('[opencli] OpenCLI extension initialized');
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

// MV3 service workers can be started by events other than install/startup
// (including unpacked-extension e2e launches). Initialize on every worker load;
// initialize() is idempotent, so lifecycle events remain harmless.
initialize();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Idle-lease alarms and keepalive can both fire in a freshly woken worker;
  // gate on recovery so releaseLease never persists an empty snapshot.
  await workerReady;
  if (alarm.name === 'keepalive') void connect();
  const leaseKey = leaseKeyFromAlarmName(alarm.name);
  if (!leaseKey) return;
  if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) {
    // A command is mid-flight (the alarm can fire while a long command runs
    // in a woken worker) — defer; command completion re-arms the idle timer.
    resetWindowIdleTimer(leaseKey);
    return;
  }
  await releaseLease(leaseKey, 'idle alarm');
});

// ─── Popup status API ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getStatus') {
    void (async () => {
      const contextId = await getCurrentContextId();
      const connected = ws?.readyState === WebSocket.OPEN;
      const extensionVersion = chrome.runtime.getManifest().version;
      const daemonVersion = connected ? await fetchDaemonVersion() : null;
      sendResponse({
        connected,
        reconnecting: reconnectTimer !== null,
        contextId,
        extensionVersion,
        daemonVersion,
      });
    })();
    return true;
  }
  return false;
});

/**
 * Best-effort fetch of the daemon's reported version for the popup status panel.
 * Resolves to null on any failure — the popup degrades to showing connection
 * state without the version label.
 */
async function fetchDaemonVersion(): Promise<string | null> {
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${DAEMON_PORT}/status`, {
      method: 'GET',
      headers: { 'X-OpenCLI': '1' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = await res.json() as { daemonVersion?: unknown };
    return typeof body.daemonVersion === 'string' ? body.daemonVersion : null;
  } catch {
    return null;
  }
}

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  // Session-independent actions — handle before session resolution.
  if (cmd.action === 'sessions') return handleSessions(cmd);

  const session = getSessionName(cmd.session);
  const surface = getCommandSurface(cmd);
  const leaseKey = getLeaseKey(session, surface);
  if (isWindowMode(cmd.windowMode)) {
    setSessionOverride(leaseKey, { windowMode: cmd.windowMode });
    if (cmd.windowMode === 'dedicated') applyDedicatedCommandFields(leaseKey, cmd);
  }
  if (surface === 'adapter' && (cmd.siteSession === 'persistent' || cmd.siteSession === 'ephemeral')) {
    setSessionOverride(leaseKey, { lifecycle: cmd.siteSession });
  }
  // Apply custom idle timeout if specified in the command
  if (cmd.idleTimeout != null && cmd.idleTimeout > 0) {
    setSessionOverride(leaseKey, { idleTimeoutMs: cmd.idleTimeout * 1000 });
  }
  // Reset idle timer on every command (window stays alive while active).
  // The in-flight refcount below additionally blocks idle release while a
  // long command is still executing — otherwise a 30s idle timer could tear
  // the tab down mid-command.
  resetWindowIdleTimer(leaseKey);
  activeCommandCounts.set(leaseKey, (activeCommandCounts.get(leaseKey) ?? 0) + 1);
  try {
    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd, leaseKey);
      case 'navigate':
        return await handleNavigate(cmd, leaseKey);
      case 'tabs':
        return await handleTabs(cmd, leaseKey);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd, leaseKey);
      case 'close-window':
        return await handleCloseWindow(cmd, leaseKey);
      case 'cdp':
        return await handleCdp(cmd, leaseKey);
      case 'set-file-input':
        return await handleSetFileInput(cmd, leaseKey);
      case 'insert-text':
        return await handleInsertText(cmd, leaseKey);
      case 'bind':
        return await handleBind(cmd, leaseKey);
      case 'network-capture-start':
        return await handleNetworkCaptureStart(cmd, leaseKey);
      case 'network-capture-read':
        return await handleNetworkCaptureRead(cmd, leaseKey);
      case 'wait-download':
        return await handleWaitDownload(cmd);
      case 'frames':
        return await handleFrames(cmd, leaseKey);
      case 'contexts':
        return await handleContexts(cmd, leaseKey);
      case 'clipboard':
        return await handleClipboard(cmd);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return errorResult(cmd.id, err);
  } finally {
    const remaining = (activeCommandCounts.get(leaseKey) ?? 1) - 1;
    if (remaining <= 0) activeCommandCounts.delete(leaseKey);
    else activeCommandCounts.set(leaseKey, remaining);
    // Grant a fresh idle window measured from command COMPLETION, not start.
    resetWindowIdleTimer(leaseKey);
  }
}

// ─── Action handlers ─────────────────────────────────────────────────

/** Internal blank page used when no user URL is provided. */
const BLANK_PAGE = 'about:blank';

/** Default navigate() timeout when the command carries no `timeoutMs` (older CLI, or unset). */
const DEFAULT_NAVIGATE_TIMEOUT_MS = 15000;

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

/** Check if a URL is safe for user-facing navigation (http/https only). */
function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Minimal URL normalization for same-page comparison: root slash + default port only. */
function normalizeUrlForComparison(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl: string | undefined, targetUrl: string): boolean {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}

function getUrlOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function enumerateCrossOriginFrames(tree: any): Array<{ index: number; frameId: string; url: string; name: string }> {
  const frames: Array<{ index: number; frameId: string; url: string; name: string }> = [];

  function collect(node: any, accessibleOrigin: string | null) {
    for (const child of (node.childFrames || [])) {
      const frame = child.frame;
      const frameUrl = frame.url || frame.unreachableUrl || '';
      const frameOrigin = getUrlOrigin(frameUrl);

      // Mirror dom-snapshot's [F#] rules:
      // - same-origin frames expand inline and do not get an [F#] slot
      // - cross-origin / blocked frames get one slot and stop recursion there
      if (accessibleOrigin && frameOrigin && frameOrigin === accessibleOrigin) {
        collect(child, frameOrigin);
        continue;
      }

      frames.push({
        index: frames.length,
        frameId: frame.id,
        url: frameUrl,
        name: frame.name || '',
      });
    }
  }

  const rootFrame = tree?.frameTree?.frame;
  const rootUrl = rootFrame?.url || rootFrame?.unreachableUrl || '';
  collect(tree.frameTree, getUrlOrigin(rootUrl));
  return frames;
}

/**
 * Cross-origin frame list for a tab, merging Page.getFrameTree's childFrames
 * (same-process frames) with chrome.debugger's OOPIF targets (cross-origin
 * frames that site isolation moves out of the parent page's frame tree, so
 * they never show up as childFrames — see executor.listIframeTargets).
 * Shared by handleFrames and handleExec's frameIndex branch so both use the
 * same index ordering.
 */
async function enumerateFramesForTab(tabId: number): Promise<{ frames: Array<{ index: number; frameId: string; url: string; name: string }>; debug: Record<string, unknown> }> {
  const tree = await executor.getFrameTree(tabId);
  const frames = enumerateCrossOriginFrames(tree);
  const knownFrameIds = new Set(frames.map((f) => f.frameId));
  const treeChildCount = frames.length;

  let iframeTargets: Array<{ targetId: string; url: string; title: string }> = [];
  let debug: Record<string, unknown> = {};
  try {
    const result = await executor.listIframeTargets(tabId);
    iframeTargets = result.targets;
    debug = result.debug;
  } catch (err) {
    // OOPIF discovery is best-effort — fall back to the frame-tree-only list.
    debug = { listError: String(err) };
  }
  for (const target of iframeTargets) {
    if (!target.targetId || knownFrameIds.has(target.targetId)) continue;
    knownFrameIds.add(target.targetId);
    frames.push({
      index: frames.length,
      frameId: target.targetId,
      url: target.url,
      name: target.title || '',
    });
  }
  return { frames, debug: { treeChildCount, ...debug } };
}

function setLeaseSession(
  leaseKey: string,
  session: Omit<TargetLease, 'idleTimer' | 'idleDeadlineAt' | 'contextId' | 'ownership' | 'lifecycle' | 'windowRole'>,
): void {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  automationSessions.set(leaseKey, {
    ...makeSession(leaseKey, session),
    idleTimer: null,
    idleDeadlineAt: timeout <= 0 ? 0 : Date.now() + timeout,
  });
  void persistRuntimeState();
}

/**
 * Resolve tabId from command's page (targetId).
 * Returns undefined if no page identity is provided.
 */
async function resolveCommandTabId(cmd: Command): Promise<number | undefined> {
  if (cmd.page) return identity.resolveTabId(cmd.page);
  return undefined;
}

type ResolvedTab = { tabId: number; tab: chrome.tabs.Tab | null };

/**
 * Resolve target tab for the session lease, returning both the tabId and
 * the Tab object (when available) so callers can skip a redundant chrome.tabs.get().
 */
async function resolveTab(tabId: number | undefined, leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  const resolved = await resolveTabForLease(tabId, leaseKey, initialUrl);
  if (getWindowMode(leaseKey) !== 'dedicated') return resolved;
  return applyDedicatedSessionPolicy(leaseKey, resolved);
}

async function resolveTabForLease(tabId: number | undefined, leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  const existingSession = automationSessions.get(leaseKey);
  // Even when an explicit tabId is provided, validate it is still debuggable.
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = existingSession;
      const matchesSession = session
        ? (session.preferredTabId !== null ? session.preferredTabId === tabId : tab.windowId === session.windowId)
        : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return { tabId, tab };
      if (session && !session.owned) {
        throw new CommandFailure(
          matchesSession ? 'bound_tab_not_debuggable' : 'bound_tab_mismatch',
          matchesSession
            ? `Bound tab for session "${session.session}" is not debuggable (${tab.url ?? 'unknown URL'}).`
            : `Target tab is not the tab bound to session "${session.session}".`,
          'Run "opencli browser bind" again on a debuggable http(s) tab.',
        );
      }
      if (session && !matchesSession && session.preferredTabId === null && isDebuggableUrl(tab.url)) {
        // Tab drifted to another window but content is still valid.
        // Try to move it back instead of abandoning it.
        console.warn(`[opencli] Tab ${tabId} drifted to window ${tab.windowId}, moving back to ${session.windowId}`);
        try {
          await chrome.tabs.move(tabId, { windowId: session.windowId, index: -1 });
          const moved = await chrome.tabs.get(tabId);
          if (moved.windowId === session.windowId && isDebuggableUrl(moved.url)) {
            return { tabId, tab: moved };
          }
        } catch (moveErr) {
          console.warn(`[opencli] Failed to move tab back: ${moveErr}`);
        }
      } else if (!isDebuggableUrl(tab.url)) {
        console.warn(`[opencli] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      if (existingSession && !existingSession.owned) {
        automationSessions.delete(leaseKey);
        throw new CommandFailure(
          'bound_tab_gone',
          `Bound tab for session "${existingSession.session}" no longer exists.`,
          'Run "opencli browser bind" again, then retry the command.',
        );
      }
      console.warn(`[opencli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  const existingPreferredTabId = existingSession?.preferredTabId ?? null;
  if (existingSession && existingPreferredTabId !== null) {
    const session = existingSession;
    try {
      const preferredTab = await chrome.tabs.get(existingPreferredTabId);
      if (isDebuggableUrl(preferredTab.url)) return { tabId: preferredTab.id!, tab: preferredTab };
      if (!session.owned) {
        throw new CommandFailure(
          'bound_tab_not_debuggable',
          `Bound tab for session "${session.session}" is not debuggable (${preferredTab.url ?? 'unknown URL'}).`,
          'Switch the tab to an http(s) page or run "opencli browser bind" on another tab.',
        );
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      await removeLeaseSession(leaseKey);
      if (!session.owned) {
        throw new CommandFailure(
          'bound_tab_gone',
          `Bound tab for session "${session.session}" no longer exists.`,
          'Run "opencli browser bind" again, then retry the command.',
        );
      }
      return createOwnedTabLease(leaseKey, initialUrl);
    }
  }

  if (!existingSession || (existingSession.owned && existingSession.preferredTabId === null)) {
    // When no URL is provided (non-navigation commands like eval/click/state),
    // refuse to auto-create a blank tab for a session that doesn't exist.
    // This prevents a common mistake where $$ in shell expands to a different
    // PID on each Bash tool invocation, silently creating orphan blank tabs
    // instead of reusing the intended session.
    // Only guard the user-facing `opencli browser <session> ...` surface. Adapter
    // leases (COOKIE/INTERCEPT/UI strategies) legitimately open their automation tab
    // without a URL, so applying this guard to them breaks every browser-backed
    // adapter command — and `opencli doctor`'s probe along with them.
    if (!existingSession && !initialUrl && getSurfaceFromKey(leaseKey) === 'browser') {
      const sessionName = getSessionFromKey(leaseKey);
      const activeSessions: string[] = [];
      for (const [k, s] of automationSessions.entries()) {
        if (s.owned) {
          const name = getSessionFromKey(k);
          const url = s.preferredTabId != null
            ? await chrome.tabs.get(s.preferredTabId).then(t => t.url ?? '(unknown)').catch(() => '(closed)')
            : '(no tab)';
          activeSessions.push(`  ${name}  ${url}`);
        }
      }
      const sessionList = activeSessions.length > 0
        ? `\nActive sessions:\n${activeSessions.join('\n')}`
        : '\nNo active sessions.';
      throw new CommandFailure(
        'session_not_found',
        `No active session "${sessionName}".${sessionList}`,
        'Open a URL first with "opencli browser <session> open <url>". If using $$ for session names, note that $$ changes with each shell process — use a fixed name instead.',
      );
    }
    return createOwnedTabLease(leaseKey, initialUrl);
  }

  // Get (or create) the container window for this lease
  const windowId = await getAutomationWindow(leaseKey, initialUrl);

  const role = getOwnedWindowRole(leaseKey);
  const group = existingSession?.owned ? await ensureOwnedContainerGroup(role, leaseKey, windowId, []) : null;
  const scopedWindowId = group?.windowId ?? windowId;
  const reusableTabId = await findReusableOwnedContainerTab(scopedWindowId, existingSession?.owned ? (group?.id ?? null) : undefined);
  if (reusableTabId !== undefined) return { tabId: reusableTabId, tab: await chrome.tabs.get(reusableTabId) };

  // No debuggable tab — another extension may have hijacked the tab URL.
  // Only recycle arbitrary tabs for legacy unscoped sessions. Owned sessions
  // without a group signal must create a fresh tab rather than overwrite user
  // content in a window where an OpenCLI group may have disappeared.
  const tabs = await chrome.tabs.query({ windowId: scopedWindowId });
  const reuseTab = existingSession?.owned ? undefined : tabs.find(t => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return { tabId: reuseTab.id, tab: updated };
      console.warn(`[opencli] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
      // Tab was closed during navigation
    }
  }

  // Fallback: create a new tab. Not active unless foreground/active was asked for —
  // see createOwnedTabLeaseUnlocked.
  const newTab = await chrome.tabs.create({
    windowId: scopedWindowId,
    url: BLANK_PAGE,
    active: tabActivationFor(leaseKey),
  });
  if (!newTab.id) throw new Error('Failed to create tab in automation container');
  await ensureOwnedContainerGroup(role, leaseKey, scopedWindowId, [newTab.id]);
  return { tabId: newTab.id, tab: await chrome.tabs.get(newTab.id) };
}

/** Build a page-scoped success result with targetId resolved from tabId */
async function pageScopedResult(id: string, tabId: number, data?: unknown): Promise<Result> {
  const page = await identity.resolveTargetId(tabId);
  return { id, ok: true, data, page };
}

/** Convenience wrapper returning just the tabId (used by most handlers) */
async function resolveTabId(tabId: number | undefined, leaseKey: string, initialUrl?: string): Promise<number> {
  const resolved = await resolveTab(tabId, leaseKey, initialUrl);
  return resolved.tabId;
}

async function listAutomationTabs(leaseKey: string): Promise<chrome.tabs.Tab[]> {
  const session = automationSessions.get(leaseKey);
  if (!session) return [];
  if (session.preferredTabId !== null) {
    try {
      return [await chrome.tabs.get(session.preferredTabId)];
    } catch {
      automationSessions.delete(leaseKey);
      return [];
    }
  }
  try {
    return await chrome.tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(leaseKey);
    return [];
  }
}

async function listAutomationWebTabs(leaseKey: string): Promise<chrome.tabs.Tab[]> {
  const tabs = await listAutomationTabs(leaseKey);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

/**
 * Derive the per-command CDP deadline from the command's absolute deadline
 * (preferred — remaining budget absorbs service-worker wake and queueing
 * latency) or the legacy duration field. Undercut by 5s so this (more
 * specific) error reaches the CLI before the daemon's generic timer fires.
 * Returns undefined when the command carries neither — callers fall back to
 * the executor's default deadline.
 */
function commandCdpTimeoutMs(cmd: Command): number | undefined {
  if (typeof cmd.deadlineAt === 'number' && cmd.deadlineAt > 0) {
    return Math.max(10_000, cmd.deadlineAt - Date.now() - 5_000);
  }
  if (typeof cmd.timeout === 'number' && cmd.timeout > 0) {
    return Math.max(10_000, cmd.timeout * 1000 - 5_000);
  }
  return undefined;
}

/**
 * Map an executor error to a machine-readable code so the CLI can decide
 * retry safety without regex-matching message text:
 * - `attach_failed` / `tab_gone`: failed BEFORE any page code ran — a new
 *   logical attempt is safe;
 * - `target_navigated`: the document changed under the command — the page
 *   layer decides whether to settle-retry;
 * - `detached_mid_command` / `cdp_timeout`: died MID-execution — the outcome
 *   is unknown, a blind re-run could double-apply a write.
 */
function classifyExtensionError(message: string): string | undefined {
  if (/Inspected target navigated|Target closed/.test(message)) return 'target_navigated';
  if (/Detached while handling command/.test(message)) return 'detached_mid_command';
  if (/CDP command .* timed out/.test(message)) return 'cdp_timeout';
  if (/attach failed|Debugger is not attached/.test(message)) return 'attach_failed';
  if (/No tab with id|no longer exists|No window with id/.test(message)) return 'tab_gone';
  if (/No iframe target found for frame|No session with given id|Cannot find context with specified id/.test(message)) return 'frame_not_attached';
  return undefined;
}

function errorResult(id: string, err: unknown): Result {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CommandFailure) {
    return { id, ok: false, error: message, errorCode: err.code, ...(err.hint ? { errorHint: err.hint } : {}) };
  }
  const errorCode = classifyExtensionError(message);
  return { id, ok: false, error: message, ...(errorCode ? { errorCode } : {}) };
}

async function handleExec(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === 'browser';
    if (cmd.frameIndex != null) {
      const { frames } = await enumerateFramesForTab(tabId);
      if (cmd.frameIndex < 0 || cmd.frameIndex >= frames.length) {
        return { id: cmd.id, ok: false, error: `Frame index ${cmd.frameIndex} out of range (${frames.length} cross-origin frames available)` };
      }
      const data = await executor.evaluateInFrame(tabId, cmd.code, frames[cmd.frameIndex].frameId, aggressive, commandCdpTimeoutMs(cmd));
      return pageScopedResult(cmd.id, tabId, data);
    }
    if (cmd.execContextId != null) {
      await executor.ensureAttached(tabId, aggressive);
      // A context id created in a child OOPIF flatten session is NOT visible
      // to a Runtime.evaluate sent on the plain {tabId} (tab-level) debuggee.
      // Sending it there anyway does not error -- each flatten session numbers
      // its own contexts independently, so it silently evaluates a
      // same-numbered context in the wrong (main) frame instead. Resolve
      // which session actually owns this context id and route there; if it
      // is unknown or its session has since gone away, fail loudly with a
      // machine-readable code instead of guessing.
      const owner = executor.resolveContextSession(tabId, cmd.execContextId);
      if (!owner) {
        return {
          id: cmd.id,
          ok: false,
          error: `Execution context ${cmd.execContextId} is not known for this tab (use "browser contexts" for current ids)`,
          errorCode: 'frame_not_attached',
        };
      }
      if (!owner.live) {
        return {
          id: cmd.id,
          ok: false,
          error: `Execution context ${cmd.execContextId}'s frame session has detached or navigated away; re-run "browser contexts" and retry`,
          errorCode: 'frame_not_attached',
        };
      }
      const debuggee = (owner.sessionId
        ? { tabId, sessionId: owner.sessionId }
        : { tabId }) as chrome.debugger.Debuggee;
      const result = await executor.sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
        expression: cmd.code,
        contextId: cmd.execContextId,
        returnByValue: true,
        awaitPromise: true,
      }, commandCdpTimeoutMs(cmd)) as {
        result?: { value?: unknown };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Evaluation error in context';
        return { id: cmd.id, ok: false, error: errMsg };
      }
      return pageScopedResult(cmd.id, tabId, result.result?.value);
    }
    const data = await executor.evaluateAsync(tabId, cmd.code, aggressive, commandCdpTimeoutMs(cmd));
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleFrames(cmd: Command, leaseKey: string): Promise<Result> {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const result = await enumerateFramesForTab(tabId);
    if (cmd.debug) {
      return { id: cmd.id, ok: true, data: result };
    }
    return { id: cmd.id, ok: true, data: result.frames };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleContexts(cmd: Command, leaseKey: string): Promise<Result> {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === 'browser';
    await executor.ensureAttached(tabId, aggressive);
    const contexts = executor.getAllContexts(tabId);
    return { id: cmd.id, ok: true, data: contexts };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleNavigate(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
  }
  // Pass target URL so that first-time window creation can start on the right domain
  const cmdTabId = await resolveCommandTabId(cmd);
  const resolved = await resolveTab(cmdTabId, leaseKey, cmd.url);
  const tabId = resolved.tabId;

  const beforeTab = resolved.tab ?? await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  // Fast-path: tab is already at the target URL and fully loaded.
  if (beforeTab.status === 'complete' && isTargetUrl(beforeTab.url, targetUrl)) {
    return pageScopedResult(cmd.id, tabId, { title: beforeTab.title, url: beforeTab.url, timedOut: false });
  }

  // Detach any existing debugger before top-level navigation unless network
  // capture is already armed on this tab. Otherwise we would clear the capture
  // state right before the page load we are trying to observe.
  // Some sites (observed on creator.xiaohongshu.com flows) can invalidate the
  // current inspected target during navigation, which leaves a stale CDP attach
  // state and causes the next Runtime.evaluate to fail with
  // "Inspected target navigated or closed". Resetting here forces a clean
  // re-attach after navigation when capture is not active.
  if (!executor.hasActiveNetworkCapture(tabId)) {
    await executor.detach(tabId);
  }

  await chrome.tabs.update(tabId, { url: targetUrl });

  // Wait until navigation completes. Resolve when status is 'complete' AND either:
  // - the URL matches the target (handles same-URL / canonicalized navigations), OR
  // - the URL differs from the pre-navigation URL (handles redirects).
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const isNavigationDone = (url: string | undefined): boolean => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isNavigationDone(tab.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also check if the tab already navigated (e.g. instant cache hit)
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === 'complete' && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch { /* tab gone */ }
    }, 100);

    // Timeout fallback with warning. `cmd.timeoutMs` carries the CLI's --timeout
    // / OPENCLI_NAV_TIMEOUT_MS value; missing/undefined (older CLI) keeps the
    // previous hardcoded default so older clients see unchanged behavior.
    const navTimeoutMs = cmd.timeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[opencli] Navigate to ${targetUrl} timed out after ${navTimeoutMs}ms`);
      finish();
    }, navTimeoutMs);
  });

  let tab = await chrome.tabs.get(tabId);

  // Post-navigation drift detection: if the tab moved to another window
  // during navigation (e.g. a tab-management extension regrouped it),
  // try to move it back to maintain session isolation.
  const postNavigationSession = automationSessions.get(leaseKey);
  if (postNavigationSession && tab.windowId !== postNavigationSession.windowId) {
    console.warn(`[opencli] Tab ${tabId} drifted to window ${tab.windowId} during navigation, moving back to ${postNavigationSession.windowId}`);
    try {
      await chrome.tabs.move(tabId, { windowId: postNavigationSession.windowId, index: -1 });
      tab = await chrome.tabs.get(tabId);
    } catch (moveErr) {
      console.warn(`[opencli] Failed to recover drifted tab: ${moveErr}`);
    }
  }

  return pageScopedResult(cmd.id, tabId, { title: tab.title, url: tab.url, timedOut });
}

async function handleTabs(cmd: Command, leaseKey: string): Promise<Result> {
  const session = automationSessions.get(leaseKey);
  if (session && !session.owned && cmd.op !== 'list') {
    return {
      id: cmd.id,
      ok: false,
      errorCode: 'bound_tab_mutation_blocked',
      error: `Session "${session.session}" is bound to a user tab; tab new/select/close requires an owned OpenCLI session.`,
      errorHint: 'Unbind the session first, or use a different session for owned OpenCLI tabs.',
    };
  }
  switch (cmd.op) {
    case 'list': {
      const tabs = await listAutomationWebTabs(leaseKey);
      const data = await Promise.all(tabs.map(async (t, i) => {
        let page: string | undefined;
        try { page = t.id ? await identity.resolveTargetId(t.id) : undefined; } catch { /* skip */ }
        return { index: i, page, url: t.url, title: t.title, active: t.active };
      }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
      }
      if (!automationSessions.has(leaseKey)) {
        const created = await createOwnedTabLease(leaseKey, cmd.url);
        return pageScopedResult(cmd.id, created.tabId, { url: created.tab?.url });
      }
      const windowId = await getAutomationWindow(leaseKey);
      let tab = await chrome.tabs.create({
        windowId,
        url: cmd.url ?? BLANK_PAGE,
        active: tabActivationFor(leaseKey),
      });
      if (tab.id !== undefined && isDedicatedWindow(windowId)) selfCreatedTabIds.add(tab.id);
      const tabId = tab.id;
      if (!tabId) return { id: cmd.id, ok: false, error: 'Failed to create tab' };
      const group = await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, windowId, [tabId]);
      const sessionWindowId = group?.windowId ?? tab.windowId;
      if (tab.windowId !== sessionWindowId) tab = await chrome.tabs.get(tabId);
      setLeaseSession(leaseKey, {
        session: getSessionFromKey(leaseKey),
        surface: getSurfaceFromKey(leaseKey),
        kind: 'owned',
        windowId: sessionWindowId,
        owned: true,
        preferredTabId: tabId,
      });
      resetWindowIdleTimer(leaseKey);
      return pageScopedResult(cmd.id, tabId, { url: tab.url });
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(leaseKey);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        const closedPage = await identity.resolveTargetId(target.id).catch(() => undefined);
        const currentSession = automationSessions.get(leaseKey);
        if (currentSession?.preferredTabId === target.id) {
          await releaseLease(leaseKey, 'tab close');
        } else {
          await safeDetach(target.id);
          await chrome.tabs.remove(target.id);
        }
        return { id: cmd.id, ok: true, data: { closed: closedPage } };
      }
      const cmdTabId = await resolveCommandTabId(cmd);
      const tabId = await resolveTabId(cmdTabId, leaseKey);
      const closedPage = await identity.resolveTargetId(tabId).catch(() => undefined);
      const currentSession = automationSessions.get(leaseKey);
      if (currentSession?.preferredTabId === tabId) {
        await releaseLease(leaseKey, 'tab close');
      } else {
        await safeDetach(tabId);
        await chrome.tabs.remove(tabId);
      }
      return { id: cmd.id, ok: true, data: { closed: closedPage } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.page === undefined)
        return { id: cmd.id, ok: false, error: 'Missing index or page' };
      const cmdTabId = await resolveCommandTabId(cmd);
      if (cmdTabId !== undefined) {
        const session = automationSessions.get(leaseKey);
        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.get(cmdTabId);
        } catch {
          return { id: cmd.id, ok: false, error: `Page no longer exists` };
        }
        if (!session || tab.windowId !== session.windowId) {
          return { id: cmd.id, ok: false, error: `Page is not in the automation container` };
        }
        await chrome.tabs.update(cmdTabId, { active: true });
        return pageScopedResult(cmd.id, cmdTabId, { selected: true });
      }
      const tabs = await listAutomationWebTabs(leaseKey);
      const target = tabs[cmd.index!];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      return pageScopedResult(cmd.id, target.id, { selected: true });
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: 'Cookie scope required: provide domain or url to avoid dumping all cookies' };
  }
  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command, leaseKey: string): Promise<Result> {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
      width: cmd.width,
      height: cmd.height,
    });
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

/** CDP methods permitted via the 'cdp' passthrough action. */
const CDP_ALLOWLIST = new Set([
  // Agent DOM context
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.focus',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.scrollIntoViewIfNeeded',
  'DOMSnapshot.captureSnapshot',
  // Native input events
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  // Page metrics & screenshots
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  // Runtime.enable needed for CDP attach setup (Runtime.evaluate normally goes through
  // the 'exec' action, but is also allowlisted here for contextId-scoped passthrough
  // evaluation, e.g. content script isolated worlds discovered via the 'contexts' action)
  'Runtime.enable',
  'Runtime.evaluate',
  // Iframe discovery diagnostics (read-only)
  'Target.getTargets',
  'Target.getTargetInfo',
  // Emulation (used by screenshot full-page)
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]);

async function handleCdp(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: 'Missing cdpMethod' };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}` };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === 'browser';
    await executor.ensureAttached(tabId, aggressive);
    const params = cmd.cdpParams ?? {};
    const routeFrameId = typeof params.frameId === 'string' && params.sessionId === 'target'
      ? params.frameId
      : undefined;
    const routeTargetUrl = typeof params.targetUrl === 'string' ? params.targetUrl : undefined;
    const data = routeFrameId
      ? await executor.sendCommandInFrameTarget(tabId, routeFrameId, cmd.cdpMethod, stripOpenCliFrameRoutingParams(params, true), aggressive, commandCdpTimeoutMs(cmd) ?? 30_000, routeTargetUrl)
      : await executor.sendDebuggerCommand(
        { tabId },
        cmd.cdpMethod,
        stripOpenCliFrameRoutingParams(params, false),
        commandCdpTimeoutMs(cmd),
      );
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

function stripOpenCliFrameRoutingParams(params: Record<string, unknown>, stripFrameId: boolean): Record<string, unknown> {
  const { sessionId, frameId, targetUrl, ...rest } = params;
  if (!stripFrameId && frameId !== undefined) return { ...rest, frameId };
  return rest;
}

async function handleSessions(cmd: Command): Promise<Result> {
  if (cmd.op === 'window-status' || cmd.op === 'window-ensure') return handleDedicatedWindowOp(cmd);
  if (cmd.op === 'cleanup') {
    const keys = [...automationSessions.keys()];
    for (const key of keys) await releaseLease(key, 'cleanup');
    return { id: cmd.id, ok: true, data: { released: keys.length } };
  }
  // Default: list
  // windowId is here because "which window is this session actually in?" is the
  // question every tab-ownership problem reduces to, and until now it could only be
  // answered by squinting at the browser. Reading it back through the extension also
  // beats asking the OS: AppleScript and the extension can disagree about what Chrome
  // contains (more than one Chrome instance, a profile the script is not attached to),
  // and when they do, the extension's view is the one the automation actually acts on.
  //
  // groupTitle answers the companion question "which tab group is it in" —
  // one group per session, titled after it — and windowFallbackReason explains
  // a window we had to create instead of borrowing (null when the tab sits in
  // one of the person's own windows, or when they asked for `--window isolated`).
  const entries: Array<{
    session: string;
    surface: string;
    kind: string;
    tabId: number | null;
    windowId: number | null;
    groupId: number | null;
    groupTitle: string | null;
    windowFallbackReason: WindowFallbackReason | null;
    dedicatedSlot: string | null;
    tabActive: boolean | null;
    url?: string;
    title?: string;
  }> = [];
  for (const [leaseKey, lease] of automationSessions) {
    let url: string | undefined;
    let title: string | undefined;
    let windowId: number | null = lease.windowId ?? null;
    let groupId: number | null = null;
    let groupTitle: string | null = null;
    let tabActive: boolean | null = null;
    if (lease.preferredTabId !== null) {
      try {
        const tab = await chrome.tabs.get(lease.preferredTabId);
        tabActive = typeof tab.active === 'boolean' ? tab.active : null;
        url = tab.url;
        title = tab.title;
        windowId = tab.windowId ?? windowId;
        if (typeof tab.groupId === 'number' && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          groupId = tab.groupId;
          groupTitle = await chrome.tabGroups.get(tab.groupId).then(g => g.title ?? null).catch(() => null);
        }
      } catch { /* tab may be gone */ }
    }
    // Looked up by window, not by the lease's own role: a stand-in window one
    // role created can host the other role's sessions too, and the reason
    // belongs to the window.
    let windowFallbackReason: WindowFallbackReason | null = null;
    if (lease.owned && windowId !== null) {
      for (const container of Object.values(ownedContainers)) {
        if (container.windowId === windowId && !container.borrowed) {
          windowFallbackReason = container.windowFallbackReason;
          break;
        }
      }
    }
    entries.push({
      session: lease.session,
      surface: lease.surface,
      kind: lease.kind,
      tabId: lease.preferredTabId,
      windowId,
      groupId,
      groupTitle,
      windowFallbackReason,
      dedicatedSlot: dedicatedSlotForWindow(windowId)?.slot ?? null,
      tabActive,
      url,
      title,
    });
  }
  return { id: cmd.id, ok: true, data: entries };
}

async function handleCloseWindow(cmd: Command, leaseKey: string): Promise<Result> {
  const sessionName = automationSessions.get(leaseKey)?.session ?? getSessionFromKey(leaseKey);
  await releaseLease(leaseKey, 'explicit close');
  return { id: cmd.id, ok: true, data: { closed: true, session: sessionName } };
}

async function handleSetFileInput(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing or empty files array' };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await executor.setFileInputFiles(tabId, cmd.files, cmd.selector);
    return pageScopedResult(cmd.id, tabId, { count: cmd.files.length });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleInsertText(cmd: Command, leaseKey: string): Promise<Result> {
  if (typeof cmd.text !== 'string') {
    return { id: cmd.id, ok: false, error: 'Missing text payload' };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await executor.insertText(tabId, cmd.text);
    return pageScopedResult(cmd.id, tabId, { inserted: true });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleNetworkCaptureStart(cmd: Command, leaseKey: string): Promise<Result> {
  const cmdTabId = await resolveCommandTabId(cmd);
  // network-capture-start is called speculatively before navigation (open command);
  // if the session doesn't exist yet, return started:false instead of erroring —
  // the subsequent navigate command will create the session.
  let tabId: number;
  try {
    tabId = await resolveTabId(cmdTabId, leaseKey);
  } catch (err) {
    if (err instanceof CommandFailure && err.code === 'session_not_found') {
      return { id: cmd.id, ok: true, data: { started: false } };
    }
    throw err;
  }
  try {
    await executor.startNetworkCapture(tabId, cmd.pattern);
    return pageScopedResult(cmd.id, tabId, { started: true });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleNetworkCaptureRead(cmd: Command, leaseKey: string): Promise<Result> {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await executor.readNetworkCapture(tabId);
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleWaitDownload(cmd: Command): Promise<Result> {
  try {
    const data = await executor.waitForDownload(cmd.pattern ?? '', cmd.timeoutMs ?? 30000);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

// ─── Clipboard (offscreen document) ────────────────────────────────
//
// MV3 service workers have no `document`, and a normal tab's
// document.execCommand/navigator.clipboard calls are gated behind document
// focus — opencli's automation tabs run in background windows by default,
// so that path is essentially never usable. chrome.offscreen with reason
// `CLIPBOARD` is the documented, focus-exempt way to do clipboard I/O from
// a service worker. The offscreen document is kept alive indefinitely as a
// singleton (same pattern as the owned container windows below) rather than
// closed/recreated per call — there is no per-call cleanup need since it
// holds no per-session state.

let offscreenDocPromise: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (offscreenDocPromise) return offscreenDocPromise;
  offscreenDocPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD' as chrome.offscreen.Reason],
    justification: 'Read the system clipboard for the opencli "clipboard" command.',
  }).finally(() => { offscreenDocPromise = null; });
  return offscreenDocPromise;
}

async function readSystemClipboard(timeoutMs = 5000): Promise<string> {
  await ensureOffscreenDocument();
  const response = await new Promise<{ text?: string; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('offscreen clipboard read timed out')), timeoutMs);
    chrome.runtime.sendMessage({ type: 'opencli-read-clipboard' }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp ?? {});
    });
  });
  if (response.error) throw new Error(response.error);
  return response.text ?? '';
}

async function handleClipboard(cmd: Command): Promise<Result> {
  try {
    const text = await readSystemClipboard();
    return { id: cmd.id, ok: true, data: { text } };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function releaseLease(leaseKey: string, reason: string = 'released'): Promise<void> {
  const session = automationSessions.get(leaseKey);
  if (!session) {
    sessionOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    await persistRuntimeState();
    return;
  }

  if (session.idleTimer) clearTimeout(session.idleTimer);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);

  if (session.owned) {
    const tabId = session.preferredTabId;
    if (tabId !== null) {
      const hasOtherOwnedLease = [...automationSessions.entries()].some(([otherLease, otherSession]) =>
        otherLease !== leaseKey &&
        otherSession.owned &&
        otherSession.windowId === session.windowId &&
        otherSession.preferredTabId !== null,
      );
      await safeDetach(tabId);
      identity.evictTab(tabId);
      const dedicatedSlot = dedicatedSlotForWindow(session.windowId);
      if (dedicatedSlot) {
        // Dedicated windows outlive their leases: the last tab stays as a placeholder.
        const outcome = await releaseDedicatedLeaseTab(dedicatedSlot, tabId);
        console.log(`[opencli] Released dedicated tab lease ${tabId} (${outcome}, slot=${dedicatedSlot.slot}, session=${session.session}, surface=${session.surface}, ${reason})`);
      } else if (hasOtherOwnedLease) {
        await chrome.tabs.remove(tabId).catch(() => {});
        console.log(`[opencli] Released owned tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
      } else if (ownedContainers[getOwnedWindowRole(leaseKey)].borrowed) {
        // In a window we merely borrowed, a leftover blank placeholder is litter in
        // the person's own tab strip. Close it instead — the placeholder only pays
        // for itself inside a container window nobody else looks at.
        await chrome.tabs.remove(tabId).catch(() => {});
        console.log(`[opencli] Closed borrowed tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
      } else {
        try {
          // Releasing a lease must never pull the view anywhere: this fires on idle
          // timeout and on cleanup, so `active: true` here reads to the person as the
          // browser randomly jumping to a blank page long after they stopped watching.
          const tab = await chrome.tabs.update(tabId, { url: BLANK_PAGE });
          const group = await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, session.windowId, [tab.id ?? tabId]);
          if (group) session.windowId = group.windowId;
          console.log(`[opencli] Released owned tab lease ${tabId} as reusable placeholder (session=${session.session}, surface=${session.surface}, ${reason})`);
        } catch {
          await chrome.tabs.remove(tabId).catch(() => {});
          console.log(`[opencli] Released owned tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
        }
      }
    } else {
      console.log(`[opencli] Released legacy owned window lease ${session.windowId} without closing container (session=${session.session}, surface=${session.surface}, ${reason})`);
    }
  } else if (session.preferredTabId !== null) {
    await safeDetach(session.preferredTabId);
    console.log(`[opencli] Detached borrowed tab lease ${session.preferredTabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
  }

  automationSessions.delete(leaseKey);
  sessionOverrides.delete(leaseKey);

  await persistRuntimeState();
}

async function reconcileTargetLeaseRegistry(): Promise<void> {
  // Dedicated slots first: every guard below asks "is this a dedicated window".
  await restoreDedicatedState();
  const registry = await readRegistry();
  // Restore the orphan-group ledger (readRegistry already coerced it to a
  // clean shape). Legacy bare `groupIds` come back ownerless: kept only so the
  // prune pass retires them, never adopted for a session.
  ownedGroupLedger.clear();
  for (const role of Object.keys(ownedContainers) as OwnedWindowRole[]) {
    const stored = registry.ownedContainers[role];
    for (const [groupId, leaseKey] of Object.entries(stored.groups ?? {})) {
      if (getOwnedWindowRole(leaseKey) === role) ownedGroupLedger.set(Number(groupId), leaseKey);
    }
    for (const groupId of stored.groupIds ?? []) {
      if (!ownedGroupLedger.has(groupId)) ownedGroupLedger.set(groupId, null);
    }
  }
  // Only windowId/borrowed/reason are restored to the container cache; the
  // in-memory group map starts empty (a fresh worker) and repopulates via the
  // session ledger, title, and lease layers during the convergence below.
  for (const role of Object.keys(ownedContainers) as OwnedWindowRole[]) {
    const stored = registry.ownedContainers[role];
    ownedContainers[role].windowId = stored?.windowId ?? null;
    ownedContainers[role].borrowed = stored?.borrowed === true;
    ownedContainers[role].windowFallbackReason = stored?.windowFallbackReason ?? null;
    ownedContainers[role].groups.clear();
    const windowId = ownedContainers[role].windowId;
    if (windowId !== null) {
      try {
        await chrome.windows.get(windowId);
      } catch {
        forgetContainerWindow(role);
      }
    }
  }

  automationSessions.clear();
  for (const [leaseKey, stored] of Object.entries(registry.leases)) {
    const tabId = stored.preferredTabId;
    if (tabId === null) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isDebuggableUrl(tab.url)) continue;
      if (stored.lifecycle === 'ephemeral' || stored.lifecycle === 'persistent' || stored.lifecycle === 'pinned') {
        setSessionOverride(leaseKey, { lifecycle: stored.lifecycle });
      }
      const session = makeSession(leaseKey, {
        session: typeof stored.session === 'string' ? stored.session : getSessionFromKey(leaseKey),
        surface: stored.surface === 'adapter' ? 'adapter' : getSurfaceFromKey(leaseKey),
        kind: stored.kind === 'bound' || stored.owned === false ? 'bound' : 'owned',
        windowId: tab.windowId,
        owned: stored.owned,
        preferredTabId: tabId,
      });
      const timeout = getIdleTimeout(leaseKey);
      automationSessions.set(leaseKey, {
        ...session,
        idleTimer: null,
        idleDeadlineAt: stored.idleDeadlineAt,
      });
      if (session.owned) {
        const role = getOwnedWindowRole(leaseKey);
        if (ownedContainers[role].windowId === null && !isDedicatedWindow(tab.windowId)) ownedContainers[role].windowId = tab.windowId;
        const group = await ensureOwnedContainerGroup(role, leaseKey, tab.windowId, [tabId]);
        if (group) {
          const current = automationSessions.get(leaseKey);
          if (current) current.windowId = group.windowId;
        }
      }
      const remaining = stored.idleDeadlineAt > 0 ? stored.idleDeadlineAt - Date.now() : timeout;
      if (timeout > 0) {
        if (remaining <= 0) {
          await releaseLease(leaseKey, 'reconciled idle expiry');
        } else {
          // Honor the persisted remaining lifetime — not a fresh full timeout —
          // so a lease cannot dodge idle expiry by riding repeated SW restarts.
          resetWindowIdleTimer(leaseKey, remaining);
        }
      }
    } catch {
      // Registry is semantic state, not truth. If Chrome no longer has the tab,
      // drop the lease record and never close unrelated user resources.
    }
  }

  // Converge every session's group on startup: adopt/title an orphan the ledger
  // surfaces, or drop a dangling id when none survives. Walks the ledger's
  // lease keys, not just live leases, so an orphan left by a mid-create crash
  // (grouped, never titled, lease never persisted) gets repaired instead of
  // accumulating as an untitled duplicate (#2097). Best effort — reconcile
  // must still persist restored leases if this fails.
  const leaseKeysToConverge = new Set<string>();
  for (const owner of ownedGroupLedger.values()) if (owner !== null) leaseKeysToConverge.add(owner);
  for (const [leaseKey, session] of automationSessions.entries()) if (session.owned) leaseKeysToConverge.add(leaseKey);
  for (const leaseKey of leaseKeysToConverge) {
    try {
      await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, null, []);
    } catch (err) {
      console.warn(`[opencli] Startup group convergence failed for ${getSessionFromKey(leaseKey)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Ownerless legacy ids only ever need pruning.
  await pruneOwnedGroupLedger().catch(() => {});

  await persistRuntimeState();
}

async function handleBind(cmd: Command, leaseKey: string): Promise<Result> {
  const existing = automationSessions.get(leaseKey);
  if (existing?.owned) {
    await releaseLease(leaseKey, 'rebind');
  }
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const boundTab = activeTabs.find((tab) => isDebuggableUrl(tab.url))
    ?? fallbackTabs.find((tab) => isDebuggableUrl(tab.url));
  if (!boundTab?.id) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: 'bound_tab_not_found',
      error: 'No debuggable tab found in the current window',
      errorHint: 'Focus the target Chrome tab/window, then retry bind.',
    };
  }

  const current = automationSessions.get(leaseKey);
  if (current && !current.owned && current.preferredTabId !== null && current.preferredTabId !== boundTab.id) {
    await executor.detach(current.preferredTabId).catch(() => {});
  }

  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: 'bound',
    windowId: boundTab.windowId,
    owned: false,
    preferredTabId: boundTab.id,
  });
  resetWindowIdleTimer(leaseKey);
  console.log(`[opencli] Session ${getSessionFromKey(leaseKey)} explicitly bound to tab ${boundTab.id} (${boundTab.url})`);
  return pageScopedResult(cmd.id, boundTab.id, {
    url: boundTab.url,
    title: boundTab.title,
    session: getSessionFromKey(leaseKey),
  });
}

export const __test__ = {
  handleExec,
  // Dedicated automation windows
  applyDedicatedCommandFields,
  ensureDedicatedWindow,
  checkDedicatedForeignTab,
  handleTabAttached,
  computeDisplayCell,
  pickDisplay,
  compileDisplayMatcher,
  restoreDedicatedState,
  handleDedicatedWindowOp,
  setForeignTabSettleMs: (ms: number) => { foreignTabSettleMs = ms; },
  getDedicatedSlot: (slot: string = 'default') => {
    const state = dedicatedSlots.get(slot);
    return state ? {
      slot: state.slot,
      windowId: state.windowId,
      placeholderTabIds: [...state.placeholderTabIds],
      placement: { ...state.placement },
      autoSelect: state.autoSelect,
      foreignTabPolicy: state.foreignTabPolicy,
      evictedTabs: state.evictedTabs,
    } : null;
  },
  releaseLease,
  handleNavigate,
  isTargetUrl,
  handleTabs,
  handleBind,
  resolveTabId,
  resetWindowIdleTimer,
  handleCommand,
  getSessionName,
  getCommandSurface,
  getIdleTimeout,
  getLeaseKey,
  sessionOverrides,
  reconcileTargetLeaseRegistry,
  ensureOwnedContainerGroup,
  getContainer: (role: OwnedWindowRole) => ({
    windowId: ownedContainers[role].windowId,
    borrowed: ownedContainers[role].borrowed,
    windowFallbackReason: ownedContainers[role].windowFallbackReason,
    groups: Object.fromEntries(ownedContainers[role].groups),
    // Every ledger id (both roles, ownerless legacy ids included).
    groupIds: [...ownedGroupLedger.keys()],
    ledger: Object.fromEntries([...ownedGroupLedger.entries()].map(([id, owner]) => [String(id), owner])),
  }),
  getInteractiveContainer: () => ({
    windowId: ownedContainers.interactive.windowId,
    groups: Object.fromEntries(ownedContainers.interactive.groups),
    groupIds: [...ownedGroupLedger.keys()],
  }),
  handleSessions,
  connectForTest: connect,
  scheduleReconnectForTest: () => scheduleReconnect(),
  getReconnectAttempts: () => reconnectAttempts,
  setReconnectAttempts: (value: number) => { reconnectAttempts = value; },
  nextReconnectDelayMs,
  resetReconnectState: () => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
    wsKeepaliveTimer = null;
    wsKeepaliveSocket = null;
    connectInFlight = null;
    ws = null;
  },
  getSession: (leaseKey: string = 'default') => automationSessions.get(leaseKey) ?? null,
  getAutomationWindowId: (leaseKey: string = 'default') => automationSessions.get(leaseKey)?.windowId ?? null,
  setAutomationWindowId: (leaseKey: string, windowId: number | null) => {
    if (windowId === null) {
      const session = automationSessions.get(leaseKey);
      if (session?.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(leaseKey);
      return;
    }
    setLeaseSession(leaseKey, {
      session: getSessionFromKey(leaseKey),
      surface: getSurfaceFromKey(leaseKey),
      kind: 'owned',
      windowId,
      owned: true,
      preferredTabId: null,
    });
  },
  setSession: (leaseKey: string, session: { windowId: number; owned: boolean; preferredTabId: number | null }) => {
    setLeaseSession(leaseKey, {
      session: getSessionFromKey(leaseKey),
      surface: getSurfaceFromKey(leaseKey),
      kind: session.owned ? 'owned' : 'bound',
      ...session,
    });
  },
};
