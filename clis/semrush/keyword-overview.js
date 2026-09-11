/**
 * Semrush Keyword Overview — UI strategy.
 *
 * Strategy note (see references/adapters.md):
 *   Strategy: UI
 *   Contract: visible-ui
 *   Evidence:
 *     - observed state: /analytics/keywordoverview/?q=<keyword>&db=<country> renders the
 *       core metrics behind `data-testid` anchors (volume-total, kd-metric, intent-widget,
 *       metrics-widget for CPC/competition, global-volume-total). These are semantic
 *       test hooks, not incidental styling classes.
 *     - auth source: browser cookie (Chrome must already be logged in to semrush.com)
 *     - replay result: verified live for "running shoes" / db=us — volume-total="246.0K",
 *       kd-metric="71%困难", intent-widget="意图商务", metrics-widget contains
 *       "CPC$0.88竞争激烈程度1.00".
 *   Same rationale as semrush/analytics-overview.js for choosing UI over
 *   INTERCEPT/PAGE_FETCH: CDP network capture is broken in this environment
 *   (verified against an unrelated site), and the page-JS interceptor cannot see
 *   requests fired during the initial hard navigation. The monthly search-volume
 *   trend chart is CSS-bar based (`.kwo-bar` elements carry a `--height: NN%` custom
 *   property, not an absolute value) — trend is reported as those relative
 *   percentages, not absolute per-month volume.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseCompactNumber, parseLeadingNumber } from './utils.js';

cli({
    site: 'semrush',
    name: 'keyword-overview',
    access: 'read',
    description: 'Semrush Keyword Overview：search volume、KD、CPC、intent、trend（相对趋势）',
    domain: 'www.semrush.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'keyword', positional: true, required: true, help: 'Keyword phrase' },
        { name: 'country', default: 'us', help: 'Semrush database / country code (e.g. us, uk, de)' },
    ],
    columns: ['keyword', 'country', 'volume', 'global_volume', 'kd', 'kd_label', 'intent', 'cpc', 'competition', 'trend_relative'],
    func: async (page, args) => {
        const keyword = String(args.keyword || '').trim();
        const country = String(args.country || 'us').trim().toLowerCase();
        if (!keyword) {
            throw new ArgumentError('Invalid keyword');
        }
        const qs = new URLSearchParams({ q: keyword, db: country });
        await page.goto(`https://www.semrush.com/analytics/keywordoverview/?${qs.toString()}`);
        await page.wait(8);

        const currentUrl = await page.evaluate('window.location.href');
        if (typeof currentUrl === 'string' && /\/(login|sso)\b/i.test(currentUrl)) {
            throw new AuthRequiredError('semrush.com', 'Semrush session expired or not logged in');
        }

        const data = await page.evaluate(`
      (() => {
        function textOf(sel) {
          const el = document.querySelector('[data-testid="' + sel + '"]');
          return el ? el.textContent.trim() : null;
        }
        const bars = Array.from(document.querySelectorAll('[data-testid="trend-widget"] .kwo-bar'))
          .map((el) => {
            const m = /--height:\\s*([\\d.]+)%/.exec(el.getAttribute('style') || '');
            return m ? Number.parseFloat(m[1]) : null;
          })
          .filter((v) => v !== null);
        return {
          volume: textOf('volume-total'),
          globalVolume: textOf('global-volume-total'),
          kd: textOf('kd-metric'),
          intent: textOf('intent-widget'),
          metrics: textOf('metrics-widget'),
          trendBars: bars,
        };
      })()
    `);

        if (!data || !data.volume) {
            throw new EmptyResultError('semrush keyword-overview', 'Keyword Overview did not render; check the keyword/country, or Semrush account quota/plan');
        }

        const kdMatch = /^(\d+)%(.*)$/.exec(String(data.kd || ''));
        const cpcMatch = /CPC\$([\d.]+)/.exec(String(data.metrics || ''));
        const compMatch = /竞争激烈程度\s*([\d.]+)|Competitive Density\s*([\d.]+)/.exec(String(data.metrics || ''));
        const intentText = String(data.intent || '').replace(/^意图|^Intent:?/i, '').trim();

        return [{
            keyword,
            country,
            volume: parseCompactNumber(data.volume),
            global_volume: parseCompactNumber(data.globalVolume),
            kd: kdMatch ? Number.parseInt(kdMatch[1], 10) : parseLeadingNumber(data.kd),
            kd_label: kdMatch ? kdMatch[2].trim() : '',
            intent: intentText,
            cpc: cpcMatch ? Number.parseFloat(cpcMatch[1]) : null,
            competition: compMatch ? Number.parseFloat(compMatch[1] || compMatch[2]) : null,
            trend_relative: data.trendBars || [],
        }];
    },
});
