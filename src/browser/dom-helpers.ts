/**
 * Shared DOM operation JS generators.
 *
 * Used by both Page (daemon mode) and CDPPage (direct CDP mode)
 * to eliminate code duplication for click, type, press, wait, scroll, etc.
 */

/** Generate JS to press a keyboard key */
export function pressKeyJs(key: string, modifiers: string[] = []): string {
  const hasCtrl = modifiers.includes('Ctrl') || modifiers.includes('Control');
  const hasAlt = modifiers.includes('Alt');
  const hasMeta = modifiers.includes('Meta');
  const hasShift = modifiers.includes('Shift');
  return `
    (() => {
      const el = document.activeElement || document.body;
      const init = {
        key: ${JSON.stringify(key)},
        bubbles: true,
        ctrlKey: ${hasCtrl},
        altKey: ${hasAlt},
        metaKey: ${hasMeta},
        shiftKey: ${hasShift},
      };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return 'pressed';
    })()
  `;
}

/** Generate JS to wait for text to appear in the page */
export function waitForTextJs(text: string, timeoutMs: number): string {
  return `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      const check = () => {
        if (document.body.innerText.includes(${JSON.stringify(text)})) return resolve('found');
        if (Date.now() > deadline) return reject(new Error('Text not found: ' + ${JSON.stringify(text)}));
        setTimeout(check, 200);
      };
      check();
    })
  `;
}

/** Generate JS for scroll */
export function scrollJs(direction: string, amount: number): string {
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  return `window.scrollBy(${dx}, ${dy})`;
}

/** Generate JS for auto-scroll with lazy-load detection */
export function autoScrollJs(times: number, delayMs: number): string {
  return `
    (async () => {
      if (!document.body) return;
      for (let i = 0; i < ${times}; i++) {
        const lastHeight = document.body.scrollHeight;
        window.scrollTo(0, lastHeight);
        await new Promise(resolve => {
          let timeoutId;
          const observer = new MutationObserver(() => {
            if (document.body.scrollHeight > lastHeight) {
              clearTimeout(timeoutId);
              observer.disconnect();
              setTimeout(resolve, 100);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          timeoutId = setTimeout(() => { observer.disconnect(); resolve(null); }, ${delayMs});
        });
      }
    })()
  `;
}

/** Generate JS to read performance resource entries as network requests */
export function networkRequestsJs(includeStatic: boolean): string {
  return `
    (() => {
      const entries = performance.getEntriesByType('resource');
      return entries
        ${includeStatic ? '' : '.filter(e => !["img", "font", "css", "script"].some(t => e.initiatorType === t))'}
        .map(e => ({
          url: e.name,
          type: e.initiatorType,
          duration: Math.round(e.duration),
          size: e.transferSize || 0,
        }));
    })()
  `;
}

/**
 * Generate JS to wait until the DOM stabilizes (no mutations for `quietMs`),
 * with a hard cap at `maxMs`. Uses MutationObserver in the browser.
 *
 * Returns as soon as the page stops changing, avoiding unnecessary fixed waits.
 * If document.body is not available, falls back to a fixed sleep of maxMs.
 */
export function waitForDomStableJs(maxMs: number, quietMs: number): string {
  return `
    new Promise(resolve => {
      if (!document.body) {
        setTimeout(() => resolve('nobody'), ${maxMs});
        return;
      }
      let timer = null;
      let cap = null;
      const done = (reason) => {
        clearTimeout(timer);
        clearTimeout(cap);
        obs.disconnect();
        resolve(reason);
      };
      const resetQuiet = () => {
        clearTimeout(timer);
        timer = setTimeout(() => done('quiet'), ${quietMs});
      };
      const obs = new MutationObserver(resetQuiet);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
      resetQuiet();
      cap = setTimeout(() => done('capped'), ${maxMs});
    })
  `;
}

/**
 * Generate JS to wait until window.__opencli_xhr has ≥1 captured response.
 * Polls every 100ms. Resolves 'captured' on success; rejects after maxMs.
 * Used after installInterceptor() + goto() instead of a fixed sleep.
 */
export function waitForCaptureJs(maxMs: number): string {
  return `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${maxMs};
      const check = () => {
        if ((window.__opencli_xhr || []).length > 0) return resolve('captured');
        if (Date.now() > deadline) return reject(new Error('No network capture within ${maxMs / 1000}s'));
        setTimeout(check, 100);
      };
      check();
    })
  `;
}

/**
 * Generate JS to wait until document.querySelector(selector) returns a match.
 * Uses MutationObserver for near-instant resolution; falls back to reject after timeoutMs.
 */
export function waitForSelectorJs(selector: string, timeoutMs: number): string {
  return `
    new Promise((resolve, reject) => {
      const sel = ${JSON.stringify(selector)};
      if (document.querySelector(sel)) return resolve('found');
      const cap = setTimeout(() => {
        obs.disconnect();
        reject(new Error('Selector not found: ' + sel));
      }, ${timeoutMs});
      const obs = new MutationObserver(() => {
        if (document.querySelector(sel)) {
          clearTimeout(cap);
          obs.disconnect();
          resolve('found');
        }
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    })
  `;
}

/**
 * Window key holding the trusted-click liveness probe state. One probe lives
 * per document at a time: installing a new probe removes the previous
 * listener, so a long click loop never accumulates listeners.
 */
const CLICK_PROBE_KEY = '__opencliTrustedClickProbe';

/**
 * Generate JS to arm a trusted-click liveness probe ahead of a CDP
 * `Input.dispatchMouseEvent` click.
 *
 * Why this exists: a trusted CDP click can resolve without any effect when the
 * browser drops the input before it reaches the renderer — observed on real
 * Chrome with windows placed off the visible display (the `dedicated` window
 * mode's deliberate placement), where `Input.dispatchMouseEvent` reports
 * success while the page never sees mousedown/click at all. In-page
 * `el.click()` bypasses the input pipeline and still works there.
 *
 * The probe is a window-level capture listener that records ONLY
 * `isTrusted === true` mouse events (a page re-dispatching its own synthetic
 * clicks cannot satisfy it — isTrusted is read-only and false for those). It
 * records mousedown as well as click: some frameworks act on mousedown and
 * preventDefault the click, and that still proves the input pipeline
 * delivered our event.
 *
 * Returns the probe token ("" on failure); callers treat a non-token result
 * as "probe unavailable" and keep the legacy trust-the-CDP-result behaviour.
 */
export function clickProbeInstallJs(): string {
  return `
    (() => {
      const KEY = ${JSON.stringify(CLICK_PROBE_KEY)};
      const w = window;
      const prev = w[KEY];
      if (prev && prev.handler) {
        try {
          w.removeEventListener('mousedown', prev.handler, true);
          w.removeEventListener('click', prev.handler, true);
        } catch (e) {}
      }
      const token = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const state = { token: token, observed: false, tag: '' };
      const handler = (e) => {
        const st = w[KEY];
        if (!st || st.token !== token || st.observed) return;
        if (!e || e.isTrusted !== true) return;
        st.observed = true;
        try { st.tag = (e.target && e.target.tagName) || ''; } catch (err) {}
      };
      state.handler = handler;
      w[KEY] = state;
      w.addEventListener('mousedown', handler, true);
      w.addEventListener('click', handler, true);
      return token;
    })()
  `;
}

/**
 * Generate JS to read the probe armed by clickProbeInstallJs() and detach it.
 *
 * Runs after the CDP click returned. Polls in-page (25ms ticks, bounded by
 * settleMs) so a trusted event that lands a beat after the dispatch response
 * still counts; exits early once the probe has fired. Detaches the listeners
 * on every outcome so the page is left clean.
 *
 * Statuses:
 *   'observed' — a trusted mousedown/click reached this document: the input
 *                pipeline works, the CDP click result is trustworthy.
 *   'dropped'  — the probe never fired within the settle window: the trusted
 *                input was dropped before reaching the page. Callers fall
 *                back to the JS el.click() path, which cannot be dropped.
 *   'missing'  — no probe with the expected token exists (e.g. the page
 *                navigated between install and check — itself proof that
 *                something happened). Callers keep the CDP result.
 */
export function clickProbeCheckJs(token: string, settleMs: number): string {
  return `
    (async () => {
      const KEY = ${JSON.stringify(CLICK_PROBE_KEY)};
      const w = window;
      const st = w[KEY];
      if (!st || st.token !== ${JSON.stringify(token)}) {
        if (st && st.handler) {
          try {
            w.removeEventListener('mousedown', st.handler, true);
            w.removeEventListener('click', st.handler, true);
          } catch (e) {}
          delete w[KEY];
        }
        return { status: 'missing' };
      }
      const deadline = Date.now() + ${Math.max(0, Math.round(settleMs))};
      while (!st.observed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      try {
        w.removeEventListener('mousedown', st.handler, true);
        w.removeEventListener('click', st.handler, true);
      } catch (e) {}
      delete w[KEY];
      if (!st.observed) return { status: 'dropped' };
      return { status: 'observed', tag: st.tag };
    })()
  `;
}
