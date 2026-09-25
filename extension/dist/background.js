const DAEMON_PORT = 19825;
const DAEMON_HOST = "localhost";
const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
const DAEMON_PING_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/ping`;

const attached = /* @__PURE__ */ new Set();
const tabFrameContexts = /* @__PURE__ */ new Map();
const tabAllContexts = /* @__PURE__ */ new Map();
const tabLiveSessionIds = /* @__PURE__ */ new Map();
const frameTargets = /* @__PURE__ */ new Map();
const frameTargetKeys = /* @__PURE__ */ new Map();
let frameTargetCleanupRegistered = false;
const frameRoutes = /* @__PURE__ */ new Map();
const frameSessionUnsupported = /* @__PURE__ */ new Set();
const tabIframeTargets = /* @__PURE__ */ new Map();
const tabAttachedEventCounts = /* @__PURE__ */ new Map();
const CDP_RESPONSE_BODY_CAPTURE_LIMIT = 8 * 1024 * 1024;
const CDP_REQUEST_BODY_CAPTURE_LIMIT = 1 * 1024 * 1024;
const networkCaptures = /* @__PURE__ */ new Map();
const CDP_COMMAND_TIMEOUT_MS = 6e4;
const CDP_PROBE_TIMEOUT_MS = 2e3;
async function sendDebuggerCommand(target, method, params, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  let timer;
  const commandPromise = params === void 0 ? chrome.debugger.sendCommand(target, method) : chrome.debugger.sendCommand(target, method, params);
  commandPromise.catch(() => {
  });
  try {
    return await Promise.race([
      commandPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `CDP command ${method} timed out after ${Math.round(timeoutMs / 1e3)}s — the page may be blocked by a native dialog (alert/confirm/print)`
        )), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
function isDebuggableUrl$1(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === "about:blank" || url.startsWith("data:");
}
async function ensureAttached(tabId, aggressiveRetry = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isDebuggableUrl$1(tab.url)) {
      attached.delete(tabId);
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? "unknown"}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Cannot debug tab")) throw e;
    attached.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  if (attached.has(tabId)) {
    try {
      await sendDebuggerCommand({ tabId }, "Runtime.evaluate", {
        expression: "1",
        returnByValue: true
      }, CDP_PROBE_TIMEOUT_MS);
      return;
    } catch {
      attached.delete(tabId);
    }
  }
  const MAX_ATTACH_RETRIES = aggressiveRetry ? 5 : 2;
  const RETRY_DELAY_MS = aggressiveRetry ? 1500 : 500;
  let lastError = "";
  const preservedNetworkCapture = networkCaptures.get(tabId);
  for (let attempt = 1; attempt <= MAX_ATTACH_RETRIES; attempt++) {
    try {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
      }
      await chrome.debugger.attach({ tabId }, "1.3");
      lastError = "";
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTACH_RETRIES) {
        console.warn(`[opencli] attach attempt ${attempt}/${MAX_ATTACH_RETRIES} failed: ${lastError}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        try {
          const tab = await chrome.tabs.get(tabId);
          if (!isDebuggableUrl$1(tab.url)) {
            lastError = `Tab URL changed to ${tab.url} during retry`;
            break;
          }
        } catch {
          lastError = `Tab ${tabId} no longer exists`;
        }
      }
    }
  }
  if (lastError) {
    let finalUrl = "unknown";
    let finalWindowId = "unknown";
    try {
      const tab = await chrome.tabs.get(tabId);
      finalUrl = tab.url ?? "undefined";
      finalWindowId = String(tab.windowId);
    } catch {
    }
    console.warn(`[opencli] attach failed for tab ${tabId}: url=${finalUrl}, windowId=${finalWindowId}, error=${lastError}`);
    const hint = lastError.includes("chrome-extension://") ? ". Tip: another Chrome extension may be interfering — try disabling other extensions" : "";
    throw new Error(`attach failed: ${lastError}${hint}`);
  }
  attached.add(tabId);
  try {
    await sendDebuggerCommand({ tabId }, "Runtime.enable");
  } catch {
  }
  if (preservedNetworkCapture) {
    try {
      await sendDebuggerCommand({ tabId }, "Network.enable");
      networkCaptures.set(tabId, preservedNetworkCapture);
    } catch {
    }
  }
}
async function evaluate(tabId, expression, aggressiveRetry = false, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  try {
    await ensureAttached(tabId, aggressiveRetry);
    const result = await sendDebuggerCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, timeoutMs);
    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
      throw new Error(errMsg);
    }
    return result.result?.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Detached") || msg.includes("Debugger is not attached") || msg.includes("Target closed")) {
      attached.delete(tabId);
    }
    throw e;
  }
}
const evaluateAsync = evaluate;
async function screenshot(tabId, options = {}) {
  await ensureAttached(tabId);
  const format = options.format ?? "png";
  const fullPage = options.fullPage === true;
  const overrideWidth = options.width && options.width > 0 ? Math.ceil(options.width) : void 0;
  const overrideHeight = !fullPage && options.height && options.height > 0 ? Math.ceil(options.height) : void 0;
  const needsOverride = fullPage || overrideWidth !== void 0 || overrideHeight !== void 0;
  if (needsOverride) {
    if (overrideWidth !== void 0 && fullPage) {
      await sendDebuggerCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        mobile: false,
        width: overrideWidth,
        height: 0,
        deviceScaleFactor: 1
      });
    }
    let finalWidth = overrideWidth ?? 0;
    let finalHeight = overrideHeight ?? 0;
    if (fullPage) {
      const metrics = await sendDebuggerCommand({ tabId }, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) {
        if (finalWidth === 0) finalWidth = Math.ceil(size.width);
        finalHeight = Math.ceil(size.height);
      }
    }
    await sendDebuggerCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
      mobile: false,
      width: finalWidth,
      height: finalHeight,
      deviceScaleFactor: 1
    });
  }
  try {
    const params = { format };
    if (format === "jpeg" && options.quality !== void 0) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }
    const result = await sendDebuggerCommand({ tabId }, "Page.captureScreenshot", params);
    return result.data;
  } finally {
    if (needsOverride) {
      await sendDebuggerCommand({ tabId }, "Emulation.clearDeviceMetricsOverride").catch(() => {
      });
    }
  }
}
async function setFileInputFiles(tabId, files, selector) {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, "DOM.enable");
  await sendDebuggerCommand({ tabId }, "Page.enable");
  const query = selector || 'input[type="file"]';
  const found = await sendDebuggerCommand({ tabId }, "Runtime.evaluate", {
    expression: `!!document.querySelector(${JSON.stringify(query)})`,
    returnByValue: true
  });
  if (!found.result?.value) {
    throw new Error(`No element found matching selector: ${query}`);
  }
  await sendDebuggerCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const backendNodeId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Page.fileChooserOpened not received within 5s — the input may not have opened a file chooser"));
      }, 5e3);
      const listener = (source, method, params) => {
        if (source.tabId !== tabId || method !== "Page.fileChooserOpened") return;
        cleanup();
        const backend = params?.backendNodeId;
        if (typeof backend === "number") resolve(backend);
        else reject(new Error("Page.fileChooserOpened carried no backendNodeId"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
      };
      chrome.debugger.onEvent.addListener(listener);
      void sendDebuggerCommand({ tabId }, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(query)}).click()`
      }).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    await sendDebuggerCommand({ tabId }, "DOM.setFileInputFiles", {
      files,
      backendNodeId
    });
  } finally {
    await sendDebuggerCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {
    });
  }
}
function matchesDownloadPattern(item, pattern) {
  if (!pattern) return true;
  const haystack = [
    item.filename,
    item.url,
    item.finalUrl,
    item.mime
  ].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}
function downloadResult(item, startedAt) {
  return {
    downloaded: item.state === "complete",
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt
  };
}
async function waitForDownload(pattern = "", timeoutMs = 3e4) {
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);
  return await new Promise((resolve) => {
    let done = false;
    const inProgressIds = /* @__PURE__ */ new Set();
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(result);
    };
    const inspectById = async (id) => {
      const items = await chrome.downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === "complete" || item.state === "interrupted") finish(downloadResult(item, startedAt));
    };
    const onCreated = (item) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === "complete" || item.state === "interrupted") finish(downloadResult(item, startedAt));
    };
    const onChanged = (delta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: "interrupted",
        error: `No download matched "${pattern || "*"}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt
      });
    }, timeout);
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    void chrome.downloads.search({
      limit: 50,
      orderBy: ["-startTime"],
      startedAfter: new Date(startedAt - Math.max(timeout, 1e3)).toISOString()
    }).then((recent) => {
      if (done) return;
      const completed = recent.find((item) => item.state === "complete" && matchesDownloadPattern(item, pattern));
      if (completed) {
        finish(downloadResult(completed, startedAt));
        return;
      }
      for (const item of recent) {
        if (item.state === "in_progress" && matchesDownloadPattern(item, pattern)) inProgressIds.add(item.id);
      }
    }).catch((err) => {
      finish({
        downloaded: false,
        state: "interrupted",
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt
      });
    });
  });
}
function frameTargetKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}
function registerFrameTargetCleanup() {
  if (frameTargetCleanupRegistered) return;
  frameTargetCleanupRegistered = true;
  chrome.debugger.onEvent.addListener((_source, method, params) => {
    if (method === "Target.detachedFromTarget") {
      const targetId = String(params?.targetId || "");
      clearFrameTarget(targetId);
    }
  });
}
function clearFrameTarget(targetId) {
  if (!targetId) return;
  const key = frameTargetKeys.get(targetId);
  if (key) {
    frameTargets.delete(key);
    frameRoutes.delete(key);
  }
  frameTargetKeys.delete(targetId);
}
async function ensureFrameRoute(tabId, frameId, aggressiveRetry = false, targetUrl, forceAttach = false) {
  registerFrameTargetCleanup();
  await ensureAttached(tabId, aggressiveRetry);
  const key = frameTargetKey(tabId, frameId);
  const cached = frameRoutes.get(key);
  if (cached) return cached;
  await sendDebuggerCommand({ tabId }, "Target.setDiscoverTargets", { discover: true }).catch(() => {
  });
  await sendDebuggerCommand({ tabId }, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "iframe", exclude: false }]
  }).catch(() => {
  });
  let known = resolveFrameFromAttachEvents(tabId, frameId, targetUrl);
  if (!known && !tabIframeTargets.get(tabId)?.size) {
    await waitForIframeAttachEvents(tabId, 300);
    known = resolveFrameFromAttachEvents(tabId, frameId, targetUrl);
  }
  const useSession = !forceAttach && !frameSessionUnsupported.has(key) && !!known?.sessionId;
  let route;
  if (useSession && known?.sessionId) {
    route = {
      kind: "session",
      targetId: known.targetId,
      sessionId: known.sessionId,
      // Cast: sessionId is a Chrome 125+ debuggee field the pinned
      // @types/chrome does not know about. See DebuggerSessionTarget.
      debuggee: { tabId, sessionId: known.sessionId }
    };
  } else {
    const targetId = known?.targetId ?? await resolveFrameTargetId(tabId, frameId, targetUrl);
    try {
      await chrome.debugger.attach({ targetId }, "1.3");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Another debugger is already attached")) throw err;
    }
    frameTargets.set(key, targetId);
    route = { kind: "target", targetId, debuggee: { targetId } };
  }
  frameTargetKeys.set(route.targetId, key);
  frameRoutes.set(key, route);
  await sendDebuggerCommand(route.debuggee, "Runtime.enable").catch(() => {
  });
  return route;
}
function demoteFrameRoute(tabId, frameId) {
  const key = frameTargetKey(tabId, frameId);
  const route = frameRoutes.get(key);
  frameRoutes.delete(key);
  if (route) {
    frameSessionUnsupported.add(key);
    frameTargetKeys.delete(route.targetId);
  }
}
function resolveFrameFromAttachEvents(tabId, frameId, targetUrl) {
  const known = tabIframeTargets.get(tabId);
  if (!known) return void 0;
  const direct = known.get(frameId);
  if (direct) return { targetId: frameId, sessionId: direct.sessionId };
  if (targetUrl) {
    for (const [targetId, info] of known) {
      if (info.url === targetUrl) return { targetId, sessionId: info.sessionId };
    }
  }
  return void 0;
}
async function resolveFrameTargetId(tabId, frameId, targetUrl) {
  const result = await sendDebuggerCommand({ tabId }, "Target.getTargets").catch(() => null);
  const targets = result?.targetInfos ?? [];
  const frameTarget = targets.find((candidate) => {
    const candidateId = candidate.targetId || candidate.id;
    return candidate.type === "iframe" && (candidateId === frameId || !!targetUrl && candidate.url === targetUrl);
  });
  const targetId = frameTarget?.targetId || frameTarget?.id;
  if (targetId) return targetId;
  const candidates = targets.filter((target) => target.type === "iframe").map((target) => `${target.targetId || target.id || "?"} ${target.url || ""}`).join("; ");
  throw new Error(`No iframe target found for frame ${frameId}${targetUrl ? ` (${targetUrl})` : ""}. Candidates: ${candidates || "none"}`);
}
async function waitForIframeAttachEvents(tabId, maxWaitMs = 500) {
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
async function listIframeTargets(tabId) {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, "Target.setDiscoverTargets", { discover: true }).catch(() => {
  });
  let autoAttachError;
  try {
    await sendDebuggerCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }]
    });
  } catch (err) {
    autoAttachError = err instanceof Error ? err.message : String(err);
  }
  await waitForIframeAttachEvents(tabId);
  const eventCandidates = Array.from(tabIframeTargets.get(tabId)?.entries() ?? []).map(([targetId, info]) => ({ targetId, url: info.url, title: info.title }));
  const knownTargetIds = new Set(eventCandidates.map((c) => c.targetId));
  let getTargetsError;
  let getTargetsCandidates = [];
  try {
    const result = await sendDebuggerCommand({ tabId }, "Target.getTargets");
    const targets = result?.targetInfos ?? [];
    getTargetsCandidates = targets.filter((t) => t.type === "iframe").map((t) => ({ targetId: t.targetId || t.id || "", url: t.url || "", title: t.title || "" })).filter((t) => t.targetId && !knownTargetIds.has(t.targetId));
  } catch (err) {
    getTargetsError = err instanceof Error ? err.message : String(err);
  }
  const getTargetsIframeCount = getTargetsCandidates.length;
  let domFrameUrls = [];
  if (getTargetsCandidates.length > 0) {
    try {
      const raw = await evaluate(
        tabId,
        `(() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'IFRAME' && el.src) out.push(el.src); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; })()`
      );
      if (Array.isArray(raw)) domFrameUrls = raw;
    } catch {
    }
    if (domFrameUrls.length > 0) {
      const domOrigins = /* @__PURE__ */ new Set();
      for (const url of domFrameUrls) {
        try {
          domOrigins.add(new URL(url).origin);
        } catch {
        }
      }
      getTargetsCandidates = getTargetsCandidates.filter((c) => domFrameUrls.includes(c.url) || (() => {
        try {
          return domOrigins.has(new URL(c.url).origin);
        } catch {
          return false;
        }
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
      domFrameUrls
    }
  };
}
async function sendCommandInFrameTarget(tabId, frameId, method, params = {}, aggressiveRetry = false, timeoutMs = CDP_COMMAND_TIMEOUT_MS, targetUrl) {
  const route = await ensureFrameRoute(tabId, frameId, aggressiveRetry, targetUrl);
  try {
    return await sendDebuggerCommand(route.debuggee, method, params, timeoutMs);
  } catch (err) {
    if (route.kind !== "session") throw err;
    demoteFrameRoute(tabId, frameId);
    const fallback = await ensureFrameRoute(tabId, frameId, aggressiveRetry, targetUrl, true);
    return sendDebuggerCommand(fallback.debuggee, method, params, timeoutMs);
  }
}
async function insertText(tabId, text) {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, "Input.insertText", { text });
}
function registerFrameTracking() {
  registerFrameTargetCleanup();
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const eventSessionId = source.sessionId;
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      if (context?.auxData?.frameId) {
        if (!tabAllContexts.has(tabId)) {
          tabAllContexts.set(tabId, /* @__PURE__ */ new Map());
        }
        tabAllContexts.get(tabId).set(context.id, {
          id: context.id,
          origin: context.origin || "",
          name: context.name || "",
          auxData: context.auxData,
          sessionId: eventSessionId
        });
      }
      if (!context?.auxData?.frameId || context.auxData.isDefault !== true) return;
      const frameId = context.auxData.frameId;
      if (!tabFrameContexts.has(tabId)) {
        tabFrameContexts.set(tabId, /* @__PURE__ */ new Map());
      }
      tabFrameContexts.get(tabId).set(frameId, { contextId: context.id, sessionId: eventSessionId });
    }
    if (method === "Runtime.executionContextDestroyed") {
      const ctxId = params.executionContextId;
      tabAllContexts.get(tabId)?.delete(ctxId);
      const contexts = tabFrameContexts.get(tabId);
      if (contexts) {
        for (const [fid, entry] of contexts) {
          if (entry.contextId === ctxId) {
            contexts.delete(fid);
            break;
          }
        }
      }
    }
    if (method === "Runtime.executionContextsCleared") {
      tabFrameContexts.delete(tabId);
      tabAllContexts.delete(tabId);
    }
    if (method === "Target.attachedToTarget") {
      const targetInfo = params?.targetInfo;
      const attachedSessionId = typeof params?.sessionId === "string" ? params.sessionId : void 0;
      if (attachedSessionId) {
        if (!tabLiveSessionIds.has(tabId)) tabLiveSessionIds.set(tabId, /* @__PURE__ */ new Set());
        tabLiveSessionIds.get(tabId).add(attachedSessionId);
      }
      if (targetInfo?.type === "iframe" && targetInfo.targetId) {
        if (!tabIframeTargets.has(tabId)) tabIframeTargets.set(tabId, /* @__PURE__ */ new Map());
        tabIframeTargets.get(tabId).set(targetInfo.targetId, {
          url: targetInfo.url || "",
          title: targetInfo.title || "",
          // Flatten-mode child session id — the preferred way to command this
          // OOPIF (see ensureFrameRoute).
          sessionId: attachedSessionId
        });
        tabAttachedEventCounts.set(tabId, (tabAttachedEventCounts.get(tabId) || 0) + 1);
      }
    }
    if (method === "Target.detachedFromTarget") {
      const targetId = String(params?.targetId || "");
      if (targetId) tabIframeTargets.get(tabId)?.delete(targetId);
      const sessionId = String(params?.sessionId || "");
      if (sessionId) {
        tabLiveSessionIds.get(tabId)?.delete(sessionId);
        clearFrameRoutesForSession(tabId, sessionId);
        clearContextsForSession(tabId, sessionId);
      }
    }
    if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
      const targetId = String(params?.targetId || "");
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
function getAllContexts(tabId) {
  const contexts = tabAllContexts.get(tabId);
  if (!contexts) return [];
  return Array.from(contexts.values());
}
function resolveContextSession(tabId, contextId) {
  const entry = tabAllContexts.get(tabId)?.get(contextId);
  if (!entry) return void 0;
  if (!entry.sessionId) return { sessionId: void 0, live: true };
  const live = tabLiveSessionIds.get(tabId)?.has(entry.sessionId) ?? false;
  return { sessionId: entry.sessionId, live };
}
async function getFrameTree(tabId) {
  await ensureAttached(tabId);
  return sendDebuggerCommand({ tabId }, "Page.getFrameTree");
}
async function evaluateInFrame(tabId, expression, frameId, aggressiveRetry = false, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  await ensureAttached(tabId, aggressiveRetry);
  await sendDebuggerCommand({ tabId }, "Runtime.enable").catch(() => {
  });
  const contexts = tabFrameContexts.get(tabId);
  const cached = contexts?.get(frameId);
  const cacheUsable = cached !== void 0 && (cached.sessionId === void 0 || (tabLiveSessionIds.get(tabId)?.has(cached.sessionId) ?? false));
  if (cacheUsable && cached) {
    const debuggee = cached.sessionId ? { tabId, sessionId: cached.sessionId } : { tabId };
    try {
      const result2 = await sendDebuggerCommand(debuggee, "Runtime.evaluate", {
        expression,
        contextId: cached.contextId,
        returnByValue: true,
        awaitPromise: true
      }, timeoutMs);
      if (result2.exceptionDetails) {
        const errMsg = result2.exceptionDetails.exception?.description || result2.exceptionDetails.text || "Eval error";
        throw new Error(errMsg);
      }
      return result2.result?.value;
    } catch (err) {
      const msg = String(err?.message || err);
      if (!/Cannot find context|context with specified id|Execution context was destroyed|No session with given id|Detached while handling command/i.test(msg)) {
        throw err;
      }
      contexts?.delete(frameId);
    }
  } else if (cached) {
    contexts?.delete(frameId);
  }
  const result = await sendCommandInFrameTarget(tabId, frameId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, aggressiveRetry, timeoutMs);
  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Eval error";
    throw new Error(errMsg);
  }
  return result.result?.value;
}
function normalizeCapturePatterns(pattern) {
  return String(pattern || "").split("|").map((part) => part.trim()).filter(Boolean);
}
function shouldCaptureUrl(url, patterns) {
  if (!url) return false;
  if (!patterns.length) return true;
  return patterns.some((pattern) => url.includes(pattern));
}
function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[String(key)] = String(value);
  }
  return out;
}
function getOrCreateNetworkCaptureEntry(tabId, requestId, fallback) {
  const state = networkCaptures.get(tabId);
  if (!state) return null;
  const existingIndex = state.requestToIndex.get(requestId);
  if (existingIndex !== void 0) {
    return state.entries[existingIndex] || null;
  }
  const url = fallback?.url || "";
  if (!shouldCaptureUrl(url, state.patterns)) return null;
  const entry = {
    kind: "cdp",
    url,
    method: fallback?.method || "GET",
    requestHeaders: fallback?.requestHeaders || {},
    timestamp: Date.now()
  };
  state.entries.push(entry);
  state.requestToIndex.set(requestId, state.entries.length - 1);
  return entry;
}
async function startNetworkCapture(tabId, pattern) {
  await ensureAttached(tabId);
  await sendDebuggerCommand({ tabId }, "Network.enable");
  networkCaptures.set(tabId, {
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestToIndex: /* @__PURE__ */ new Map()
  });
}
async function readNetworkCapture(tabId) {
  const state = networkCaptures.get(tabId);
  if (!state) return [];
  const entries = state.entries.slice();
  state.entries = [];
  state.requestToIndex.clear();
  return entries;
}
function hasActiveNetworkCapture(tabId) {
  return networkCaptures.has(tabId);
}
function clearContextsForSession(tabId, sessionId) {
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
function clearFrameRoutesForSession(tabId, sessionId) {
  for (const [key, route] of [...frameRoutes.entries()]) {
    if (route.kind !== "session" || route.sessionId !== sessionId) continue;
    if (!key.startsWith(`${tabId}:`)) continue;
    frameRoutes.delete(key);
    frameTargetKeys.delete(route.targetId);
  }
}
function clearFrameTargetsForTab(tabId) {
  const prefix = `${tabId}:`;
  for (const [key, route] of [...frameRoutes.entries()]) {
    if (!key.startsWith(prefix)) continue;
    frameRoutes.delete(key);
    frameSessionUnsupported.delete(key);
    if (route.kind === "session") frameTargetKeys.delete(route.targetId);
  }
  for (const [key, targetId] of [...frameTargets.entries()]) {
    if (!key.startsWith(prefix)) continue;
    frameTargets.delete(key);
    frameTargetKeys.delete(targetId);
    chrome.debugger.detach({ targetId }).catch(() => {
    });
  }
}
async function detach(tabId) {
  clearFrameTargetsForTab(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  networkCaptures.delete(tabId);
  tabFrameContexts.delete(tabId);
  tabAllContexts.delete(tabId);
  tabIframeTargets.delete(tabId);
  tabAttachedEventCounts.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
  }
}
function registerListeners() {
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
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl$1(info.url)) {
      await detach(tabId);
    }
  });
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;
    const state = networkCaptures.get(tabId);
    if (!state) return;
    const eventParams = params;
    if (method === "Network.requestWillBeSent") {
      const requestId = String(eventParams?.requestId || "");
      const request = eventParams?.request;
      const entry = getOrCreateNetworkCaptureEntry(tabId, requestId, {
        url: request?.url,
        method: request?.method,
        requestHeaders: normalizeHeaders(request?.headers)
      });
      if (!entry) return;
      if (!eventParams?.redirectResponse) {
        entry.requestBodyKind = request?.hasPostData ? "string" : "empty";
        {
          const raw = String(request?.postData || "");
          const fullSize = raw.length;
          const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
          entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
          entry.requestBodyFullSize = fullSize;
          entry.requestBodyTruncated = truncated;
        }
        try {
          const postData = await sendDebuggerCommand({ tabId }, "Network.getRequestPostData", { requestId });
          if (postData?.postData) {
            const raw = postData.postData;
            const fullSize = raw.length;
            const truncated = fullSize > CDP_REQUEST_BODY_CAPTURE_LIMIT;
            entry.requestBodyKind = "string";
            entry.requestBodyPreview = truncated ? raw.slice(0, CDP_REQUEST_BODY_CAPTURE_LIMIT) : raw;
            entry.requestBodyFullSize = fullSize;
            entry.requestBodyTruncated = truncated;
          }
        } catch {
        }
      }
      return;
    }
    if (method === "Network.responseReceived") {
      const requestId = String(eventParams?.requestId || "");
      const response = eventParams?.response;
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === void 0) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      entry.responseStatus = response?.status;
      entry.responseContentType = response?.mimeType || "";
      entry.responseHeaders = normalizeHeaders(response?.headers);
      return;
    }
    if (method === "Network.loadingFinished") {
      const requestId = String(eventParams?.requestId || "");
      const stateEntryIndex = state.requestToIndex.get(requestId);
      if (stateEntryIndex === void 0) return;
      const entry = state.entries[stateEntryIndex];
      if (!entry) return;
      try {
        const body = await sendDebuggerCommand({ tabId }, "Network.getResponseBody", { requestId });
        if (typeof body?.body === "string") {
          const fullSize = body.body.length;
          const truncated = fullSize > CDP_RESPONSE_BODY_CAPTURE_LIMIT;
          const stored = truncated ? body.body.slice(0, CDP_RESPONSE_BODY_CAPTURE_LIMIT) : body.body;
          entry.responsePreview = body.base64Encoded ? `base64:${stored}` : stored;
          entry.responseBodyFullSize = fullSize;
          entry.responseBodyTruncated = truncated;
        }
      } catch {
      }
    }
  });
}

const targetToTab = /* @__PURE__ */ new Map();
const tabToTarget = /* @__PURE__ */ new Map();
async function resolveTargetId(tabId) {
  const cached = tabToTarget.get(tabId);
  if (cached) return cached;
  await refreshMappings();
  const result = tabToTarget.get(tabId);
  if (!result) throw new Error(`No targetId for tab ${tabId} — page may have been closed`);
  return result;
}
async function resolveTabId$1(targetId) {
  const cached = targetToTab.get(targetId);
  if (cached !== void 0) return cached;
  await refreshMappings();
  const result = targetToTab.get(targetId);
  if (result === void 0) throw new Error(`Page not found: ${targetId} — stale page identity`);
  return result;
}
function evictTab(tabId) {
  const targetId = tabToTarget.get(tabId);
  if (targetId) targetToTab.delete(targetId);
  tabToTarget.delete(tabId);
}
async function refreshMappings() {
  const targets = await chrome.debugger.getTargets();
  targetToTab.clear();
  tabToTarget.clear();
  for (const t of targets) {
    if (t.type === "page" && t.tabId !== void 0) {
      targetToTab.set(t.id, t.tabId);
      tabToTarget.set(t.tabId, t.id);
    }
  }
}

const JOURNAL_KEY = "opencli_command_journal_v1";
const JOURNAL_MAX_ENTRIES = 64;
const JOURNAL_RESULT_MAX_BYTES = 64 * 1024;
let cache = null;
let writeQueue = Promise.resolve();
const inFlight = /* @__PURE__ */ new Map();
async function load() {
  if (cache) return cache;
  try {
    const stored = await chrome.storage.session.get(JOURNAL_KEY);
    cache = stored?.[JOURNAL_KEY] ?? {};
  } catch {
    cache = {};
  }
  return cache;
}
function persist() {
  const snapshot = cache;
  if (!snapshot) return;
  writeQueue = writeQueue.then(async () => {
    try {
      await chrome.storage.session.set({ [JOURNAL_KEY]: snapshot });
    } catch {
    }
  });
}
function trim(journal) {
  const ids = Object.keys(journal);
  if (ids.length <= JOURNAL_MAX_ENTRIES) return;
  ids.sort((a, b) => journal[a].ts - journal[b].ts);
  for (const id of ids.slice(0, ids.length - JOURNAL_MAX_ENTRIES)) delete journal[id];
}
function resultByteLength(result) {
  try {
    return JSON.stringify(result).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
const UNKNOWN_OUTCOME_HINT = "Inspect the browser/session state before retrying. Do not blindly re-run write commands such as navigate, click, type, or eval.";
async function executeWithJournal(cmd, execute) {
  const id = cmd.id;
  if (!id) return execute(cmd);
  const running = inFlight.get(id);
  if (running) return running;
  const run = (async () => {
    const journal = await load();
    const entry = journal[id];
    if (entry?.status === "done") {
      if (entry.result) return entry.result;
      return {
        id,
        ok: false,
        errorCode: "result_evicted",
        error: "Command already executed, but its result was too large to record for replay.",
        errorHint: UNKNOWN_OUTCOME_HINT
      };
    }
    if (entry?.status === "started") {
      return {
        id,
        ok: false,
        errorCode: "command_lost",
        error: "Command was interrupted mid-execution (extension or browser restarted); it may or may not have applied.",
        errorHint: UNKNOWN_OUTCOME_HINT
      };
    }
    journal[id] = { status: "started", ts: Date.now() };
    trim(journal);
    persist();
    let result;
    try {
      result = await execute(cmd);
    } catch (err) {
      result = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    journal[id] = resultByteLength(result) <= JOURNAL_RESULT_MAX_BYTES ? { status: "done", ts: Date.now(), result } : { status: "done", ts: Date.now() };
    persist();
    return result;
  })();
  inFlight.set(id, run);
  try {
    return await run;
  } finally {
    inFlight.delete(id);
  }
}

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const CONTEXT_ID_KEY = "opencli_context_id_v1";
let currentContextId = "default";
let contextIdPromise = null;
let connectInFlight = null;
let handshakeTimer = null;
let workerReady = Promise.resolve();
let workerRecovered = true;
async function getCurrentContextId() {
  if (contextIdPromise) return contextIdPromise;
  contextIdPromise = (async () => {
    try {
      const local = chrome.storage?.local;
      if (!local) return currentContextId;
      const raw = await local.get(CONTEXT_ID_KEY);
      const existing = raw[CONTEXT_ID_KEY];
      if (typeof existing === "string" && existing.trim()) {
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
function generateContextId() {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length;
  let id = "";
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
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
function forwardLog(level, args) {
  try {
    const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    safeSend(ws, { type: "log", level, msg, ts: Date.now() });
  } catch {
  }
}
function safeSend(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
console.log = (...args) => {
  _origLog(...args);
  forwardLog("info", args);
};
console.warn = (...args) => {
  _origWarn(...args);
  forwardLog("warn", args);
};
console.error = (...args) => {
  _origError(...args);
  forwardLog("error", args);
};
function isDaemonSocketActive(socket = ws) {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;
}
function connect() {
  if (isDaemonSocketActive()) return Promise.resolve();
  if (connectInFlight) return connectInFlight;
  const attempt = workerRecovered ? connectAttempt() : workerReady.then(() => connectAttempt());
  connectInFlight = attempt.finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}
async function connectAttempt() {
  if (isDaemonSocketActive()) return;
  try {
    const res = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(1e3),
      credentials: "omit"
    });
    if (!res.ok) {
      console.warn(`[opencli] daemon ping failed: HTTP ${res.status}`);
      scheduleReconnect();
      return;
    }
    reconnectAttempts = 0;
  } catch {
    scheduleReconnect();
    return;
  }
  if (isDaemonSocketActive()) return;
  let thisWs;
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
    console.warn("[opencli] Daemon WebSocket handshake timed out; reconnecting");
    ws = null;
    thisWs.close();
    scheduleReconnect();
  }, 1e4);
  thisWs.onopen = () => {
    if (ws !== thisWs) return;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    console.log("[opencli] Connected to daemon");
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    safeSend(thisWs, {
      type: "hello",
      contextId: currentContextId,
      version: chrome.runtime.getManifest().version,
      compatRange: ">=1.7.0"
    });
    startWsKeepalive(thisWs);
  };
  thisWs.onmessage = async (event) => {
    if (ws !== thisWs) return;
    let stallTimer;
    try {
      const command = JSON.parse(event.data);
      let stage = "journal storage";
      stallTimer = setTimeout(() => {
        console.warn(`[opencli] Command ${command.id} action=${command.action} still waiting at ${stage} after 5s`);
      }, 5e3);
      const result = await executeWithJournal(command, (cmd) => {
        stage = "Chrome API handler";
        return handleCommand(cmd);
      });
      const target = ws && ws.readyState === WebSocket.OPEN ? ws : thisWs;
      safeSend(target, result);
    } catch (err) {
      console.error("[opencli] Message handling error:", err);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  };
  thisWs.onclose = () => {
    stopWsKeepalive(thisWs);
    if (ws !== thisWs) return;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    console.log("[opencli] Disconnected from daemon");
    ws = null;
    scheduleReconnect();
  };
  thisWs.onerror = () => {
    thisWs.close();
  };
}
const WS_KEEPALIVE_INTERVAL_MS = 2e4;
let wsKeepaliveTimer = null;
let wsKeepaliveSocket = null;
function startWsKeepalive(socket) {
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveSocket = socket;
  wsKeepaliveTimer = setInterval(() => {
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
      stopWsKeepalive(socket);
      return;
    }
    safeSend(socket, { type: "ping", ts: Date.now() });
  }, WS_KEEPALIVE_INTERVAL_MS);
}
function stopWsKeepalive(socket) {
  if (wsKeepaliveSocket !== socket) return;
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveTimer = null;
  wsKeepaliveSocket = null;
}
const RECONNECT_BASE_DELAY_MS = 1e3;
const RECONNECT_MAX_DELAY_MS = 15e3;
function nextReconnectDelayMs() {
  const exp = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempts, 6));
  return exp + Math.floor(Math.random() * 500);
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = nextReconnectDelayMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}
const WINDOW_MODES = ["foreground", "active", "background", "isolated", "dedicated"];
function isWindowMode(value) {
  return typeof value === "string" && WINDOW_MODES.includes(value);
}
const automationSessions = /* @__PURE__ */ new Map();
const IDLE_TIMEOUT_DEFAULT = 3e4;
const IDLE_TIMEOUT_INTERACTIVE = 6e5;
const IDLE_TIMEOUT_NONE = -1;
const REGISTRY_KEY = "opencli_target_lease_registry_v2";
const LEASE_IDLE_ALARM_PREFIX = "opencli:lease-idle:";
const OWNED_TAB_GROUP_TITLE_PREFIX = "OpenCLI: ";
const OWNED_TAB_GROUP_COLOR = "orange";
let leaseMutationQueue = Promise.resolve();
const ownedContainers = {
  interactive: { windowId: null, groups: /* @__PURE__ */ new Map(), borrowed: false, windowFallbackReason: null, promise: null, groupPromise: null },
  automation: { windowId: null, groups: /* @__PURE__ */ new Map(), borrowed: false, windowFallbackReason: null, promise: null, groupPromise: null }
};
const DEFAULT_DEDICATED_SLOT = "default";
const DEDICATED_REGISTRY_KEY = "opencli_dedicated_windows_v1";
const dedicatedSlots = /* @__PURE__ */ new Map();
const selfMovingTabIds = /* @__PURE__ */ new Map();
let dedicatedEnsureQueue = Promise.resolve();
let dedicatedReleaseQueue = Promise.resolve();
const selfCreatedTabIds = /* @__PURE__ */ new Set();
let dedicatedTabCreatesInFlight = 0;
let foreignTabSettleMs = 1500;
const ownedGroupLedger = /* @__PURE__ */ new Map();
class CommandFailure extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = "CommandFailure";
  }
}
const sessionOverrides = /* @__PURE__ */ new Map();
function setSessionOverride(key, patch) {
  sessionOverrides.set(key, { ...sessionOverrides.get(key), ...patch });
}
const activeCommandCounts = /* @__PURE__ */ new Map();
const LEASE_KEY_SEPARATOR = "\0";
function getLeaseKey(session, surface) {
  return `${surface}${LEASE_KEY_SEPARATOR}${encodeURIComponent(session)}`;
}
function getSessionName(session) {
  const raw = session?.trim();
  if (!raw) throw new CommandFailure(
    "session_required",
    "Browser session is required.",
    "Pass a browser session name, e.g. opencli browser <session> <command>."
  );
  return raw;
}
function getCommandSurface(cmd) {
  return cmd.surface === "adapter" ? "adapter" : "browser";
}
function getSurfaceFromKey(key) {
  return key.split(LEASE_KEY_SEPARATOR, 1)[0] === "adapter" ? "adapter" : "browser";
}
function getSessionFromKey(key) {
  const idx = key.indexOf(LEASE_KEY_SEPARATOR);
  if (idx === -1) return key;
  try {
    return decodeURIComponent(key.slice(idx + 1));
  } catch {
    return key.slice(idx + 1);
  }
}
function getIdleTimeout(key) {
  const session = automationSessions.get(key);
  if (session?.kind === "bound") return IDLE_TIMEOUT_NONE;
  const overrides = sessionOverrides.get(key);
  const adapterPersistent = getSurfaceFromKey(key) === "adapter" && (session?.lifecycle === "persistent" || overrides?.lifecycle === "persistent");
  if (adapterPersistent) return IDLE_TIMEOUT_NONE;
  if (overrides?.idleTimeoutMs !== void 0) return overrides.idleTimeoutMs;
  return getSurfaceFromKey(key) === "browser" ? IDLE_TIMEOUT_INTERACTIVE : IDLE_TIMEOUT_DEFAULT;
}
function getLeaseLifecycle(key, kind) {
  if (kind === "bound") return "pinned";
  const override = sessionOverrides.get(key)?.lifecycle;
  if (override) return override;
  return getSurfaceFromKey(key) === "browser" ? "persistent" : "ephemeral";
}
function getOwnedWindowRole(key) {
  return getSurfaceFromKey(key) === "browser" ? "interactive" : "automation";
}
function getWindowRole(key, ownership) {
  return ownership === "borrowed" ? "borrowed-user" : getOwnedWindowRole(key);
}
const DEFAULT_WINDOW_MODE = "dedicated";
let defaultWindowMode = DEFAULT_WINDOW_MODE;
function getWindowMode(key) {
  return sessionOverrides.get(key)?.windowMode ?? defaultWindowMode;
}
function makeAlarmName(leaseKey) {
  return `${LEASE_IDLE_ALARM_PREFIX}${encodeURIComponent(leaseKey)}`;
}
function leaseKeyFromAlarmName(name) {
  if (!name.startsWith(LEASE_IDLE_ALARM_PREFIX)) return null;
  try {
    return decodeURIComponent(name.slice(LEASE_IDLE_ALARM_PREFIX.length));
  } catch {
    return null;
  }
}
function withLeaseMutation(fn) {
  const run = leaseMutationQueue.then(fn, fn);
  leaseMutationQueue = run.then(() => void 0, () => void 0);
  return run;
}
function makeSession(key, session) {
  const ownership = session.owned ? "owned" : "borrowed";
  return {
    ...session,
    contextId: currentContextId,
    ownership,
    lifecycle: getLeaseLifecycle(key, session.kind),
    windowRole: getWindowRole(key, ownership)
  };
}
const WINDOW_FALLBACK_REASONS = ["no-normal-window", "all-incognito", "all-owned", "query-failed"];
function snapshotContainer(role) {
  const groups = {};
  for (const [groupId, leaseKey] of ownedGroupLedger.entries()) {
    if (leaseKey !== null && getOwnedWindowRole(leaseKey) === role) groups[String(groupId)] = leaseKey;
  }
  return {
    windowId: ownedContainers[role].windowId,
    borrowed: ownedContainers[role].borrowed,
    windowFallbackReason: ownedContainers[role].windowFallbackReason,
    groups
  };
}
function emptyRegistry() {
  return {
    version: 2,
    contextId: currentContextId,
    ownedContainers: {
      interactive: snapshotContainer("interactive"),
      automation: snapshotContainer("automation")
    },
    leases: {}
  };
}
function coerceStoredContainer(raw) {
  const groups = {};
  if (raw?.groups && typeof raw.groups === "object") {
    for (const [groupId, leaseKey] of Object.entries(raw.groups)) {
      if (/^\d+$/.test(groupId) && typeof leaseKey === "string") groups[groupId] = leaseKey;
    }
  }
  return {
    windowId: typeof raw?.windowId === "number" ? raw.windowId : null,
    borrowed: raw?.borrowed === true,
    windowFallbackReason: WINDOW_FALLBACK_REASONS.includes(raw?.windowFallbackReason) ? raw.windowFallbackReason : null,
    groups,
    groupIds: Array.isArray(raw?.groupIds) ? raw.groupIds.filter((id) => typeof id === "number") : []
  };
}
async function readRegistry() {
  try {
    const session = chrome.storage?.session;
    if (!session) return emptyRegistry();
    const raw = await session.get(REGISTRY_KEY);
    const stored = raw[REGISTRY_KEY];
    if (!stored || stored.version !== 2 || typeof stored.leases !== "object") return emptyRegistry();
    const storedContainers = stored.ownedContainers && typeof stored.ownedContainers === "object" ? stored.ownedContainers : emptyRegistry().ownedContainers;
    return {
      version: 2,
      contextId: currentContextId,
      ownedContainers: {
        interactive: coerceStoredContainer(storedContainers.interactive),
        automation: coerceStoredContainer(storedContainers.automation)
      },
      leases: stored.leases
    };
  } catch {
    return emptyRegistry();
  }
}
async function writeRegistry(registry) {
  try {
    await chrome.storage?.session?.set({ [REGISTRY_KEY]: registry });
  } catch {
  }
}
async function persistRuntimeState() {
  const leases = {};
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
      updatedAt: Date.now()
    };
  }
  await writeRegistry({
    version: 2,
    contextId: currentContextId,
    ownedContainers: {
      interactive: snapshotContainer("interactive"),
      automation: snapshotContainer("automation")
    },
    leases
  });
}
function scheduleIdleAlarm(leaseKey, timeout) {
  const alarmName = makeAlarmName(leaseKey);
  try {
    if (timeout > 0) {
      chrome.alarms?.create?.(alarmName, { when: Date.now() + timeout });
    } else {
      chrome.alarms?.clear?.(alarmName);
    }
  } catch {
  }
}
async function safeDetach(tabId) {
  try {
    const detach$1 = detach;
    if (typeof detach$1 === "function") await detach$1(tabId);
  } catch {
  }
}
async function removeLeaseSession(leaseKey) {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.delete(leaseKey);
  sessionOverrides.delete(leaseKey);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
  await persistRuntimeState();
}
function resetWindowIdleTimer(leaseKey, remainingMs) {
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
  const interval = remainingMs === void 0 ? timeout : Math.max(0, Math.min(remainingMs, timeout));
  scheduleIdleAlarm(leaseKey, interval);
  session.idleDeadlineAt = Date.now() + interval;
  void persistRuntimeState();
  session.idleTimer = setTimeout(async () => {
    if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) {
      return;
    }
    await releaseLease(leaseKey, "idle timeout");
  }, interval);
}
function getOwnedGroupTitle(leaseKey) {
  const session = getSessionFromKey(leaseKey);
  if (getSurfaceFromKey(leaseKey) === "adapter") {
    const site = /^site:([^:]+)(?::[0-9a-f-]{36})?$/i.exec(session)?.[1];
    if (site) return `${OWNED_TAB_GROUP_TITLE_PREFIX}${site}`;
  }
  return `${OWNED_TAB_GROUP_TITLE_PREFIX}${session}`;
}
function otherOwnedPreferredTabIds(leaseKey) {
  const ids = /* @__PURE__ */ new Set();
  for (const [key, session] of automationSessions.entries()) {
    if (key === leaseKey || !session.owned || session.preferredTabId === null) continue;
    ids.add(session.preferredTabId);
  }
  return ids;
}
function wantsActiveTab(mode) {
  return mode === "foreground" || mode === "active";
}
async function focusOwnedWindowIfRequested(windowId, mode) {
  if (mode !== "foreground") return;
  const updateWindow = chrome.windows.update;
  if (typeof updateWindow === "function") await updateWindow(windowId, { focused: true }).catch(() => {
  });
}
async function toOwnedContainerGroupCandidate(group) {
  try {
    const chromeWindow = await chrome.windows.get(group.windowId);
    const reusableTabId = await findReusableOwnedContainerTab(group.windowId, group.id);
    return {
      id: group.id,
      windowId: group.windowId,
      title: group.title,
      focused: !!chromeWindow.focused,
      hasReusableTab: reusableTabId !== void 0
    };
  } catch {
    return null;
  }
}
function selectOwnedContainerGroupCandidate(candidates) {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.focused !== b.focused) return a.focused ? -1 : 1;
    if (a.hasReusableTab !== b.hasReusableTab) return a.hasReusableTab ? -1 : 1;
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.id - b.id;
  })[0];
}
async function pruneOwnedGroupLedger() {
  const alive = /* @__PURE__ */ new Map();
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
async function collectOwnedGroupCandidates(role, leaseKey) {
  const container = ownedContainers[role];
  const groupsById = /* @__PURE__ */ new Map();
  const foreignTabIds = otherOwnedPreferredTabIds(leaseKey);
  const claimedByOther = (groupId) => {
    const owner = ownedGroupLedger.get(groupId);
    return owner !== void 0 && owner !== null && owner !== leaseKey;
  };
  const cachedGroupId = container.groups.get(leaseKey);
  if (cachedGroupId !== void 0) {
    try {
      const group = await chrome.tabGroups.get(cachedGroupId);
      groupsById.set(group.id, group);
    } catch {
      container.groups.delete(leaseKey);
    }
  }
  for (const [groupId, group] of await pruneOwnedGroupLedger()) {
    if (ownedGroupLedger.get(groupId) === leaseKey && !groupsById.has(groupId)) groupsById.set(groupId, group);
  }
  try {
    const titled = await chrome.tabGroups.query({ title: getOwnedGroupTitle(leaseKey) });
    for (const group of titled) {
      if (groupsById.has(group.id) || claimedByOther(group.id)) continue;
      const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
      if (tabsInGroup.some((tab) => tab.id !== void 0 && foreignTabIds.has(tab.id))) continue;
      groupsById.set(group.id, group);
    }
  } catch {
  }
  const session = automationSessions.get(leaseKey);
  if (session?.owned && session.preferredTabId !== null) {
    try {
      const tab = await chrome.tabs.get(session.preferredTabId);
      const groupId = tab.groupId;
      if (typeof groupId === "number" && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !claimedByOther(groupId)) {
        const group = await chrome.tabGroups.get(groupId);
        groupsById.set(group.id, group);
      }
    } catch {
    }
  }
  const candidates = await Promise.all([...groupsById.values()].map(toOwnedContainerGroupCandidate));
  return candidates.filter((candidate) => candidate !== null);
}
function updateOwnedSessionWindowForTabs(role, tabIds, windowId) {
  const moved = new Set(tabIds);
  for (const [leaseKey, session] of automationSessions.entries()) {
    if (!session.owned || getOwnedWindowRole(leaseKey) !== role) continue;
    if (session.preferredTabId !== null && moved.has(session.preferredTabId)) {
      session.windowId = windowId;
    }
  }
}
async function ensureTabsInWindow(tabIds, windowId) {
  const movedIds = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== windowId) {
        await moveTabSelf(tabId, windowId);
        movedIds.push(tabId);
      }
    } catch {
    }
  }
  return movedIds;
}
async function ensureCanonicalGroupTitle(leaseKey, group) {
  const title = getOwnedGroupTitle(leaseKey);
  if (group.title === title) return group;
  const updated = await chrome.tabGroups.update(group.id, {
    title,
    color: OWNED_TAB_GROUP_COLOR
  });
  return { id: updated.id, windowId: updated.windowId, title: updated.title };
}
async function convergeOwnedGroupDuplicates(role, leaseKey, canonical, candidates) {
  const foreignTabIds = otherOwnedPreferredTabIds(leaseKey);
  for (const duplicate of candidates) {
    if (duplicate.id === canonical.id) continue;
    const tabs = await chrome.tabs.query({ groupId: duplicate.id });
    const tabIds = tabs.map((tab) => tab.id).filter((id) => id !== void 0 && !foreignTabIds.has(id));
    if (tabIds.length === 0) continue;
    await ensureTabsInWindow(tabIds, canonical.windowId);
    await chrome.tabs.group({ groupId: canonical.id, tabIds });
    updateOwnedSessionWindowForTabs(role, tabIds, canonical.windowId);
  }
  return canonical;
}
async function attachTabsToOwnedGroup(role, group, ids) {
  if (ids.length === 0) return group;
  await ensureTabsInWindow(ids, group.windowId);
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  const missing = tabs.filter((tab) => tab !== null && tab.id !== void 0 && tab.groupId !== group.id).map((tab) => tab.id);
  if (missing.length > 0) await chrome.tabs.group({ groupId: group.id, tabIds: missing });
  updateOwnedSessionWindowForTabs(role, ids, group.windowId);
  return group;
}
async function createOwnedGroup(role, leaseKey, windowId, ids) {
  if (ids.length === 0) throw new Error(`Cannot create ${role} tab group without tabs`);
  await ensureTabsInWindow(ids, windowId);
  const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
  ownedContainers[role].groups.set(leaseKey, groupId);
  if (!isDedicatedWindow(windowId)) ownedContainers[role].windowId = windowId;
  ownedGroupLedger.set(groupId, leaseKey);
  await persistRuntimeState();
  const group = await chrome.tabGroups.update(groupId, {
    color: OWNED_TAB_GROUP_COLOR,
    title: getOwnedGroupTitle(leaseKey),
    collapsed: false
  });
  updateOwnedSessionWindowForTabs(role, ids, group.windowId);
  return { id: group.id, windowId: group.windowId, title: group.title };
}
async function ensureOwnedContainerGroup(role, leaseKey, fallbackWindowId, tabIds, pinWindowId) {
  const ids = [...new Set(tabIds.filter((id) => id !== void 0))];
  const container = ownedContainers[role];
  const previousGroupPromise = container.groupPromise ?? Promise.resolve(null);
  const nextGroupPromise = previousGroupPromise.catch(() => null).then(() => ensureOwnedContainerGroupUnlocked(
    role,
    leaseKey,
    fallbackWindowId,
    ids,
    pinWindowId ?? (fallbackWindowId ?? void 0)
  ));
  const trackedGroupPromise = nextGroupPromise.finally(() => {
    if (container.groupPromise === trackedGroupPromise) container.groupPromise = null;
  });
  container.groupPromise = trackedGroupPromise;
  return trackedGroupPromise;
}
async function ensureOwnedContainerGroupUnlocked(role, leaseKey, fallbackWindowId, ids, pinWindowId) {
  try {
    const allCandidates = await collectOwnedGroupCandidates(role, leaseKey);
    const candidates = pinWindowId === void 0 ? allCandidates : allCandidates.filter((candidate) => candidate.windowId === pinWindowId);
    const selected = selectOwnedContainerGroupCandidate(candidates);
    let canonical = selected ? { id: selected.id, windowId: selected.windowId, title: selected.title } : null;
    if (canonical) {
      canonical = await convergeOwnedGroupDuplicates(role, leaseKey, canonical, candidates);
      canonical = await ensureCanonicalGroupTitle(leaseKey, canonical);
      canonical = await attachTabsToOwnedGroup(role, canonical, ids);
    } else if (fallbackWindowId !== null && ids.length > 0) {
      canonical = await createOwnedGroup(role, leaseKey, fallbackWindowId, ids);
    }
    const container = ownedContainers[role];
    if (canonical) {
      if (!isDedicatedWindow(canonical.windowId)) {
        if (container.windowId !== canonical.windowId) {
          container.borrowed = true;
          container.windowFallbackReason = null;
        }
        container.windowId = canonical.windowId;
      }
      container.groups.set(leaseKey, canonical.id);
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
async function ensureOwnedContainerWindow(role, leaseKey, initialUrl, mode = "background") {
  const container = ownedContainers[role];
  if (container.promise) return container.promise;
  container.promise = ensureOwnedContainerWindowUnlocked(role, leaseKey, initialUrl, mode).finally(() => {
    container.promise = null;
  });
  return container.promise;
}
async function containerWindowIsDedicated(role) {
  const container = ownedContainers[role];
  if (container.windowId === null) return false;
  if (container.borrowed) return false;
  if (isDedicatedWindow(container.windowId)) return false;
  const ours = /* @__PURE__ */ new Set();
  for (const [groupId, owner] of ownedGroupLedger.entries()) {
    if (owner !== null && getOwnedWindowRole(owner) === role) ours.add(groupId);
  }
  for (const groupId of container.groups.values()) ours.add(groupId);
  if (ours.size === 0) return false;
  try {
    const tabs = await chrome.tabs.query({ windowId: container.windowId });
    if (tabs.length === 0) return true;
    return tabs.every((tab) => typeof tab.groupId === "number" && ours.has(tab.groupId));
  } catch {
    return false;
  }
}
function forgetContainerWindow(role) {
  const container = ownedContainers[role];
  container.windowId = null;
  container.groups.clear();
  container.borrowed = false;
  container.windowFallbackReason = null;
}
async function ensureOwnedContainerWindowUnlocked(role, leaseKey, initialUrl, mode = "background") {
  const container = ownedContainers[role];
  const wantsDedicated = mode === "isolated";
  if (wantsDedicated && !await containerWindowIsDedicated(role)) {
    forgetContainerWindow(role);
  }
  if (!wantsDedicated && container.windowId !== null) {
    const current = await findHostWindowForContainer(container.borrowed ? container.windowId : void 0);
    if (current.windowId !== void 0 && current.windowId !== container.windowId) {
      forgetContainerWindow(role);
    }
  }
  if (container.windowId !== null) {
    try {
      await chrome.windows.get(container.windowId);
      const group2 = await ensureOwnedContainerGroup(
        role,
        leaseKey,
        container.windowId,
        [],
        wantsDedicated ? container.windowId : void 0
      );
      if (group2) {
        await focusOwnedWindowIfRequested(group2.windowId, mode);
        const initialTabId3 = await findReusableOwnedContainerTab(group2.windowId, group2.id);
        return {
          windowId: group2.windowId,
          initialTabId: initialTabId3
        };
      }
      await focusOwnedWindowIfRequested(container.windowId, mode);
      const initialTabId2 = await findReusableOwnedContainerTab(container.windowId, null);
      const createdGroup = await ensureOwnedContainerGroup(
        role,
        leaseKey,
        container.windowId,
        [initialTabId2],
        wantsDedicated ? container.windowId : void 0
      );
      if (createdGroup) {
        return {
          windowId: createdGroup.windowId,
          initialTabId: initialTabId2
        };
      }
      return {
        windowId: container.windowId,
        initialTabId: initialTabId2
      };
    } catch {
      forgetContainerWindow(role);
    }
  }
  const host = wantsDedicated ? { windowId: void 0, reason: void 0 } : await findHostWindowForContainer();
  const hostWindowId = host.windowId;
  const existingGroup = wantsDedicated ? null : await ensureOwnedContainerGroup(role, leaseKey, null, [], hostWindowId);
  if (existingGroup) {
    await focusOwnedWindowIfRequested(existingGroup.windowId, mode);
    const initialTabId2 = await findReusableOwnedContainerTab(existingGroup.windowId, existingGroup.id);
    await persistRuntimeState();
    return {
      windowId: existingGroup.windowId,
      initialTabId: initialTabId2
    };
  }
  const startUrl = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  let initialTabId;
  if (hostWindowId !== void 0) {
    const hostTab = await chrome.tabs.create({
      windowId: hostWindowId,
      url: startUrl,
      active: wantsActiveTab(mode)
    });
    container.windowId = hostWindowId;
    container.borrowed = true;
    container.windowFallbackReason = null;
    initialTabId = hostTab.id;
    await persistRuntimeState();
    console.log(`[opencli] Using existing window ${hostWindowId} for ${role} container (start=${startUrl})`);
    await focusOwnedWindowIfRequested(hostWindowId, mode);
  } else {
    const win = await chrome.windows.create({
      url: startUrl,
      focused: mode === "foreground",
      width: 1280,
      height: 900,
      type: "normal"
    });
    container.windowId = win.id;
    container.borrowed = false;
    container.windowFallbackReason = wantsDedicated ? null : host.reason ?? "no-normal-window";
    await persistRuntimeState();
    console.log(`[opencli] Created owned ${role} window ${container.windowId} (start=${startUrl}${container.windowFallbackReason ? `, reason=${container.windowFallbackReason}` : ""})`);
    const winTabs = await chrome.tabs.query({ windowId: win.id });
    initialTabId = winTabs[0]?.id;
  }
  const tabs = initialTabId !== void 0 ? [await chrome.tabs.get(initialTabId).catch(() => void 0)].filter(Boolean) : [];
  if (initialTabId) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      const listener = (tabId, info) => {
        if (tabId === initialTabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      if (tabs[0]?.status === "complete") {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  }
  const group = await ensureOwnedContainerGroup(
    role,
    leaseKey,
    container.windowId,
    [initialTabId],
    container.windowId ?? void 0
  );
  await persistRuntimeState();
  return { windowId: group?.windowId ?? container.windowId, initialTabId };
}
async function findHostWindowForContainer(excludeWindowId) {
  const usable = (win) => win !== void 0 && win.id !== void 0 && win.type === "normal" && !win.incognito;
  const owned = new Set(
    Object.values(ownedContainers).filter((container) => !container.borrowed).map((container) => container.windowId).filter((id) => id !== null && id !== excludeWindowId)
  );
  for (const id of dedicatedWindowIds()) owned.add(id);
  const eligible = (win) => usable(win) && !owned.has(win.id);
  try {
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (eligible(lastFocused)) return { windowId: lastFocused.id };
  } catch {
  }
  let reason;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const normal = windows.filter((win) => win !== void 0 && win.id !== void 0 && win.type === "normal");
    const notIncognito = normal.filter((win) => !win.incognito);
    const candidates = notIncognito.filter(eligible);
    if (candidates.length > 0) {
      return { windowId: (candidates.find((win) => win.focused) ?? candidates[candidates.length - 1]).id };
    }
    reason = normal.length === 0 ? "no-normal-window" : notIncognito.length === 0 ? "all-incognito" : "all-owned";
  } catch {
    reason = "query-failed";
  }
  for (const container of Object.values(ownedContainers)) {
    if (container.windowId === null || container.windowId === excludeWindowId) continue;
    if (container.borrowed || container.windowFallbackReason === null) continue;
    if (isDedicatedWindow(container.windowId)) continue;
    try {
      const win = await chrome.windows.get(container.windowId);
      if (win && !win.incognito) return { windowId: container.windowId };
    } catch {
    }
  }
  return { reason };
}
async function findReusableOwnedContainerTab(windowId, ownedGroupId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const borrowedWindow = Object.values(ownedContainers).some((c) => c.windowId === windowId && c.borrowed);
    const inOurGroup = (tab) => typeof tab.groupId === "number" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && ownedGroupLedger.has(tab.groupId);
    const ungrouped = (tab) => typeof tab.groupId !== "number" || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE;
    const reusable = tabs.find(
      (tab) => tab.id !== void 0 && initialTabIsAvailable(tab.id) && isDebuggableUrl(tab.url) && (ownedGroupId === void 0 || ownedGroupId !== null && tab.groupId === ownedGroupId || !isSafeNavigationUrl(tab.url ?? "") && (inOurGroup(tab) || ungrouped(tab) && !borrowedWindow))
    );
    return reusable?.id;
  } catch {
    return void 0;
  }
}
function initialTabIsAvailable(tabId) {
  if (tabId === void 0) return false;
  for (const session of automationSessions.values()) {
    if (session.owned && session.preferredTabId === tabId) return false;
  }
  return true;
}
const DEDICATED_SLOT_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const DEDICATED_PLACEHOLDER_PREFIX = "about:blank#opencli-dedicated=";
function dedicatedPlaceholderUrl(slot) {
  return `${DEDICATED_PLACEHOLDER_PREFIX}${slot}`;
}
const DEDICATED_CELL = { width: 1280, height: 900, offsetX: 80, offsetY: 60 };
const DEDICATED_PREFERRED_TILE = { width: 1280, height: 900 };
const DEDICATED_MIN_TILE = { width: 900, height: 620 };
const DEDICATED_POOL_PREFIX = "pool-";
const DEDICATED_IDLE_TTL_DEFAULT_MS = 15 * 6e4;
const DEDICATED_REAP_ALARM = "opencli-dedicated-reap";
let dedicatedIdleTtlMs = DEDICATED_IDLE_TTL_DEFAULT_MS;
const DEDICATED_CAPABILITIES = [
  "dedicated-window",
  "window-slots",
  "window-bounds",
  "window-display",
  "auto-select",
  "foreign-tab-policy",
  "window-pool",
  "window-close",
  "window-list",
  "idle-reap",
  "auto-display",
  "dynamic-layout"
];
function emptyDedicatedPlacement() {
  return { source: "none", requestedBounds: null, displayPattern: null, displayName: null, displayFound: null, cell: null };
}
function normalizeDedicatedSlot(raw) {
  return typeof raw === "string" && DEDICATED_SLOT_PATTERN.test(raw) ? raw : DEFAULT_DEDICATED_SLOT;
}
function isRect(value) {
  if (!value || typeof value !== "object") return false;
  const r = value;
  const finite = (k) => typeof r[k] === "number" && Number.isFinite(r[k]);
  return finite("left") && finite("top") && finite("width") && finite("height") && r.width > 0 && r.height > 0;
}
function normalizeRect(r) {
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}
function rectFromUnknown(value) {
  const r = value && typeof value === "object" ? value : {};
  const n = (k) => typeof r[k] === "number" && Number.isFinite(r[k]) ? r[k] : 0;
  return { left: n("left"), top: n("top"), width: n("width"), height: n("height") };
}
function rectFromWindow(win) {
  if (!win) return null;
  const { left, top, width, height } = win;
  if ([left, top, width, height].some((v) => typeof v !== "number")) return null;
  return { left, top, width, height };
}
function rectCenterInside(rect, area) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx >= area.left && cx < area.left + area.width && cy >= area.top && cy < area.top + area.height;
}
function compileDisplayMatcher(pattern) {
  const raw = typeof pattern === "string" ? pattern.trim() : "";
  if (!raw) return null;
  const re = /^\/(.+)\/([a-z]*)$/i.exec(raw);
  if (re) {
    try {
      return new RegExp(re[1], re[2].replace(/[gy]/g, ""));
    } catch {
    }
  }
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
function pickDisplay(displays, pattern) {
  const matcher = compileDisplayMatcher(pattern);
  if (!matcher || !displays) return null;
  const usable = (d) => d.bounds.width > 0 && d.bounds.height > 0 && matcher.test(d.name);
  const secondary = displays.find((d) => !d.primary && usable(d));
  if (secondary) return secondary;
  return displays.length === 1 && usable(displays[0]) ? displays[0] : null;
}
function dedicatedGrid(area, count) {
  const n = Math.max(1, Math.trunc(count));
  const cols = Math.min(n, Math.max(1, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = Math.min(DEDICATED_PREFERRED_TILE.width, Math.floor(area.width / cols));
  const height = Math.min(DEDICATED_PREFERRED_TILE.height, Math.floor(area.height / rows));
  if (width < Math.min(DEDICATED_MIN_TILE.width, area.width) || height < Math.min(DEDICATED_MIN_TILE.height, area.height)) return null;
  return { cols, rows, width, height };
}
function dedicatedCapacity(area) {
  let capacity = 0;
  for (let n = 1; n <= 64; n += 1) {
    if (!dedicatedGrid(area, n)) break;
    capacity = n;
  }
  return capacity;
}
function dedicatedCellGrid(display) {
  const width = Math.max(1, Math.min(DEDICATED_CELL.width, display.width));
  const height = Math.max(1, Math.min(DEDICATED_CELL.height, display.height));
  const cols = Math.max(1, Math.floor(display.width / width));
  const rows = Math.max(1, Math.floor(display.height / height));
  const offsetX = Math.max(0, Math.min(DEDICATED_CELL.offsetX, Math.floor((display.width - cols * width) / cols)));
  const offsetY = Math.max(0, Math.min(DEDICATED_CELL.offsetY, Math.floor((display.height - rows * height) / rows)));
  return { width, height, cols, rows, offsetX, offsetY };
}
function dedicatedTile(area, index, count) {
  const grid = dedicatedGrid(area, count);
  if (!grid) return null;
  const capacity = grid.cols * grid.rows;
  const i = (Math.trunc(index) % capacity + capacity) % capacity;
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  const gapX = Math.max(0, Math.floor((area.width - grid.cols * grid.width) / Math.max(1, grid.cols + 1)));
  const gapY = Math.max(0, Math.floor((area.height - grid.rows * grid.height) / Math.max(1, grid.rows + 1)));
  return {
    left: area.left + gapX + col * (grid.width + gapX),
    top: area.top + gapY + row * (grid.height + gapY),
    width: grid.width,
    height: grid.height
  };
}
function pickAutomationDisplay(displays) {
  const usable = (displays ?? []).filter((d) => d.bounds.width > 0 && d.bounds.height > 0);
  if (!usable.length) return null;
  const secondary = usable.filter((d) => !d.primary);
  const external = secondary.find((d) => d.internal === false);
  return external ?? secondary[0] ?? usable[0];
}
function displayArea(display) {
  return display.workArea && display.workArea.width > 0 && display.workArea.height > 0 ? display.workArea : display.bounds;
}
function liveDedicatedStates() {
  return [...dedicatedSlots.values()].filter((state) => state.windowId !== null).sort((a, b) => (a.tileIndex ?? 0) - (b.tileIndex ?? 0) || a.slot.localeCompare(b.slot));
}
function claimTileIndex(state) {
  if (state.tileIndex !== null) return state.tileIndex;
  const taken = new Set(liveDedicatedStates().map((s) => s.tileIndex).filter((i) => i !== null));
  let index = 0;
  while (taken.has(index)) index += 1;
  state.tileIndex = index;
  return index;
}
async function retileDedicatedWindows(displays) {
  const display = pickAutomationDisplay(displays);
  if (!display) return;
  const area = displayArea(display);
  const auto = liveDedicatedStates().filter((state) => state.placement.source === "auto");
  if (!auto.length) return;
  const count = auto.length;
  const updateWindow = chrome.windows.update;
  if (typeof updateWindow !== "function") return;
  for (let i = 0; i < auto.length; i += 1) {
    const state = auto[i];
    const target = dedicatedTile(area, i, count);
    if (!target || state.windowId === null) continue;
    state.tileIndex = i;
    state.placement.requestedBounds = target;
    state.placement.cell = i;
    state.placement.displayName = display.name;
    state.placement.displayFound = true;
    let current = null;
    try {
      const win = await chrome.windows.get(state.windowId);
      if (win.state !== void 0 && win.state !== "normal") continue;
      current = rectFromWindow(win);
    } catch {
      forgetDedicatedWindow(state);
      continue;
    }
    if (current && current.left === target.left && current.top === target.top && current.width === target.width && current.height === target.height) continue;
    try {
      await updateWindow(state.windowId, target);
    } catch (err) {
      console.warn(`[opencli] Failed to re-tile dedicated window ${state.windowId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
async function assertDedicatedCapacity(state) {
  if (state.windowId !== null) return;
  const { displays } = await listDisplays();
  const display = pickAutomationDisplay(displays);
  if (!display) return;
  const capacity = dedicatedCapacity(displayArea(display));
  const live = liveDedicatedStates().length;
  if (capacity > 0 && live >= capacity) {
    throw new Error(`dedicated-pool-exhausted: ${live} automation window(s) already fill ${display.name || "the automation display"} (capacity ${capacity} at ${DEDICATED_MIN_TILE.width}x${DEDICATED_MIN_TILE.height} minimum). Wait for a running task to finish, or close one with \`opencli browser <session> window close --slot <name>\`.`);
  }
}
async function reapIdleDedicatedWindows(now = Date.now()) {
  let closed = 0;
  for (const state of dedicatedSlots.values()) {
    for (const leaseKey of [...state.holders]) {
      if (!automationSessions.has(leaseKey)) state.holders.delete(leaseKey);
    }
    if (state.holders.size === 0 && state.idleSince === null) state.idleSince = now;
  }
  for (const state of [...dedicatedSlots.values()]) {
    if (state.holders.size > 0 || state.idleSince === null) continue;
    if (now - state.idleSince < dedicatedIdleTtlMs) continue;
    if (state.windowId !== null) {
      const windowId = state.windowId;
      try {
        await chrome.windows.remove(windowId);
        closed += 1;
        console.log(`[opencli] Closed idle dedicated window ${windowId} (slot=${state.slot}, idle ${Math.round((now - state.idleSince) / 1e3)}s)`);
      } catch {
      }
      forgetDedicatedWindow(state);
    }
    state.tileIndex = null;
    if (state.pooled) dedicatedSlots.delete(state.slot);
  }
  if (closed) {
    const { displays } = await listDisplays();
    await retileDedicatedWindows(displays);
    await persistDedicatedState();
  }
  return closed;
}
function computeDisplayCell(display, cell) {
  const g = dedicatedCellGrid(display);
  const capacity = g.cols * g.rows;
  const index = (Math.trunc(cell) % capacity + capacity) % capacity;
  const col = index % g.cols;
  const row = Math.floor(index / g.cols);
  return {
    left: display.left + g.offsetX + col * (g.width + g.offsetX),
    top: display.top + g.offsetY + row * (g.height + g.offsetY),
    width: g.width,
    height: g.height
  };
}
async function listDisplays() {
  const api = chrome.system?.display;
  if (typeof api?.getInfo !== "function") {
    return { displays: null, error: 'chrome.system.display is unavailable (extension lacks the "system.display" permission; reload it)' };
  }
  try {
    const raw = await new Promise((resolve, reject) => {
      try {
        const maybe = api.getInfo((info) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) reject(new Error(lastError.message ?? "system.display.getInfo failed"));
          else resolve(info);
        });
        if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
    const displays = (Array.isArray(raw) ? raw : []).map((entry) => {
      const d = entry && typeof entry === "object" ? entry : {};
      return {
        id: String(d.id ?? ""),
        name: String(d.name ?? ""),
        primary: d.isPrimary === true,
        internal: d.isInternal === true,
        bounds: rectFromUnknown(d.bounds),
        workArea: d.workArea ? rectFromUnknown(d.workArea) : null
      };
    });
    return { displays };
  } catch (err) {
    return { displays: null, error: err instanceof Error ? err.message : String(err) };
  }
}
function getDedicatedSlot(slot, pooled = false) {
  let state = dedicatedSlots.get(slot);
  if (!state) {
    state = {
      slot,
      pooled,
      windowId: null,
      placeholderTabIds: /* @__PURE__ */ new Set(),
      placement: emptyDedicatedPlacement(),
      autoSelect: true,
      foreignTabPolicy: "evict",
      evictedTabs: 0,
      promise: null,
      holders: /* @__PURE__ */ new Set(),
      idleSince: Date.now(),
      tileIndex: null
    };
    dedicatedSlots.set(slot, state);
  }
  return state;
}
function poolSlotFor(leaseKey, hold = false) {
  for (const state2 of dedicatedSlots.values()) if (state2.holders.has(leaseKey)) return state2;
  const idle = [...dedicatedSlots.values()].filter((state2) => state2.pooled && state2.holders.size === 0).sort((a, b) => Number(b.windowId !== null) - Number(a.windowId !== null) || (a.idleSince ?? 0) - (b.idleSince ?? 0));
  const state = idle[0] ?? getDedicatedSlot(nextPoolSlotName(), true);
  if (hold) holdDedicatedSlot(state, leaseKey);
  return state;
}
function nextPoolSlotName() {
  for (let n = 1; ; n += 1) {
    const name = `${DEDICATED_POOL_PREFIX}${n}`;
    if (!dedicatedSlots.has(name)) return name;
  }
}
function holdDedicatedSlot(state, leaseKey) {
  state.holders.add(leaseKey);
  state.idleSince = null;
}
function releaseDedicatedHolder(leaseKey) {
  for (const state of dedicatedSlots.values()) {
    if (!state.holders.delete(leaseKey)) continue;
    if (state.holders.size === 0) state.idleSince = Date.now();
  }
}
function dedicatedSlotForWindow(windowId) {
  if (windowId === null || windowId === void 0) return void 0;
  for (const state of dedicatedSlots.values()) {
    if (state.windowId === windowId) return state;
  }
  return void 0;
}
function isDedicatedWindow(windowId) {
  return dedicatedSlotForWindow(windowId) !== void 0;
}
function dedicatedWindowIds() {
  return [...dedicatedSlots.values()].map((s) => s.windowId).filter((id) => id !== null);
}
function forgetDedicatedWindow(state) {
  state.windowId = null;
  state.placeholderTabIds.clear();
}
async function persistDedicatedState() {
  const slots = {};
  for (const state of dedicatedSlots.values()) {
    slots[state.slot] = {
      windowId: state.windowId,
      placeholderTabIds: [...state.placeholderTabIds],
      placement: state.placement,
      autoSelect: state.autoSelect,
      foreignTabPolicy: state.foreignTabPolicy,
      evictedTabs: state.evictedTabs,
      pooled: state.pooled,
      idleSince: state.idleSince,
      tileIndex: state.tileIndex
    };
  }
  try {
    await chrome.storage?.session?.set({ [DEDICATED_REGISTRY_KEY]: { version: 1, slots } });
  } catch {
  }
}
function coerceDedicatedPlacement(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const source = p.source === "bounds" || p.source === "display" || p.source === "auto" ? p.source : "none";
  return {
    source,
    requestedBounds: isRect(p.requestedBounds) ? normalizeRect(p.requestedBounds) : null,
    displayPattern: typeof p.displayPattern === "string" ? p.displayPattern : null,
    displayName: typeof p.displayName === "string" ? p.displayName : null,
    displayFound: typeof p.displayFound === "boolean" ? p.displayFound : null,
    cell: typeof p.cell === "number" && Number.isInteger(p.cell) ? p.cell : null
  };
}
async function restoreDedicatedState() {
  dedicatedSlots.clear();
  let stored;
  try {
    const session = chrome.storage?.session;
    if (!session) return;
    const raw = await session.get(DEDICATED_REGISTRY_KEY);
    stored = raw?.[DEDICATED_REGISTRY_KEY];
  } catch {
    return;
  }
  if (!stored || stored.version !== 1 || !stored.slots || typeof stored.slots !== "object") return;
  for (const [slot, value] of Object.entries(stored.slots)) {
    if (!DEDICATED_SLOT_PATTERN.test(slot) || !value || typeof value !== "object") continue;
    const raw = value;
    const state = getDedicatedSlot(slot, raw.pooled === true || slot.startsWith(DEDICATED_POOL_PREFIX));
    state.autoSelect = raw.autoSelect !== false;
    state.foreignTabPolicy = raw.foreignTabPolicy === "tolerate" ? "tolerate" : "evict";
    state.evictedTabs = typeof raw.evictedTabs === "number" ? raw.evictedTabs : 0;
    state.placement = coerceDedicatedPlacement(raw.placement);
    state.tileIndex = typeof raw.tileIndex === "number" && Number.isInteger(raw.tileIndex) ? raw.tileIndex : null;
    state.holders.clear();
    state.idleSince = Date.now();
    if (typeof raw.windowId !== "number") continue;
    try {
      await chrome.windows.get(raw.windowId);
    } catch {
      continue;
    }
    state.windowId = raw.windowId;
    for (const tabId of Array.isArray(raw.placeholderTabIds) ? raw.placeholderTabIds : []) {
      if (typeof tabId !== "number") continue;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId === raw.windowId) state.placeholderTabIds.add(tabId);
      } catch {
      }
    }
  }
}
function dedicatedPlacementRequest(leaseKey) {
  const overrides = sessionOverrides.get(leaseKey);
  return {
    ...overrides?.windowBounds ? { bounds: overrides.windowBounds } : {},
    ...overrides?.windowDisplay ? { display: overrides.windowDisplay } : {}
  };
}
function dedicatedSlotNameFor(leaseKey, { hold = false } = {}) {
  const pinned = sessionOverrides.get(leaseKey)?.windowSlot;
  if (typeof pinned === "string" && DEDICATED_SLOT_PATTERN.test(pinned)) {
    if (hold) holdDedicatedSlot(getDedicatedSlot(pinned), leaseKey);
    return pinned;
  }
  return poolSlotFor(leaseKey, hold).slot;
}
function applyDedicatedCommandFields(leaseKey, cmd) {
  if (typeof cmd.dedicatedIdleMs === "number" && Number.isFinite(cmd.dedicatedIdleMs) && cmd.dedicatedIdleMs > 0) {
    dedicatedIdleTtlMs = Math.round(cmd.dedicatedIdleMs);
  }
  const pinnedSlot = typeof cmd.windowSlot === "string" && DEDICATED_SLOT_PATTERN.test(cmd.windowSlot) ? cmd.windowSlot : null;
  const slot = pinnedSlot ?? dedicatedSlotNameFor(leaseKey);
  const patch = { autoSelect: cmd.autoSelect !== false, ...pinnedSlot ? { windowSlot: pinnedSlot } : {} };
  if (isRect(cmd.windowBounds)) {
    patch.windowBounds = normalizeRect(cmd.windowBounds);
    patch.windowDisplay = typeof cmd.windowDisplay === "string" && cmd.windowDisplay.trim() ? cmd.windowDisplay.trim() : void 0;
  } else if (typeof cmd.windowDisplay === "string" && cmd.windowDisplay.trim()) {
    patch.windowDisplay = cmd.windowDisplay.trim();
    patch.windowBounds = void 0;
  }
  setSessionOverride(leaseKey, patch);
  const state = getDedicatedSlot(slot);
  state.autoSelect = patch.autoSelect !== false;
  if (cmd.foreignTabPolicy === "evict" || cmd.foreignTabPolicy === "tolerate") state.foreignTabPolicy = cmd.foreignTabPolicy;
}
function tabActivationFor(leaseKey) {
  const mode = getWindowMode(leaseKey);
  if (mode === "dedicated") return sessionOverrides.get(leaseKey)?.autoSelect !== false;
  return wantsActiveTab(mode);
}
async function resolveDedicatedTarget(state, request) {
  const previous = state.placement;
  if (request.bounds) {
    state.placement = { ...emptyDedicatedPlacement(), source: "bounds", requestedBounds: normalizeRect(request.bounds), displayPattern: request.display ?? null };
  } else if (request.display) {
    state.placement = { ...emptyDedicatedPlacement(), source: "display", displayPattern: request.display };
  }
  const placement = state.placement;
  if (placement.source === "bounds" && placement.requestedBounds) {
    return { target: placement.requestedBounds, area: placement.requestedBounds };
  }
  if (placement.source !== "display" || !placement.displayPattern) {
    const { displays: displays2 } = await listDisplays();
    const display2 = pickAutomationDisplay(displays2);
    if (!display2) {
      state.placement = { ...emptyDedicatedPlacement(), source: "auto" };
      return { target: null, area: null };
    }
    const area = displayArea(display2);
    const others = liveDedicatedStates().filter((s) => s.slot !== state.slot).length;
    const index = claimTileIndex(state);
    const target = dedicatedTile(area, index, Math.max(others + 1, index + 1));
    state.placement = {
      source: "auto",
      requestedBounds: target,
      displayPattern: null,
      displayName: display2.name,
      displayFound: true,
      cell: target ? index : null
    };
    return { target, area: target };
  }
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
  const used = /* @__PURE__ */ new Set();
  for (const other of dedicatedSlots.values()) {
    if (other === state || other.windowId === null && other.promise === null) continue;
    if (other.placement.source !== "display" || other.placement.displayName !== display.name || other.placement.cell === null) continue;
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
async function ensureDedicatedWindow(slot, request = {}) {
  const state = getDedicatedSlot(slot);
  const next = dedicatedEnsureQueue.catch(() => null).then(() => ensureDedicatedWindowUnlocked(state, request));
  const tracked = next.finally(() => {
    if (state.promise === tracked) state.promise = null;
  });
  state.promise = tracked;
  dedicatedEnsureQueue = tracked.catch(() => null);
  return tracked;
}
async function ensureDedicatedWindowUnlocked(state, request) {
  let win = null;
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
  if (!win || state.windowId === null) await assertDedicatedCapacity(state);
  const { target, area } = await resolveDedicatedTarget(state, request);
  let created = false;
  let moved = false;
  let createdTabId;
  if (!win || state.windowId === null) {
    const startUrl = request.initialUrl && isSafeNavigationUrl(request.initialUrl) ? request.initialUrl : dedicatedPlaceholderUrl(state.slot);
    dedicatedTabCreatesInFlight += 1;
    try {
      const newWindow = await chrome.windows.create({
        url: startUrl,
        focused: false,
        type: "normal",
        ...target ?? { width: DEDICATED_CELL.width, height: DEDICATED_CELL.height }
      });
      state.windowId = newWindow.id;
      state.placeholderTabIds.clear();
      const initialTabs = await chrome.tabs.query({ windowId: state.windowId }).catch(() => []);
      for (const tab of initialTabs) if (tab.id !== void 0) state.placeholderTabIds.add(tab.id);
      createdTabId = initialTabs.find((tab) => tab.id !== void 0)?.id;
      created = true;
    } finally {
      dedicatedTabCreatesInFlight -= 1;
    }
    console.log(`[opencli] Created dedicated window ${state.windowId} (slot=${state.slot}, placement=${state.placement.source}${state.placement.displayName ? `:${state.placement.displayName}#${state.placement.cell}` : ""})`);
    if (state.placement.source === "auto") {
      const { displays } = await listDisplays();
      await retileDedicatedWindows(displays);
    }
  } else if (request.reposition && target && area && (win.state === void 0 || win.state === "normal")) {
    const current = rectFromWindow(win);
    if (!current || !rectCenterInside(current, area)) {
      const updateWindow = chrome.windows.update;
      if (typeof updateWindow === "function") {
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
  const initialTabId = createdTabId !== void 0 && initialTabIsAvailable(createdTabId) ? createdTabId : await findDedicatedPlaceholder(state);
  return { windowId: state.windowId, initialTabId, created, moved };
}
async function adoptOrphanDedicatedWindow(state) {
  let marked = [];
  try {
    marked = (await chrome.tabs.query({})).filter((tab) => tab.url === dedicatedPlaceholderUrl(state.slot) && tab.id !== void 0);
  } catch {
    return null;
  }
  for (const tab of marked) {
    if (isDedicatedWindow(tab.windowId)) continue;
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.type !== void 0 && win.type !== "normal") continue;
      if (win.incognito) continue;
      state.windowId = tab.windowId;
      state.placeholderTabIds.add(tab.id);
      console.log(`[opencli] Adopted dedicated window ${tab.windowId} for slot ${state.slot} from its placeholder tab`);
      return win;
    } catch {
    }
  }
  return null;
}
function isPlaceholderUrl(url) {
  return !url || url === BLANK_PAGE || url.startsWith(DEDICATED_PLACEHOLDER_PREFIX);
}
async function findDedicatedPlaceholder(state) {
  for (const tabId of [...state.placeholderTabIds]) {
    try {
      const tab = await chrome.tabs.get(tabId);
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
  return void 0;
}
function ownedLeaseForTab(tabId) {
  for (const entry of automationSessions.entries()) {
    if (entry[1].owned && entry[1].preferredTabId === tabId) return entry;
  }
  return void 0;
}
function isOpenCliTabId(tabId) {
  if (ownedLeaseForTab(tabId)) return true;
  if (selfCreatedTabIds.has(tabId)) return true;
  for (const state of dedicatedSlots.values()) if (state.placeholderTabIds.has(tabId)) return true;
  return false;
}
function classifyDedicatedTab(state, tab) {
  if (tab.id === void 0) return "foreign";
  if (ownedLeaseForTab(tab.id)) return "lease";
  if (state.placeholderTabIds.has(tab.id)) return isPlaceholderUrl(tab.url) ? "placeholder" : "foreign";
  if (selfCreatedTabIds.has(tab.id)) return "automation";
  const inOurGroup = typeof tab.groupId === "number" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && ownedGroupLedger.has(tab.groupId);
  if (inOurGroup || typeof tab.openerTabId === "number" && isOpenCliTabId(tab.openerTabId)) {
    selfCreatedTabIds.add(tab.id);
    return "automation";
  }
  return "foreign";
}
async function moveTabSelf(tabId, windowId) {
  selfMovingTabIds.set(tabId, (selfMovingTabIds.get(tabId) ?? 0) + 1);
  try {
    await chrome.tabs.move(tabId, { windowId, index: -1 });
  } finally {
    setTimeout(() => {
      const left = (selfMovingTabIds.get(tabId) ?? 1) - 1;
      if (left <= 0) selfMovingTabIds.delete(tabId);
      else selfMovingTabIds.set(tabId, left);
    }, 2e3);
  }
}
async function findEvictionWindow(tab) {
  const created = new Set(
    Object.values(ownedContainers).filter((container) => !container.borrowed).map((container) => container.windowId).filter((id) => id !== null)
  );
  const eligible = (win) => !!win && win.id !== void 0 && win.type === "normal" && !!win.incognito === !!tab.incognito && win.id !== tab.windowId && !isDedicatedWindow(win.id) && !created.has(win.id);
  try {
    const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (eligible(lastFocused)) return lastFocused.id;
  } catch {
  }
  try {
    const candidates = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(eligible);
    if (candidates.length > 0) return (candidates.find((win) => win.focused) ?? candidates[candidates.length - 1]).id;
  } catch {
  }
  return void 0;
}
async function checkDedicatedForeignTab(tabId, attempt = 0) {
  await workerReady;
  if (dedicatedTabCreatesInFlight > 0 && attempt < 10) {
    setTimeout(() => {
      void checkDedicatedForeignTab(tabId, attempt + 1);
    }, Math.max(200, foreignTabSettleMs));
    return "deferred";
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return "gone";
  }
  const state = dedicatedSlotForWindow(tab.windowId);
  if (!state) return "not-dedicated";
  if (classifyDedicatedTab(state, tab) !== "foreign") return "ours";
  if (state.foreignTabPolicy === "tolerate") return "tolerated";
  const target = await findEvictionWindow(tab);
  if (target === void 0) {
    console.warn(`[opencli] Foreign tab ${tabId} in dedicated window ${state.windowId} (slot=${state.slot}) has no window of yours to go back to; leaving it`);
    return "stranded";
  }
  try {
    await chrome.tabs.move(tabId, { windowId: target, index: -1 });
    await chrome.tabs.update(tabId, { active: true }).catch(() => {
    });
    state.evictedTabs += 1;
    await persistDedicatedState();
    console.log(`[opencli] Moved foreign tab ${tabId} out of dedicated window ${state.windowId} into window ${target}`);
    return "evicted";
  } catch {
    return "stranded";
  }
}
function scheduleForeignTabCheck(tabId) {
  setTimeout(() => {
    void checkDedicatedForeignTab(tabId);
  }, foreignTabSettleMs);
}
async function handleTabAttached(tabId, info) {
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
    const [leaseKey, lease] = owned;
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    automationSessions.delete(leaseKey);
    sessionOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    await safeDetach(tabId);
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {
    }
    console.log(`[opencli] Session ${lease.session} gave up tab ${tabId}: it was dragged out of its dedicated window`);
    await persistRuntimeState();
  }
  if (changed) await persistDedicatedState();
}
async function closeRedundantPlaceholders(state) {
  if (state.windowId === null || state.placeholderTabIds.size === 0) return;
  const hasLease = [...automationSessions.values()].some((s) => s.owned && s.windowId === state.windowId && s.preferredTabId !== null);
  if (!hasLease) return;
  for (const tabId of [...state.placeholderTabIds]) {
    if (!initialTabIsAvailable(tabId)) continue;
    state.placeholderTabIds.delete(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && isPlaceholderUrl(tab.url)) await chrome.tabs.remove(tabId).catch(() => {
    });
  }
  await persistDedicatedState();
}
async function createDedicatedTabLease(leaseKey, targetUrl) {
  try {
    return await createDedicatedTabLeaseInner(leaseKey, targetUrl);
  } catch (err) {
    releaseDedicatedHolder(leaseKey);
    throw err;
  }
}
async function createDedicatedTabLeaseInner(leaseKey, targetUrl) {
  const slot = dedicatedSlotNameFor(leaseKey, { hold: true });
  const state = getDedicatedSlot(slot);
  const role = getOwnedWindowRole(leaseKey);
  const active = tabActivationFor(leaseKey);
  dedicatedTabCreatesInFlight += 1;
  try {
    const { windowId, initialTabId } = await ensureDedicatedWindow(slot, {
      ...dedicatedPlacementRequest(leaseKey),
      reposition: true,
      initialUrl: targetUrl
    });
    let tab;
    if (initialTabId !== void 0) {
      state.placeholderTabIds.delete(initialTabId);
      tab = await chrome.tabs.get(initialTabId);
      if (!isTargetUrl(tab.url, targetUrl)) {
        tab = await chrome.tabs.update(initialTabId, { url: targetUrl });
        await new Promise((resolve) => setTimeout(resolve, 300));
        tab = await chrome.tabs.get(initialTabId);
      }
    } else {
      tab = await chrome.tabs.create({ windowId, url: targetUrl, active });
    }
    const tabId = tab.id;
    if (!tabId) throw new Error("Failed to create tab lease in dedicated window");
    selfCreatedTabIds.add(tabId);
    const group = await ensureOwnedContainerGroup(role, leaseKey, windowId, [tabId], windowId);
    if (active && !tab.active) tab = await chrome.tabs.update(tabId, { active: true }) ?? tab;
    if (tab.windowId !== windowId) tab = await chrome.tabs.get(tabId);
    setLeaseSession(leaseKey, {
      session: getSessionFromKey(leaseKey),
      surface: getSurfaceFromKey(leaseKey),
      kind: "owned",
      windowId: group?.windowId ?? windowId,
      owned: true,
      preferredTabId: tabId
    });
    resetWindowIdleTimer(leaseKey);
    await persistDedicatedState();
    return { tabId, tab };
  } finally {
    dedicatedTabCreatesInFlight -= 1;
  }
}
async function applyDedicatedSessionPolicy(leaseKey, resolved) {
  const lease = automationSessions.get(leaseKey);
  if (!lease?.owned || lease.preferredTabId !== resolved.tabId) return resolved;
  const slot = dedicatedSlotNameFor(leaseKey, { hold: true });
  const state = getDedicatedSlot(slot);
  let tab = resolved.tab ?? await chrome.tabs.get(resolved.tabId);
  if (state.windowId === null || tab.windowId !== state.windowId) {
    dedicatedTabCreatesInFlight += 1;
    try {
      const { windowId } = await ensureDedicatedWindow(slot, { ...dedicatedPlacementRequest(leaseKey), reposition: true });
      if (tab.windowId !== windowId) {
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
    tab = await chrome.tabs.update(resolved.tabId, { active: true }) ?? tab;
  }
  return { tabId: resolved.tabId, tab };
}
async function releaseDedicatedLeaseTab(state, tabId) {
  const run = dedicatedReleaseQueue.catch(() => null).then(() => releaseDedicatedLeaseTabUnlocked(state, tabId));
  dedicatedReleaseQueue = run.catch(() => null);
  return run;
}
async function releaseDedicatedLeaseTabUnlocked(state, tabId) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return "removed";
  }
  let keepsWindow = tab.windowId !== state.windowId;
  if (!keepsWindow && state.windowId !== null) {
    const others = (await chrome.tabs.query({ windowId: state.windowId }).catch(() => [])).filter((other) => other.id !== void 0 && other.id !== tabId);
    keepsWindow = others.some((other) => classifyDedicatedTab(state, other) !== "foreign");
  }
  if (keepsWindow) {
    await chrome.tabs.remove(tabId).catch(() => {
    });
    return "removed";
  }
  try {
    await chrome.tabs.update(tabId, { url: dedicatedPlaceholderUrl(state.slot) });
    await chrome.tabs.ungroup(tabId).catch(() => {
    });
    state.placeholderTabIds.add(tabId);
    await persistDedicatedState();
    return "placeholder";
  } catch {
    await chrome.tabs.remove(tabId).catch(() => {
    });
    return "removed";
  }
}
async function describeDedicatedSlot(state, displays) {
  let win = null;
  if (state.windowId !== null) {
    try {
      win = await chrome.windows.get(state.windowId);
    } catch {
      forgetDedicatedWindow(state);
    }
  }
  const bounds = rectFromWindow(win);
  let onDisplay = null;
  if (state.placement.displayPattern && displays) {
    const display = pickDisplay(displays, state.placement.displayPattern);
    onDisplay = display && bounds ? rectCenterInside(bounds, display.bounds) : false;
  }
  const counts = { total: 0, leases: 0, placeholders: 0, automation: 0, foreign: 0 };
  let activeTab = null;
  const sessions = [];
  if (win && state.windowId !== null) {
    const tabs = await chrome.tabs.query({ windowId: state.windowId }).catch(() => []);
    for (const tab of tabs) {
      if (tab.id === void 0) continue;
      const owner = classifyDedicatedTab(state, tab);
      counts.total += 1;
      if (owner === "lease") counts.leases += 1;
      else if (owner === "placeholder") counts.placeholders += 1;
      else if (owner === "automation") counts.automation += 1;
      else counts.foreign += 1;
      const lease = ownedLeaseForTab(tab.id);
      if (lease && !sessions.includes(lease[1].session)) sessions.push(lease[1].session);
      if (tab.active) {
        activeTab = {
          tabId: tab.id,
          owner,
          session: lease ? lease[1].session : null,
          // Foreign tabs are the person's: never echo their URL or title.
          ...owner === "foreign" ? {} : { url: tab.url, title: tab.title }
        };
      }
    }
  }
  return {
    slot: state.slot,
    pooled: state.pooled,
    holders: state.holders.size,
    busy: state.holders.size > 0,
    idleMs: state.idleSince === null ? null : Math.max(0, Date.now() - state.idleSince),
    tileIndex: state.tileIndex,
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
    evictedTabs: state.evictedTabs
  };
}
async function closeDedicatedWindows(target) {
  const closed = [];
  const skipped = [];
  const states = target.all ? [...dedicatedSlots.values()] : [...dedicatedSlots.values()].filter((state) => state.slot === target.slot);
  for (const state of states) {
    if (state.holders.size > 0 && !target.force) {
      skipped.push({ slot: state.slot, reason: `held by ${state.holders.size} live lease(s); pass force to close anyway` });
      continue;
    }
    if (state.windowId !== null) {
      try {
        await chrome.windows.remove(state.windowId);
      } catch {
      }
      forgetDedicatedWindow(state);
    }
    state.holders.clear();
    state.idleSince = Date.now();
    state.tileIndex = null;
    dedicatedSlots.delete(state.slot);
    closed.push(state.slot);
  }
  if (closed.length) {
    const { displays } = await listDisplays();
    await retileDedicatedWindows(displays);
    await persistDedicatedState();
  }
  return { closed, skipped };
}
async function handleDedicatedWindowOp(cmd) {
  if (cmd.op === "runtime-reload") {
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch {
      }
    }, 150);
    return { id: cmd.id, ok: true, data: { reloading: true, note: "extension reloading; leases and dedicated windows are dropped" } };
  }
  if (cmd.op === "window-close") {
    const all = cmd.windowSlot === void 0 || cmd.windowSlot === null || cmd.windowSlot === "";
    const { closed, skipped } = await closeDedicatedWindows({
      ...all ? { all: true } : { slot: String(cmd.windowSlot) },
      force: cmd.force === true
    });
    return { id: cmd.id, ok: true, data: { closed, skipped, remaining: [...dedicatedSlots.keys()].sort() } };
  }
  if (cmd.op === "window-ensure") {
    const slot = normalizeDedicatedSlot(cmd.windowSlot);
    const state = getDedicatedSlot(slot);
    if (cmd.foreignTabPolicy === "evict" || cmd.foreignTabPolicy === "tolerate") state.foreignTabPolicy = cmd.foreignTabPolicy;
    if (typeof cmd.autoSelect === "boolean") state.autoSelect = cmd.autoSelect;
    const result = await ensureDedicatedWindow(slot, {
      ...isRect(cmd.windowBounds) ? { bounds: normalizeRect(cmd.windowBounds) } : {},
      ...typeof cmd.windowDisplay === "string" && cmd.windowDisplay.trim() ? { display: cmd.windowDisplay.trim() } : {},
      reposition: true
    });
    const { displays: displays2 } = await listDisplays();
    return { id: cmd.id, ok: true, data: { ...await describeDedicatedSlot(state, displays2), created: result.created, moved: result.moved } };
  }
  const { displays, error } = await listDisplays();
  const filter = typeof cmd.windowSlot === "string" && cmd.windowSlot ? cmd.windowSlot : null;
  const windows = [];
  for (const state of [...dedicatedSlots.values()].sort((a, b) => a.slot.localeCompare(b.slot))) {
    if (filter && state.slot !== filter) continue;
    windows.push(await describeDedicatedSlot(state, displays));
  }
  const automationDisplay = pickAutomationDisplay(displays);
  const area = automationDisplay ? displayArea(automationDisplay) : null;
  const capacity = area ? dedicatedCapacity(area) : null;
  const live = liveDedicatedStates().length;
  return {
    id: cmd.id,
    ok: true,
    data: {
      supported: true,
      protocol: 1,
      capabilities: [...DEDICATED_CAPABILITIES],
      displays,
      ...displays === null ? { displaysError: error } : {},
      pool: {
        // What a caller needs to decide "run now or queue": how many windows the
        // automation display can show without overlap, how many exist, how many are free.
        automationDisplay: automationDisplay ? { id: automationDisplay.id, name: automationDisplay.name, primary: automationDisplay.primary, internal: automationDisplay.internal, area } : null,
        capacity,
        live,
        idle: [...dedicatedSlots.values()].filter((s) => s.holders.size === 0).length,
        free: capacity === null ? null : Math.max(0, capacity - live) + [...dedicatedSlots.values()].filter((s) => s.holders.size === 0 && s.windowId !== null).length,
        idleTtlMs: dedicatedIdleTtlMs
      },
      windows
    }
  };
}
async function createOwnedTabLease(leaseKey, initialUrl) {
  return withLeaseMutation(() => createOwnedTabLeaseUnlocked(leaseKey, initialUrl));
}
async function createOwnedTabLeaseUnlocked(leaseKey, initialUrl) {
  const targetUrl = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  const role = getOwnedWindowRole(leaseKey);
  const mode = getWindowMode(leaseKey);
  if (mode === "dedicated") return createDedicatedTabLease(leaseKey, targetUrl);
  const { windowId, initialTabId } = await ensureOwnedContainerWindow(role, leaseKey, targetUrl, mode);
  let tab;
  if (initialTabIsAvailable(initialTabId)) {
    tab = await chrome.tabs.get(initialTabId);
    if (!isTargetUrl(tab.url, targetUrl)) {
      tab = await chrome.tabs.update(initialTabId, { url: targetUrl });
      await new Promise((resolve) => setTimeout(resolve, 300));
      tab = await chrome.tabs.get(initialTabId);
    }
  } else {
    tab = await chrome.tabs.create({ windowId, url: targetUrl, active: wantsActiveTab(mode) });
  }
  const tabId = tab.id;
  if (!tabId) throw new Error("Failed to create tab lease in automation container");
  const group = await ensureOwnedContainerGroup(
    role,
    leaseKey,
    windowId,
    [tabId],
    mode === "isolated" ? windowId : void 0
  );
  const sessionWindowId = group?.windowId ?? tab.windowId;
  if (tab.windowId !== sessionWindowId) tab = await chrome.tabs.get(tabId);
  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: "owned",
    windowId: sessionWindowId,
    owned: true,
    preferredTabId: tabId
  });
  resetWindowIdleTimer(leaseKey);
  return { tabId, tab };
}
async function getAutomationWindow(leaseKey, initialUrl) {
  const existing = automationSessions.get(leaseKey);
  if (existing) {
    if (!existing.owned) {
      throw new CommandFailure(
        "bound_window_operation_blocked",
        `Session "${existing.session}" is bound to a user tab and does not own an OpenCLI tab lease.`,
        "Use page commands on the bound tab, or unbind the session first."
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
      await removeLeaseSession(leaseKey);
    }
  }
  if (getWindowMode(leaseKey) === "dedicated") {
    return (await ensureDedicatedWindow(dedicatedSlotNameFor(leaseKey, { hold: true }), {
      ...dedicatedPlacementRequest(leaseKey),
      reposition: true,
      initialUrl
    })).windowId;
  }
  const role = getOwnedWindowRole(leaseKey);
  return (await ensureOwnedContainerWindow(role, leaseKey, initialUrl, getWindowMode(leaseKey))).windowId;
}
chrome.windows.onRemoved.addListener(async (windowId) => {
  await workerReady;
  for (const role of Object.keys(ownedContainers)) {
    if (ownedContainers[role].windowId === windowId) forgetContainerWindow(role);
  }
  const dedicated = dedicatedSlotForWindow(windowId);
  if (dedicated) {
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
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await workerReady;
  evictTab(tabId);
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
chrome.tabs.onCreated?.addListener?.((tab) => {
  void (async () => {
    await workerReady;
    if (tab.id === void 0) return;
    if (typeof tab.openerTabId === "number" && isOpenCliTabId(tab.openerTabId)) selfCreatedTabIds.add(tab.id);
    if (isDedicatedWindow(tab.windowId)) scheduleForeignTabCheck(tab.id);
  })();
});
chrome.tabs.onAttached?.addListener?.((tabId, info) => {
  void handleTabAttached(tabId, info);
});
let initialized = false;
function initialize() {
  if (initialized) return;
  initialized = true;
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.create(DEDICATED_REAP_ALARM, { periodInMinutes: 0.5 });
  registerListeners();
  try {
    const registerFrameTracking$1 = registerFrameTracking;
    registerFrameTracking$1?.();
  } catch {
  }
  try {
    void chrome.storage?.local?.remove?.(REGISTRY_KEY)?.catch?.(() => {
    });
  } catch {
  }
  workerRecovered = false;
  workerReady = (async () => {
    await getCurrentContextId();
    await reconcileTargetLeaseRegistry();
  })().catch((err) => {
    console.warn(`[opencli] Startup recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => {
    workerRecovered = true;
  });
  void workerReady.then(() => connect());
  console.log("[opencli] OpenCLI extension initialized");
}
chrome.runtime.onInstalled.addListener(() => {
  initialize();
});
chrome.runtime.onStartup.addListener(() => {
  initialize();
});
initialize();
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await workerReady;
  if (alarm.name === "keepalive") void connect();
  if (alarm.name === DEDICATED_REAP_ALARM) {
    await reapIdleDedicatedWindows().catch(() => 0);
    return;
  }
  const leaseKey = leaseKeyFromAlarmName(alarm.name);
  if (!leaseKey) return;
  if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) {
    resetWindowIdleTimer(leaseKey);
    return;
  }
  await releaseLease(leaseKey, "idle alarm");
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStatus") {
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
        daemonVersion
      });
    })();
    return true;
  }
  return false;
});
async function fetchDaemonVersion() {
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${DAEMON_PORT}/status`, {
      method: "GET",
      headers: { "X-OpenCLI": "1" },
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.daemonVersion === "string" ? body.daemonVersion : null;
  } catch {
    return null;
  }
}
async function handleCommand(cmd) {
  if (cmd.action === "sessions") return handleSessions(cmd);
  const session = getSessionName(cmd.session);
  const surface = getCommandSurface(cmd);
  const leaseKey = getLeaseKey(session, surface);
  if (isWindowMode(cmd.windowMode)) {
    setSessionOverride(leaseKey, { windowMode: cmd.windowMode });
    if (cmd.windowMode === "dedicated") applyDedicatedCommandFields(leaseKey, cmd);
  }
  if (surface === "adapter" && (cmd.siteSession === "persistent" || cmd.siteSession === "ephemeral")) {
    setSessionOverride(leaseKey, { lifecycle: cmd.siteSession });
  }
  if (cmd.idleTimeout != null && cmd.idleTimeout > 0) {
    setSessionOverride(leaseKey, { idleTimeoutMs: cmd.idleTimeout * 1e3 });
  }
  resetWindowIdleTimer(leaseKey);
  activeCommandCounts.set(leaseKey, (activeCommandCounts.get(leaseKey) ?? 0) + 1);
  try {
    switch (cmd.action) {
      case "exec":
        return await handleExec(cmd, leaseKey);
      case "navigate":
        return await handleNavigate(cmd, leaseKey);
      case "tabs":
        return await handleTabs(cmd, leaseKey);
      case "cookies":
        return await handleCookies(cmd);
      case "screenshot":
        return await handleScreenshot(cmd, leaseKey);
      case "close-window":
        return await handleCloseWindow(cmd, leaseKey);
      case "cdp":
        return await handleCdp(cmd, leaseKey);
      case "set-file-input":
        return await handleSetFileInput(cmd, leaseKey);
      case "insert-text":
        return await handleInsertText(cmd, leaseKey);
      case "bind":
        return await handleBind(cmd, leaseKey);
      case "network-capture-start":
        return await handleNetworkCaptureStart(cmd, leaseKey);
      case "network-capture-read":
        return await handleNetworkCaptureRead(cmd, leaseKey);
      case "wait-download":
        return await handleWaitDownload(cmd);
      case "frames":
        return await handleFrames(cmd, leaseKey);
      case "contexts":
        return await handleContexts(cmd, leaseKey);
      case "clipboard":
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
    resetWindowIdleTimer(leaseKey);
  }
}
const BLANK_PAGE = "about:blank";
const DEFAULT_NAVIGATE_TIMEOUT_MS = 15e3;
function isDebuggableUrl(url) {
  if (!url) return true;
  return url.startsWith("http://") || url.startsWith("https://") || url === "about:blank" || url.startsWith("data:");
}
function isSafeNavigationUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}
function normalizeUrlForComparison(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.port === "443" || parsed.protocol === "http:" && parsed.port === "80") {
      parsed.port = "";
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
function isTargetUrl(currentUrl, targetUrl) {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}
function getUrlOrigin(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function enumerateCrossOriginFrames(tree) {
  const frames = [];
  function collect(node, accessibleOrigin) {
    for (const child of node.childFrames || []) {
      const frame = child.frame;
      const frameUrl = frame.url || frame.unreachableUrl || "";
      const frameOrigin = getUrlOrigin(frameUrl);
      if (accessibleOrigin && frameOrigin && frameOrigin === accessibleOrigin) {
        collect(child, frameOrigin);
        continue;
      }
      frames.push({
        index: frames.length,
        frameId: frame.id,
        url: frameUrl,
        name: frame.name || ""
      });
    }
  }
  const rootFrame = tree?.frameTree?.frame;
  const rootUrl = rootFrame?.url || rootFrame?.unreachableUrl || "";
  collect(tree.frameTree, getUrlOrigin(rootUrl));
  return frames;
}
async function enumerateFramesForTab(tabId) {
  const tree = await getFrameTree(tabId);
  const frames = enumerateCrossOriginFrames(tree);
  const knownFrameIds = new Set(frames.map((f) => f.frameId));
  const treeChildCount = frames.length;
  let iframeTargets = [];
  let debug = {};
  try {
    const result = await listIframeTargets(tabId);
    iframeTargets = result.targets;
    debug = result.debug;
  } catch (err) {
    debug = { listError: String(err) };
  }
  for (const target of iframeTargets) {
    if (!target.targetId || knownFrameIds.has(target.targetId)) continue;
    knownFrameIds.add(target.targetId);
    frames.push({
      index: frames.length,
      frameId: target.targetId,
      url: target.url,
      name: target.title || ""
    });
  }
  return { frames, debug: { treeChildCount, ...debug } };
}
function setLeaseSession(leaseKey, session) {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  automationSessions.set(leaseKey, {
    ...makeSession(leaseKey, session),
    idleTimer: null,
    idleDeadlineAt: timeout <= 0 ? 0 : Date.now() + timeout
  });
  void persistRuntimeState();
}
async function resolveCommandTabId(cmd) {
  if (cmd.page) return resolveTabId$1(cmd.page);
  return void 0;
}
async function resolveTab(tabId, leaseKey, initialUrl) {
  const resolved = await resolveTabForLease(tabId, leaseKey, initialUrl);
  if (getWindowMode(leaseKey) !== "dedicated") return resolved;
  return applyDedicatedSessionPolicy(leaseKey, resolved);
}
async function resolveTabForLease(tabId, leaseKey, initialUrl) {
  const existingSession = automationSessions.get(leaseKey);
  if (tabId !== void 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const session = existingSession;
      const matchesSession = session ? session.preferredTabId !== null ? session.preferredTabId === tabId : tab.windowId === session.windowId : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return { tabId, tab };
      if (session && !session.owned) {
        throw new CommandFailure(
          matchesSession ? "bound_tab_not_debuggable" : "bound_tab_mismatch",
          matchesSession ? `Bound tab for session "${session.session}" is not debuggable (${tab.url ?? "unknown URL"}).` : `Target tab is not the tab bound to session "${session.session}".`,
          'Run "opencli browser bind" again on a debuggable http(s) tab.'
        );
      }
      if (session && !matchesSession && session.preferredTabId === null && isDebuggableUrl(tab.url)) {
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
          "bound_tab_gone",
          `Bound tab for session "${existingSession.session}" no longer exists.`,
          'Run "opencli browser bind" again, then retry the command.'
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
      if (isDebuggableUrl(preferredTab.url)) return { tabId: preferredTab.id, tab: preferredTab };
      if (!session.owned) {
        throw new CommandFailure(
          "bound_tab_not_debuggable",
          `Bound tab for session "${session.session}" is not debuggable (${preferredTab.url ?? "unknown URL"}).`,
          'Switch the tab to an http(s) page or run "opencli browser bind" on another tab.'
        );
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      await removeLeaseSession(leaseKey);
      if (!session.owned) {
        throw new CommandFailure(
          "bound_tab_gone",
          `Bound tab for session "${session.session}" no longer exists.`,
          'Run "opencli browser bind" again, then retry the command.'
        );
      }
      return createOwnedTabLease(leaseKey, initialUrl);
    }
  }
  if (!existingSession || existingSession.owned && existingSession.preferredTabId === null) {
    if (!existingSession && !initialUrl && getSurfaceFromKey(leaseKey) === "browser") {
      const sessionName = getSessionFromKey(leaseKey);
      const activeSessions = [];
      for (const [k, s] of automationSessions.entries()) {
        if (s.owned) {
          const name = getSessionFromKey(k);
          const url = s.preferredTabId != null ? await chrome.tabs.get(s.preferredTabId).then((t) => t.url ?? "(unknown)").catch(() => "(closed)") : "(no tab)";
          activeSessions.push(`  ${name}  ${url}`);
        }
      }
      const sessionList = activeSessions.length > 0 ? `
Active sessions:
${activeSessions.join("\n")}` : "\nNo active sessions.";
      throw new CommandFailure(
        "session_not_found",
        `No active session "${sessionName}".${sessionList}`,
        'Open a URL first with "opencli browser <session> open <url>". If using $$ for session names, note that $$ changes with each shell process — use a fixed name instead.'
      );
    }
    return createOwnedTabLease(leaseKey, initialUrl);
  }
  const windowId = await getAutomationWindow(leaseKey, initialUrl);
  const role = getOwnedWindowRole(leaseKey);
  const group = existingSession?.owned ? await ensureOwnedContainerGroup(role, leaseKey, windowId, []) : null;
  const scopedWindowId = group?.windowId ?? windowId;
  const reusableTabId = await findReusableOwnedContainerTab(scopedWindowId, existingSession?.owned ? group?.id ?? null : void 0);
  if (reusableTabId !== void 0) return { tabId: reusableTabId, tab: await chrome.tabs.get(reusableTabId) };
  const tabs = await chrome.tabs.query({ windowId: scopedWindowId });
  const reuseTab = existingSession?.owned ? void 0 : tabs.find((t) => t.id);
  if (reuseTab?.id) {
    await chrome.tabs.update(reuseTab.id, { url: BLANK_PAGE });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const updated = await chrome.tabs.get(reuseTab.id);
      if (isDebuggableUrl(updated.url)) return { tabId: reuseTab.id, tab: updated };
      console.warn(`[opencli] data: URI was intercepted (${updated.url}), creating fresh tab`);
    } catch {
    }
  }
  const newTab = await chrome.tabs.create({
    windowId: scopedWindowId,
    url: BLANK_PAGE,
    active: tabActivationFor(leaseKey)
  });
  if (!newTab.id) throw new Error("Failed to create tab in automation container");
  await ensureOwnedContainerGroup(role, leaseKey, scopedWindowId, [newTab.id]);
  return { tabId: newTab.id, tab: await chrome.tabs.get(newTab.id) };
}
async function pageScopedResult(id, tabId, data) {
  const page = await resolveTargetId(tabId);
  return { id, ok: true, data, page };
}
async function resolveTabId(tabId, leaseKey, initialUrl) {
  const resolved = await resolveTab(tabId, leaseKey, initialUrl);
  return resolved.tabId;
}
async function listAutomationTabs(leaseKey) {
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
async function listAutomationWebTabs(leaseKey) {
  const tabs = await listAutomationTabs(leaseKey);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}
function commandCdpTimeoutMs(cmd) {
  if (typeof cmd.deadlineAt === "number" && cmd.deadlineAt > 0) {
    return Math.max(1e4, cmd.deadlineAt - Date.now() - 5e3);
  }
  if (typeof cmd.timeout === "number" && cmd.timeout > 0) {
    return Math.max(1e4, cmd.timeout * 1e3 - 5e3);
  }
  return void 0;
}
function classifyExtensionError(message) {
  if (/Inspected target navigated|Target closed/.test(message)) return "target_navigated";
  if (/Detached while handling command/.test(message)) return "detached_mid_command";
  if (/CDP command .* timed out/.test(message)) return "cdp_timeout";
  if (/attach failed|Debugger is not attached/.test(message)) return "attach_failed";
  if (/No tab with id|no longer exists|No window with id/.test(message)) return "tab_gone";
  if (/No iframe target found for frame|No session with given id|Cannot find context with specified id/.test(message)) return "frame_not_attached";
  return void 0;
}
function errorResult(id, err) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CommandFailure) {
    return { id, ok: false, error: message, errorCode: err.code, ...err.hint ? { errorHint: err.hint } : {} };
  }
  const errorCode = classifyExtensionError(message);
  return { id, ok: false, error: message, ...errorCode ? { errorCode } : {} };
}
async function handleExec(cmd, leaseKey) {
  if (!cmd.code) return { id: cmd.id, ok: false, error: "Missing code" };
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === "browser";
    if (cmd.frameIndex != null) {
      const { frames } = await enumerateFramesForTab(tabId);
      if (cmd.frameIndex < 0 || cmd.frameIndex >= frames.length) {
        return { id: cmd.id, ok: false, error: `Frame index ${cmd.frameIndex} out of range (${frames.length} cross-origin frames available)` };
      }
      const data2 = await evaluateInFrame(tabId, cmd.code, frames[cmd.frameIndex].frameId, aggressive, commandCdpTimeoutMs(cmd));
      return pageScopedResult(cmd.id, tabId, data2);
    }
    if (cmd.execContextId != null) {
      await ensureAttached(tabId, aggressive);
      const owner = resolveContextSession(tabId, cmd.execContextId);
      if (!owner) {
        return {
          id: cmd.id,
          ok: false,
          error: `Execution context ${cmd.execContextId} is not known for this tab (use "browser contexts" for current ids)`,
          errorCode: "frame_not_attached"
        };
      }
      if (!owner.live) {
        return {
          id: cmd.id,
          ok: false,
          error: `Execution context ${cmd.execContextId}'s frame session has detached or navigated away; re-run "browser contexts" and retry`,
          errorCode: "frame_not_attached"
        };
      }
      const debuggee = owner.sessionId ? { tabId, sessionId: owner.sessionId } : { tabId };
      const result = await sendDebuggerCommand(debuggee, "Runtime.evaluate", {
        expression: cmd.code,
        contextId: cmd.execContextId,
        returnByValue: true,
        awaitPromise: true
      }, commandCdpTimeoutMs(cmd));
      if (result.exceptionDetails) {
        const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation error in context";
        return { id: cmd.id, ok: false, error: errMsg };
      }
      return pageScopedResult(cmd.id, tabId, result.result?.value);
    }
    const data = await evaluateAsync(tabId, cmd.code, aggressive, commandCdpTimeoutMs(cmd));
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
async function handleFrames(cmd, leaseKey) {
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
async function handleContexts(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === "browser";
    await ensureAttached(tabId, aggressive);
    const contexts = getAllContexts(tabId);
    return { id: cmd.id, ok: true, data: contexts };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
function preferOwnedTab(leaseKey, tabId) {
  const session = automationSessions.get(leaseKey);
  if (!session?.owned) return;
  setLeaseSession(leaseKey, {
    session: session.session,
    surface: session.surface,
    kind: session.kind,
    windowId: session.windowId,
    owned: true,
    preferredTabId: tabId
  });
}
async function handleNavigate(cmd, leaseKey) {
  if (!cmd.url) return { id: cmd.id, ok: false, error: "Missing url" };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: "Blocked URL scheme -- only http:// and https:// are allowed" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const resolved = await resolveTab(cmdTabId, leaseKey, cmd.url);
  const tabId = resolved.tabId;
  const beforeTab = resolved.tab ?? await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;
  if (beforeTab.status === "complete" && isTargetUrl(beforeTab.url, targetUrl)) {
    return pageScopedResult(cmd.id, tabId, { title: beforeTab.title, url: beforeTab.url, timedOut: false });
  }
  if (!hasActiveNetworkCapture(tabId)) {
    await detach(tabId);
  }
  await chrome.tabs.update(tabId, { url: targetUrl });
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    let timeoutTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    const isNavigationDone = (url) => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };
    const listener = (id, info, tab2) => {
      if (id !== tabId) return;
      if (info.status === "complete" && isNavigationDone(tab2.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === "complete" && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch {
      }
    }, 100);
    const navTimeoutMs = cmd.timeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[opencli] Navigate to ${targetUrl} timed out after ${navTimeoutMs}ms`);
      finish();
    }, navTimeoutMs);
  });
  let tab = await chrome.tabs.get(tabId);
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
async function handleTabs(cmd, leaseKey) {
  const session = automationSessions.get(leaseKey);
  if (session && !session.owned && cmd.op !== "list") {
    return {
      id: cmd.id,
      ok: false,
      errorCode: "bound_tab_mutation_blocked",
      error: `Session "${session.session}" is bound to a user tab; tab new/select/close requires an owned OpenCLI session.`,
      errorHint: "Unbind the session first, or use a different session for owned OpenCLI tabs."
    };
  }
  switch (cmd.op) {
    case "list": {
      const tabs = await listAutomationWebTabs(leaseKey);
      const data = await Promise.all(tabs.map(async (t, i) => {
        let page;
        try {
          page = t.id ? await resolveTargetId(t.id) : void 0;
        } catch {
        }
        return { index: i, page, url: t.url, title: t.title, active: t.active };
      }));
      return { id: cmd.id, ok: true, data };
    }
    case "new": {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: "Blocked URL scheme -- only http:// and https:// are allowed" };
      }
      if (!automationSessions.has(leaseKey)) {
        const created = await createOwnedTabLease(leaseKey, cmd.url);
        return pageScopedResult(cmd.id, created.tabId, { url: created.tab?.url });
      }
      const windowId = await getAutomationWindow(leaseKey);
      let tab = await chrome.tabs.create({
        windowId,
        url: cmd.url ?? BLANK_PAGE,
        active: tabActivationFor(leaseKey)
      });
      if (tab.id !== void 0 && isDedicatedWindow(windowId)) selfCreatedTabIds.add(tab.id);
      const tabId = tab.id;
      if (!tabId) return { id: cmd.id, ok: false, error: "Failed to create tab" };
      const group = await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, windowId, [tabId]);
      const sessionWindowId = group?.windowId ?? tab.windowId;
      if (tab.windowId !== sessionWindowId) tab = await chrome.tabs.get(tabId);
      setLeaseSession(leaseKey, {
        session: getSessionFromKey(leaseKey),
        surface: getSurfaceFromKey(leaseKey),
        kind: "owned",
        windowId: sessionWindowId,
        owned: true,
        preferredTabId: tabId
      });
      resetWindowIdleTimer(leaseKey);
      return pageScopedResult(cmd.id, tabId, { url: tab.url });
    }
    case "close": {
      if (cmd.index !== void 0) {
        const tabs = await listAutomationWebTabs(leaseKey);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        const closedPage2 = await resolveTargetId(target.id).catch(() => void 0);
        const currentSession2 = automationSessions.get(leaseKey);
        if (currentSession2?.preferredTabId === target.id) {
          await releaseLease(leaseKey, "tab close");
        } else {
          await safeDetach(target.id);
          await chrome.tabs.remove(target.id);
        }
        return { id: cmd.id, ok: true, data: { closed: closedPage2 } };
      }
      if (cmd.page !== void 0 && session?.owned) {
        let tabId2;
        try {
          tabId2 = await resolveCommandTabId(cmd);
        } catch {
          return { id: cmd.id, ok: false, error: `Page no longer exists` };
        }
        if (tabId2 === void 0) {
          return { id: cmd.id, ok: false, error: `Page no longer exists` };
        }
        let tab;
        try {
          tab = await chrome.tabs.get(tabId2);
        } catch {
          return { id: cmd.id, ok: false, error: `Page no longer exists` };
        }
        if (tab.windowId !== session.windowId) {
          return { id: cmd.id, ok: false, error: `Page is not in the automation container` };
        }
        const closedPage2 = await resolveTargetId(tabId2).catch(() => void 0);
        if (session.preferredTabId === tabId2) {
          await releaseLease(leaseKey, "tab close");
        } else {
          await safeDetach(tabId2);
          await chrome.tabs.remove(tabId2);
        }
        return { id: cmd.id, ok: true, data: { closed: closedPage2 } };
      }
      const cmdTabId = await resolveCommandTabId(cmd);
      const tabId = await resolveTabId(cmdTabId, leaseKey);
      const closedPage = await resolveTargetId(tabId).catch(() => void 0);
      const currentSession = automationSessions.get(leaseKey);
      if (currentSession?.preferredTabId === tabId) {
        await releaseLease(leaseKey, "tab close");
      } else {
        await safeDetach(tabId);
        await chrome.tabs.remove(tabId);
      }
      return { id: cmd.id, ok: true, data: { closed: closedPage } };
    }
    case "select": {
      if (cmd.index === void 0 && cmd.page === void 0)
        return { id: cmd.id, ok: false, error: "Missing index or page" };
      const cmdTabId = await resolveCommandTabId(cmd);
      if (cmdTabId !== void 0) {
        const session2 = automationSessions.get(leaseKey);
        let tab;
        try {
          tab = await chrome.tabs.get(cmdTabId);
        } catch {
          return { id: cmd.id, ok: false, error: `Page no longer exists` };
        }
        if (!session2 || tab.windowId !== session2.windowId) {
          return { id: cmd.id, ok: false, error: `Page is not in the automation container` };
        }
        await chrome.tabs.update(cmdTabId, { active: true });
        preferOwnedTab(leaseKey, cmdTabId);
        return pageScopedResult(cmd.id, cmdTabId, { selected: true });
      }
      const tabs = await listAutomationWebTabs(leaseKey);
      const target = tabs[cmd.index];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await chrome.tabs.update(target.id, { active: true });
      preferOwnedTab(leaseKey, target.id);
      return pageScopedResult(cmd.id, target.id, { selected: true });
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}
async function handleCookies(cmd) {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: "Cookie scope required: provide domain or url to avoid dumping all cookies" };
  }
  const details = {};
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
    expirationDate: c.expirationDate
  }));
  return { id: cmd.id, ok: true, data };
}
async function handleScreenshot(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
      width: cmd.width,
      height: cmd.height
    });
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
const CDP_ALLOWLIST = /* @__PURE__ */ new Set([
  // Agent DOM context
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.focus",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.scrollIntoViewIfNeeded",
  "DOMSnapshot.captureSnapshot",
  // Native input events
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  // Page metrics & screenshots
  "Page.getLayoutMetrics",
  "Page.captureScreenshot",
  "Page.getFrameTree",
  "Page.handleJavaScriptDialog",
  // Runtime.enable needed for CDP attach setup (Runtime.evaluate normally goes through
  // the 'exec' action, but is also allowlisted here for contextId-scoped passthrough
  // evaluation, e.g. content script isolated worlds discovered via the 'contexts' action)
  "Runtime.enable",
  "Runtime.evaluate",
  // Iframe discovery diagnostics (read-only)
  "Target.getTargets",
  "Target.getTargetInfo",
  // Emulation (used by screenshot full-page)
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride"
]);
async function handleCdp(cmd, leaseKey) {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: "Missing cdpMethod" };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}` };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const aggressive = getSurfaceFromKey(leaseKey) === "browser";
    await ensureAttached(tabId, aggressive);
    const params = cmd.cdpParams ?? {};
    const routeFrameId = typeof params.frameId === "string" && params.sessionId === "target" ? params.frameId : void 0;
    const routeTargetUrl = typeof params.targetUrl === "string" ? params.targetUrl : void 0;
    const data = routeFrameId ? await sendCommandInFrameTarget(tabId, routeFrameId, cmd.cdpMethod, stripOpenCliFrameRoutingParams(params, true), aggressive, commandCdpTimeoutMs(cmd) ?? 3e4, routeTargetUrl) : await sendDebuggerCommand(
      { tabId },
      cmd.cdpMethod,
      stripOpenCliFrameRoutingParams(params, false),
      commandCdpTimeoutMs(cmd)
    );
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
function stripOpenCliFrameRoutingParams(params, stripFrameId) {
  const { sessionId, frameId, targetUrl, ...rest } = params;
  if (!stripFrameId && frameId !== void 0) return { ...rest, frameId };
  return rest;
}
async function handleSessions(cmd) {
  if (cmd.op === "window-status" || cmd.op === "window-ensure" || cmd.op === "window-list" || cmd.op === "window-close" || cmd.op === "runtime-reload") return handleDedicatedWindowOp(cmd);
  if (cmd.op === "cleanup") {
    const keys = [...automationSessions.keys()];
    for (const key of keys) await releaseLease(key, "cleanup");
    return { id: cmd.id, ok: true, data: { released: keys.length } };
  }
  const entries = [];
  for (const [leaseKey, lease] of automationSessions) {
    let url;
    let title;
    let windowId = lease.windowId ?? null;
    let groupId = null;
    let groupTitle = null;
    let tabActive = null;
    if (lease.preferredTabId !== null) {
      try {
        const tab = await chrome.tabs.get(lease.preferredTabId);
        tabActive = typeof tab.active === "boolean" ? tab.active : null;
        url = tab.url;
        title = tab.title;
        windowId = tab.windowId ?? windowId;
        if (typeof tab.groupId === "number" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          groupId = tab.groupId;
          groupTitle = await chrome.tabGroups.get(tab.groupId).then((g) => g.title ?? null).catch(() => null);
        }
      } catch {
      }
    }
    let windowFallbackReason = null;
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
      title
    });
  }
  return { id: cmd.id, ok: true, data: entries };
}
async function handleCloseWindow(cmd, leaseKey) {
  const sessionName = automationSessions.get(leaseKey)?.session ?? getSessionFromKey(leaseKey);
  await releaseLease(leaseKey, "explicit close");
  return { id: cmd.id, ok: true, data: { closed: true, session: sessionName } };
}
async function handleSetFileInput(cmd, leaseKey) {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: "Missing or empty files array" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await setFileInputFiles(tabId, cmd.files, cmd.selector);
    return pageScopedResult(cmd.id, tabId, { count: cmd.files.length });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
async function handleInsertText(cmd, leaseKey) {
  if (typeof cmd.text !== "string") {
    return { id: cmd.id, ok: false, error: "Missing text payload" };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await insertText(tabId, cmd.text);
    return pageScopedResult(cmd.id, tabId, { inserted: true });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
async function handleNetworkCaptureStart(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  let tabId;
  try {
    tabId = await resolveTabId(cmdTabId, leaseKey);
  } catch (err) {
    if (err instanceof CommandFailure && err.code === "session_not_found") {
      return { id: cmd.id, ok: true, data: { started: false } };
    }
    throw err;
  }
  try {
    await startNetworkCapture(tabId, cmd.pattern);
    return pageScopedResult(cmd.id, tabId, { started: true });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
async function handleNetworkCaptureRead(cmd, leaseKey) {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await readNetworkCapture(tabId);
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
async function handleWaitDownload(cmd) {
  try {
    const data = await waitForDownload(cmd.pattern ?? "", cmd.timeoutMs ?? 3e4);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
let offscreenDocPromise = null;
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (offscreenDocPromise) return offscreenDocPromise;
  offscreenDocPromise = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD"],
    justification: 'Read the system clipboard for the opencli "clipboard" command.'
  }).finally(() => {
    offscreenDocPromise = null;
  });
  return offscreenDocPromise;
}
async function readSystemClipboard(timeoutMs = 5e3) {
  await ensureOffscreenDocument();
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("offscreen clipboard read timed out")), timeoutMs);
    chrome.runtime.sendMessage({ type: "opencli-read-clipboard" }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp ?? {});
    });
  });
  if (response.error) throw new Error(response.error);
  return response.text ?? "";
}
async function handleClipboard(cmd) {
  try {
    const text = await readSystemClipboard();
    return { id: cmd.id, ok: true, data: { text } };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}
async function releaseLease(leaseKey, reason = "released") {
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
      const hasOtherOwnedLease = [...automationSessions.entries()].some(
        ([otherLease, otherSession]) => otherLease !== leaseKey && otherSession.owned && otherSession.windowId === session.windowId && otherSession.preferredTabId !== null
      );
      await safeDetach(tabId);
      evictTab(tabId);
      const dedicatedSlot = dedicatedSlotForWindow(session.windowId);
      releaseDedicatedHolder(leaseKey);
      if (dedicatedSlot) {
        const outcome = await releaseDedicatedLeaseTab(dedicatedSlot, tabId);
        console.log(`[opencli] Released dedicated tab lease ${tabId} (${outcome}, slot=${dedicatedSlot.slot}, session=${session.session}, surface=${session.surface}, ${reason})`);
      } else if (hasOtherOwnedLease) {
        await chrome.tabs.remove(tabId).catch(() => {
        });
        console.log(`[opencli] Released owned tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
      } else if (ownedContainers[getOwnedWindowRole(leaseKey)].borrowed) {
        await chrome.tabs.remove(tabId).catch(() => {
        });
        console.log(`[opencli] Closed borrowed tab lease ${tabId} (session=${session.session}, surface=${session.surface}, ${reason})`);
      } else {
        try {
          const tab = await chrome.tabs.update(tabId, { url: BLANK_PAGE });
          const group = await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, session.windowId, [tab.id ?? tabId]);
          if (group) session.windowId = group.windowId;
          console.log(`[opencli] Released owned tab lease ${tabId} as reusable placeholder (session=${session.session}, surface=${session.surface}, ${reason})`);
        } catch {
          await chrome.tabs.remove(tabId).catch(() => {
          });
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
async function reconcileTargetLeaseRegistry() {
  await restoreDedicatedState();
  const registry = await readRegistry();
  ownedGroupLedger.clear();
  for (const role of Object.keys(ownedContainers)) {
    const stored = registry.ownedContainers[role];
    for (const [groupId, leaseKey] of Object.entries(stored.groups ?? {})) {
      if (getOwnedWindowRole(leaseKey) === role) ownedGroupLedger.set(Number(groupId), leaseKey);
    }
    for (const groupId of stored.groupIds ?? []) {
      if (!ownedGroupLedger.has(groupId)) ownedGroupLedger.set(groupId, null);
    }
  }
  for (const role of Object.keys(ownedContainers)) {
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
      if (stored.lifecycle === "ephemeral" || stored.lifecycle === "persistent" || stored.lifecycle === "pinned") {
        setSessionOverride(leaseKey, { lifecycle: stored.lifecycle });
      }
      const session = makeSession(leaseKey, {
        session: typeof stored.session === "string" ? stored.session : getSessionFromKey(leaseKey),
        surface: stored.surface === "adapter" ? "adapter" : getSurfaceFromKey(leaseKey),
        kind: stored.kind === "bound" || stored.owned === false ? "bound" : "owned",
        windowId: tab.windowId,
        owned: stored.owned,
        preferredTabId: tabId
      });
      const timeout = getIdleTimeout(leaseKey);
      automationSessions.set(leaseKey, {
        ...session,
        idleTimer: null,
        idleDeadlineAt: stored.idleDeadlineAt
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
          await releaseLease(leaseKey, "reconciled idle expiry");
        } else {
          resetWindowIdleTimer(leaseKey, remaining);
        }
      }
    } catch {
    }
  }
  const leaseKeysToConverge = /* @__PURE__ */ new Set();
  for (const owner of ownedGroupLedger.values()) if (owner !== null) leaseKeysToConverge.add(owner);
  for (const [leaseKey, session] of automationSessions.entries()) if (session.owned) leaseKeysToConverge.add(leaseKey);
  for (const leaseKey of leaseKeysToConverge) {
    try {
      await ensureOwnedContainerGroup(getOwnedWindowRole(leaseKey), leaseKey, null, []);
    } catch (err) {
      console.warn(`[opencli] Startup group convergence failed for ${getSessionFromKey(leaseKey)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await pruneOwnedGroupLedger().catch(() => {
  });
  await persistRuntimeState();
}
async function handleBind(cmd, leaseKey) {
  const existing = automationSessions.get(leaseKey);
  if (existing?.owned) {
    await releaseLease(leaseKey, "rebind");
  }
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const boundTab = activeTabs.find((tab) => isDebuggableUrl(tab.url)) ?? fallbackTabs.find((tab) => isDebuggableUrl(tab.url));
  if (!boundTab?.id) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: "bound_tab_not_found",
      error: "No debuggable tab found in the current window",
      errorHint: "Focus the target Chrome tab/window, then retry bind."
    };
  }
  const current = automationSessions.get(leaseKey);
  if (current && !current.owned && current.preferredTabId !== null && current.preferredTabId !== boundTab.id) {
    await detach(current.preferredTabId).catch(() => {
    });
  }
  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: "bound",
    windowId: boundTab.windowId,
    owned: false,
    preferredTabId: boundTab.id
  });
  resetWindowIdleTimer(leaseKey);
  console.log(`[opencli] Session ${getSessionFromKey(leaseKey)} explicitly bound to tab ${boundTab.id} (${boundTab.url})`);
  return pageScopedResult(cmd.id, boundTab.id, {
    url: boundTab.url,
    title: boundTab.title,
    session: getSessionFromKey(leaseKey)
  });
}
