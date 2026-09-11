/**
 * Semrush Domain Overview — UI_SELECTOR strategy.
 *
 * Strategy note (see references/adapters.md):
 *   Strategy: UI_SELECTOR
 *   Contract: visible-ui
 *   Evidence:
 *     - observed state: the summary card at /analytics/overview/?q=<domain>&searchType=domain
 *       renders the core metrics as plain DOM text tagged with a `data-at` attribute
 *       per metric (do-summary-as / do-summary-ot / do-summary-pt / do-summary-ref_domains /
 *       do-summary-ok / do-summary-pk / do-summary-bl). These `data-at` values are
 *       semantic (author-facing) anchors, not obfuscated class hashes, so they read as a
 *       deliberate, stable contract rather than incidental styling hooks.
 *     - auth source: browser cookie (Chrome must already be logged in to semrush.com)
 *     - replay result: verified live on zh.semrush.com (account locale is Chinese) —
 *       metric VALUES render as Latin-script "K/M" abbreviations regardless of UI
 *       locale, so the parser does not depend on the account's display language.
 *   CDP-based network capture (`page.startNetworkCapture` / `browser network`) was
 *   tried first and found broken in this environment (chrome.debugger attach yields
 *   zero captured requests even on unrelated sites such as bilibili.com — a bridge
 *   issue, not specific to Semrush), and the page-JS fetch/XHR interceptor
 *   (`installInterceptor`) cannot see requests fired during the initial hard
 *   navigation (the patch is only injected after the page has already loaded).
 *   The rendered DOM is stable and semantically anchored, so UI_SELECTOR is used
 *   instead of forcing an unstable INTERCEPT/PAGE_FETCH path.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseCompactNumber, parsePercent } from './utils.js';

function normalizeDomain(input) {
    return String(input || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '');
}

cli({
    site: 'semrush',
    name: 'analytics-overview',
    access: 'read',
    description: 'Semrush Domain Overview：organic/paid traffic、keywords、Authority Score、referring domains、backlinks',
    domain: 'www.semrush.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'domain', positional: true, required: true, help: 'Root domain to analyze (e.g. example.com)' },
    ],
    columns: [
        'domain', 'authority_score', 'authority_rating',
        'organic_traffic', 'organic_traffic_change_pct',
        'paid_traffic', 'paid_traffic_change_pct',
        'referring_domains', 'organic_keywords', 'organic_keywords_change_pct',
        'paid_keywords', 'paid_keywords_change_pct', 'backlinks',
    ],
    func: async (page, args) => {
        const domain = normalizeDomain(args.domain);
        if (!domain) {
            throw new ArgumentError('Invalid domain', 'Pass a bare domain like example.com');
        }
        await page.goto(`https://www.semrush.com/analytics/overview/?q=${encodeURIComponent(domain)}&searchType=domain`);
        await page.wait(6);

        const currentUrl = await page.evaluate('window.location.href');
        if (typeof currentUrl === 'string' && /\/(login|sso)\b/i.test(currentUrl)) {
            throw new AuthRequiredError('semrush.com', 'Semrush session expired or not logged in');
        }

        const data = await page.evaluate(`
      (() => {
        function textsOf(sel) {
          const el = document.querySelector('[data-at="' + sel + '"]');
          if (!el) return null;
          const out = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const t = n.textContent.trim();
            if (t) out.push(t);
          }
          return out;
        }
        return {
          as: textsOf('do-summary-as'),
          ot: textsOf('do-summary-ot'),
          pt: textsOf('do-summary-pt'),
          ref: textsOf('do-summary-ref_domains'),
          ok: textsOf('do-summary-ok'),
          pk: textsOf('do-summary-pk'),
          bl: textsOf('do-summary-bl'),
        };
      })()
    `);

        if (!data || !Array.isArray(data.as) || data.as.length === 0) {
            throw new EmptyResultError('semrush analytics-overview', 'Domain Overview summary card did not render; check the domain, or Semrush account quota/plan');
        }

        // Each `textsOf(...)` returns [label, value, change?] in DOM order.
        const [, asValue, asRating] = data.as;
        const [, otValue, otChange] = data.ot || [];
        const [, ptValue, ptChange] = data.pt || [];
        const [, refValue] = data.ref || [];
        const [, okValue, okChange] = data.ok || [];
        const [, pkValue, pkChange] = data.pk || [];
        const [, blValue] = data.bl || [];

        return [{
            domain,
            authority_score: parseCompactNumber(asValue),
            authority_rating: asRating || '',
            organic_traffic: parseCompactNumber(otValue),
            organic_traffic_change_pct: parsePercent(otChange),
            paid_traffic: parseCompactNumber(ptValue),
            paid_traffic_change_pct: parsePercent(ptChange),
            referring_domains: parseCompactNumber(refValue),
            organic_keywords: parseCompactNumber(okValue),
            organic_keywords_change_pct: parsePercent(okChange),
            paid_keywords: parseCompactNumber(pkValue),
            paid_keywords_change_pct: parsePercent(pkChange),
            backlinks: parseCompactNumber(blValue),
        }];
    },
});
