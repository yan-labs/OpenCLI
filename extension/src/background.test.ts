import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T extends (...args: any[]) => void> = {
  addListener: any;
  removeListener?: any;
};

type MockTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
  groupId?: number;
};

type MockTabGroup = {
  id: number;
  windowId: number;
  title?: string;
  color?: chrome.tabGroups.ColorEnum;
  collapsed?: boolean;
};

const leaseKey = (surface: 'browser' | 'adapter', session: string): string =>
  `${surface}\u0000${encodeURIComponent(session)}`;
const browserKey = (session: string): string => leaseKey('browser', session);
const adapterKey = (session: string): string => leaseKey('adapter', session);

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createChromeMock() {
  let nextTabId = 10;
  let nextGroupId = 100;
  const storageState: Record<string, unknown> = {};
  const sessionStorageState: Record<string, unknown> = {};
  const tabs: MockTab[] = [
    { id: 1, windowId: 1, url: 'https://automation.example', title: 'automation', active: true, status: 'complete', groupId: -1 },
    { id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete', groupId: -1 },
    { id: 3, windowId: 1, url: 'chrome://extensions', title: 'chrome', active: false, status: 'complete', groupId: -1 },
  ];
  const groups: MockTabGroup[] = [];
  let lastFocusedWindowId = 2;

  const removeEmptyGroups = () => {
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i];
      if (!tabs.some((tab) => tab.groupId === group.id)) groups.splice(i, 1);
    }
  };

  const query = vi.fn(async (queryInfo: { windowId?: number; active?: boolean; lastFocusedWindow?: boolean; groupId?: number } = {}) => {
    return tabs.filter((tab) => {
      if (queryInfo.windowId !== undefined && tab.windowId !== queryInfo.windowId) return false;
      if (queryInfo.lastFocusedWindow && tab.windowId !== lastFocusedWindowId) return false;
      if (queryInfo.active !== undefined && !!tab.active !== queryInfo.active) return false;
      if (queryInfo.groupId !== undefined && tab.groupId !== queryInfo.groupId) return false;
      return true;
    });
  });
  const create = vi.fn(async ({ windowId, url, active }: { windowId?: number; url?: string; active?: boolean }) => {
    const tab: MockTab = {
      id: nextTabId++,
      windowId: windowId ?? 999,
      url,
      title: url ?? 'blank',
      active: !!active,
      status: 'complete',
      groupId: -1,
    };
    tabs.push(tab);
    return tab;
  });
  const update = vi.fn(async (tabId: number, updates: { active?: boolean; url?: string }) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Unknown tab ${tabId}`);
    if (updates.active !== undefined) tab.active = updates.active;
    if (updates.url !== undefined) tab.url = updates.url;
    return tab;
  });

  const chrome = {
    tabs: {
      query,
      create,
      update,
      remove: vi.fn(async (_tabId: number) => {}),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return tab;
      }),
      move: vi.fn(async (tabId: number, moveProps: { windowId: number; index: number }) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        tab.windowId = moveProps.windowId;
        tab.groupId = -1;
        removeEmptyGroups();
        return tab;
      }),
      group: vi.fn(async (options: { tabIds?: number | number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
        const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds].filter((id): id is number => typeof id === 'number');
        let groupId = options.groupId;
        if (groupId === undefined) {
          groupId = nextGroupId++;
          groups.push({
            id: groupId,
            windowId: options.createProperties?.windowId ?? tabs.find((tab) => tab.id === tabIds[0])?.windowId ?? 1,
            collapsed: false,
          });
        }
        for (const tabId of tabIds) {
          const tab = tabs.find((entry) => entry.id === tabId);
          if (!tab) throw new Error(`Unknown tab ${tabId}`);
          tab.groupId = groupId;
          const group = groups.find((entry) => entry.id === groupId);
          if (group) tab.windowId = group.windowId;
        }
        removeEmptyGroups();
        return groupId;
      }),
      ungroup: vi.fn(async (tabIds: number | number[]) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tabId of ids) {
          const tab = tabs.find((entry) => entry.id === tabId);
          if (tab) tab.groupId = -1;
        }
        removeEmptyGroups();
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } as Listener<(id: number, info: chrome.tabs.TabChangeInfo) => void>,
      onRemoved: { addListener: vi.fn() } as Listener<(tabId: number) => void>,
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: vi.fn(async (groupId: number) => {
        const group = groups.find((entry) => entry.id === groupId);
        if (!group) throw new Error(`Unknown group ${groupId}`);
        return group;
      }),
      query: vi.fn(async (queryInfo: { windowId?: number; title?: string; color?: chrome.tabGroups.ColorEnum } = {}) => groups.filter((group) => {
        if (queryInfo.windowId !== undefined && group.windowId !== queryInfo.windowId) return false;
        if (queryInfo.title !== undefined && group.title !== queryInfo.title) return false;
        if (queryInfo.color !== undefined && group.color !== queryInfo.color) return false;
        return true;
      })),
      update: vi.fn(async (groupId: number, updates: { title?: string; color?: chrome.tabGroups.ColorEnum; collapsed?: boolean }) => {
        const group = groups.find((entry) => entry.id === groupId);
        if (!group) throw new Error(`Unknown group ${groupId}`);
        Object.assign(group, updates);
        return group;
      }),
    },
    debugger: {
      getTargets: vi.fn(async () => tabs.map(t => ({
        type: 'page',
        id: `target-${t.id}`,
        tabId: t.id,
        url: t.url ?? '',
        title: t.title ?? '',
        attached: false,
      }))),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      onDetach: { addListener: vi.fn() } as Listener<(source: { tabId?: number }) => void>,
      onEvent: { addListener: vi.fn() } as Listener<(source: any, method: string, params: any) => void>,
    },
    windows: {
      // Default: no reusable user window, so the container falls back to creating one.
      // Tests that exercise host-window reuse override this.
      getAll: vi.fn(async () => [] as any[]),
      getLastFocused: vi.fn(async () => undefined as any),
      get: vi.fn(async (windowId: number) => ({ id: windowId, focused: windowId === lastFocusedWindowId })),
      create: vi.fn(async ({ url, focused, width, height, type }: any) => ({ id: 1, url, focused, width, height, type })),
      remove: vi.fn(async (_windowId: number) => {}),
      onRemoved: { addListener: vi.fn() } as Listener<(windowId: number) => void>,
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: { addListener: vi.fn() } as Listener<(alarm: { name: string }) => void>,
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageState[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(storageState, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete storageState[key];
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStorageState[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStorageState, items);
        }),
      },
    },
    runtime: {
      onInstalled: { addListener: vi.fn() } as Listener<() => void>,
      onStartup: { addListener: vi.fn() } as Listener<() => void>,
      onMessage: { addListener: vi.fn() } as Listener<(msg: unknown, sender: unknown, sendResponse: (value: unknown) => void) => void>,
      getManifest: vi.fn(() => ({ version: 'test-version' })),
    },
    cookies: {
      getAll: vi.fn(async () => []),
    },
  };

  return {
    chrome,
    tabs,
    groups,
    query,
    create,
    update,
    setLastFocusedWindowId: (windowId: number) => { lastFocusedWindowId = windowId; },
  };
}

describe('background tab isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    // Most tests exercise tab/session behavior, not daemon reconnect cadence.
    // Keep the startup ping pending unless a test explicitly controls it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Let each module's fire-and-forget startup recovery + connect() settle
    // under THIS test's fetch stub. Otherwise a slow recovery can spill its
    // connect into the next test and open a stray socket against that test's
    // stub, corrupting the shared MockWebSocket.instances count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists only automation-window web tabs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleTabs({ id: '1', action: 'tabs', op: 'list', session: adapterKey('twitter') }, adapterKey('twitter'));

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        index: 0,
        page: 'target-1',
        url: 'https://automation.example',
        title: 'automation',
        active: true,
      },
    ]);
  });

  it('lists cross-origin frames in the same order exposed by snapshot [F#] markers', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.sendCommand = vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'root', url: 'https://main.example/' },
            childFrames: [
              {
                frame: { id: 'same-origin-parent', url: 'https://main.example/embed' },
                childFrames: [
                  {
                    frame: { id: 'cross-origin-nested', url: 'https://x.example/widget', name: 'nested-x' },
                    childFrames: [
                      {
                        frame: { id: 'hidden-descendant', url: 'https://x.example/inner' },
                      },
                    ],
                  },
                ],
              },
              {
                frame: { id: 'cross-origin-sibling', url: 'https://y.example/iframe', name: 'sibling-y' },
              },
            ],
          },
        };
      }
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleCommand({ id: 'frames', action: 'frames', session: 'twitter', surface: 'adapter' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { index: 0, frameId: 'cross-origin-nested', url: 'https://x.example/widget', name: 'nested-x' },
      { index: 1, frameId: 'cross-origin-sibling', url: 'https://y.example/iframe', name: 'sibling-y' },
    ]);
  });

  it('falls back to chrome.debugger OOPIF targets for a cross-origin iframe missing from the frame tree', async () => {
    // Under Chrome's site isolation a cross-origin iframe is an out-of-process
    // target: Page.getFrameTree's childFrames on the parent session can be
    // empty even though the iframe is really there. enumerateFramesForTab
    // must recover it from Target.getTargets instead of returning [].
    const { chrome } = createChromeMock();
    chrome.debugger.sendCommand = vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.enable') return {};
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'root', url: 'https://main.example/' },
            // No childFrames — the OOPIF is invisible from here.
          },
        };
      }
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { targetId: 'oopif-1', type: 'iframe', url: 'https://cross.example/widget', title: 'cross-widget' },
          ],
        };
      }
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleCommand({ id: 'frames', action: 'frames', session: 'twitter', surface: 'adapter' });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { index: 0, frameId: 'oopif-1', url: 'https://cross.example/widget', name: 'cross-widget' },
    ]);
  });

  it('does not parse lease-key separators from command session fields', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    expect(mod.__test__.getSessionName(adapterKey('twitter'))).toBe(adapterKey('twitter'));
    expect(mod.__test__.getCommandSurface({ session: adapterKey('twitter') })).toBe('browser');
    expect(mod.__test__.getCommandSurface({ session: browserKey('work'), surface: 'adapter' })).toBe('adapter');
  });

  it('routes structured command session and surface fields without encoded lease keys', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.sendCommand = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleCommand({
      id: 'structured-cdp',
      action: 'cdp',
      session: 'twitter',
      surface: 'adapter',
      cdpMethod: 'Accessibility.enable',
      cdpParams: {},
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Accessibility.enable',
      {},
    );
  });

  it('does not route encoded adapter lease keys through the command session backdoor', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.sendCommand = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);
    // URL-less commands on the browser surface no longer auto-create a tab — that
    // guard is what stops a mistyped session name from spawning an orphan blank tab.
    // Materialize the browser-surface lease first; what this test asserts is the
    // lease-key namespacing, not the incidental auto-create.
    await mod.__test__.resolveTabId(undefined, browserKey(adapterKey('twitter')), 'https://example.com');

    const result = await mod.__test__.handleCommand({
      id: 'encoded-session',
      action: 'cdp',
      session: adapterKey('twitter'),
      cdpMethod: 'Accessibility.enable',
      cdpParams: {},
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(mod.__test__.getSession(adapterKey('twitter'))).toEqual(expect.objectContaining({
      surface: 'adapter',
      session: 'twitter',
    }));
    expect(mod.__test__.getSession(browserKey(adapterKey('twitter')))).toEqual(expect.objectContaining({
      surface: 'browser',
      session: adapterKey('twitter'),
    }));
  });

  it('allows Accessibility.enable through the guarded CDP passthrough', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.sendCommand = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleCommand({
      id: 'ax-enable',
      action: 'cdp',
      session: 'twitter',
      surface: 'adapter',
      cdpMethod: 'Accessibility.enable',
      cdpParams: {},
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Accessibility.enable',
      {},
    );
  });

  it('routes frame-target CDP passthrough calls through the iframe target', async () => {
    const { chrome } = createChromeMock();
    chrome.debugger.sendCommand = vi.fn(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') return { result: { value: 1 } };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Target.sendMessageToTarget') return {};
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const sendCommandInFrameTarget = vi.fn(async () => ({ nodes: [] }));
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      registerFrameTracking: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
      ensureAttached: vi.fn(async () => {}),
      sendCommandInFrameTarget,
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleCommand({
      id: 'frame-ax',
      action: 'cdp',
      session: 'twitter',
      surface: 'adapter',
      cdpMethod: 'Accessibility.getFullAXTree',
      cdpParams: { frameId: 'cross-frame', sessionId: 'target', targetUrl: 'https://frame.test/' },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ nodes: [] }),
    }));
    expect(sendCommandInFrameTarget).toHaveBeenCalledWith(
      1,
      'cross-frame',
      'Accessibility.getFullAXTree',
      {},
      false,
      30_000,
      'https://frame.test/',
    );
  });

  it('routes wait-download commands to the download observer', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const waitForDownload = vi.fn(async () => ({
      downloaded: true,
      filename: '/tmp/receipt.pdf',
      state: 'complete',
      elapsedMs: 12,
    }));
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      registerFrameTracking: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
      waitForDownload,
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const result = await mod.__test__.handleCommand({
      id: 'download',
      action: 'wait-download',
      pattern: 'receipt',
      timeoutMs: 1234,
      session: 'mercury',
      surface: 'adapter',
    });

    expect(result).toEqual({
      id: 'download',
      ok: true,
      data: {
        downloaded: true,
        filename: '/tmp/receipt.pdf',
        state: 'complete',
        elapsedMs: 12,
      },
    });
    expect(waitForDownload).toHaveBeenCalledWith('receipt', 1234);
  });

  it('routes exec frameIndex through the same cross-origin frame ordering as handleFrames', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const evaluateInFrame = vi.fn(async () => 'frame-result');
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      registerFrameTracking: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
      evaluateAsync: vi.fn(async () => 'main-result'),
      evaluateInFrame,
      getFrameTree: vi.fn(async () => ({
        frameTree: {
          frame: { id: 'root', url: 'https://main.example/' },
          childFrames: [
            {
              frame: { id: 'same-origin-parent', url: 'https://main.example/embed' },
              childFrames: [
                { frame: { id: 'cross-origin-nested', url: 'https://x.example/widget', name: 'nested-x' } },
              ],
            },
            {
              frame: { id: 'cross-origin-sibling', url: 'https://y.example/iframe', name: 'sibling-y' },
            },
          ],
        },
      })),
      screenshot: vi.fn(),
      setFileInputFiles: vi.fn(),
      insertText: vi.fn(),
      startNetworkCapture: vi.fn(),
      readNetworkCapture: vi.fn(async () => []),
      ensureAttached: vi.fn(),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const listResult = await mod.__test__.handleCommand({ id: 'frames', action: 'frames', session: 'twitter', surface: 'adapter' });
    const execResult = await mod.__test__.handleCommand({
      id: 'exec-in-frame',
      action: 'exec',
      code: 'document.title',
      frameIndex: 0,
      session: 'twitter',
      surface: 'adapter',
    });

    expect(listResult.ok).toBe(true);
    expect(listResult.data).toEqual([
      { index: 0, frameId: 'cross-origin-nested', url: 'https://x.example/widget', name: 'nested-x' },
      { index: 1, frameId: 'cross-origin-sibling', url: 'https://y.example/iframe', name: 'sibling-y' },
    ]);
    expect(execResult.ok).toBe(true);
    // Fifth arg is the CDP deadline derived from cmd.timeout (undefined here — no timeout on the command).
    expect(evaluateInFrame).toHaveBeenCalledWith(1, 'document.title', 'cross-origin-nested', false, undefined);
  });

  it('derives the CDP deadline from cmd.timeout for exec (timeout*1000 - 5s, floor 10s)', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const evaluateAsync = vi.fn(async () => 'main-result');
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      registerFrameTracking: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
      evaluateAsync,
      evaluateInFrame: vi.fn(),
      getFrameTree: vi.fn(),
      screenshot: vi.fn(),
      setFileInputFiles: vi.fn(),
      insertText: vi.fn(),
      startNetworkCapture: vi.fn(),
      readNetworkCapture: vi.fn(async () => []),
      ensureAttached: vi.fn(),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    // 120s transport timeout → 115s CDP deadline
    await mod.__test__.handleCommand({
      id: 'exec-with-timeout',
      action: 'exec',
      code: '1',
      session: 'twitter',
      surface: 'adapter',
      timeout: 120,
    });
    expect(evaluateAsync).toHaveBeenLastCalledWith(1, '1', false, 115_000);

    // Tiny transport timeout → clamped to the 10s floor
    await mod.__test__.handleCommand({
      id: 'exec-with-tiny-timeout',
      action: 'exec',
      code: '1',
      session: 'twitter',
      surface: 'adapter',
      timeout: 8,
    });
    expect(evaluateAsync).toHaveBeenLastCalledWith(1, '1', false, 10_000);
  });

  it('creates new tabs inside the automation container', async () => {
    const { chrome, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleTabs({ id: '2', action: 'tabs', op: 'new', url: 'https://new.example', session: adapterKey('twitter') }, adapterKey('twitter'));

    expect(result.ok).toBe(true);
    // Background is the default, so a new automation tab must not become the active
    // tab — that would yank the view away from whatever the person is reading.
    expect(create).toHaveBeenCalledWith({ windowId: 1, url: 'https://new.example', active: false });
  });

  it('reuses the initial container tab for first tab-new lease instead of leaving a blank tab', async () => {
    const { chrome, create, update } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const result = await mod.__test__.handleTabs(
      { id: 'first-new', action: 'tabs', op: 'new', url: 'https://first.example', session: browserKey('default') },
      browserKey('default'),
    );

    expect(result.ok).toBe(true);
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://first.example' }));
    expect(update).toHaveBeenCalledWith(1, { url: 'https://first.example' });
    expect(create).not.toHaveBeenCalled();
  });

  it('closes a tab by page identity', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleTabs(
      { id: 'close-by-page', action: 'tabs', op: 'close', session: adapterKey('twitter'), page: 'target-1' },
      adapterKey('twitter'),
    );

    expect(result).toEqual({
      id: 'close-by-page',
      ok: true,
      data: { closed: 'target-1' },
    });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
  });

  it('treats normalized same-url navigate as already complete', async () => {
    const { chrome, tabs, update } = createChromeMock();
    tabs[0].url = 'https://www.bilibili.com/';
    tabs[0].title = 'bilibili';
    tabs[0].status = 'complete';
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleNavigate(
      { id: 'same-url', action: 'navigate', url: 'https://www.bilibili.com', session: adapterKey('twitter') },
      adapterKey('twitter'),
    );

    expect(result).toEqual({
      id: 'same-url',
      ok: true,
      page: 'target-1',
      data: {
        title: 'bilibili',
        url: 'https://www.bilibili.com/',
        timedOut: false,
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the debugger attached during navigation when network capture is active', async () => {
    const { chrome, tabs } = createChromeMock();
    const onUpdatedListeners: Array<(id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void> = [];
    chrome.tabs.onUpdated.addListener = vi.fn((fn) => { onUpdatedListeners.push(fn); });
    chrome.tabs.onUpdated.removeListener = vi.fn((fn) => {
      const idx = onUpdatedListeners.indexOf(fn);
      if (idx >= 0) onUpdatedListeners.splice(idx, 1);
    });
    chrome.tabs.update = vi.fn(async (tabId: number, updates: { active?: boolean; url?: string }) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) throw new Error(`Unknown tab ${tabId}`);
      if (updates.active !== undefined) tab.active = updates.active;
      if (updates.url !== undefined) tab.url = updates.url;
      tab.status = 'complete';
      for (const listener of [...onUpdatedListeners]) {
        listener(tabId, { status: 'complete', url: tab.url }, tab as chrome.tabs.Tab);
      }
      return tab;
    });
    vi.stubGlobal('chrome', chrome);

    const detachMock = vi.fn(async () => {});
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => true),
      detach: detachMock,
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const result = await mod.__test__.handleNavigate(
      { id: 'capture-nav', action: 'navigate', url: 'https://eos.douyin.com/livesite/live/current', session: adapterKey('twitter') },
      adapterKey('twitter'),
    );

    expect(result.ok).toBe(true);
    expect(detachMock).not.toHaveBeenCalled();
  });

  /**
   * Both of these navigate-timeout tests must keep the tab looking permanently
   * "not yet at the target URL" — otherwise handleNavigate's own fast path
   * ("tab already at target and complete") returns before ever scheduling its
   * wait/timeout, and the test would pass for the wrong reason. `chrome.tabs.update`
   * is therefore a deliberate no-op (never mutates url/status), for BOTH the
   * pre-navigation update inside createOwnedTabLeaseUnlocked and handleNavigate's
   * own update call. Once the real wait/timeout is scheduled, the test finishes
   * it by invoking the captured timeout callback directly (the same code path
   * `finish()` would take on a real timeout) instead of waiting out the delay
   * in real time or leaving a live timer dangling into a later test.
   */
  it('schedules the navigate timeout fallback at 15000ms when cmd.timeoutMs is absent (old-CLI compatibility)', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.tabs.update = vi.fn(async (tabId: number) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) throw new Error(`Unknown tab ${tabId}`);
      return tab;
    });
    vi.stubGlobal('chrome', chrome);
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const resultPromise = mod.__test__.handleNavigate(
        { id: 'nav-default-timeout', action: 'navigate', url: 'https://eos.douyin.com/livesite/default-timeout', session: adapterKey('twitter') },
        adapterKey('twitter'),
      );

      // Let the mandatory internal waits (the 300ms pre-navigation settle inside
      // createOwnedTabLeaseUnlocked, plus microtask chains) elapse for real, so
      // handleNavigate's own checkTimer/timeoutTimer are definitely scheduled by
      // the time we inspect the spy below.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const timeoutCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 15000);
      expect(timeoutCall).toBeTruthy();

      // Fire the captured callback directly instead of waiting out 15s of real
      // time or leaving the timer dangling into a later test.
      (timeoutCall![0] as () => void)();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect((result as { data?: { timedOut?: boolean } }).data?.timedOut).toBe(true);
    } finally {
      // handleNavigate's success path arms a real idle timer (30s default for
      // adapter sessions) on the lease. Release it here — while `chrome` is
      // still stubbed — so it doesn't fire after this test (and its stub)
      // have torn down, which would surface as an unhandled rejection later
      // in the run instead of a clean pass/fail here.
      await mod.__test__.releaseLease(adapterKey('twitter'), 'test cleanup');
      setTimeoutSpy.mockRestore();
    }
  });

  it('schedules the navigate timeout fallback at cmd.timeoutMs (not the 15000ms default) when the CLI passes --timeout / OPENCLI_NAV_TIMEOUT_MS', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.tabs.update = vi.fn(async (tabId: number) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) throw new Error(`Unknown tab ${tabId}`);
      return tab;
    });
    vi.stubGlobal('chrome', chrome);
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const resultPromise = mod.__test__.handleNavigate(
        { id: 'nav-custom-timeout', action: 'navigate', url: 'https://eos.douyin.com/livesite/custom-timeout', session: adapterKey('twitter'), timeoutMs: 45000 },
        adapterKey('twitter'),
      );

      await new Promise((resolve) => setTimeout(resolve, 500));

      const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay);
      const timeoutCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 45000);
      expect(timeoutCall).toBeTruthy();
      expect(delays).not.toContain(15000);

      (timeoutCall![0] as () => void)();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect((result as { data?: { timedOut?: boolean } }).data?.timedOut).toBe(true);
    } finally {
      // See the identical comment in the previous test: release the lease
      // while `chrome` is still stubbed so its real idle timer doesn't fire
      // later in the run against an already-torn-down stub.
      await mod.__test__.releaseLease(adapterKey('twitter'), 'test cleanup');
      setTimeoutSpy.mockRestore();
    }
  });

  it('keeps hash routes distinct when comparing target URLs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    expect(mod.__test__.isTargetUrl('https://example.com/', 'https://example.com')).toBe(true);
    expect(mod.__test__.isTargetUrl('https://example.com/#feed', 'https://example.com/#settings')).toBe(false);
    expect(mod.__test__.isTargetUrl('https://example.com/app/', 'https://example.com/app')).toBe(false);
  });

  it('returns the persisted profile contextId from popup status', async () => {
    const { chrome } = createChromeMock();
    await chrome.storage.local.set({ opencli_context_id_v1: 'abc123xy' });
    vi.stubGlobal('chrome', chrome);

    await import('./background');
    const onMessageListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = vi.fn();

    const keepAlive = onMessageListener({ type: 'getStatus' }, {}, sendResponse);

    expect(keepAlive).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
        contextId: 'abc123xy',
      }));
    });
  });

  it('keeps the active daemon connection when a superseded WebSocket closes later', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    await import('./background');
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });
    const firstWs = MockWebSocket.instances[0];
    firstWs.readyState = 3;

    const onAlarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    await onAlarmListener({ name: 'keepalive' });
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });
    const secondWs = MockWebSocket.instances[1];
    secondWs.readyState = MockWebSocket.OPEN;

    firstWs.onclose?.();
    secondWs.onmessage?.({
      data: JSON.stringify({
        id: 'sessions-after-stale-close',
        action: 'tabs',
        op: 'list',
        session: 'work',
        surface: 'browser',
      }),
    });

    await vi.waitFor(() => {
      expect(secondWs.sent.some((entry) => entry.includes('sessions-after-stale-close'))).toBe(true);
    });
  });

  it('coalesces concurrent daemon connection attempts while the probe is in flight', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const ping = deferred<{ ok: boolean }>();
    const fetchMock = vi.fn(() => ping.promise);
    vi.stubGlobal('fetch', fetchMock);

    await import('./background');
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const onAlarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    await onAlarmListener({ name: 'keepalive' });
    await onAlarmListener({ name: 'keepalive' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);

    ping.resolve({ ok: true });
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  it('uses the production-safe 30s keepalive alarm period', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    await import('./background');

    expect(chrome.alarms.create).toHaveBeenCalledWith('keepalive', { periodInMinutes: 0.5 });
  });

  it('retries a WebSocket handshake that never opens or closes', async () => {
    vi.useFakeTimers();
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.connectForTest();
    const socket = MockWebSocket.instances[0];
    expect(socket.readyState).toBe(MockWebSocket.CONNECTING);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    mod.__test__.resetReconnectState();
  });

  it('reconnect delay backs off exponentially with a 15s cap and resets on success', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.resetReconnectState();

    mod.__test__.setReconnectAttempts(0);
    const first = mod.__test__.nextReconnectDelayMs();
    expect(first).toBeGreaterThanOrEqual(1_000);
    expect(first).toBeLessThan(1_500);

    mod.__test__.setReconnectAttempts(3);
    const fourth = mod.__test__.nextReconnectDelayMs();
    expect(fourth).toBeGreaterThanOrEqual(8_000);
    expect(fourth).toBeLessThan(8_500);

    mod.__test__.setReconnectAttempts(10);
    const capped = mod.__test__.nextReconnectDelayMs();
    expect(capped).toBeGreaterThanOrEqual(15_000);
    expect(capped).toBeLessThan(15_500);
  });

  it('a successful daemon ping resets the backoff before the WebSocket attempt', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.resetReconnectState();
    mod.__test__.setReconnectAttempts(5);

    await mod.__test__.connectForTest();

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    expect(mod.__test__.getReconnectAttempts()).toBe(0);
  });

  it('pings without credentials and logs a non-OK status instead of swallowing it', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 431 }));
    vi.stubGlobal('fetch', fetchMock);

    await import('./background');

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // The ping must not attach the localhost cookie jar — that is what pushes
    // the request past Node's header limit and makes the daemon answer 431.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
    // A non-OK ping must be logged, not silently swallowed.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 431'));
    // The WebSocket must not be attempted after a failed ping.
    expect(MockWebSocket.instances).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('ignores daemon commands delivered to a superseded WebSocket', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    await import('./background');
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });
    const firstWs = MockWebSocket.instances[0];
    firstWs.readyState = MockWebSocket.OPEN;

    const onAlarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    firstWs.readyState = MockWebSocket.CLOSED;
    await onAlarmListener({ name: 'keepalive' });
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });
    firstWs.readyState = MockWebSocket.OPEN;

    await firstWs.onmessage?.({
      data: JSON.stringify({
        id: 'stale-command',
        action: 'tabs',
        op: 'list',
        session: 'work',
        surface: 'browser',
      }),
    });

    expect(firstWs.sent.some((entry) => entry.includes('stale-command'))).toBe(false);
  });

  it('can execute concurrently on two pages in the same session', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs.push({
      id: 4,
      windowId: 1,
      url: 'https://automation-2.example',
      title: 'automation-2',
      active: false,
      status: 'complete',
    });
    vi.stubGlobal('chrome', chrome);

    let inFlight = 0;
    let maxInFlight = 0;
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      evaluateAsync: vi.fn(async (tabId: number, code: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 30));
        inFlight--;
        return { tabId, code };
      }),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const [first, second] = await Promise.all([
      mod.__test__.handleExec({ id: 'p1', action: 'exec', session: adapterKey('twitter'), page: 'target-1', code: 'window.__task = 1' }, adapterKey('twitter')),
      mod.__test__.handleExec({ id: 'p2', action: 'exec', session: adapterKey('twitter'), page: 'target-4', code: 'window.__task = 2' }, adapterKey('twitter')),
    ]);

    expect(first).toEqual(expect.objectContaining({
      ok: true,
      page: 'target-1',
      data: { tabId: 1, code: 'window.__task = 1' },
    }));
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      page: 'target-4',
      data: { tabId: 4, code: 'window.__task = 2' },
    }));
    expect(maxInFlight).toBe(2);
  });

  it('can execute concurrently across two sessions in the shared container window', async () => {
    const { chrome, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    let inFlight = 0;
    let maxInFlight = 0;
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      evaluateAsync: vi.fn(async (tabId: number, code: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 30));
        inFlight--;
        return { tabId, code };
      }),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);
    mod.__test__.setAutomationWindowId(adapterKey('zhihu'), 2);

    const [first, second] = await Promise.all([
      mod.__test__.handleExec({ id: 'w1', action: 'exec', session: adapterKey('twitter'), code: 'window.__window = 1' }, adapterKey('twitter')),
      mod.__test__.handleExec({ id: 'w2', action: 'exec', session: adapterKey('zhihu'), code: 'window.__window = 2' }, adapterKey('zhihu')),
    ]);

    expect(first).toEqual(expect.objectContaining({
      ok: true,
      page: 'target-1',
      data: expect.objectContaining({ tabId: 1, code: 'window.__window = 1' }),
    }));
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      page: 'target-10',
      data: expect.objectContaining({ tabId: 10, code: 'window.__window = 2' }),
    }));
    expect(maxInFlight).toBe(2);
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ windowId: 1, url: 'about:blank', active: false });
  });

  it('releases owned sessions without closing the shared container', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.resolveTabId(undefined, adapterKey('first'));
    await mod.__test__.resolveTabId(undefined, adapterKey('second'));
    expect(mod.__test__.getSession(adapterKey('second'))).toEqual(expect.objectContaining({ preferredTabId: 10 }));

    const closeSecond = await mod.__test__.handleCommand({ id: 'close-second', action: 'close-window', session: 'second', surface: 'adapter' });
    expect(closeSecond).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(10);
    expect(chrome.tabs.update).not.toHaveBeenCalledWith(10, { url: 'about:blank' });
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(adapterKey('first'))).not.toBeNull();
    expect(mod.__test__.getSession(adapterKey('second'))).toBeNull();

    await mod.__test__.handleCommand({ id: 'close-first', action: 'close-window', session: 'first', surface: 'adapter' });
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank' });
    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });

  it('releases the current owned tab lease when tabs close targets it', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    const result = await mod.__test__.handleTabs(
      { id: 'close-current-lease', action: 'tabs', op: 'close', session: adapterKey('twitter') },
      adapterKey('twitter'),
    );

    expect(result).toEqual(expect.objectContaining({
      id: 'close-current-lease',
      ok: true,
      data: { closed: 'target-1' },
    }));
    // Releasing a lease resets the tab but must never select it: this fires on idle
    // timeout and cleanup, long after the person stopped watching.
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank' });
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(adapterKey('twitter'))).toBeNull();
  });

  it('reconciles an owned adapter container with no stored leases without closing it or touching its tabs', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      opencli_target_lease_registry_v2: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getAutomationWindowId()).toBeNull();
    chrome.windows.create.mockClear();

    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'), 'https://after.example');

    // The http tab already in the window carries no ownership signal, so it is
    // the person's: untouched and left outside any group. The new lease gets a
    // fresh tab in its own session-named group.
    expect(tabId).not.toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === 1)?.url).toBe('https://automation.example');
    expect(tabs.find((tab) => tab.id === 1)?.groupId).toBe(-1);
    expect(tabs.find((tab) => tab.id === tabId)?.url).toBe('https://after.example');
    expect(tabs.find((tab) => tab.id === tabId)?.groupId).not.toBe(-1);
    expect(groups).toEqual([expect.objectContaining({ windowId: 1, title: 'OpenCLI: twitter' })]);
  });

  it('restores owned and borrowed leases from the registry', async () => {
    const { chrome } = createChromeMock();
    const deadline = Date.now() + 30_000;
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      opencli_target_lease_registry_v2: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
        leases: {
          [adapterKey('twitter')]: {
            windowId: 1,
            owned: true,
            preferredTabId: 1,
            contextId: 'user-default',
            ownership: 'owned',
            lifecycle: 'ephemeral',
            windowRole: 'automation',
            idleDeadlineAt: deadline,
            updatedAt: Date.now(),
          },
          [browserKey('default')]: {
            windowId: 2,
            owned: false,
            preferredTabId: 2,
            contextId: 'user-default',
            ownership: 'borrowed',
            lifecycle: 'pinned',
            windowRole: 'borrowed-user',
            idleDeadlineAt: 0,
            updatedAt: Date.now(),
          },
        },
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    expect(mod.__test__.getSession(adapterKey('twitter'))).toEqual(expect.objectContaining({
      owned: true,
      ownership: 'owned',
      lifecycle: 'ephemeral',
      windowRole: 'automation',
      preferredTabId: 1,
    }));
    expect(mod.__test__.getSession(browserKey('default'))).toEqual(expect.objectContaining({
      owned: false,
      ownership: 'borrowed',
      lifecycle: 'pinned',
      windowRole: 'borrowed-user',
      preferredTabId: 2,
      idleTimer: null,
      idleDeadlineAt: 0,
    }));
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      `opencli:lease-idle:${encodeURIComponent(adapterKey('twitter'))}`,
      expect.objectContaining({ when: expect.any(Number) }),
    );
    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });

  it('honors the persisted remaining idle lifetime on reconcile instead of granting a fresh full timeout', async () => {
    const { chrome } = createChromeMock();
    const now = Date.now();
    // 5s left of a 30s adapter idle timeout when the service worker restarts.
    const deadline = now + 5_000;
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      opencli_target_lease_registry_v2: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
        leases: {
          [adapterKey('twitter')]: {
            windowId: 1,
            owned: true,
            preferredTabId: 1,
            contextId: 'user-default',
            ownership: 'owned',
            lifecycle: 'ephemeral',
            windowRole: 'automation',
            idleDeadlineAt: deadline,
            updatedAt: now,
          },
        },
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    const alarmName = `opencli:lease-idle:${encodeURIComponent(adapterKey('twitter'))}`;
    const createCalls = chrome.alarms.create.mock.calls.filter((c: unknown[]) => c[0] === alarmName);
    expect(createCalls.length).toBeGreaterThan(0);
    const scheduledWhen = (createCalls.at(-1)![1] as { when: number }).when;

    // The alarm must fire after the ~5s remaining, NOT after a fresh 30s timeout.
    // Without honoring `remaining`, the lease keeps getting a full 30s on every
    // SW restart and can dodge idle expiry indefinitely.
    expect(scheduledWhen).toBeLessThan(now + 15_000);
    expect(scheduledWhen).toBeGreaterThan(now + 1_000);
    expect(mod.__test__.getSession(adapterKey('twitter')).idleDeadlineAt).toBeLessThan(now + 15_000);
  });

  it('releases owned leases from the idle alarm path', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.resolveTabId(undefined, adapterKey('alarm'));

    const onAlarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    await onAlarmListener({ name: `opencli:lease-idle:${encodeURIComponent(adapterKey('alarm'))}` });

    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank' });
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(adapterKey('alarm'))).toBeNull();
  });

  it('reuses the placeholder tab left by an idle release', async () => {
    const { chrome, tabs } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.resolveTabId(undefined, adapterKey('first'));

    const onAlarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    await onAlarmListener({ name: `opencli:lease-idle:${encodeURIComponent(adapterKey('first'))}` });

    expect(tabs[0].url).toBe('about:blank');
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    chrome.windows.create.mockClear();

    const reused = await mod.__test__.resolveTabId(undefined, adapterKey('next'), 'https://next.example');

    expect(reused).toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'https://next.example' });
  });

  it('deduplicates concurrent automation container creation', async () => {
    const { chrome } = createChromeMock();
    chrome.windows.get = vi.fn(async (windowId: number) => {
      if (windowId === 90 || windowId === 91) throw new Error(`stale window ${windowId}`);
      return { id: windowId, focused: false };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(adapterKey('stale-a'), { windowId: 90, owned: true, preferredTabId: null });
    mod.__test__.setSession(adapterKey('stale-b'), { windowId: 91, owned: true, preferredTabId: null });

    const [first, second] = await Promise.all([
      mod.__test__.handleTabs({ id: 'new-a', action: 'tabs', op: 'new', session: adapterKey('stale-a'), url: 'https://a.example' }, adapterKey('stale-a')),
      mod.__test__.handleTabs({ id: 'new-b', action: 'tabs', op: 'new', session: adapterKey('stale-b'), url: 'https://b.example' }, adapterKey('stale-b')),
    ]);

    expect(first).toEqual(expect.objectContaining({ ok: true }));
    expect(second).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('groups adapter automation tabs under the site name', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    // Adapter tabs used to sit ungrouped in a window of their own. Now they live
    // in the person's window like everything else, so the label is what tells
    // them apart from the person's own tabs.
    expect(tabId).toBe(1);
    expect(tabs[0].groupId).not.toBe(-1);
    expect(groups).toEqual([expect.objectContaining({ id: tabs[0].groupId, title: 'OpenCLI: twitter', color: 'orange' })]);
  });

  it('gives every session its own group titled after it, on both surfaces', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const a = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://a.example');
    const b = await mod.__test__.resolveTabId(undefined, browserKey('checkout'), 'https://b.example');
    const c = await mod.__test__.resolveTabId(undefined, adapterKey('reddit'), 'https://c.example');

    const groupOf = (id: number) => tabs.find((tab) => tab.id === id)?.groupId;
    // Three sessions, three groups, one window — never the pooled
    // "OpenCLI: recon, checkout" group of before.
    expect(new Set([groupOf(a), groupOf(b), groupOf(c)]).size).toBe(3);
    expect(tabs.filter((tab) => [a, b, c].includes(tab.id)).every((tab) => tab.windowId === 7)).toBe(true);
    expect(groups.map((group) => group.title).sort()).toEqual(['OpenCLI: checkout', 'OpenCLI: recon', 'OpenCLI: reddit']);
    expect(chrome.windows.create).not.toHaveBeenCalled();

    // A second tab opened on a session joins that session's group, not a new one.
    await mod.__test__.handleTabs(
      { id: 'more', action: 'tabs', op: 'new', url: 'https://a2.example', session: browserKey('recon') } as never,
      browserKey('recon'),
    );
    expect(tabs.at(-1)?.groupId).toBe(groupOf(a));
    expect(groups).toHaveLength(3);
  });

  it('titles adapter groups after the site, not the runtime session name', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    // What the CLI actually sends: `site:<site>` for a persistent site session,
    // `site:<site>:<uuid>` for a one-shot run.
    const persistent = await mod.__test__.resolveTabId(undefined, adapterKey('site:reddit'), 'https://reddit.example/p');
    const oneShot = await mod.__test__.resolveTabId(undefined, adapterKey('site:reddit:0b08261e-d0f4-420c-9baa-3029d7e51a7d'), 'https://reddit.example/o');

    expect(groups.map((group) => group.title)).toEqual(['OpenCLI: reddit', 'OpenCLI: reddit']);
    // Same title, still two sessions, still two groups.
    expect(tabs.find((tab) => tab.id === persistent)?.groupId).not.toBe(tabs.find((tab) => tab.id === oneShot)?.groupId);
  });

  it('keeps a browser session and an adapter session apart even when they share a name', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const viaBrowser = await mod.__test__.resolveTabId(undefined, browserKey('reddit'), 'https://reddit.example/a');
    const viaAdapter = await mod.__test__.resolveTabId(undefined, adapterKey('reddit'), 'https://reddit.example/b');

    // Same title, different lease keys: the title layer alone would have merged
    // them, and then releasing one session would have taken the other's tab.
    const browserGroup = tabs.find((tab) => tab.id === viaBrowser)?.groupId;
    const adapterGroup = tabs.find((tab) => tab.id === viaAdapter)?.groupId;
    expect(browserGroup).not.toBe(-1);
    expect(adapterGroup).not.toBe(-1);
    expect(browserGroup).not.toBe(adapterGroup);
    expect(groups.map((group) => group.title)).toEqual(['OpenCLI: reddit', 'OpenCLI: reddit']);
  });

  it('opens interactive automation in the window the person is already using', async () => {
    const { chrome, tabs } = createChromeMock();
    // The person has one ordinary Chrome window open, with their own tabs in it.
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://example.com');

    // A second Chrome window landing on top of their layout is a worse interruption
    // than the tab itself, so the container borrows the window they already have.
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).toBe(7);
    // And borrowing their window makes activation dangerous, so the tab stays inactive.
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 7, active: false }));
  });

  it('opens adapter automation in the window the person is already using too', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    // Adapter runs used to get a window of their own "because nobody watches
    // them" — but the window itself is what the person sees. Same rule as the
    // browser surface: borrow, stay inactive, group under the session name.
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).toBe(7);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 7, active: false }));

    const listed = await mod.__test__.handleSessions({ id: 'ls', action: 'sessions', op: 'list' } as never);
    expect(listed.data).toEqual([expect.objectContaining({
      session: 'twitter',
      surface: 'adapter',
      windowId: 7,
      groupTitle: 'OpenCLI: twitter',
      windowFallbackReason: null,
    })]);
  });

  it('records why a window had to be created when none of the person\'s can be borrowed', async () => {
    const cases: Array<{ name: string; setup: (chrome: any) => void; reason: string }> = [
      {
        name: 'no window at all',
        setup: (chrome) => { chrome.windows.getAll = vi.fn(async () => []); },
        reason: 'no-normal-window',
      },
      {
        name: 'only incognito windows',
        setup: (chrome) => { chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: true, type: 'normal' }]); },
        reason: 'all-incognito',
      },
      {
        name: 'the query itself fails',
        setup: (chrome) => {
          chrome.windows.getLastFocused = vi.fn(async () => { throw new Error('no window manager'); });
          chrome.windows.getAll = vi.fn(async () => { throw new Error('no window manager'); });
        },
        reason: 'query-failed',
      },
    ];
    for (const { name, setup, reason } of cases) {
      vi.resetModules();
      const { chrome } = createChromeMock();
      setup(chrome);
      vi.stubGlobal('chrome', chrome);

      const mod = await import('./background');
      // This block is about what `background` mode does — the mode the person's own
      // window is borrowed for. The shipped default is `dedicated`; pin it here.
      mod.__test__.setDefaultWindowMode('background');
      await mod.__test__.resolveTabId(undefined, adapterKey('twitter'), 'https://x.example');

      expect(chrome.windows.create, name).toHaveBeenCalled();
      const listed = await mod.__test__.handleSessions({ id: 'ls', action: 'sessions', op: 'list' } as never);
      expect(listed.data, name).toEqual([expect.objectContaining({ session: 'twitter', windowFallbackReason: reason })]);
    }
  });

  it('shares one stand-in window between both roles instead of opening two', async () => {
    const { chrome, tabs } = createChromeMock();
    let nextWindowId = 20;
    let nextTabId = 200;
    const created: number[] = [];
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      const windowId = nextWindowId++;
      created.push(windowId);
      tabs.push({ id: nextTabId++, windowId, url, title: url ?? 'blank', active: true, status: 'complete', groupId: -1 });
      return { id: windowId, url, focused, width, height, type };
    });
    // Once created, the stand-in is a normal window Chrome reports back.
    chrome.windows.getAll = vi.fn(async () => created.map((id) => ({ id, focused: false, incognito: false, type: 'normal' })));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const browserTab = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://a.example');
    const adapterTab = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'), 'https://b.example');

    // No window of the person's existed, so one was created for the first
    // session; the second session of the other role must join it, not add a
    // second empty window to the pile.
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(tabs.find((tab) => tab.id === browserTab)?.windowId).toBe(20);
    expect(tabs.find((tab) => tab.id === adapterTab)?.windowId).toBe(20);
    const listed = await mod.__test__.handleSessions({ id: 'ls', action: 'sessions', op: 'list' } as never);
    expect(listed.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ session: 'recon', windowFallbackReason: 'no-normal-window' }),
      expect.objectContaining({ session: 'twitter', windowFallbackReason: 'no-normal-window' }),
    ]));
  });

  it('reports no fallback reason for a window the person asked for with --window isolated', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    chrome.windows.getLastFocused = vi.fn(async () => ({ id: 7, focused: true, incognito: false, type: 'normal' }));
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      tabs.push({ id: 600, windowId: 60, url, title: url ?? 'blank', active: false, status: 'complete', groupId: -1 });
      return { id: 60, url, focused, width, height, type };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.sessionOverrides.set(browserKey('iso'), { windowMode: 'isolated' });
    await mod.__test__.resolveTabId(undefined, browserKey('iso'), 'https://iso.example');

    expect(chrome.windows.create).toHaveBeenCalled();
    const listed = await mod.__test__.handleSessions({ id: 'ls', action: 'sessions', op: 'list' } as never);
    expect(listed.data).toEqual([expect.objectContaining({ session: 'iso', windowId: 60, windowFallbackReason: null })]);
  });

  it('escapes to its own window even when the borrowed flag was never recorded', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    // Simulate a container adopted by an older build: it points at the person's
    // window but carries no `borrowed` flag, so the flag alone would call it ours.
    // Window 2 holds one of the person's own pages in the mock fixture.
    mod.__test__.setAutomationWindowId(browserKey('recon'), 2);
    mod.__test__.sessionOverrides.set(browserKey('recon'), { windowMode: 'isolated' });

    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://example.com');

    // A window holding the person's pages cannot be the dedicated container
    // `isolated` asked for, flag or no flag.
    expect(chrome.windows.create).toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).not.toBe(2);
  });

  it('treats a window full of new tabs as the person\'s, not as our container', async () => {
    const { chrome, tabs } = createChromeMock();
    // A window someone just opened: two blank new tabs, no group of ours.
    tabs.length = 0;
    tabs.push({ id: 30, windowId: 3, url: 'chrome://newtab/', title: 'New Tab', active: true, status: 'complete', groupId: -1 });
    tabs.push({ id: 31, windowId: 3, url: 'chrome://newtab/', title: 'New Tab', active: false, status: 'complete', groupId: -1 });
    chrome.windows.getAll = vi.fn(async () => [{ id: 3, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(browserKey('recon'), 3);
    mod.__test__.sessionOverrides.set(browserKey('recon'), { windowMode: 'isolated' });

    await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://example.com');

    // Guessing ownership from tab URLs said "only non-http tabs, must be ours" and
    // quietly swallowed every `isolated` request into the person's window.
    expect(chrome.windows.create).toHaveBeenCalled();
  });

  it('does not let group convergence drag an isolated tab back to the shared window', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    // The person's window already holds an OpenCLI group from earlier work.
    tabs.length = 0;
    tabs.push({ id: 40, windowId: 4, url: 'https://user.example', title: 'user', active: true, status: 'complete', groupId: -1 });
    tabs.push({ id: 41, windowId: 4, url: 'https://example.com', title: 'prev', active: false, status: 'complete', groupId: 900 });
    groups.push({ id: 900, windowId: 4, title: 'OpenCLI: earlier', color: 'orange', collapsed: false });
    chrome.windows.getAll = vi.fn(async () => [{ id: 4, focused: true, incognito: false, type: 'normal' }]);
    let nextWindowId = 60;
    let nextTabId = 600;
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      const windowId = nextWindowId++;
      tabs.push({ id: nextTabId++, windowId, url, title: url ?? 'blank', active: false, status: 'complete', groupId: -1 });
      return { id: windowId, url, focused, width, height, type };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.sessionOverrides.set(browserKey('iso'), { windowMode: 'isolated' });
    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('iso'), 'https://example.org');

    // The dedicated window was created correctly before; what undid `isolated` was
    // convergence adopting the group in window 4 and moving the tab into it.
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).not.toBe(4);
  });

  it('follows the person when they move to a different window', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs.length = 0;
    tabs.push({ id: 80, windowId: 8, url: 'https://old.example', title: 'old', active: false, status: 'complete', groupId: -1 });
    tabs.push({ id: 90, windowId: 9, url: 'https://now.example', title: 'now', active: true, status: 'complete', groupId: -1 });
    // Chrome is not the frontmost app, so `focused` is false on every window —
    // the state an agent driving from a terminal always sees.
    chrome.windows.getAll = vi.fn(async () => [
      { id: 8, focused: false, incognito: false, type: 'normal' },
      { id: 9, focused: false, incognito: false, type: 'normal' },
    ]);
    chrome.windows.getLastFocused = vi.fn(async () => ({ id: 9, focused: false, incognito: false, type: 'normal' }));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    // An earlier session borrowed window 8. The person has since moved to window 9.
    mod.__test__.setAutomationWindowId(browserKey('earlier'), 8);

    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('later'), 'https://example.com');

    // Piling into the window they left an hour ago is the same complaint as opening
    // a new one, just quieter.
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).toBe(9);
  });

  it('keeps a second isolated session in the dedicated window instead of killing the first', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    // The person's window already carries an OpenCLI group from earlier work —
    // the convergence target that used to swallow the second isolated session.
    tabs.length = 0;
    tabs.push({ id: 40, windowId: 4, url: 'https://user.example', title: 'user', active: true, status: 'complete', groupId: -1 });
    tabs.push({ id: 41, windowId: 4, url: 'https://earlier.example', title: 'earlier', active: false, status: 'complete', groupId: 900 });
    groups.push({ id: 900, windowId: 4, title: 'OpenCLI: earlier', color: 'orange', collapsed: false });
    chrome.windows.getAll = vi.fn(async () => [{ id: 4, focused: true, incognito: false, type: 'normal' }]);
    chrome.windows.getLastFocused = vi.fn(async () => ({ id: 4, focused: true, incognito: false, type: 'normal' }));
    let nextWindowId = 60;
    let nextTabId = 600;
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      const windowId = nextWindowId++;
      tabs.push({ id: nextTabId++, windowId, url, title: url ?? 'blank', active: false, status: 'complete', groupId: -1 });
      return { id: windowId, url, focused, width, height, type };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.sessionOverrides.set(browserKey('isoA'), { windowMode: 'isolated' });
    mod.__test__.sessionOverrides.set(browserKey('isoB'), { windowMode: 'isolated' });

    const tabA = await mod.__test__.resolveTabId(undefined, browserKey('isoA'), 'https://a.example');
    const windowA = tabs.find((tab) => tab.id === tabA)?.windowId;
    const tabB = await mod.__test__.resolveTabId(undefined, browserKey('isoB'), 'https://b.example');
    const windowB = tabs.find((tab) => tab.id === tabB)?.windowId;

    // Neither may fall back into window 4, and the first session must survive the
    // second: previously B took the reuse branch, convergence pulled it into the
    // person's window, and A silently lost its container.
    expect(windowA).not.toBe(4);
    expect(windowB).not.toBe(4);
    expect(mod.__test__.getSession(browserKey('isoA'))).toBeTruthy();
    expect(mod.__test__.getSession(browserKey('isoB'))).toBeTruthy();
  });

  it('does not let an isolated window capture later default-mode sessions', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs.length = 0;
    tabs.push({ id: 40, windowId: 4, url: 'https://user.example', title: 'user', active: true, status: 'complete', groupId: -1 });
    chrome.windows.getAll = vi.fn(async () => [{ id: 4, focused: true, incognito: false, type: 'normal' }]);
    chrome.windows.getLastFocused = vi.fn(async () => ({ id: 4, focused: true, incognito: false, type: 'normal' }));
    let nextWindowId = 60;
    let nextTabId = 600;
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      const windowId = nextWindowId++;
      tabs.push({ id: nextTabId++, windowId, url, title: url ?? 'blank', active: false, status: 'complete', groupId: -1 });
      return { id: windowId, url, focused, width, height, type };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.sessionOverrides.set(browserKey('iso'), { windowMode: 'isolated' });
    const isoTab = await mod.__test__.resolveTabId(undefined, browserKey('iso'), 'https://iso.example');
    const isoWindow = tabs.find((tab) => tab.id === isoTab)?.windowId;

    // Default mode after that must still land where the person is. The role has
    // one container slot, so without re-asking, the isolated window it now holds
    // would silently swallow work the person explicitly asked to watch.
    const defTab = await mod.__test__.resolveTabId(undefined, browserKey('later'), 'https://later.example');
    expect(tabs.find((tab) => tab.id === defTab)?.windowId).toBe(4);
    expect(isoWindow).not.toBe(4);
  });

  it('never relocates another window\'s tabs when a call names its own window', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    // Two OpenCLI groups in two windows: the isolated container (win 8) and one
    // in the person's window (win 4). This is the state that killed sessions —
    // convergence merged them and emptied win 8, so Chrome closed it.
    tabs.length = 0;
    tabs.push({ id: 40, windowId: 4, url: 'https://user.example', title: 'user', active: true, status: 'complete', groupId: -1 });
    tabs.push({ id: 41, windowId: 4, url: 'https://prev.example', title: 'prev', active: false, status: 'complete', groupId: 700 });
    tabs.push({ id: 80, windowId: 8, url: 'https://iso.example', title: 'iso', active: false, status: 'complete', groupId: 800 });
    groups.push({ id: 700, windowId: 4, title: 'OpenCLI: prev', color: 'orange', collapsed: false });
    groups.push({ id: 800, windowId: 8, title: 'OpenCLI: iso', color: 'orange', collapsed: false });
    chrome.windows.getAll = vi.fn(async () => [{ id: 4, focused: true, incognito: false, type: 'normal' }]);
    chrome.windows.getLastFocused = vi.fn(async () => ({ id: 4, focused: true, incognito: false, type: 'normal' }));
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    // A call that names window 4 must confine itself to window 4.
    await mod.__test__.ensureOwnedContainerGroup('interactive', browserKey('prev'), 4, [40]);

    // The isolated window's tab has to stay put. Moving it empties window 8.
    expect(tabs.find((tab) => tab.id === 80)?.windowId).toBe(8);
    expect(tabs.find((tab) => tab.id === 80)?.groupId).toBe(800);
    expect(chrome.tabs.move).not.toHaveBeenCalled();
  });

  it('never folds another session\'s group into its own, even on an unpinned discovery call', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    // Two sessions, two groups, two windows. The discovery call (no window
    // named) may walk across windows — but only ever to ITS OWN group.
    tabs.length = 0;
    tabs.push({ id: 40, windowId: 4, url: 'https://user.example', title: 'user', active: true, status: 'complete', groupId: -1 });
    tabs.push({ id: 41, windowId: 4, url: 'https://prev.example', title: 'prev', active: false, status: 'complete', groupId: 700 });
    tabs.push({ id: 80, windowId: 8, url: 'https://iso.example', title: 'iso', active: false, status: 'complete', groupId: 800 });
    groups.push({ id: 700, windowId: 4, title: 'OpenCLI: prev', color: 'orange', collapsed: false });
    groups.push({ id: 800, windowId: 8, title: 'OpenCLI: iso', color: 'orange', collapsed: false });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('iso'), { windowId: 8, owned: true, preferredTabId: 80 });
    const found = await mod.__test__.ensureOwnedContainerGroup('interactive', browserKey('prev'), null, []);

    expect(found).toEqual(expect.objectContaining({ id: 700, windowId: 4 }));
    expect(tabs.find((tab) => tab.id === 80)?.windowId).toBe(8);
    expect(tabs.find((tab) => tab.id === 80)?.groupId).toBe(800);
    expect(chrome.tabs.move).not.toHaveBeenCalled();
    expect(groups).toHaveLength(2);
  });

  it('carries every window mode through to the session override', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    // A mode the command handler forgets is dropped silently — the flag parses, the
    // command succeeds, and the behaviour is just the default. Assert every mode
    // survives the trip so the guard cannot fall behind the union again.
    for (const mode of ['foreground', 'background', 'isolated'] as const) {
      const leaseKey = browserKey(`mode-${mode}`);
      await mod.__test__.handleCommand({
        id: `m-${mode}`,
        action: 'tabs',
        op: 'list',
        session: `mode-${mode}`,
        windowMode: mode,
      } as never);
      expect(mod.__test__.sessionOverrides.get(leaseKey)?.windowMode).toBe(mode);
    }
  });

  it('lets --window isolated opt back into a separate window', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.sessionOverrides.set(browserKey('recon'), { windowMode: 'isolated' });
    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://example.com');

    expect(chrome.windows.create).toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).not.toBe(7);
  });

  it('never borrows an incognito window for the container', async () => {
    const { chrome, tabs } = createChromeMock();
    // Incognito is a different context — its cookies are not the person's session.
    chrome.windows.getAll = vi.fn(async () => [{ id: 9, focused: true, incognito: true, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://example.com');

    expect(chrome.windows.create).toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).not.toBe(9);
  });

  it('does not leave a blank placeholder tab behind in a borrowed window', async () => {
    const { chrome, tabs } = createChromeMock();
    chrome.windows.getAll = vi.fn(async () => [{ id: 7, focused: true, incognito: false, type: 'normal' }]);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://example.com');
    const before = tabs.length;
    await mod.__test__.releaseLease(browserKey('recon'), 'test');

    // Inside a container window the blank placeholder is free to keep; inside the
    // person's own tab strip it is litter, so the tab goes away instead.
    expect(chrome.tabs.remove).toHaveBeenCalledWith(tabId);
    expect(chrome.tabs.update).not.toHaveBeenCalledWith(tabId, { url: 'about:blank' });
    expect(tabs.length).toBeLessThan(before + 1);
  });

  it('puts browser and adapter sessions in one window, each in its own labelled group', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    let nextWindowId = 20;
    let nextTabId = 200;
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      const windowId = nextWindowId++;
      const tab: MockTab = {
        id: nextTabId++,
        windowId,
        url,
        title: url ?? 'blank',
        active: true,
        status: 'complete',
        groupId: -1,
      };
      tabs.push(tab);
      return { id: windowId, url, focused, width, height, type };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    // URL-less commands on the browser surface are refused so a mistyped session
    // cannot spawn an orphan blank tab; `tabs op:new` is the explicit way to open
    // one. The adapter surface still creates its automation tab without a URL.
    const browserTab = await mod.__test__.handleTabs(
      { id: 'seed', action: 'tabs', op: 'new' } as never,
      browserKey('default'),
    );
    expect(browserTab.ok).toBe(true);
    const browserTabId = tabs.at(-1)!.id!;
    const adapterTabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    // No window of the person's exists in this fixture, so ONE stand-in window
    // is created and both roles use it. Neither role focuses it — background is
    // the default for both, and foreground is opt-in via `--window foreground`.
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false }));
    expect(tabs.find((tab) => tab.id === browserTabId)?.windowId).toBe(20);
    expect(tabs.find((tab) => tab.id === adapterTabId)?.windowId).toBe(20);
    expect(groups).toEqual([
      expect.objectContaining({ windowId: 20, title: 'OpenCLI: default' }),
      expect.objectContaining({ windowId: 20, title: 'OpenCLI: twitter' }),
    ]);
    expect(tabs.find((tab) => tab.id === browserTabId)?.groupId).toBe(groups[0].id);
    expect(tabs.find((tab) => tab.id === adapterTabId)?.groupId).toBe(groups[1].id);
  });

  it('lets adapters explicitly request a foreground automation window', async () => {
    const { chrome, tabs } = createChromeMock();
    let nextWindowId = 30;
    let nextTabId = 300;
    chrome.windows.create = vi.fn(async ({ url, focused, width, height, type }: any) => {
      const windowId = nextWindowId++;
      tabs.push({
        id: nextTabId++,
        windowId,
        url,
        title: url ?? 'blank',
        active: true,
        status: 'complete',
        groupId: -1,
      });
      return { id: windowId, url, focused, width, height, type };
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const result = await mod.__test__.handleCommand({
      id: 'new-foreground',
      action: 'tabs',
      op: 'new',
      session: 'twitter',
      surface: 'adapter',
      url: 'https://x.com',
      windowMode: 'foreground',
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: true }));
  });

  it('creates additional adapter lease tabs in the same window, each in its own group', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const firstTabId = await mod.__test__.resolveTabId(undefined, adapterKey('first'));
    const secondTabId = await mod.__test__.resolveTabId(undefined, adapterKey('second'));

    expect(secondTabId).toBe(10);
    expect(tabs.find((tab) => tab.id === 10)?.windowId).toBe(1);
    expect(groups.map((group) => group.title)).toEqual(['OpenCLI: first', 'OpenCLI: second']);
    expect(tabs.find((tab) => tab.id === firstTabId)?.groupId).toBe(groups[0].id);
    expect(tabs.find((tab) => tab.id === secondTabId)?.groupId).toBe(groups[1].id);
  });

  it('reuses a persisted adapter window after worker restart, reading the pre-per-session registry shape', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      opencli_target_lease_registry_v2: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          // The shape an older build wrote: a singular groupId, no groups map.
          interactive: { windowId: null, groupId: null },
          automation: { windowId: 1, groupId: null },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();
    chrome.windows.create.mockClear();

    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === tabId)?.windowId).toBe(1);
    expect(tabs.find((tab) => tab.id === tabId)?.groupId).not.toBe(-1);
    expect(groups).toEqual([expect.objectContaining({ windowId: 1, title: 'OpenCLI: twitter' })]);
  });

  it('reuses a restored adapter preferred tab after worker restart and re-groups it', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    const deadline = Date.now() + 30_000;
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      opencli_target_lease_registry_v2: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1, groupId: 99 } },
        leases: {
          [adapterKey('twitter')]: {
            windowId: 1,
            owned: true,
            preferredTabId: 1,
            contextId: 'user-default',
            ownership: 'owned',
            lifecycle: 'ephemeral',
            windowRole: 'automation',
            idleDeadlineAt: deadline,
            updatedAt: Date.now(),
          },
        },
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();
    chrome.windows.create.mockClear();

    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    // The lease's own tab is the ownership signal, so it is reused — and since
    // the group did not survive the restart, it is rebuilt around that tab.
    expect(tabId).toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(tabs[0].groupId).not.toBe(-1);
    expect(groups).toEqual([expect.objectContaining({ id: tabs[0].groupId, windowId: 1, title: 'OpenCLI: twitter' })]);
  });

  it('leaves legacy OpenCLI Adapter groups alone when choosing an adapter container', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    tabs.push({
      id: 77,
      windowId: 7,
      url: 'about:blank',
      title: 'blank',
      active: true,
      status: 'complete',
      groupId: 99,
    });
    groups.push({
      id: 99,
      windowId: 7,
      title: 'OpenCLI Adapter',
      color: 'orange',
      collapsed: true,
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    // A group titled by an older build is not ours to adopt: no lease, no
    // ledger entry, no per-session title. It keeps its tab and its title.
    expect(tabId).not.toBe(77);
    expect(mod.__test__.getAutomationWindowId(adapterKey('twitter'))).not.toBe(7);
    expect(tabs.find((tab) => tab.id === 77)?.groupId).toBe(99);
    expect(groups.find((group) => group.id === 99)?.title).toBe('OpenCLI Adapter');
    expect(chrome.tabGroups.update).not.toHaveBeenCalledWith(99, expect.anything());
    expect(groups.filter((group) => group.title === 'OpenCLI: twitter')).toHaveLength(1);
  });

  it('does not reuse a user http tab from an adapter-owned window without an owned lease signal', async () => {
    const { chrome, tabs } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      opencli_target_lease_registry_v2: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1, groupId: 99 } },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();
    chrome.windows.create.mockClear();

    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'), 'https://after.example');

    expect(tabId).not.toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === 1)?.url).toBe('https://automation.example');
    expect(tabs.find((tab) => tab.id === 1)?.groupId).toBe(-1);
    expect(tabs.find((tab) => tab.id === tabId)?.url).toBe('https://after.example');
    expect(tabs.find((tab) => tab.id === tabId)?.groupId).not.toBe(-1);
  });

  it('does not group borrowed user tabs for bound sessions', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    const result = await mod.__test__.handleBind(
      { id: 'bind', action: 'bind', session: browserKey('default') },
      browserKey('default'),
    );

    expect(result.ok).toBe(true);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });

  it('keeps adapter:notebooklm inside its owned automation lease instead of rebinding to a user tab', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs[0].url = 'https://notebooklm.google.com/';
    tabs[0].title = 'NotebookLM Home';
    tabs[1].url = 'https://notebooklm.google.com/notebook/nb-live';
    tabs[1].title = 'Live Notebook';
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    expect(tabId).toBe(1);
    expect(mod.__test__.getSession(adapterKey('twitter'))).toEqual(expect.objectContaining({
      windowId: 1,
    }));
  });

  it('moves drifted legacy tab back to its automation container instead of creating a new one', async () => {
    const { chrome, tabs } = createChromeMock();
    // Tab 1 belongs to automation container 1 but drifted to window 2
    tabs[0].windowId = 2;
    tabs[0].url = 'https://twitter.com/home';
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    const tabId = await mod.__test__.resolveTabId(1, adapterKey('twitter'));

    // Should have moved tab 1 back to window 1 and reused it
    expect(chrome.tabs.move).toHaveBeenCalledWith(1, { windowId: 1, index: -1 });
    expect(tabId).toBe(1);
  });

  it('falls through to re-resolve when drifted tab move fails', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs[0].windowId = 2;
    tabs[0].url = 'https://twitter.com/home';
    // Make move fail
    chrome.tabs.move = vi.fn(async () => { throw new Error('Cannot move tab'); });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    // Should still resolve (by finding/creating a tab in the correct window)
    const tabId = await mod.__test__.resolveTabId(1, adapterKey('twitter'));
    expect(typeof tabId).toBe('number');
  });

  it('does not fall back from an owned session to a user http tab in the same window', async () => {
    const { chrome, tabs } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(adapterKey('twitter'), { windowId: 1, owned: true, preferredTabId: 3 });

    const tabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'));

    expect(tabId).not.toBe(1);
    expect(tabs.find((tab) => tab.id === 1)?.url).toBe('https://automation.example');
    expect(tabs.find((tab) => tab.id === 1)?.groupId).toBe(-1);
    expect(tabs.find((tab) => tab.id === tabId)?.url).toBe('about:blank');
    expect(tabs.find((tab) => tab.id === tabId)?.groupId).not.toBe(-1);
  });

  it('idle timeout releases the automation lease for adapter:notebooklm', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs[0].url = 'https://notebooklm.google.com/';
    tabs[0].title = 'NotebookLM Home';
    tabs[0].active = true;

    vi.useFakeTimers();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(adapterKey('twitter'), 1);

    mod.__test__.resetWindowIdleTimer(adapterKey('twitter'));
    await vi.advanceTimersByTimeAsync(30001);

    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(adapterKey('twitter'))).toBeNull();
  });

  it('keeps persistent adapter site sessions alive across adapter idle timeout', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs[0].url = 'https://chatgpt.com/';
    tabs[0].title = 'ChatGPT';
    tabs[0].active = true;

    vi.useFakeTimers();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    const first = await mod.__test__.handleCommand({
      id: 'persistent-nav-1',
      action: 'navigate',
      session: 'chatgpt',
      surface: 'adapter',
      siteSession: 'persistent',
      url: 'https://chatgpt.com/',
    });
    expect(first.ok).toBe(true);
    const page = first.page;

    const session = mod.__test__.getSession(adapterKey('chatgpt'));
    expect(session).toEqual(expect.objectContaining({
      lifecycle: 'persistent',
      surface: 'adapter',
      session: 'chatgpt',
    }));
    expect(mod.__test__.getIdleTimeout(adapterKey('chatgpt'))).toBe(-1);

    await vi.advanceTimersByTimeAsync(60001);
    expect(mod.__test__.getSession(adapterKey('chatgpt'))).not.toBeNull();

    const second = await mod.__test__.handleCommand({
      id: 'persistent-nav-2',
      action: 'navigate',
      session: 'chatgpt',
      surface: 'adapter',
      siteSession: 'persistent',
      url: 'https://chatgpt.com/',
    });
    expect(second.ok).toBe(true);
    expect(second.page).toBe(page);
    expect(mod.__test__.getSession(adapterKey('chatgpt'))).not.toBeNull();
  });

  it('uses 10-minute timeout for browser:* sessions', async () => {
    const { chrome } = createChromeMock();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(browserKey('default'), 1);

    mod.__test__.resetWindowIdleTimer(browserKey('default'));
    // After 30s (adapter timeout), session should still be alive
    await vi.advanceTimersByTimeAsync(30001);
    expect(mod.__test__.getSession(browserKey('default'))).not.toBeNull();

    // After 10 min total, session should be cleaned up
    await vi.advanceTimersByTimeAsync(600000 - 30001);
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(browserKey('default'))).toBeNull();
  });

  it('clears session overrides on idle expiry', async () => {
    const { chrome } = createChromeMock();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(browserKey('default'), 1);

    // Set a custom timeout override
    mod.__test__.sessionOverrides.set(browserKey('default'), { idleTimeoutMs: 120_000 });
    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(120_000);

    // Trigger idle timer with the custom timeout
    mod.__test__.resetWindowIdleTimer(browserKey('default'));
    await vi.advanceTimersByTimeAsync(120001);

    // Override should be cleaned up
    expect(mod.__test__.sessionOverrides.has(browserKey('default'))).toBe(false);
    expect(mod.__test__.getSession(browserKey('default'))).toBeNull();
    // Should fall back to default interactive timeout
    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(600_000);
  });

  it('clears session overrides on explicit close', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(browserKey('default'), 1);
    mod.__test__.sessionOverrides.set(browserKey('default'), { idleTimeoutMs: 300_000 });

    const result = await mod.__test__.handleCommand({
      id: 'close-1',
      action: 'close-window',
      session: 'default',
      surface: 'browser',
    });

    expect(result.ok).toBe(true);
    expect(mod.__test__.sessionOverrides.has(browserKey('default'))).toBe(false);
  });

  it('applies idleTimeout from command to session override', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(browserKey('default'), 1);

    // Default for browser:* is 10 min
    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(600_000);

    // Send a benign command with custom idleTimeout (in seconds)
    await mod.__test__.handleCommand({
      id: 'custom-1',
      action: 'cookies',
      session: 'default',
      surface: 'browser',
      domain: 'example.com',
      idleTimeout: 120,
    });

    // Override should now be 120s = 120000ms
    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(120_000);
  });

  it('clears session overrides when user manually closes the automation container', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    // Set up a session with window ID 42 and a custom timeout override
    mod.__test__.setAutomationWindowId(browserKey('default'), 42);
    mod.__test__.sessionOverrides.set(browserKey('default'), { idleTimeoutMs: 180_000 });
    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(180_000);

    // Simulate user closing the window — invoke the onRemoved listener
    const onRemovedListener = chrome.windows.onRemoved.addListener.mock.calls[0][0];
    await onRemovedListener(42);

    // Session and override should both be cleaned up
    expect(mod.__test__.getSession(browserKey('default'))).toBeNull();
    expect(mod.__test__.sessionOverrides.has(browserKey('default'))).toBe(false);
    // Should fall back to default interactive timeout
    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(600_000);
  });


  it('bind does not reach into background windows when the current window has no match', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs[1].url = 'chrome://extensions';
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    const result = await mod.__test__.handleBind({
      id: 'bind-current-window-only',
      action: 'bind',
      session: browserKey('default'),
    }, browserKey('default'));

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'bound_tab_not_found',
      error: expect.stringContaining('current window'),
    }));
    expect(mod.__test__.getSession(browserKey('default'))).toBeNull();
  });

  it('bind attaches the current tab to the named browser session', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    const bound = await mod.__test__.handleBind({
      id: 'bind-good',
      action: 'bind',
      session: 'default',
    }, browserKey('default'));

    expect(bound).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ session: 'default', url: 'https://user.example' }),
    }));
    expect(mod.__test__.getSession(browserKey('default'))).toEqual(expect.objectContaining({
      windowId: 2,
      owned: false,
      preferredTabId: 2,
      idleTimer: null,
      idleDeadlineAt: 0,
    }));
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('rebind releases an owned browser lease before binding the current user tab', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setAutomationWindowId(browserKey('default'), 1);

    const result = await mod.__test__.handleBind({
      id: 'bind-overwrite',
      action: 'bind',
      session: 'default',
    }, browserKey('default'));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ session: 'default', url: 'https://user.example' }),
    }));
    expect(mod.__test__.getSession(browserKey('default'))).toEqual(expect.objectContaining({
      windowId: 2,
      owned: false,
      kind: 'bound',
    }));
  });

  it('keeps borrowed bound sessions alive without closing the user window on idle', async () => {
    const { chrome } = createChromeMock();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('default'), { windowId: 2, owned: false, preferredTabId: 2 });

    expect(mod.__test__.getIdleTimeout(browserKey('default'))).toBe(-1);
    mod.__test__.resetWindowIdleTimer(browserKey('default'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(browserKey('default'))).not.toBeNull();
  });

  it('explicit close on a borrowed bound session detaches without touching tabs or windows', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('default'), { windowId: 2, owned: false, preferredTabId: 2 });

    const result = await mod.__test__.handleCommand({
      id: 'bound-close',
      action: 'close-window',
      session: 'default',
      surface: 'browser',
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession(browserKey('default'))).toBeNull();
  });

  it('cleans borrowed sessions when the bound tab is closed', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('default'), { windowId: 2, owned: false, preferredTabId: 2 });

    const onRemovedListener = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
    await onRemovedListener(2);

    expect(mod.__test__.getSession(browserKey('default'))).toBeNull();
    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });

  it('fails closed when a borrowed bound tab is gone instead of creating an automation lease', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('default'), { windowId: 2, owned: false, preferredTabId: 999 });

    const result = await mod.__test__.handleCommand({
      id: 'bound-exec-gone',
      action: 'exec',
      session: 'default',
      surface: 'browser',
      code: 'document.title',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'bound_tab_gone',
    }));
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('fails closed when a borrowed bound tab is no longer debuggable', async () => {
    const { chrome, tabs } = createChromeMock();
    tabs[1].url = 'chrome://settings';
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('default'), { windowId: 2, owned: false, preferredTabId: 2 });

    const result = await mod.__test__.handleCommand({
      id: 'bound-exec-undebuggable',
      action: 'exec',
      session: 'default',
      surface: 'browser',
      code: 'document.title',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'bound_tab_not_debuggable',
    }));
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('allows navigation but blocks tab mutation on borrowed sessions', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    vi.doMock('./cdp', () => ({
      registerListeners: vi.fn(),
      registerFrameTracking: vi.fn(),
      hasActiveNetworkCapture: vi.fn(() => false),
      detach: vi.fn(async () => {}),
    }));

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    mod.__test__.setSession(browserKey('default'), { windowId: 2, owned: false, preferredTabId: 2 });

    const nav = await mod.__test__.handleCommand({
      id: 'bound-nav',
      action: 'navigate',
      session: 'default',
      surface: 'browser',
      url: 'https://other.example',
    });
    const tabNew = await mod.__test__.handleCommand({
      id: 'bound-tab-new',
      action: 'tabs',
      session: 'default',
      surface: 'browser',
      op: 'new',
      url: 'https://other.example',
    });

    expect(nav).toEqual(expect.objectContaining({ ok: true }));
    expect(tabNew).toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'bound_tab_mutation_blocked',
    }));
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, expect.objectContaining({ url: 'https://other.example' }));
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  const REGISTRY_KEY = 'opencli_target_lease_registry_v2';

  // Gate the registry read (in storage.session) so the startup recovery
  // chain (workerReady) stays pending on demand. Every other storage read
  // (context id) resolves normally. `readDirect` bypasses the gate so a test
  // can inspect stored state without blocking on (or releasing) it.
  function gateRegistryRead(chrome: any) {
    const gate = deferred<void>();
    const originalGet = chrome.storage.session.get;
    chrome.storage.session.get = vi.fn(async (key: string) => {
      if (key === REGISTRY_KEY) await gate.promise;
      return originalGet(key);
    });
    return {
      gate,
      readDirect: async (key: string) => (await originalGet(key))[key],
    };
  }

  it('does not wipe the persisted registry when a lease idle alarm fires before recovery', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    const deadline = Date.now() + 30_000;
    tabs.push({ id: 50, windowId: 5, url: 'about:blank', title: 'blank', active: true, status: 'complete', groupId: 200 });
    groups.push({ id: 200, windowId: 5, title: '', color: 'orange', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null, groups: { '200': browserKey('recon') } },
          automation: { windowId: 1 },
        },
        leases: {
          [adapterKey('twitter')]: {
            windowId: 1,
            owned: true,
            preferredTabId: 1,
            contextId: 'user-default',
            ownership: 'owned',
            lifecycle: 'ephemeral',
            windowRole: 'automation',
            idleDeadlineAt: deadline,
            updatedAt: Date.now(),
          },
        },
      },
    });
    const { gate, readDirect } = gateRegistryRead(chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    // Wake the worker via the idle alarm before recovery has restored state.
    const onAlarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    const alarmDone = onAlarmListener({ name: `opencli:lease-idle:${encodeURIComponent(adapterKey('twitter'))}` });

    // Drain runnable tasks while recovery stays gated. A pre-fix worker would
    // have persisted its empty snapshot by now, wiping the registry; the gated
    // worker must leave storage untouched.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const midFlight = await readDirect(REGISTRY_KEY);
    expect(midFlight.ownedContainers.interactive.groups).toEqual({ '200': browserKey('recon') });
    expect(midFlight.leases[adapterKey('twitter')]).toBeDefined();

    gate.resolve();
    await alarmDone;

    const finalRegistry = await readDirect(REGISTRY_KEY);
    // The session ledger survived recovery and the orphan it named got its title.
    expect(finalRegistry.ownedContainers.interactive.groups).toEqual({ '200': browserKey('recon') });
    expect(mod.__test__.getInteractiveContainer().groups).toEqual({ [browserKey('recon')]: 200 });
    expect(groups.find((group) => group.id === 200)?.title).toBe('OpenCLI: recon');
    // The lease was released down the proper owned-placeholder path, not wiped.
    // Releasing a lease resets the tab but must never select it: this fires on idle
    // timeout and cleanup, long after the person stopped watching.
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank' });
    expect(mod.__test__.getSession(adapterKey('twitter'))).toBeNull();
  });

  it('does not wipe the persisted registry when tabs.onRemoved fires before recovery', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    const deadline = Date.now() + 30_000;
    tabs.push({ id: 50, windowId: 5, url: 'about:blank', title: 'blank', active: true, status: 'complete', groupId: 200 });
    groups.push({ id: 200, windowId: 5, title: '', color: 'orange', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null, groups: { '200': browserKey('recon') } },
          automation: { windowId: 1 },
        },
        leases: {
          [adapterKey('twitter')]: {
            windowId: 1,
            owned: true,
            preferredTabId: 1,
            contextId: 'user-default',
            ownership: 'owned',
            lifecycle: 'ephemeral',
            windowRole: 'automation',
            idleDeadlineAt: deadline,
            updatedAt: Date.now(),
          },
        },
      },
    });
    const { gate, readDirect } = gateRegistryRead(chrome);

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');

    // Wake the worker via an unrelated tab-close before recovery.
    const onRemovedListener = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
    const removedDone = onRemovedListener(999);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const midFlight = await readDirect(REGISTRY_KEY);
    expect(midFlight.ownedContainers.interactive.groups).toEqual({ '200': browserKey('recon') });
    expect(midFlight.leases[adapterKey('twitter')]).toBeDefined();

    gate.resolve();
    await removedDone;

    const finalRegistry = await readDirect(REGISTRY_KEY);
    expect(finalRegistry.ownedContainers.interactive.groups).toEqual({ '200': browserKey('recon') });
    expect(mod.__test__.getInteractiveContainer().groups).toEqual({ [browserKey('recon')]: 200 });
    // The unrelated lease survived the unrelated tab-close.
    expect(finalRegistry.leases[adapterKey('twitter')]).toBeDefined();
  });

  it('adopts an untitled orphan group through the session ledger instead of creating a new one', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    tabs.push({ id: 50, windowId: 5, url: 'about:blank', title: 'blank', active: true, status: 'complete', groupId: 200 });
    groups.push({ id: 200, windowId: 5, title: '', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null, groups: { '200': browserKey('recon') } },
          automation: { windowId: null },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    // The orphan was adopted and titled for its session — no second group spawned.
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('OpenCLI: recon');
    const createGroupCalls = chrome.tabs.group.mock.calls.filter((call: any[]) => call[0]?.createProperties);
    expect(createGroupCalls).toHaveLength(0);
    const container = mod.__test__.getInteractiveContainer();
    expect(container.groups).toEqual({ [browserKey('recon')]: 200 });
    expect(container.groupIds).toContain(200);
  });

  it('adopts an orphan adapter group the same way', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    tabs.push({ id: 50, windowId: 5, url: 'about:blank', title: 'blank', active: true, status: 'complete', groupId: 200 });
    groups.push({ id: 200, windowId: 5, title: '', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null },
          automation: { windowId: null, groups: { '200': adapterKey('reddit') } },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('OpenCLI: reddit');
    expect(mod.__test__.getContainer('automation').groups).toEqual({ [adapterKey('reddit')]: 200 });
  });

  it('never adopts an ownerless group id left by a pre-per-session build', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    tabs.push({ id: 50, windowId: 5, url: 'about:blank', title: 'blank', active: true, status: 'complete', groupId: 200 });
    groups.push({ id: 200, windowId: 5, title: '', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          // The old ledger: bare ids, no session attached.
          interactive: { windowId: null, groupIds: [200] },
          automation: { windowId: null },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    // With no session to name it after there is nothing safe to do with it:
    // it stays as it is, untitled, and no session's group map claims it.
    expect(groups[0].title).toBe('');
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    expect(mod.__test__.getInteractiveContainer().groups).toEqual({});
  });

  it('prunes a vanished group id from the session ledger on convergence', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.session.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null, groups: { '300': browserKey('recon') }, groupIds: [301] },
          automation: { windowId: null, groups: { '302': adapterKey('reddit') } },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    expect(chrome.windows.create).not.toHaveBeenCalled();
    const createGroupCalls = chrome.tabs.group.mock.calls.filter((call: any[]) => call[0]?.createProperties);
    expect(createGroupCalls).toHaveLength(0);
    expect(mod.__test__.getInteractiveContainer().groupIds).toEqual([]);
    // The pruned ids are gone from the persisted session registry too.
    const finalRegistry = (await chrome.storage.session.get(REGISTRY_KEY) as any)[REGISTRY_KEY];
    expect(finalRegistry.ownedContainers.interactive.groups).toEqual({});
    expect(finalRegistry.ownedContainers.automation.groups).toEqual({});
  });

  it('ignores legacy groupIds persisted in the local registry so a recycled id cannot hijack a user group', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    // A user-created group from THIS browser session whose id happens to match
    // a ledger entry a previous OpenCLI version persisted across restarts.
    tabs.push({ id: 70, windowId: 7, url: 'https://vacation.example', title: 'trip', active: true, status: 'complete', groupId: 400 });
    groups.push({ id: 400, windowId: 7, title: 'Vacation', color: 'blue', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.local.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null, groupId: null, groupIds: [400] },
          automation: { windowId: null, groupId: null },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    // The user group is untouched: no retitle, no merge, no group mutation.
    expect(groups.find((group) => group.id === 400)?.title).toBe('Vacation');
    expect(tabs.find((tab) => tab.id === 70)?.groupId).toBe(400);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    // And the stale id never entered the in-memory ledger.
    expect(mod.__test__.getInteractiveContainer().groupIds).not.toContain(400);
  });

  it('ignores a legacy interactive groupId persisted in the local registry so a recycled id cannot hijack a user group', async () => {
    const { chrome, tabs, groups } = createChromeMock();
    // Same hazard as the plural groupIds ledger, through the singular cached
    // pointer: group ids are browser-session scoped, so a groupId persisted by
    // a previous browser session can collide with a user-created group here.
    tabs.push({ id: 70, windowId: 7, url: 'https://vacation.example', title: 'trip', active: true, status: 'complete', groupId: 400 });
    groups.push({ id: 400, windowId: 7, title: 'Vacation', color: 'blue', collapsed: false });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.local.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null, groupId: 400 },
          automation: { windowId: null, groupId: null },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    // The user group is untouched: no retitle, no merge, no group mutation.
    expect(groups.find((group) => group.id === 400)?.title).toBe('Vacation');
    expect(tabs.find((tab) => tab.id === 70)?.groupId).toBe(400);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    // And the stale pointer was never adopted into memory.
    expect(mod.__test__.getInteractiveContainer().groups).toEqual({});
    expect(mod.__test__.getInteractiveContainer().groupIds).not.toContain(400);
  });

  it('ignores legacy container windowIds persisted in the local registry so recycled ids cannot claim user windows', async () => {
    const { chrome, tabs } = createChromeMock();
    // Window 7 belongs to the user in THIS browser session; a registry left in
    // storage.local by a previous browser session claims it as both OpenCLI
    // containers (window ids are browser-session scoped, just like group ids).
    tabs.push({ id: 70, windowId: 7, url: 'https://vacation.example', title: 'trip', active: true, status: 'complete', groupId: -1 });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.local.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: 7 },
          automation: { windowId: 7 },
        },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    // The user window was never claimed as an owned container.
    expect(mod.__test__.getInteractiveContainer().windowId).not.toBe(7);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();

    // The next adapter lease opens its own container window instead of
    // dropping automation tabs into the user's window 7.
    const leaseTabId = await mod.__test__.resolveTabId(undefined, adapterKey('twitter'), 'https://work.example');
    expect(chrome.windows.create).toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === leaseTabId)?.windowId).not.toBe(7);
    expect(tabs.find((tab) => tab.id === 70)?.groupId).toBe(-1);
  });

  it('ignores a legacy lease persisted in the local registry so a recycled tab id cannot capture a user tab', async () => {
    const { chrome, tabs } = createChromeMock();
    // Tab 70 is the user's page in THIS browser session; a stale lease from a
    // previous browser session points at the same (recycled) tab id.
    tabs.push({ id: 70, windowId: 7, url: 'https://vacation.example', title: 'trip', active: true, status: 'complete', groupId: -1 });
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.local.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: {
          interactive: { windowId: null },
          automation: { windowId: null },
        },
        leases: {
          [browserKey('work')]: {
            session: 'work',
            surface: 'browser',
            kind: 'owned',
            windowId: 7,
            owned: true,
            preferredTabId: 70,
            contextId: 'user-default',
            ownership: 'owned',
            lifecycle: 'persistent',
            windowRole: 'interactive',
            idleDeadlineAt: Date.now() + 600_000,
            updatedAt: Date.now(),
          },
        },
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    // The stale lease was not resurrected onto the user's tab, and the tab was
    // never grouped, navigated, or closed.
    expect(mod.__test__.getSession(browserKey('work'))).toBeNull();
    expect(tabs.find((tab) => tab.id === 70)?.groupId).toBe(-1);
    expect(tabs.find((tab) => tab.id === 70)?.url).toBe('https://vacation.example');
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('removes the legacy storage.local registry key on startup reconcile', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    await chrome.storage.local.set({
      [REGISTRY_KEY]: {
        version: 2,
        contextId: 'user-default',
        ownedContainers: { interactive: { windowId: 7 }, automation: { windowId: 1 } },
        leases: {},
      },
    });

    const mod = await import('./background');
    // This block is about what `background` mode does — the mode the person's own
    // window is borrowed for. The shipped default is `dedicated`; pin it here.
    mod.__test__.setDefaultWindowMode('background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    expect(chrome.storage.local.remove).toHaveBeenCalledWith(REGISTRY_KEY);
    const leftover = (await chrome.storage.local.get(REGISTRY_KEY) as any)[REGISTRY_KEY];
    expect(leftover).toBeUndefined();
  });
});

// ─── Dedicated automation windows (`--window dedicated`) ────────────────────
function dedicatedHarness(opts: { withDisplayApi?: boolean } = {}) {
  const mock = createChromeMock();
  const chrome = mock.chrome as any;
  const tabs = mock.tabs;
  type MockWindow = { id: number; type: string; incognito: boolean; focused: boolean; state: string; left: number; top: number; width: number; height: number };
  const windows = new Map<number, MockWindow>([
    [1, { id: 1, type: 'normal', incognito: false, focused: false, state: 'normal', left: 0, top: 25, width: 1400, height: 880 }],
    [2, { id: 2, type: 'normal', incognito: false, focused: true, state: 'normal', left: 40, top: 25, width: 1400, height: 880 }],
  ]);
  let nextWindowId = 50;
  let nextTabId = 500;
  let lastFocused = 2;
  chrome.windows.get = vi.fn(async (id: number) => {
    const win = windows.get(id);
    if (!win) throw new Error(`No window with id: ${id}`);
    return { ...win };
  });
  chrome.windows.getAll = vi.fn(async () => [...windows.values()].map((w) => ({ ...w })));
  chrome.windows.getLastFocused = vi.fn(async () => ({ ...windows.get(lastFocused)! }));
  chrome.windows.create = vi.fn(async (props: any) => {
    const id = nextWindowId++;
    windows.set(id, {
      id, type: 'normal', incognito: false, focused: !!props.focused, state: 'normal',
      left: props.left ?? 300, top: props.top ?? 200, width: props.width, height: props.height,
    });
    tabs.push({ id: nextTabId++, windowId: id, url: props.url, title: props.url, active: true, status: 'complete', groupId: -1 });
    return { ...windows.get(id)! };
  });
  chrome.windows.update = vi.fn(async (id: number, info: any) => {
    const win = windows.get(id);
    if (!win) throw new Error(`No window with id: ${id}`);
    Object.assign(win, info);
    return { ...win };
  });
  const displays = [
    { id: 'main', name: 'Built-in Retina Display', isPrimary: true, isInternal: true, bounds: { left: 0, top: 0, width: 1512, height: 982 }, workArea: { left: 0, top: 25, width: 1512, height: 957 } },
    { id: 'virt', name: '虚拟 16:9', isPrimary: false, isInternal: false, bounds: { left: -2560, top: -1440, width: 2560, height: 1440 }, workArea: { left: -2560, top: -1440, width: 2560, height: 1440 } },
  ];
  if (opts.withDisplayApi !== false) {
    chrome.system = { display: { getInfo: vi.fn(async (cb?: (d: unknown[]) => void) => { cb?.(displays); return displays; }) } };
  }
  chrome.tabs.onCreated = { addListener: vi.fn() };
  chrome.tabs.onAttached = { addListener: vi.fn() };
  return {
    ...mock,
    chrome,
    windows,
    setLastFocused: (id: number) => { lastFocused = id; },
    closeWindow: async (id: number) => {
      windows.delete(id);
      for (let i = tabs.length - 1; i >= 0; i -= 1) if (tabs[i].windowId === id) tabs.splice(i, 1);
      for (const call of chrome.windows.onRemoved.addListener.mock.calls) await call[0](id);
    },
  };
}

describe('dedicated automation window', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  const useDedicated = (mod: any, key: string, fields: Record<string, unknown> = {}) => {
    mod.__test__.sessionOverrides.set(key, { windowMode: 'dedicated' });
    mod.__test__.applyDedicatedCommandFields(key, { id: 'x', action: 'exec', windowMode: 'dedicated', ...fields });
  };

  it('creates its own window unfocused at the requested bounds and never touches the person\'s window', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    useDedicated(mod, key, { windowSlot: 'semrush', windowBounds: { left: -2480, top: -1380, width: 1280, height: 900 } });

    const tabId = await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');

    expect(h.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(h.chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, left: -2480, top: -1380, width: 1280, height: 900 }));
    expect(h.tabs.find((t) => t.id === tabId)?.windowId).toBe(50);
    for (const call of h.chrome.tabs.create.mock.calls) expect(call[0].windowId).not.toBe(2);
    for (const call of h.chrome.windows.update.mock.calls) expect(call[1]).not.toHaveProperty('focused');
    expect(mod.__test__.getDedicatedSlot('semrush')).toMatchObject({ windowId: 50, placement: { source: 'bounds' } });
    // The person's window stays out of every role container.
    expect(mod.__test__.getContainer('interactive').windowId).not.toBe(2);
  });

  it('tiles slots on the display matched by name without overlapping them', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    useDedicated(mod, browserKey('semrush'), { windowSlot: 'semrush', windowDisplay: '/虚拟|virtual/i' });
    useDedicated(mod, browserKey('similarweb'), { windowSlot: 'similarweb', windowDisplay: '/虚拟|virtual/i' });

    await mod.__test__.resolveTabId(undefined, browserKey('semrush'), 'https://www.semrush.com/');
    await mod.__test__.resolveTabId(undefined, browserKey('similarweb'), 'https://pro.similarweb.com/');

    expect(h.chrome.windows.create.mock.calls[0][0]).toMatchObject({ left: -2560, top: -1380, width: 1280, height: 900, focused: false });
    expect(h.chrome.windows.create.mock.calls[1][0]).toMatchObject({ left: -1280, top: -1380, width: 1280, height: 900, focused: false });
    expect(mod.__test__.getDedicatedSlot('semrush')?.placement).toMatchObject({ source: 'display', displayName: '虚拟 16:9', displayFound: true, cell: 0 });
    expect(mod.__test__.getDedicatedSlot('similarweb')?.placement).toMatchObject({ cell: 1 });
  });

  it('computes display cells and matches display names', async () => {
    vi.stubGlobal('chrome', dedicatedHarness().chrome);
    const mod = await import('./background');
    const display = { left: -2560, top: -1440, width: 2560, height: 1440 };
    expect(mod.__test__.computeDisplayCell(display, 0)).toEqual({ left: -2560, top: -1380, width: 1280, height: 900 });
    expect(mod.__test__.computeDisplayCell(display, 1)).toEqual({ left: -1280, top: -1380, width: 1280, height: 900 });
    expect(mod.__test__.computeDisplayCell(display, 2)).toEqual({ left: -2560, top: -1380, width: 1280, height: 900 });
    expect(mod.__test__.computeDisplayCell({ left: 0, top: 0, width: 1024, height: 768 }, 0)).toEqual({ left: 0, top: 0, width: 1024, height: 768 });
    expect(mod.__test__.compileDisplayMatcher('/虚拟|virtual/i')!.test('Virtual 16:9')).toBe(true);
    expect(mod.__test__.compileDisplayMatcher('VIRT')!.test('my virtual screen')).toBe(true);
    expect(mod.__test__.compileDisplayMatcher('a.b')!.test('axb')).toBe(false);
    const displays = [
      { id: '1', name: 'Virtual main', primary: true, internal: false, bounds: { left: 0, top: 0, width: 10, height: 10 }, workArea: null },
      { id: '2', name: 'Virtual side', primary: false, internal: false, bounds: { left: 10, top: 0, width: 10, height: 10 }, workArea: null },
    ];
    expect(mod.__test__.pickDisplay(displays, 'virtual')?.id).toBe('2');
    expect(mod.__test__.pickDisplay(displays, 'nope')).toBeNull();
    // Primary only when it is the sole display (physical screen asleep).
    expect(mod.__test__.pickDisplay([displays[0]], 'virtual')?.id).toBe('1');
    expect(mod.__test__.pickDisplay([displays[0], { ...displays[1], name: 'Studio Display' }], 'virtual')).toBeNull();
  });

  it('moves a lease tab that sits in the person\'s window into the dedicated window and selects it', async () => {
    const h = dedicatedHarness();
    h.tabs.push({ id: 40, windowId: 2, url: 'https://www.semrush.com/analytics', title: 'semrush', active: false, status: 'complete', groupId: -1 });
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    mod.__test__.setSession(key, { windowId: 2, owned: true, preferredTabId: 40 });
    useDedicated(mod, key, { windowSlot: 'semrush' });

    const tabId = await mod.__test__.resolveTabId(undefined, key);

    expect(tabId).toBe(40);
    const tab = h.tabs.find((t) => t.id === 40)!;
    expect(tab.windowId).toBe(50);
    expect(tab.active).toBe(true);
    expect(mod.__test__.getSession(key)?.windowId).toBe(50);
    // The window's own blank starter tab is litter once the lease tab is in.
    expect(h.chrome.tabs.remove).toHaveBeenCalledWith(500);
    expect(h.chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false }));
  });

  it('selects the session tab before each command unless autoSelect is off', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const a = browserKey('a');
    const b = browserKey('b');
    useDedicated(mod, a);
    useDedicated(mod, b, { autoSelect: false });
    const tabA = await mod.__test__.resolveTabId(undefined, a, 'https://a.example/');
    const tabB = await mod.__test__.resolveTabId(undefined, b, 'https://b.example/');
    // Two leases held at the same time are two tasks that both need to render, so the
    // pool gives them a window each (tiled, never stacked) instead of one shared window
    // where only the active tab would be visible.
    expect(h.tabs.find((t) => t.id === tabB)?.windowId).not.toBe(h.tabs.find((t) => t.id === tabA)?.windowId);
    // The second window is created for b directly on its URL, and unfocused like every
    // automation window — `tabs.create` only appears when a window already exists.
    expect(h.chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://b.example/', focused: false }));

    h.tabs.find((t) => t.id === tabA)!.active = false;
    h.chrome.tabs.update.mockClear();
    await mod.__test__.resolveTabId(undefined, a);
    expect(h.chrome.tabs.update).toHaveBeenCalledWith(tabA, { active: true });

    h.chrome.tabs.update.mockClear();
    await mod.__test__.resolveTabId(undefined, b);
    expect(h.chrome.tabs.update).not.toHaveBeenCalledWith(tabB, { active: true });
  });

  it('sends a foreign tab back to the person\'s last window without focusing it, and keeps automation children', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    useDedicated(mod, key, { windowSlot: 'semrush' });
    const leaseTab = await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');
    h.tabs.push({ id: 77, windowId: 50, url: 'https://news.example/', title: 'news', active: true, status: 'complete', groupId: -1 });
    h.tabs.push({ id: 78, windowId: 50, url: 'https://www.semrush.com/popup', title: 'child', active: false, status: 'complete', groupId: -1, openerTabId: leaseTab } as any);

    expect(await mod.__test__.checkDedicatedForeignTab(78)).toBe('ours');
    expect(await mod.__test__.checkDedicatedForeignTab(77)).toBe('evicted');

    expect(h.tabs.find((t) => t.id === 77)?.windowId).toBe(2);
    expect(h.chrome.tabs.update).toHaveBeenCalledWith(77, { active: true });
    for (const call of h.chrome.windows.update.mock.calls) expect(call[1]).not.toHaveProperty('focused');
    expect(h.tabs.find((t) => t.id === leaseTab)?.windowId).toBe(50);
    expect(mod.__test__.getDedicatedSlot('semrush')?.evictedTabs).toBe(1);
    // The dedicated window never becomes "borrowed" because of a foreign tab.
    expect(mod.__test__.getDedicatedSlot('semrush')?.windowId).toBe(50);
  });

  it('never evicts into a dedicated window even when it was the last focused one', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    useDedicated(mod, browserKey('a'), { windowSlot: 'a' });
    useDedicated(mod, browserKey('b'), { windowSlot: 'b' });
    await mod.__test__.resolveTabId(undefined, browserKey('a'), 'https://a.example/');
    await mod.__test__.resolveTabId(undefined, browserKey('b'), 'https://b.example/');
    h.setLastFocused(51);
    h.tabs.push({ id: 77, windowId: 50, url: 'https://news.example/', title: 'news', active: false, status: 'complete', groupId: -1 });
    expect(await mod.__test__.checkDedicatedForeignTab(77)).toBe('evicted');
    expect([1, 2]).toContain(h.tabs.find((t) => t.id === 77)?.windowId);
  });

  it('tolerates foreign tabs when asked, and never hands one to a new session', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('one');
    useDedicated(mod, key, { foreignTabPolicy: 'tolerate' });
    const first = await mod.__test__.resolveTabId(undefined, key, 'https://one.example/');
    h.tabs.push({ id: 77, windowId: 50, url: 'about:blank', title: 'blank', active: false, status: 'complete', groupId: -1 });
    expect(await mod.__test__.checkDedicatedForeignTab(77)).toBe('tolerated');
    expect(h.tabs.find((t) => t.id === 77)?.windowId).toBe(50);

    await mod.__test__.releaseLease(key, 'test');
    // The last lease leaves a placeholder instead of closing the window.
    expect(h.chrome.tabs.update).toHaveBeenCalledWith(first, { url: `about:blank#opencli-dedicated=${mod.__test__.getDedicatedSlot()?.slot}` });
    expect(h.chrome.tabs.remove).not.toHaveBeenCalledWith(first);
    expect(h.chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getDedicatedSlot()?.placeholderTabIds).toEqual([first]);

    const two = browserKey('two');
    useDedicated(mod, two);
    const second = await mod.__test__.resolveTabId(undefined, two, 'https://two.example/');
    expect(second).toBe(first);
    expect(second).not.toBe(77);
    expect(h.chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('lets a lease tab dragged out of the dedicated window become the person\'s', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    useDedicated(mod, key);
    const tabId = await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Wait out our own grouping moves so this reads as the person's drag.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    h.tabs.find((t) => t.id === tabId)!.windowId = 2;

    await mod.__test__.handleTabAttached(tabId, { newWindowId: 2 });

    expect(mod.__test__.getSession(key)).toBeNull();
    expect(h.chrome.tabs.remove).not.toHaveBeenCalledWith(tabId);
  }, 10_000);

  it('recreates a closed dedicated window on the next command with the same placement', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    useDedicated(mod, key, { windowSlot: 'semrush', windowDisplay: '虚拟' });
    await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');
    await h.closeWindow(50);
    expect(mod.__test__.getDedicatedSlot('semrush')?.windowId).toBeNull();
    expect(mod.__test__.getSession(key)).toBeNull();

    mod.__test__.sessionOverrides.set(key, { windowMode: 'dedicated', windowSlot: 'semrush' });
    const tabId = await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');
    expect(h.chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(h.chrome.windows.create.mock.calls[1][0]).toMatchObject({ left: -2560, top: -1380, focused: false });
    expect(h.tabs.find((t) => t.id === tabId)?.windowId).toBe(51);
  });

  it('keeps default-mode and isolated sessions out of the dedicated window', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    useDedicated(mod, browserKey('semrush'));
    await mod.__test__.resolveTabId(undefined, browserKey('semrush'), 'https://www.semrush.com/');
    // The person clicked the dedicated window once; it is now "last focused".
    h.setLastFocused(50);

    const bg = await mod.__test__.resolveTabId(undefined, browserKey('recon'), 'https://recon.example/');
    expect(h.tabs.find((t) => t.id === bg)?.windowId).not.toBe(50);

    mod.__test__.sessionOverrides.set(browserKey('iso'), { windowMode: 'isolated' });
    const iso = await mod.__test__.resolveTabId(undefined, browserKey('iso'), 'https://iso.example/');
    expect(h.tabs.find((t) => t.id === iso)?.windowId).not.toBe(50);
    expect(mod.__test__.getDedicatedSlot()?.windowId).toBe(50);
  });

  it('reports dedicated windows through sessions window-status and the session list', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    useDedicated(mod, key, { windowSlot: 'semrush', windowDisplay: '虚拟' });
    const tabId = await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');
    h.tabs.push({ id: 77, windowId: 50, url: 'https://secret.example/?token=1', title: 'secret', active: false, status: 'complete', groupId: -1 });

    const status = await mod.__test__.handleSessions({ id: 's', action: 'sessions', op: 'window-status' } as never);
    expect(status.ok).toBe(true);
    const data = status.data as any;
    expect(data).toMatchObject({ supported: true, protocol: 1 });
    expect(data.capabilities).toContain('dedicated-window');
    expect(data.displays).toHaveLength(2);
    expect(data.windows).toEqual([expect.objectContaining({
      slot: 'semrush', windowId: 50, exists: true, onDisplay: true,
      bounds: { left: -2560, top: -1380, width: 1280, height: 900 },
      activeTab: expect.objectContaining({ tabId, owner: 'lease', session: 'semrush' }),
      tabs: expect.objectContaining({ leases: 1, foreign: 1 }),
      sessions: ['semrush'], foreignTabPolicy: 'evict', autoSelect: true,
    })]);
    expect(JSON.stringify(data)).not.toContain('secret');

    const listed = await mod.__test__.handleSessions({ id: 'l', action: 'sessions', op: 'list' } as never);
    expect(listed.data).toEqual([expect.objectContaining({ session: 'semrush', dedicatedSlot: 'semrush', tabActive: true, windowId: 50 })]);
  });

  it('window-ensure creates or moves the window back onto its display without focusing', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const ensure = (fields: Record<string, unknown>) => mod.__test__.handleSessions({ id: 'e', action: 'sessions', op: 'window-ensure', ...fields } as never);

    const created = (await ensure({ windowSlot: 'semrush', windowDisplay: '虚拟' })).data as any;
    expect(created).toMatchObject({ slot: 'semrush', created: true, moved: false, onDisplay: true });

    // Dragged back to the main screen by hand.
    Object.assign(h.windows.get(50)!, { left: 100, top: 100 });
    const moved = (await ensure({ windowSlot: 'semrush' })).data as any;
    expect(moved).toMatchObject({ created: false, moved: true, onDisplay: true });
    expect(h.chrome.windows.update).toHaveBeenCalledWith(50, { left: -2560, top: -1380, width: 1280, height: 900 });

    // Nudged within the display: left alone.
    Object.assign(h.windows.get(50)!, { left: -2400, top: -1300 });
    h.chrome.windows.update.mockClear();
    expect(((await ensure({ windowSlot: 'semrush' })).data as any).moved).toBe(false);
    expect(h.chrome.windows.update).not.toHaveBeenCalled();

    const missing = (await ensure({ windowSlot: 'other', windowDisplay: 'no-such-display' })).data as any;
    expect(missing).toMatchObject({ created: true, placement: expect.objectContaining({ displayFound: false }), onDisplay: false });
    expect(h.chrome.windows.create.mock.calls[1][0]).not.toHaveProperty('left');
    expect(h.chrome.windows.create.mock.calls[1][0]).toMatchObject({ focused: false });
  });

  it('reports displays as unavailable when chrome.system.display is missing', async () => {
    const h = dedicatedHarness({ withDisplayApi: false });
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const status = (await mod.__test__.handleSessions({ id: 's', action: 'sessions', op: 'window-status' } as never)).data as any;
    expect(status.displays).toBeNull();
    expect(status.displaysError).toMatch(/system\.display/);
  });

  it('restores the dedicated slot after a service-worker restart', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('semrush');
    useDedicated(mod, key, { windowSlot: 'semrush', windowBounds: { left: -2480, top: -1380, width: 1280, height: 900 } });
    const tabId = await mod.__test__.resolveTabId(undefined, key, 'https://www.semrush.com/');
    await new Promise((resolve) => setTimeout(resolve, 0));

    vi.resetModules();
    const restarted = await import('./background');
    await restarted.__test__.reconcileTargetLeaseRegistry();
    expect(restarted.__test__.getDedicatedSlot('semrush')).toMatchObject({ windowId: 50, placement: { source: 'bounds' } });
    expect(restarted.__test__.getSession(key)).toMatchObject({ preferredTabId: tabId, windowId: 50 });
    // The restored lease is not re-adopted into a role container.
    expect(restarted.__test__.getContainer('interactive').windowId).not.toBe(50);
  });

  it('keeps the four existing window modes unaware of dedicated state', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    // The four pre-dedicated modes still behave exactly as they did — asked for by
    // name, since `dedicated` is now what a session gets when nobody names a mode.
    mod.__test__.setDefaultWindowMode('background');
    const tabId = await mod.__test__.resolveTabId(undefined, browserKey('plain'), 'https://plain.example/');
    expect(h.tabs.find((t) => t.id === tabId)?.windowId).toBe(2);
    expect(mod.__test__.getDedicatedSlot()).toBeNull();
    expect(h.chrome.system.display.getInfo).not.toHaveBeenCalled();
  });
});

describe('dedicated automation window — review regressions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });
  const useDedicated = (mod: any, key: string, fields: Record<string, unknown> = {}) => {
    mod.__test__.sessionOverrides.set(key, { windowMode: 'dedicated' });
    mod.__test__.applyDedicatedCommandFields(key, { id: 'x', action: 'exec', windowMode: 'dedicated', ...fields });
  };
  // tabs.remove that behaves like Chrome: the tab goes away, an emptied window closes.
  const realRemove = (h: any) => {
    h.chrome.tabs.remove = vi.fn(async (tabId: number) => {
      const i = h.tabs.findIndex((t: any) => t.id === tabId);
      if (i < 0) throw new Error(`No tab with id: ${tabId}`);
      const [tab] = h.tabs.splice(i, 1);
      for (const c of h.chrome.tabs.onRemoved.addListener.mock.calls) await c[0](tabId);
      if (!h.tabs.some((t: any) => t.windowId === tab.windowId)) await h.closeWindow(tab.windowId);
    });
  };

  it('treats a tab opened by an automation child as automation too (opener chain)', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    const key = browserKey('s');
    useDedicated(mod, key);
    const lease = await mod.__test__.resolveTabId(undefined, key, 'https://app.example/');
    h.tabs.push({ id: 78, windowId: 50, url: 'https://app.example/child', active: false, status: 'complete', groupId: -1, openerTabId: lease } as any);
    h.tabs.push({ id: 79, windowId: 50, url: 'https://sso.example/login', active: false, status: 'complete', groupId: -1, openerTabId: 78 } as any);
    expect(await mod.__test__.checkDedicatedForeignTab(78)).toBe('ours');
    expect(await mod.__test__.checkDedicatedForeignTab(79)).toBe('ours');
    expect(h.tabs.find((t) => t.id === 79)?.windowId).toBe(50);
  });

  it('keeps the window when two leases of one slot are released at the same time', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    const a = browserKey('a'); const b = browserKey('b');
    useDedicated(mod, a); useDedicated(mod, b);
    await mod.__test__.resolveTabId(undefined, a, 'https://a.example/');
    await mod.__test__.resolveTabId(undefined, b, 'https://b.example/');
    realRemove(h);
    await Promise.all([mod.__test__.releaseLease(a, 'idle timeout'), mod.__test__.releaseLease(b, 'idle timeout')]);
    expect(h.windows.has(50)).toBe(true);
    expect(h.tabs.filter((t) => t.windowId === 50)).toHaveLength(1);
    expect(mod.__test__.getDedicatedSlot()?.placeholderTabIds).toHaveLength(1);
  });

  it('never hands out a placeholder the person has navigated to their own page', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    const one = browserKey('one');
    useDedicated(mod, one);
    const first = await mod.__test__.resolveTabId(undefined, one, 'https://one.example/');
    await mod.__test__.releaseLease(one, 'test');
    h.tabs.find((t) => t.id === first)!.url = 'https://mail.example/inbox/draft';
    const two = browserKey('two');
    useDedicated(mod, two);
    const second = await mod.__test__.resolveTabId(undefined, two, 'https://two.example/');
    expect(second).not.toBe(first);
    expect(h.tabs.find((t) => t.id === first)?.url).toBe('https://mail.example/inbox/draft');
  });

  it('keeps the lease when moving its tab empties (and closes) the source window', async () => {
    const h = dedicatedHarness();
    for (let i = h.tabs.length - 1; i >= 0; i -= 1) if (h.tabs[i].windowId === 1) h.tabs.splice(i, 1);
    h.tabs.push({ id: 40, windowId: 1, url: 'https://app.example/x', active: true, status: 'complete', groupId: -1 });
    const origMove = h.chrome.tabs.move;
    h.chrome.tabs.move = vi.fn(async (tabId: number, props: any) => {
      const from = h.tabs.find((t) => t.id === tabId)!.windowId;
      const res = await origMove(tabId, props);
      if (!h.tabs.some((t) => t.windowId === from)) {
        h.windows.delete(from);
        Promise.resolve().then(() => { for (const c of h.chrome.windows.onRemoved.addListener.mock.calls) void c[0](from); });
      }
      return res;
    });
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    const key = browserKey('s');
    mod.__test__.setSession(key, { windowId: 1, owned: true, preferredTabId: 40 });
    useDedicated(mod, key);
    await mod.__test__.resolveTabId(undefined, key);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mod.__test__.getSession(key)).toMatchObject({ preferredTabId: 40, windowId: 50 });
  });

  it('gives concurrently ensured slots on one display different tiles', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    const ensure = (slot: string) => mod.__test__.handleSessions({ id: slot, action: 'sessions', op: 'window-ensure', windowSlot: slot, windowDisplay: '虚拟' });
    await Promise.all([ensure('semrush'), ensure('similarweb')]);
    const rects = h.chrome.windows.create.mock.calls.map((x: any) => [x[0].left, x[0].top]);
    expect(rects[0]).not.toEqual(rects[1]);
  });

  it('replaces earlier bounds when a later command asks for a display', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    const key = browserKey('s');
    useDedicated(mod, key, { windowBounds: { left: 10, top: 10, width: 800, height: 600 } });
    mod.__test__.applyDedicatedCommandFields(key, { id: 'y', action: 'exec', windowMode: 'dedicated', windowDisplay: '虚拟' });
    await mod.__test__.resolveTabId(undefined, key, 'https://a.example/');
    expect(h.chrome.windows.create.mock.calls[0][0]).toMatchObject({ left: -2560, top: -1380 });
  });

  it('forgets a placeholder of slot A once it is dragged into slot B\'s window', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    await mod.__test__.handleSessions({ id: 'e', action: 'sessions', op: 'window-ensure', windowSlot: 'A' });
    await mod.__test__.handleSessions({ id: 'e', action: 'sessions', op: 'window-ensure', windowSlot: 'B' });
    const pA = mod.__test__.getDedicatedSlot('A').placeholderTabIds[0];
    h.tabs.find((t) => t.id === pA)!.windowId = 51;
    mod.__test__.setForeignTabSettleMs(0);
    await mod.__test__.handleTabAttached(pA, { newWindowId: 51 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mod.__test__.getDedicatedSlot('A').placeholderTabIds).not.toContain(pA);
    expect([1, 2]).toContain(h.tabs.find((t) => t.id === pA)?.windowId);
  });

  it('adopts its marked window after an extension reload wiped session storage', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    await mod.__test__.handleSessions({ id: 'e', action: 'sessions', op: 'window-ensure', windowSlot: 'semrush' });
    expect(h.tabs.find((t) => t.windowId === 50)?.url).toBe('about:blank#opencli-dedicated=semrush');
    for (const key of Object.keys((await h.chrome.storage.session.get(null as any)) ?? {})) void key;
    vi.resetModules();
    // Reload: storage.session is cleared.
    h.chrome.storage.session.get = vi.fn(async (key: string) => ({ [key]: undefined }));
    h.chrome.tabs.query = vi.fn(async (q: any = {}) => h.tabs.filter((t) => q.windowId === undefined || t.windowId === q.windowId));
    const reloaded: any = await import('./background');
    await reloaded.__test__.reconcileTargetLeaseRegistry();
    const res = (await reloaded.__test__.handleSessions({ id: 'e2', action: 'sessions', op: 'window-ensure', windowSlot: 'semrush' })).data;
    expect(res).toMatchObject({ windowId: 50, created: false });
    expect(h.chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('does not move a fullscreen or minimized dedicated window', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod: any = await import('./background');
    await mod.__test__.handleSessions({ id: 'e', action: 'sessions', op: 'window-ensure', windowSlot: 's', windowDisplay: '虚拟' });
    Object.assign(h.windows.get(50)!, { left: 0, top: 0, state: 'fullscreen' });
    const res = (await mod.__test__.handleSessions({ id: 'e', action: 'sessions', op: 'window-ensure', windowSlot: 's' })).data;
    expect(res).toMatchObject({ moved: false, state: 'fullscreen', onDisplay: false });
    expect(h.chrome.windows.update).not.toHaveBeenCalled();
  });
});

// ─── Window pool, dynamic layout, idle reaping (2026-09-14) ──────────────
describe('dedicated automation window — pool and layout', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  const useDedicated = (mod: any, key: string, fields: Record<string, unknown> = {}) => {
    mod.__test__.sessionOverrides.set(key, { windowMode: 'dedicated' });
    mod.__test__.applyDedicatedCommandFields(key, { id: 'x', action: 'exec', windowMode: 'dedicated', ...fields });
  };
  const overlaps = (a: any, b: any) => a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;

  it('grid/tile/capacity: tiles never overlap, never shrink past the minimum, and capacity is honest', async () => {
    vi.stubGlobal('chrome', dedicatedHarness().chrome);
    const mod = await import('./background');
    const area = { left: -2560, top: -1440, width: 2560, height: 1440 };
    expect(mod.__test__.dedicatedGrid(area, 1)).toMatchObject({ cols: 1, rows: 1, width: 1280, height: 900 });
    const capacity = mod.__test__.dedicatedCapacity(area);
    expect(capacity).toBeGreaterThanOrEqual(2);
    expect(mod.__test__.dedicatedGrid(area, capacity + 1)).toBeNull();
    for (let n = 1; n <= capacity; n += 1) {
      const rects = Array.from({ length: n }, (_, i) => mod.__test__.dedicatedTile(area, i, n));
      expect(rects.every((r: any) => r !== null)).toBe(true);
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) expect(overlaps(rects[i], rects[j])).toBe(false);
        expect(rects[i].left).toBeGreaterThanOrEqual(area.left);
        expect(rects[i].top).toBeGreaterThanOrEqual(area.top);
        expect(rects[i].left + rects[i].width).toBeLessThanOrEqual(area.left + area.width);
        expect(rects[i].top + rects[i].height).toBeLessThanOrEqual(area.top + area.height);
      }
    }
  });

  it('picks a secondary, non-internal display for automation and never the built-in one', async () => {
    vi.stubGlobal('chrome', dedicatedHarness().chrome);
    const mod = await import('./background');
    const internal = { id: '1', name: '', primary: true, internal: true, bounds: { left: 0, top: 0, width: 1512, height: 982 }, workArea: null };
    const virt = { id: '8', name: '', primary: false, internal: false, bounds: { left: -2560, top: -1440, width: 2560, height: 1440 }, workArea: null };
    expect(mod.__test__.pickAutomationDisplay([internal, virt])?.id).toBe('8');
    // Lid closed: the virtual screen is the only one left and inherits `primary`.
    expect(mod.__test__.pickAutomationDisplay([{ ...virt, primary: true }])?.id).toBe('8');
    expect(mod.__test__.pickAutomationDisplay([])).toBeNull();
  });

  it('ten one-shot sessions in a row reuse one window instead of opening ten', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const windowIds = new Set<number>();
    for (let i = 0; i < 10; i += 1) {
      const key = browserKey(`one-shot-${i}`);
      useDedicated(mod, key);
      const tabId = await mod.__test__.resolveTabId(undefined, key, `https://run-${i}.example/`);
      windowIds.add(h.tabs.find((t: any) => t.id === tabId)!.windowId);
      await mod.__test__.releaseLease(key, 'test');
    }
    expect(windowIds.size).toBe(1);
    expect(h.chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(mod.__test__.dedicatedSlotNames()).toHaveLength(1);
    // The one window it kept is idle and named by the pool, not by any session.
    const slot = mod.__test__.getDedicatedSlot();
    expect(slot.pooled).toBe(true);
    expect(slot.slot).toMatch(/^pool-\d+$/);
    expect(slot.holders).toEqual([]);
  });

  it('concurrent sessions each get their own window, tiled without overlap on the automation display', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const keys = ['a', 'b', 'c'].map((n) => browserKey(`conc-${n}`));
    const tabIds: number[] = [];
    for (const key of keys) {
      useDedicated(mod, key);
      tabIds.push(await mod.__test__.resolveTabId(undefined, key, `https://${key}.example/`));
    }
    const windowIds = tabIds.map((id) => h.tabs.find((t: any) => t.id === id)!.windowId);
    expect(new Set(windowIds).size).toBe(3);
    const rects = windowIds.map((id) => h.windows.get(id)!);
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) expect(overlaps(rects[i], rects[j])).toBe(false);
      // On the virtual display (negative origin), never on the person's screen.
      expect(rects[i].left).toBeLessThan(0);
      expect(rects[i].focused).toBe(false);
    }
    // Freeing one hands its window back to the pool for the next caller.
    await mod.__test__.releaseLease(keys[0], 'test');
    const next = browserKey('conc-d');
    useDedicated(mod, next);
    const reused = await mod.__test__.resolveTabId(undefined, next, 'https://d.example/');
    expect(h.tabs.find((t: any) => t.id === reused)!.windowId).toBe(windowIds[0]);
    expect(h.chrome.windows.create).toHaveBeenCalledTimes(3);
  });

  it('refuses to overlap when the display is full and says so instead of stacking silently', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const capacity = mod.__test__.dedicatedCapacity({ left: -2560, top: -1440, width: 2560, height: 1440 });
    for (let i = 0; i < capacity; i += 1) {
      const key = browserKey(`full-${i}`);
      useDedicated(mod, key);
      await mod.__test__.resolveTabId(undefined, key, `https://full-${i}.example/`);
    }
    const overflow = browserKey('overflow');
    useDedicated(mod, overflow);
    await expect(mod.__test__.resolveTabId(undefined, overflow, 'https://overflow.example/'))
      .rejects.toThrow(/dedicated-pool-exhausted/);
    expect(h.chrome.windows.create).toHaveBeenCalledTimes(capacity);
    // The failed command holds nothing: its would-be slot is idle, so it is reusable
    // and reapable instead of pinning a window nobody owns.
    const stranded = mod.__test__.dedicatedSlotNames().filter((n: string) => !mod.__test__.getDedicatedSlot(n).windowId);
    for (const name of stranded) expect(mod.__test__.getDedicatedSlot(name).holders).toEqual([]);
  });

  it('closes an idle window once its TTL passes, and never one that is still held', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    h.chrome.windows.remove = vi.fn(async (id: number) => { await h.closeWindow(id); });
    const held = browserKey('held');
    const done = browserKey('done');
    useDedicated(mod, held);
    useDedicated(mod, done);
    const heldTab = await mod.__test__.resolveTabId(undefined, held, 'https://held.example/');
    await mod.__test__.resolveTabId(undefined, done, 'https://done.example/');
    await mod.__test__.releaseLease(done, 'test');

    mod.__test__.setDedicatedIdleTtlMs(60_000);
    expect(await mod.__test__.reapIdleDedicatedWindows()).toBe(0); // too young
    mod.__test__.setDedicatedIdleTtlMs(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await mod.__test__.reapIdleDedicatedWindows()).toBe(1);
    // The held session's window is untouched, and its slot is still there.
    expect(h.tabs.find((t: any) => t.id === heldTab)).toBeTruthy();
    expect(mod.__test__.dedicatedSlotNames()).toHaveLength(1);
  });

  it('window-close closes a window on request, and refuses a busy one unless forced', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    h.chrome.windows.remove = vi.fn(async (id: number) => { await h.closeWindow(id); });
    const key = browserKey('busy');
    useDedicated(mod, key);
    await mod.__test__.resolveTabId(undefined, key, 'https://busy.example/');
    const slot = mod.__test__.getDedicatedSlot().slot;

    const refused = await mod.__test__.handleDedicatedWindowOp({ id: '1', action: 'sessions', op: 'window-close', windowSlot: slot });
    expect(refused.data.closed).toEqual([]);
    expect(refused.data.skipped[0]).toMatchObject({ slot });
    expect(h.chrome.windows.remove).not.toHaveBeenCalled();

    const forced = await mod.__test__.handleDedicatedWindowOp({ id: '2', action: 'sessions', op: 'window-close', windowSlot: slot, force: true });
    expect(forced.data.closed).toEqual([slot]);
    expect(h.chrome.windows.remove).toHaveBeenCalled();
    expect(mod.__test__.dedicatedSlotNames()).toEqual([]);
  });

  it('window-status reports pool capacity, how many windows are live and how many are free', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    const key = browserKey('pool-status');
    useDedicated(mod, key);
    await mod.__test__.resolveTabId(undefined, key, 'https://status.example/');
    const res = await mod.__test__.handleDedicatedWindowOp({ id: '1', action: 'sessions', op: 'window-list' });
    expect(res.data.capabilities).toEqual(expect.arrayContaining(['window-pool', 'window-close', 'window-list', 'idle-reap', 'auto-display', 'dynamic-layout']));
    expect(res.data.pool).toMatchObject({ live: 1, idle: 0 });
    expect(res.data.pool.capacity).toBeGreaterThanOrEqual(2);
    expect(res.data.pool.automationDisplay.primary).toBe(false);
    expect(res.data.windows[0]).toMatchObject({ pooled: true, busy: true, holders: 1 });
  });
});

describe('dedicated automation window — holder bookkeeping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  const useDedicated = (mod: any, key: string, fields: Record<string, unknown> = {}) => {
    mod.__test__.sessionOverrides.set(key, { windowMode: 'dedicated' });
    mod.__test__.applyDedicatedCommandFields(key, { id: 'x', action: 'exec', windowMode: 'dedicated', ...fields });
  };

  it('a command that never takes a lease does not claim a window', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    // Policy-only traffic: `close` on a session with nothing open, repeated.
    for (let i = 0; i < 5; i += 1) useDedicated(mod, browserKey(`policy-${i}`));
    for (const name of mod.__test__.dedicatedSlotNames()) {
      expect(mod.__test__.getDedicatedSlot(name).holders).toEqual([]);
    }
    expect(h.chrome.windows.create).not.toHaveBeenCalled();
  });

  it('reaping reconciles holders whose lease is already gone', async () => {
    const h = dedicatedHarness();
    vi.stubGlobal('chrome', h.chrome);
    const mod = await import('./background');
    h.chrome.windows.remove = vi.fn(async (id: number) => { await h.closeWindow(id); });
    const key = browserKey('ghost');
    useDedicated(mod, key);
    await mod.__test__.resolveTabId(undefined, key, 'https://ghost.example/');
    const slot = mod.__test__.getDedicatedSlot().slot;
    expect(mod.__test__.getDedicatedSlot(slot).holders).toEqual([key]);
    // Drop the lease the way a crashed/forgotten command would: registry entry gone,
    // no release path ever ran.
    mod.__test__.forgetSession(key);
    mod.__test__.setDedicatedIdleTtlMs(1);
    // First pass notices the dead holder and starts the idle clock; the window is
    // closed on the next pass, like any other idle window.
    expect(await mod.__test__.reapIdleDedicatedWindows()).toBe(0);
    expect(mod.__test__.getDedicatedSlot(slot).holders).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(await mod.__test__.reapIdleDedicatedWindows()).toBe(1);
    expect(mod.__test__.dedicatedSlotNames()).toEqual([]);
  });
});
