/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();

/**
 * `sessionId` is the flatten-mode CDP session (per chrome.debugger's `source`
 * param) that the Runtime.executionContextCreated event actually arrived on.
 * A context created in a child OOPIF session is NOT visible to a
 * `Runtime.evaluate` sent on the tab-level `{tabId}` debuggee — each flatten
 * session has its own independently-numbered Runtime domain, so a stray
 * `{tabId}`-only send with a child session's contextId does not error, it
 * silently evaluates against whatever context happens to own that same
 * small integer in the MAIN frame's session. Recording sessionId here is
 * what lets evaluateInFrame's cached-context fast path (and the CLI's
 * `eval --context <id>` path in background.ts) address the correct session
 * instead of guessing tabId-only and getting a wrong-but-successful result.
 * Undefined sessionId means the context belongs to the tab-level session.
 */
const tabFrameContexts = new Map<number, Map<string, { contextId: number; sessionId?: string }>>();
const tabAllContexts = new Map<number, Map<number, { id: number; origin: string; name: string; auxData: any; sessionId?: string }>>();
/** Child flatten-mode sessionIds currently attached per tab (added on Target.attachedToTarget, removed on detach/destroy/crash). A route or cached context whose sessionId is missing here is stale and must not be used. */
const tabLiveSessionIds = new Map<number, Set<string>>();
const frameTargets = new Map<string, string>();
const frameTargetKeys = new Map<string, string>();
let frameTargetCleanupRegistered = false;

/**
 * Chrome 125+ widened `chrome.debugger`'s debuggee to `DebuggerSession`, which
 * adds an optional `sessionId` alongside `tabId` — that is how an extension
 * addresses a flatten-mode child session (an OOPIF auto-attached under a
 * tab-level attach) without attaching to its targetId separately. The
 * @types/chrome pinned in this repo still types `Debuggee` as
 * `{ tabId | extensionId | targetId }` only, so the field is declared here and
 * cast at the call site. Drop the cast once the types catch up.
 */
type DebuggerSessionTarget = chrome.debugger.Debuggee & { sessionId?: string };

/**
 * How to reach a given child frame. 'session' is the preferred flatten-mode
 * route ({tabId, sessionId}, no extra attach); 'target' is the legacy
 * `chrome.debugger.attach({targetId})` fallback for Chromes that reject the
 * sessionId debuggee. Cached per `frameTargetKey` so each command does not
 * re-probe both paths.
 */
type FrameRoute =
  | { kind: 'session'; targetId: string; sessionId: string; debuggee: chrome.debugger.Debuggee }
  | { kind: 'target'; targetId: string; debuggee: chrome.debugger.Debuggee };
const frameRoutes = new Map<string, FrameRoute>();
/** frameTargetKeys for which the sessionId route was tried and rejected — never retried. */
const frameSessionUnsupported = new Set<string>();

/**
 * OOPIF (out-of-process iframe) targets discovered via CDP `Target.attachedToTarget`
 * events, keyed by tabId then targetId. Populated by registerFrameTracking's
 * onEvent listener once `Target.setAutoAttach` is armed for a tab (see
 * listIframeTargets / ensureFrameRoute). This is the primary discovery path —
 * Chrome pushes an event as each matching sub-target attaches, which is more
 * reliable than a one-shot `Target.getTargets` snapshot that can race target
 * creation or (per anecdotal real-world testing, see listIframeTargets) simply
 * come back empty for a tab-level chrome.debugger session in some cases.
 *
 * Attribution: events for sub-targets auto-attached under a tab-level
 * `chrome.debugger.attach({tabId})` session arrive through chrome.debugger's
 * onEvent with `source.tabId` set to that SAME parent tab (this mirrors the
 * pre-existing Runtime.executionContextCreated handling below, which has
 * relied on the identical fact for child-frame execution contexts). So tabId
 * is the attribution signal used here, and it is the correct one.
 *
 * `sessionId` is the flatten-mode CDP session the `Target.attachedToTarget`
 * event carried in its own params. It is recorded because Chrome 125+ accepts
 * `{ tabId, sessionId }` as a chrome.debugger debuggee (see
 * DebuggerSessionTarget below), which is the ONLY way to talk to an OOPIF from
 * a tab-level session: the older `chrome.debugger.attach({targetId})` route
 * first needs `Target.getTargets`, and Chrome answers that with
 * `{"code":-32000,"message":"Not allowed"}` for a tab-level session.
 */
const tabIframeTargets = new Map<number, Map<string, { url: string; title: string; sessionId?: string }>>();
/** Diagnostic counters: total Target.attachedToTarget (iframe) events seen per tab, for the 'debug' frames output. Not reset between calls — it is a lifetime counter surfaced as a coarse "did events fire at all" signal. */
const tabAttachedEventCounts = new Map<number, number>();

// Large cap so agents stop hitting silent JSON.parse failures on real API bodies.
// See src/browser/cdp.ts CDP_RESPONSE_BODY_CAPTURE_LIMIT for the matching constant
// on the direct-CDP path. Keep in sync.
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;

type NetworkCaptureEntry = {
  kind: 'cdp';
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBodyKind?: string;
  requestBodyPreview?: string;
  requestBodyFullSize?: number;
  requestBodyTruncated?: boolean;
  responseStatus?: number;
  responseContentType?: string;
  responseHeaders?: Record<string, string>;
  responsePreview?: string;
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  timestamp: number;
};

type NetworkCaptureState = {
  patterns: string[];
  entries: NetworkCaptureEntry[];
  requestToIndex: Map<string, number>;
};

export type DownloadWaitResult = {
  downloaded: boolean;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
};

const networkCaptures = new Map<number, NetworkCaptureState>();

/**
 * Default deadline for a single chrome.debugger command. chrome.debugger has
 * no timeout of its own: a page-blocking native dialog (alert/confirm/print/
 * beforeunload) makes Runtime.evaluate hang forever, wedging every later
 * command on the tab. Long enough for legitimate in-page waits (default 30s
 * plus headroom), short enough to fail before the daemon's 120s timer.
 */
const CDP_COMMAND_TIMEOUT_MS = 60_000;
/** Health-check probe deadline — a blocked probe should fail fast. */
const CDP_PROBE_TIMEOUT_MS = 2_000;

/**
 * chrome.debugger.sendCommand with a deadline. The underlying command cannot
 * be cancelled — this only unblocks the caller so the CLI gets an error
 * instead of an infinite hang.
 */
export async function sendDebuggerCommand<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const commandPromise = (params === undefined
    ? chrome.debugger.sendCommand(target, method)
    : chrome.debugger.sendCommand(target, method, params)) as Promise<T>;
  // If the timeout wins the race, the command promise may still reject much
  // later (e.g. debugger detach on tab close) — swallow that on a side branch
  // so it never surfaces as an unhandled rejection in the service worker.
  commandPromise.catch(() => {});
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `CDP command ${method} timed out after ${Math.round(timeoutMs / 1000)}s — the page may be blocked by a native dialog (alert/confirm/print)`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

export async function ensureAttached(tabId: number, aggressiveRetry: boolean = false): Promise<void> {
  // Verify the tab URL is debuggable before attempting attach
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl(tab.url)) {
      // Invalidate cache if previously attached
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`);
    }
  } catch (e) {
    // Re-throw our own error, catch only chrome.tabs.get failures
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }

  if (attached.has(tabId)) {
    // Verify the debugger is still actually attached by sending a harmless command
    try {
      await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      }, CDP_PROBE_TIMEOUT_MS);
      return; // Still attached and working
    } catch {
      // Stale cache entry — need to re-attach
      attached.delete(tabId);
    }
  }

  // Retry attach up to 3 times — other extensions (1Password, Playwright MCP Bridge)
  // can temporarily interfere with chrome.debugger. A short delay usually resolves it.
  // Normal commands: 2 retries, 500ms delay (fast fail for non-browser use)
  // Browser commands: 5 retries, 1500ms delay (aggressive, tolerates extension interference)
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = '';

  // The forced detach below fires chrome.debugger.onDetach, whose handler wipes
  // this tab's armed network-capture state; detaching also disables the CDP
  // Network domain. Snapshot the capture so we can restore it after a successful
  // re-attach instead of silently dropping in-flight capture — otherwise any
  // non-navigate command that triggers a re-attach (a stale-attach health-check
  // failure during SPA navigation or third-party debugger interference) leaves
  // network-capture-read returning [] even though requests fired.
  const preservedNetworkCapture = networkCaptures.get(tabId);

  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      // Force detach first to clear any stale state from other extensions
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      await chrome.debugger.attach({ tabId }, '1.3');
      lastError = '';
      break; // Success
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[opencli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        // Re-verify tab URL before retrying (it may have changed)
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break; // Don't retry if URL became un-debuggable
          }
        } catch {
          // Tab is gone — don't fail early here.
          // Later retry layers can re-resolve a fresh automation tab/window.
          lastError = `Tab ${tabId} no longer exists`;
          // Don't break; fall through to retry
        }
      }
    }
  }

  if (lastError) {
    // Log detailed diagnostics for debugging extension conflicts
    let finalUrl = 'unknown';
    let finalWindowId = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? 'undefined';
      finalWindowId = String(tab.windowId);
    } catch { /* tab gone */ }
    console.warn(`[opencli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);

    const hint = lastError.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);

  try {
    await sendDebuggerCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }

  // Restore network capture that the re-attach (detach + onDetach) tore down.
  // The detach always disables the CDP Network domain, so re-enable it and put
  // the accumulated capture state back unconditionally. Done last (after the
  // awaits above) so it wins over the onDetach handler's delete, which fires
  // while those awaits yield to the event loop.
  if (preservedNetworkCapture) {
    try {
      await sendDebuggerCommand({ tabId }, 'Network.enable');
      networkCaptures.set(tabId, preservedNetworkCapture);
    } catch {
      // Leave capture cleared rather than arm a half-attached Network domain;
      // the next start-capture re-arms cleanly.
    }
  }
}

export async function evaluate(
  tabId: number,
  expression: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  // No retry loop here: failures carry a machine-readable errorCode (see
  // classifyExtensionError in background.ts) and the CLI decides whether a
  // NEW logical attempt is safe. ensureAttached still does its own local
  // attach retries; a debugger error mid-evaluate invalidates the attach
  // cache so the next attempt re-attaches.
  try {
    await ensureAttached(tabId, aggressiveRetry);

    const result = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs) as {
      result?: { type: string; value?: unknown; description?: string; subtype?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Eval error';
      throw new Error(errMsg);
    }

    return result.result?.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Detached') || msg.includes('Debugger is not attached') || msg.includes('Target closed')) {
      attached.delete(tabId); // Force re-attach on the next command
    }
    throw e;
  }
}

export const evaluateAsync = evaluate;

/**
 * Capture a screenshot via CDP Page.captureScreenshot.
 * Returns base64-encoded image data.
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : undefined;
  // height is ignored under fullPage so the existing measure-from-content path stays unchanged for users who pass --height alongside --full-page.
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : undefined;
  const needsOverride = fullPage || overrideWidth !== undefined || overrideHeight !== undefined;

  if (needsOverride) {
    // When width is set, apply it first so layout reflows before we read content size.
    if (overrideWidth !== undefined && fullPage) {
      await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1,
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await sendDebuggerCommand({ tabId }, 'Page.getLayoutMetrics') as {
        contentSize?: { width: number; height: number };
        cssContentSize?: { width: number; height: number };
      };
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await sendDebuggerCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1,
    });
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await sendDebuggerCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64-encoded
    };

    return result.data;
  } finally {
    if (needsOverride) {
      await sendDebuggerCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * Set local file paths on a file input element via CDP DOM.setFileInputFiles.
 * This bypasses the need to send large base64 payloads through the message channel —
 * Chrome reads the files directly from the local filesystem.
 *
 * @param tabId - Target tab ID
 * @param files - Array of absolute local file paths
 * @param selector - CSS selector to find the file input (optional, defaults to first file input)
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // Enable DOM + Page domains. Page is needed for file-chooser interception.
  await sendDebuggerCommand({ tabId }, 'DOM.enable');
  await sendDebuggerCommand({ tabId }, 'Page.enable');

  // Find the file input element (used to trigger the chooser).
  const query = selector || 'input[type="file"]';
  const found = await sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
    expression: `!!document.querySelector(${JSON.stringify(query)})`,
    returnByValue: true,
  }) as { result?: { value?: boolean } };
  if (!found.result?.value) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  // Chrome rejects DOM.setFileInputFiles with a plain nodeId/backendNodeId when
  // the debugger is attached via chrome.debugger (crbug 928255, "-32000 Not
  // allowed"). The only accepted path is file-chooser interception: enable it,
  // programmatically open the chooser, and use the backendNodeId that the
  // intercepted Page.fileChooserOpened event hands back. See issue #2108.
  await sendDebuggerCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const backendNodeId = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Page.fileChooserOpened not received within 5s — the input may not have opened a file chooser'));
      }, 5000);
      const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
        if (source.tabId !== tabId || method !== 'Page.fileChooserOpened') return;
        // This is our chooser event — settle now either way, so a malformed
        // event rejects immediately instead of hanging until the 5s timeout.
        cleanup();
        const backend = (params as { backendNodeId?: number })?.backendNodeId;
        if (typeof backend === 'number') resolve(backend);
        else reject(new Error('Page.fileChooserOpened carried no backendNodeId'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
      };
      chrome.debugger.onEvent.addListener(listener);
      // Open the chooser programmatically — interception suppresses the native
      // dialog and fires Page.fileChooserOpened instead. Works for hidden inputs.
      void sendDebuggerCommand({ tabId }, 'Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(query)}).click()`,
      }).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    // backendNodeId from the intercepted chooser IS accepted by Chrome.
    await sendDebuggerCommand({ tabId }, 'DOM.setFileInputFiles', {
      files,
      backendNodeId,
    });
  } finally {
    await sendDebuggerCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

function matchesDownloadPattern(item: chrome.downloads.DownloadItem, pattern: string): boolean {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime,
  ].filter(Boolean).join('\n').toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}

function downloadResult(item: chrome.downloads.DownloadItem, startedAt: number): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDownload(pattern: string = '', timeoutMs: number = 30000): Promise<DownloadWaitResult> {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);

  return await new Promise<DownloadWaitResult>((resolve) => {
    let done = false;
    const inProgressIds = new Set<number>();
    const finish = (result: DownloadWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };

    const inspectById = async (id: number) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };

    const onCreated = (item: chrome.downloads.DownloadItem) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === 'complete' || item.state === 'interrupted') finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: `No download matched "${pattern || '*'}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeout);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);

    void chrome.downloads.search({
      limit: 50,
      orderBy: ['-startTime'],
      startedAfter: new Date(startedAt - Math.max(timeout, 1000)).toISOString(),
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === 'complete' && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === 'in_progress' && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

function frameTargetKey(tabId: number, frameId: string): string {
  return `${tabId}:${frameId}`;
}

function registerFrameTargetCleanup(): void {
  if (frameTargetCleanupRegistered) return;
  frameTargetCleanupRegistered = true;
  chrome.debugger.onEvent.addListener((_source, method, params: any) => {
    if (method === 'Target.detachedFromTarget') {
      const targetId = String(params?.targetId || '');
      clearFrameTarget(targetId);
    }
  });
}

function clearFrameTarget(targetId: string): void {
  if (!targetId) return;
  const key = frameTargetKeys.get(targetId);
  if (key) {
    frameTargets.delete(key);
    frameRoutes.delete(key);
  }
  frameTargetKeys.delete(targetId);
}

/**
 * Resolve a frame to a usable CDP route, preferring the flatten-mode
 * `{tabId, sessionId}` session recorded from `Target.attachedToTarget` over
 * the legacy attach-by-targetId path (which depends on `Target.getTargets`,
 * a command Chrome answers with "Not allowed" for a tab-level session).
 *
 * `forceAttach` skips the session route — used by the one-shot fallback in
 * sendCommandInFrameTarget when a sessionId debuggee is rejected.
 */
async function ensureFrameRoute(
  tabId: number,
  frameId: string,
  aggressiveRetry: boolean = false,
  targetUrl?: string,
  forceAttach: boolean = false,
): Promise<FrameRoute> {
  registerFrameTargetCleanup();
  await ensureAttached(tabId, aggressiveRetry);
  const key = frameTargetKey(tabId, frameId);
  const cached = frameRoutes.get(key);
  if (cached) return cached;

  await sendDebuggerCommand({ tabId }, 'Target.setDiscoverTargets', { discover: true }).catch(() => {});
  await sendDebuggerCommand({ tabId }, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }],
  }).catch(() => {});

  let known = resolveFrameFromAttachEvents(tabId, frameId, targetUrl);
  if (!known && !(tabIframeTargets.get(tabId)?.size)) {
    // Nothing recorded yet for this tab — autoAttach was likely just armed, so
    // give the asynchronous attachedToTarget events a brief chance to land.
    await waitForIframeAttachEvents(tabId, 300);
    known = resolveFrameFromAttachEvents(tabId, frameId, targetUrl);
  }

  const useSession = !forceAttach && !frameSessionUnsupported.has(key) && !!known?.sessionId;
  let route: FrameRoute;
  if (useSession && known?.sessionId) {
    route = {
      kind: 'session',
      targetId: known.targetId,
      sessionId: known.sessionId,
      // Cast: sessionId is a Chrome 125+ debuggee field the pinned
      // @types/chrome does not know about. See DebuggerSessionTarget.
      debuggee: { tabId, sessionId: known.sessionId } as DebuggerSessionTarget as chrome.debugger.Debuggee,
    };
  } else {
    const targetId = known?.targetId ?? await resolveFrameTargetId(tabId, frameId, targetUrl);
    try {
      await chrome.debugger.attach({ targetId } as chrome.debugger.Debuggee, '1.3');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('Another debugger is already attached')) throw err;
    }
    frameTargets.set(key, targetId);
    route = { kind: 'target', targetId, debuggee: { targetId } as chrome.debugger.Debuggee };
  }
  frameTargetKeys.set(route.targetId, key);
  frameRoutes.set(key, route);
  // Runtime domain must be enabled once per session before Runtime.evaluate.
  await sendDebuggerCommand(route.debuggee, 'Runtime.enable').catch(() => {});
  return route;
}

/** Forget a route that turned out to be unusable, so the next call re-resolves. */
function demoteFrameRoute(tabId: number, frameId: string): void {
  const key = frameTargetKey(tabId, frameId);
  const route = frameRoutes.get(key);
  frameRoutes.delete(key);
  if (route) {
    frameSessionUnsupported.add(key);
    frameTargetKeys.delete(route.targetId);
  }
}

/**
 * Look the frame up in the targets collected from `Target.attachedToTarget`.
 * The CLI passes the OOPIF's targetId as the frameId (that is what the
 * `frames` command reports), so a direct key hit is the normal case; URL
 * matching covers callers that only know the frame's URL.
 */
function resolveFrameFromAttachEvents(
  tabId: number,
  frameId: string,
  targetUrl?: string,
): { targetId: string; sessionId?: string } | undefined {
  const known = tabIframeTargets.get(tabId);
  if (!known) return undefined;
  const direct = known.get(frameId);
  if (direct) return { targetId: frameId, sessionId: direct.sessionId };
  if (targetUrl) {
    for (const [targetId, info] of known) {
      if (info.url === targetUrl) return { targetId, sessionId: info.sessionId };
    }
  }
  return undefined;
}

/**
 * Last-resort resolution via `Target.getTargets`. Kept for the environments where
 * the command is permitted; a tab-level chrome.debugger session normally gets
 * `{"code":-32000,"message":"Not allowed"}` back, hence the catch.
 */
async function resolveFrameTargetId(tabId: number, frameId: string, targetUrl?: string): Promise<string> {
  const result = await sendDebuggerCommand({ tabId }, 'Target.getTargets').catch(() => null) as
    | { targetInfos?: Array<{ targetId?: string; id?: string; type?: string; url?: string }> }
    | null;
  const targets = result?.targetInfos ?? [];
  const frameTarget = targets.find((candidate) => {
    const candidateId = candidate.targetId || candidate.id;
    return candidate.type === 'iframe'
      && (
        candidateId === frameId
        || (!!targetUrl && candidate.url === targetUrl)
      );
  });
  const targetId = frameTarget?.targetId || frameTarget?.id;
  if (targetId) return targetId;
  const candidates = targets
    .filter((target) => target.type === 'iframe')
    .map((target) => `${target.targetId || target.id || '?'} ${target.url || ''}`)
    .join('; ');
  throw new Error(`No iframe target found for frame ${frameId}${targetUrl ? ` (${targetUrl})` : ''}. Candidates: ${candidates || 'none'}`);
}

export type IframeTargetInfo = { targetId: string; url: string; title: string };

export type IframeDiscoveryDebug = {
  /** Error from Target.setAutoAttach, if it rejected (normally swallowed). */
  autoAttachError?: string;
  /** Error from Target.getTargets, if it rejected (normally swallowed). */
  getTargetsError?: string;
  /** How many type==='iframe' entries Target.getTargets returned, before DOM filtering. */
  getTargetsIframeCount: number;
  /** How many Target.attachedToTarget (iframe) events had landed in tabIframeTargets by the time discovery finished. */
  attachedEventCount: number;
  /** <iframe src> URLs found by walking the tab's DOM (including shadow roots), used to filter getTargets candidates. */
  domFrameUrls: string[];
};

/**
 * Poll tabIframeTargets for this tab until it stops growing (2 consecutive
 * empty ticks) or maxWaitMs elapses, so callers give chrome.debugger time to
 * deliver Target.attachedToTarget events after Target.setAutoAttach arms —
 * those events are asynchronous and are not guaranteed to have landed by the
 * time setAutoAttach's own promise resolves.
 */
async function waitForIframeAttachEvents(tabId: number, maxWaitMs = 500): Promise<void> {
  const start = Date.now();
  const tickMs = 50;
  let lastSize = tabIframeTargets.get(tabId)?.size ?? 0;
  let stableTicks = 0;
  while (Date.now() - start < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, tickMs));
    const size = tabIframeTargets.get(tabId)?.size ?? 0;
    if (size === lastSize) {
      stableTicks += 1;
      if (stableTicks >= 2 && size > 0) return;
    } else {
      stableTicks = 0;
      lastSize = size;
    }
  }
}

/**
 * List OOPIF (out-of-process iframe) targets for a tab, for cross-origin
 * iframes that Page.getFrameTree's childFrames omits under Chrome's site
 * isolation.
 *
 * Primary source: `Target.attachedToTarget` events, collected into
 * tabIframeTargets by registerFrameTracking as they land (see that map's own
 * doc comment for why source.tabId is trustworthy attribution here). This is
 * the reliable path — real-world testing found `Target.getTargets` can come
 * back empty for a tab-level chrome.debugger session even when a matching
 * OOPIF genuinely exists (e.g. a shadow-DOM-hosted cross-origin iframe
 * injected by another extension), so a getTargets snapshot alone is not
 * sufficient.
 *
 * Secondary source: `Target.getTargets`, kept as a supplementary candidate
 * list in case autoAttach events are slow or the target attached before
 * tracking was armed. Because Target.getTargets is a CDP-spec browser-global
 * command and it is undocumented whether chrome.debugger's per-tab
 * attachment narrows its result to this tab, every getTargets candidate is
 * cross-checked against this tab's own DOM (the <iframe> elements' `src`,
 * walking shadow roots, by exact URL or, failing that, origin) before being
 * trusted — event-sourced candidates are NOT filtered this way since they are
 * already tab-scoped by construction. If the DOM can't be read (e.g. CSP or a
 * timing race), getTargets candidates are kept unfiltered rather than
 * silently dropped, since an unverified frame is still more useful than none.
 */
export async function listIframeTargets(tabId: number): Promise<{ targets: IframeTargetInfo[]; debug: IframeDiscoveryDebug }> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Target.setDiscoverTargets', { discover: true }).catch(() => {});

  let autoAttachError: string | undefined;
  try {
    await sendDebuggerCommand({ tabId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    });
  } catch (err) {
    autoAttachError = err instanceof Error ? err.message : String(err);
  }

  await waitForIframeAttachEvents(tabId);

  const eventCandidates: IframeTargetInfo[] = Array.from(tabIframeTargets.get(tabId)?.entries() ?? [])
    .map(([targetId, info]) => ({ targetId, url: info.url, title: info.title }));
  const knownTargetIds = new Set(eventCandidates.map((c) => c.targetId));

  let getTargetsError: string | undefined;
  let getTargetsCandidates: IframeTargetInfo[] = [];
  try {
    const result = await sendDebuggerCommand({ tabId }, 'Target.getTargets') as
      { targetInfos?: Array<{ targetId?: string; id?: string; type?: string; url?: string; title?: string }> };
    const targets = result?.targetInfos ?? [];
    getTargetsCandidates = targets
      .filter((t) => t.type === 'iframe')
      .map((t) => ({ targetId: t.targetId || t.id || '', url: t.url || '', title: t.title || '' }))
      .filter((t) => t.targetId && !knownTargetIds.has(t.targetId));
  } catch (err) {
    getTargetsError = err instanceof Error ? err.message : String(err);
  }
  const getTargetsIframeCount = getTargetsCandidates.length;

  let domFrameUrls: string[] = [];
  if (getTargetsCandidates.length > 0) {
    try {
      const raw = await evaluate(
        tabId,
        `(() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'IFRAME' && el.src) out.push(el.src); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; })()`,
      );
      if (Array.isArray(raw)) domFrameUrls = raw as string[];
    } catch {
      // Can't verify — fall through and trust getTargets' own scoping.
    }
    if (domFrameUrls.length > 0) {
      const domOrigins = new Set<string>();
      for (const url of domFrameUrls) {
        try { domOrigins.add(new URL(url).origin); } catch { /* ignore */ }
      }
      getTargetsCandidates = getTargetsCandidates.filter((c) => domFrameUrls.includes(c.url) || (() => {
        try { return domOrigins.has(new URL(c.url).origin); } catch { return false; }
      })());
    }
  }

  return {
    targets: [...eventCandidates, ...getTargetsCandidates],
    debug: {
      autoAttachError,
      getTargetsError,
      getTargetsIframeCount,
      attachedEventCount: eventCandidates.length,
      domFrameUrls,
    },
  };
}

export async function sendCommandInFrameTarget(
  tabId: number,
  frameId: string,
  method: string,
  params: Record<string, unknown> = {},
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
  targetUrl?: string,
): Promise<unknown> {
  const route = await ensureFrameRoute(tabId, frameId, aggressiveRetry, targetUrl);
  try {
    return await sendDebuggerCommand(route.debuggee, method, params, timeoutMs);
  } catch (err) {
    if (route.kind !== 'session') throw err;
    // The {tabId, sessionId} debuggee is Chrome 125+; on an older build it is
    // rejected outright, and a session can also disappear under us. Fall back
    // once to attach-by-targetId and remember not to try the session again.
    demoteFrameRoute(tabId, frameId);
    const fallback = await ensureFrameRoute(tabId, frameId, aggressiveRetry, targetUrl, true);
    return sendDebuggerCommand(fallback.debuggee, method, params, timeoutMs);
  }
}

export async function insertText(
  tabId: number,
  text: string,
): Promise<void> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Input.insertText', { text });
}

export function registerFrameTracking(): void {
  registerFrameTargetCleanup();
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (!tabId) return;
    // Chrome 106+ stamps flatten-mode child-session events with
    // source.sessionId (same DebuggerSessionTarget widening as the debuggee
    // side — see the type above). Undefined means this event came from the
    // tab-level session itself.
    const eventSessionId = (source as DebuggerSessionTarget).sessionId;

    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      // Store ALL contexts (including content script isolated worlds)
      if (context?.auxData?.frameId) {
        if (!tabAllContexts.has(tabId)) {
          tabAllContexts.set(tabId, new Map());
        }
        tabAllContexts.get(tabId)!.set(context.id, {
          id: context.id,
          origin: context.origin || '',
          name: context.name || '',
          auxData: context.auxData,
          sessionId: eventSessionId,
        });
      }
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId as string;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, new Map());
      }
      tabFrameContexts.get(tabId)!.set(frameId, { contextId: context.id, sessionId: eventSessionId });
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const ctxId = params.executionContextId;
      tabAllContexts.get(tabId)?.delete(ctxId);
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, entry] of contexts) {
          if (entry.contextId === ctxId) { contexts.delete(fid); break; }
        }
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      tabFrameContexts.delete(tabId);
      tabAllContexts.delete(tabId);
    }

    if (method === 'Target.attachedToTarget') {
      const targetInfo = params?.targetInfo as { targetId?: string; type?: string; url?: string; title?: string } | undefined;
      const attachedSessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
      if (attachedSessionId) {
        if (!tabLiveSessionIds.has(tabId)) tabLiveSessionIds.set(tabId, new Set());
        tabLiveSessionIds.get(tabId)!.add(attachedSessionId);
      }
      if (targetInfo?.type === 'iframe' && targetInfo.targetId) {
        if (!tabIframeTargets.has(tabId)) tabIframeTargets.set(tabId, new Map());
        tabIframeTargets.get(tabId)!.set(targetInfo.targetId, {
          url: targetInfo.url || '',
          title: targetInfo.title || '',
          // Flatten-mode child session id — the preferred way to command this
          // OOPIF (see ensureFrameRoute).
          sessionId: attachedSessionId,
        });
        tabAttachedEventCounts.set(tabId, (tabAttachedEventCounts.get(tabId) || 0) + 1);
      }
    }

    if (method === 'Target.detachedFromTarget') {
      const targetId = String(params?.targetId || '');
      if (targetId) tabIframeTargets.get(tabId)?.delete(targetId);
      const sessionId = String(params?.sessionId || '');
      if (sessionId) {
        tabLiveSessionIds.get(tabId)?.delete(sessionId);
        clearFrameRoutesForSession(tabId, sessionId);
        clearContextsForSession(tabId, sessionId);
      }
    }

    // Target.targetDestroyed / Target.targetCrashed carry only targetId (no
    // sessionId) but mean the same thing for routing purposes: whatever
    // route or cached context pointed at that target is now dead and must
    // not be reused silently. Chrome does not guarantee detachedFromTarget
    // also fires in every case (e.g. the tab-level session going away out
    // from under a still-listed OOPIF), so this is a second, independent
    // invalidation path rather than relying on detachedFromTarget alone.
    if (method === 'Target.targetDestroyed' || method === 'Target.targetCrashed') {
      const targetId = String(params?.targetId || '');
      if (targetId) {
        const info = tabIframeTargets.get(tabId)?.get(targetId);
        tabIframeTargets.get(tabId)?.delete(targetId);
        if (info?.sessionId) {
          tabLiveSessionIds.get(tabId)?.delete(info.sessionId);
          clearFrameRoutesForSession(tabId, info.sessionId);
          clearContextsForSession(tabId, info.sessionId);
        }
        clearFrameTarget(targetId);
      }
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabFrameContexts.delete(tabId);
    tabAllContexts.delete(tabId);
    tabIframeTargets.delete(tabId);
    tabLiveSessionIds.delete(tabId);
    tabAttachedEventCounts.delete(tabId);
  });
}

export function getAllContexts(tabId: number): Array<{ id: number; origin: string; name: string; auxData: any; sessionId?: string }> {
  const contexts = tabAllContexts.get(tabId);
  if (!contexts) return [];
  return Array.from(contexts.values());
}

/**
 * Which flatten-mode session (undefined = tab-level) a given execution
 * context id belongs to, and whether that session is still live. Used by
 * background.ts's `eval --context <id>` handling to route the command to
 * the session that actually owns the context instead of guessing
 * `{tabId}`-only — which, for a child-session context id, does not error,
 * it silently evaluates a same-numbered context in the wrong (main) frame.
 */
export function resolveContextSession(
  tabId: number,
  contextId: number,
): { sessionId?: string; live: boolean } | undefined {
  const entry = tabAllContexts.get(tabId)?.get(contextId);
  if (!entry) return undefined;
  if (!entry.sessionId) return { sessionId: undefined, live: true };
  const live = tabLiveSessionIds.get(tabId)?.has(entry.sessionId) ?? false;
  return { sessionId: entry.sessionId, live };
}

export async function getFrameTree(tabId: number): Promise<any> {
  await ensureAttached(tabId);
  return sendDebuggerCommand({ tabId }, 'Page.getFrameTree');
}

export async function evaluateInFrame(
  tabId: number,
  expression: string,
  frameId: string,
  aggressiveRetry: boolean = false,
  timeoutMs: number = CDP_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  await ensureAttached(tabId, aggressiveRetry);

  await sendDebuggerCommand({ tabId }, 'Runtime.enable').catch(() => {});

  const contexts = tabFrameContexts.get(tabId);
  const cached = contexts?.get(frameId);

  // A cached context tied to a child flatten-mode session MUST be routed via
  // {tabId, sessionId} — sending it on the plain {tabId} (tab-level) debuggee
  // does not error, it silently evaluates a same-numbered context in the
  // main frame's own session instead (each flatten session numbers its
  // Runtime contexts independently). If the owning session is no longer
  // live, treat the cache as stale rather than guessing.
  const cacheUsable = cached !== undefined
    && (cached.sessionId === undefined || (tabLiveSessionIds.get(tabId)?.has(cached.sessionId) ?? false));

  if (cacheUsable && cached) {
    const debuggee = cached.sessionId
      ? ({ tabId, sessionId: cached.sessionId } as DebuggerSessionTarget as chrome.debugger.Debuggee)
      : ({ tabId } as chrome.debugger.Debuggee);
    try {
      const result = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
        expression,
        contextId: cached.contextId,
        returnByValue: true,
        awaitPromise: true,
      }, timeoutMs) as {
        result?: { type: string; value?: unknown; description?: string; subtype?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Eval error';
        throw new Error(errMsg);
      }
      return result.result?.value;
    } catch (err) {
      // A navigated/reloaded frame invalidates its cached context id, but the
      // Runtime.executionContextDestroyed event may not have been processed
      // yet — the cache still holds the stale id and Runtime.evaluate rejects
      // with "Cannot find context with specified id". Drop the stale id and
      // fall through to the frame-target path instead of failing (evaluate()
      // likewise re-resolves on a dead context). Re-throw genuine page errors.
      const msg = String((err as { message?: string })?.message || err);
      if (!/Cannot find context|context with specified id|Execution context was destroyed|No session with given id|Detached while handling command/i.test(msg)) {
        throw err;
      }
      contexts?.delete(frameId);
    }
  } else if (cached) {
    // Cache hit but the owning session is no longer live — drop it instead
    // of ever sending the stale contextId anywhere.
    contexts?.delete(frameId);
  }

  // No cached context, or the cached one went stale: resolve via the frame
  // target/session. ensureFrameRoute issues Runtime.enable once per route, so
  // no per-command enable is needed here.
  const result = await sendCommandInFrameTarget(tabId, frameId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, aggressiveRetry, timeoutMs) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

function normalizeCapturePatterns(pattern?: string): string[] {
  return String(pattern || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldCaptureUrl(url: string | undefined, patterns: string[]): boolean {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[String(key)] = String(value);
  }
  return out;
}

function getOrCreateNetworkCaptureEntry(tabId: number, requestId: string, fallback?: {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
}): NetworkCaptureEntry | null {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(requestId);
  if (existingIndex !== undefined) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || '';
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry: NetworkCaptureEntry = {
    kind: 'cdp',
    url,
    method: fallback?.method || 'GET',
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now(),
  };
  state.entries.push(entry);
  state.requestToIndex.set(requestId, state.entries.length - 1);
  return entry;
}

export async function startNetworkCapture(
  tabId: number,
  pattern?: string,
): Promise<void> {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, 'Network.enable');
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: new Map(),
  });
}

export async function readNetworkCapture(tabId: number): Promise<NetworkCaptureEntry[]> {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}

export function hasActiveNetworkCapture(tabId: number): boolean {
  return networkCaptures.has(tabId);
}

/**
 * Drop any tabFrameContexts / tabAllContexts entries attributed to a
 * flatten-mode session that just detached, was destroyed, or crashed — a
 * cached contextId for a dead session must never be reused; a numerically
 * identical contextId can legitimately exist in a different (e.g. the
 * tab-level) session and silently produce a wrong-frame result instead of
 * an error. See evaluateInFrame's fast path and handleExec's
 * `cmd.execContextId` branch in background.ts.
 */
function clearContextsForSession(tabId: number, sessionId: string): void {
  const frameCtxs = tabFrameContexts.get(tabId);
  if (frameCtxs) {
    for (const [fid, entry] of [...frameCtxs.entries()]) {
      if (entry.sessionId === sessionId) frameCtxs.delete(fid);
    }
  }
  const allCtxs = tabAllContexts.get(tabId);
  if (allCtxs) {
    for (const [cid, entry] of [...allCtxs.entries()]) {
      if (entry.sessionId === sessionId) allCtxs.delete(cid);
    }
  }
}

/** Drop any cached session route whose flatten-mode session just went away. */
function clearFrameRoutesForSession(tabId: number, sessionId: string): void {
  for (const [key, route] of [...frameRoutes.entries()]) {
    if (route.kind !== 'session' || route.sessionId !== sessionId) continue;
    if (!key.startsWith(`${tabId}:`)) continue;
    frameRoutes.delete(key);
    frameTargetKeys.delete(route.targetId);
  }
}

function clearFrameTargetsForTab(tabId: number): void {
  const prefix = `${tabId}:`;
  for (const [key, route] of [...frameRoutes.entries()]) {
    if (!key.startsWith(prefix)) continue;
    frameRoutes.delete(key);
    frameSessionUnsupported.delete(key);
    // Session routes own no separate chrome.debugger attachment — the tab-level
    // one covers them — so only the legacy targetId routes are detached below.
    if (route.kind === 'session') frameTargetKeys.delete(route.targetId);
  }
  for (const [key, targetId] of [...frameTargets.entries()]) {
    if (!key.startsWith(prefix)) continue;
    frameTargets.delete(key);
    frameTargetKeys.delete(targetId);
    chrome.debugger.detach({ targetId } as chrome.debugger.Debuggee).catch(() => {});
  }
}

export async function detach(tabId: number): Promise<void> {
  clearFrameTargetsForTab(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  networkCaptures.delete(tabId);
  tabFrameContexts.delete(tabId);
  tabAllContexts.delete(tabId);
  tabIframeTargets.delete(tabId);
  tabAttachedEventCounts.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    networkCaptures.delete(tabId);
    tabFrameContexts.delete(tabId);
    tabAllContexts.delete(tabId);
    tabIframeTargets.delete(tabId);
    tabAttachedEventCounts.delete(tabId);
    clearFrameTargetsForTab(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      attached.delete(source.tabId);
      networkCaptures.delete(source.tabId);
      tabFrameContexts.delete(source.tabId);
      tabAllContexts.delete(source.tabId);
      tabIframeTargets.delete(source.tabId);
      tabAttachedEventCounts.delete(source.tabId);
      clearFrameTargetsForTab(source.tabId);
      return;
    }
    if (source.targetId) clearFrameTarget(source.targetId);
  });
  // Invalidate attached cache when tab URL changes to non-debuggable
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params as Record<string, any> | undefined;

    if (method === 'Network.requestWillBeSent') {
      const requestId = String(eventParams?.requestId || '');
      const request = eventParams?.request as {
        url?: string;
        method?: string;
        headers?: Record<string, unknown>;
        postData?: string;
        hasPostData?: boolean;
      } | undefined;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: request?.url,
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers),
      });
      if (!entry) return;
      // On an HTTP 30x, CDP re-fires requestWillBeSent with the SAME requestId
      // (the prior hop is carried in `redirectResponse`) for the redirect
      // target — typically a GET with no postData. Overwriting the body here
      // would wipe the original request's captured POST body, so only populate
      // the body on the initial send.
      if (!eventParams?.redirectResponse) {
        entry.requestBodyKind = request?.hasPostData ? 'string' : 'empty';
        {
          const raw = String(request?.postData || '');
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
        try {
          const postData = await sendDebuggerCommand({ tabId }, 'Network.getRequestPostData', { requestId }) as { postData?: string };
          if (postData?.postData) {
            const raw = postData.postData;
            const fullSize = raw.length;
            const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
            entry.requestBodyKind = 'string';
            entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
            entry.requestBodyFullSize = fullSize;
            entry.requestBodyTruncated = truncated;
          }
        } catch {
          // Optional; some requests do not expose postData.
        }
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const requestId = String(eventParams?.requestId || '');
      const response = eventParams?.response as {
        url?: string;
        mimeType?: string;
        status?: number;
        headers?: Record<string, unknown>;
      } | undefined;
      // Lookup-only (like loadingFinished below): never create an entry from a
      // response. If the matching requestWillBeSent was already drained by a
      // readNetworkCapture() while the request was in flight, creating one here
      // produces an orphan half-entry with a defaulted method ('GET') and no
      // request data.
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || '';
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(eventParams?.requestId || '');
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === undefined) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        const body = await sendDebuggerCommand({ tabId }, 'Network.getResponseBody', { requestId }) as {
          body?: string;
          base64Encoded?: boolean;
        };
        if (typeof body?.body === 'string') {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
        // Optional; bodies are unavailable for some requests (e.g. uploads).
      }
    }
  });
}
