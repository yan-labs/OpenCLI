/**
 * Semrush Keyword Magic Tool — UI strategy.
 *
 * Strategy note (see references/adapters.md):
 *   Strategy: UI
 *   Contract: visible-ui
 *   Evidence:
 *     - observed state: /analytics/keywordmagic/?q=<seed>&db=<country> renders a
 *       results table with `data-testid="table-row"` rows, each carrying
 *       `data-testid="table-cell-{keyword,intent,volume,kd,cpc,comp-lvl,
 *       serp-features,results,updated}"` cells — semantic test hooks, not
 *       incidental classes.
 *     - auth source: browser cookie (Chrome must already be logged in to semrush.com)
 *     - replay result: verified live for seed "running shoes" / db=us.
 *   Same rationale as the other semrush adapters for choosing UI over
 *   INTERCEPT/PAGE_FETCH (CDP network capture broken in this environment;
 *   page-JS interceptor misses the initial hard-navigation requests).
 *   Known limitation: on a free/trial Semrush plan the table only exposes the
 *   seed keyword itself (all further related-keyword rows are paywalled behind
 *   "开始免费 Pro 试用版，获取更多请求并解锁隐藏结果" / "Start a free Pro trial to
 *   unlock more results"). This is an account/plan limitation, not an adapter
 *   bug — the adapter returns whatever rows the current account can see.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseCompactNumber, parseLeadingNumber } from './utils.js';

cli({
    site: 'semrush',
    name: 'keyword-magic',
    access: 'read',
    description: 'Semrush Keyword Magic Tool：相关词列表（keyword/volume/KD/CPC/intent）',
    domain: 'www.semrush.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'seed', positional: true, required: true, help: 'Seed keyword' },
        { name: 'country', default: 'us', help: 'Semrush database / country code (e.g. us, uk, de)' },
        { name: 'limit', type: 'int', default: 20, help: 'Maximum number of rows to return' },
    ],
    columns: ['keyword', 'intent', 'volume', 'kd', 'cpc', 'competition', 'serp_features', 'results', 'updated'],
    func: async (page, args) => {
        const seed = String(args.seed || '').trim();
        const country = String(args.country || 'us').trim().toLowerCase();
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
        if (!seed) {
            throw new ArgumentError('Invalid seed keyword');
        }
        const qs = new URLSearchParams({ q: seed, db: country });
        await page.goto(`https://www.semrush.com/analytics/keywordmagic/?${qs.toString()}`);
        await page.wait(8);

        const currentUrl = await page.evaluate('window.location.href');
        if (typeof currentUrl === 'string' && /\/(login|sso)\b/i.test(currentUrl)) {
            throw new AuthRequiredError('semrush.com', 'Semrush session expired or not logged in');
        }

        const rows = await page.evaluate(`
      (() => {
        const trs = Array.from(document.querySelectorAll('[data-testid="table-row"]'));
        function cell(tr, name) {
          const el = tr.querySelector('[data-testid="table-cell-' + name + '"]');
          return el ? el.textContent.trim() : '';
        }
        return trs.map((tr) => ({
          keyword: cell(tr, 'keyword'),
          intent: cell(tr, 'intent'),
          volume: cell(tr, 'volume'),
          kd: cell(tr, 'kd'),
          cpc: cell(tr, 'cpc'),
          comp: cell(tr, 'comp-lvl'),
          serpFeatures: cell(tr, 'serp-features'),
          results: cell(tr, 'results'),
          updated: cell(tr, 'updated'),
        }));
      })()
    `);

        // On a free/trial plan, Semrush still renders an empty `table-row` shell for
        // every locked/blurred result beyond what the account is allowed to see —
        // same data-testid, no cell text. Drop those instead of returning blank rows.
        const nonEmptyRows = (Array.isArray(rows) ? rows : []).filter((r) => String(r.keyword || '').trim() !== '');

        if (nonEmptyRows.length === 0) {
            throw new EmptyResultError('semrush keyword-magic', 'Keyword Magic Tool table did not render; check the seed keyword/country, or Semrush account quota/plan');
        }

        return nonEmptyRows.slice(0, limit).map((r) => ({
            keyword: r.keyword.replace(/​/g, ''),
            intent: r.intent || '',
            volume: parseCompactNumber(r.volume),
            kd: parseLeadingNumber(r.kd),
            cpc: parseLeadingNumber(r.cpc),
            competition: parseLeadingNumber(r.comp),
            serp_features: parseLeadingNumber(r.serpFeatures),
            results: r.results ? Number.parseInt(r.results.replace(/,/g, ''), 10) : null,
            updated: r.updated || '',
        }));
    },
});
