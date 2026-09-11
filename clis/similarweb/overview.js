/**
 * Similarweb website overview — UI strategy.
 *
 * Strategy note (see references/adapters.md):
 *   Strategy: UI
 *   Contract: visible-ui
 *   Evidence:
 *     - observed state: the public https://www.similarweb.com/website/<domain>/ report
 *       renders monthly visits, ranks, engagement metrics, top countries and top
 *       traffic-source channels as plain DOM text under stable, semantic hooks:
 *       `data-test="global-rank|country-rank|category-rank"` (value in a sibling
 *       `.wa-rank-list__value`), `.engagement-list__item-name` / `.engagement-list__item-value`
 *       pairs (bounce rate / pages-per-visit / avg-visit-duration / month-over-month
 *       change), `.wa-legend__competitor--highlighted .wa-legend__competitor-value`
 *       (the queried domain's monthly visits), `.geography-chart__legend-item`
 *       (top countries), and `.wa-traffic-sources-single-podium-item` (top-3 traffic
 *       channels — only the #1 channel exposes its percentage on the free/public tier).
 *     - auth source: none required — this is Similarweb's public marketing tool, not
 *       a logged-in dashboard. It is still driven through the user's real Chrome
 *       per this fork's OpenCLI conventions (consistent behavior/quota with a
 *       normal browsing session).
 *     - replay result: verified live for example.com — global rank #7,941, country
 *       rank #12,471 (US), category rank #28031, monthly visits 9.3M, bounce rate
 *       65.15%, pages/visit 2.06, avg duration 00:02:30.
 *   CDP-based network capture was not attempted here (same environment-level bridge
 *   issue documented in the semrush adapters — verified broken against an unrelated
 *   site), and the rendered DOM already carries every field needed with stable
 *   semantic hooks, so UI is preferred over forcing INTERCEPT.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseCompactNumber, parsePercent, parseDurationSeconds } from './utils.js';

function normalizeDomain(input) {
    return String(input || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '');
}

cli({
    site: 'similarweb',
    name: 'overview',
    access: 'read',
    description: 'Similarweb 网站概览：月访问量、跳出率、平均时长、流量来源占比、Top 国家',
    domain: 'www.similarweb.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'domain', positional: true, required: true, help: 'Root domain to analyze (e.g. example.com)' },
    ],
    columns: [
        'domain', 'global_rank', 'country', 'country_rank', 'category', 'category_rank',
        'monthly_visits', 'visits_change_pct', 'bounce_rate_pct', 'pages_per_visit',
        'avg_visit_duration_sec', 'top_countries', 'top_traffic_sources',
    ],
    func: async (page, args) => {
        const domain = normalizeDomain(args.domain);
        if (!domain) {
            throw new ArgumentError('Invalid domain', 'Pass a bare domain like example.com');
        }
        await page.goto(`https://www.similarweb.com/website/${encodeURIComponent(domain)}/`);
        await page.wait(6);

        const evalScript = `
      (() => {
        function rankInfo(testId) {
          const label = document.querySelector('[data-test="' + testId + '"]');
          if (!label) return null;
          const item = label.closest('.wa-rank-list__item') || label.parentElement;
          const value = item.querySelector('.wa-rank-list__value');
          const info = item.querySelector('.wa-rank-list__info');
          return {
            value: value ? value.textContent.trim() : null,
            info: info ? info.textContent.trim() : '',
          };
        }
        function engagementValue(testId) {
          const label = document.querySelector('[data-test="' + testId + '"]');
          if (!label) return null;
          const item = label.closest('.engagement-list__item') || label.parentElement;
          const value = item.querySelector('.engagement-list__item-value');
          return value ? value.textContent.trim() : null;
        }
        const highlighted = document.querySelector('.wa-legend__competitor--highlighted .wa-legend__competitor-value');
        const countries = Array.from(document.querySelectorAll('.geography-chart__legend-item')).map((el) => ({
          country: el.querySelector('.geography-chart__country-name')?.textContent?.trim() || '',
          share: el.querySelector('.geography-chart__country-traffic-value')?.textContent?.trim() || '',
          change: el.querySelector('.geography-chart__country-traffic-change')?.textContent?.trim() || '',
        })).filter((c) => c.country);
        const sources = Array.from(document.querySelectorAll('.wa-traffic-sources-single-podium-item')).map((el) => ({
          source: el.querySelector('.wa-traffic-sources-single-podium-item__source')?.textContent?.trim() || '',
          percentage: el.querySelector('.wa-traffic-sources-single-podium-item__percentage')?.textContent?.trim() || '',
          position: el.querySelector('.wa-traffic-sources-single-podium-item__position-description')?.textContent?.trim() || '',
        })).filter((s) => s.source);
        return {
          global: rankInfo('global-rank'),
          countryRank: rankInfo('country-rank'),
          categoryRank: rankInfo('category-rank'),
          monthlyVisits: highlighted ? highlighted.textContent.trim() : null,
          visitsChange: engagementValue('total-visits-change'),
          bounceRate: engagementValue('bounce-rate'),
          pagesPerVisit: engagementValue('pages-per-visit'),
          avgDuration: engagementValue('avg-visit-duration'),
          countries,
          sources,
        };
      })()
    `;

        // The rank card renders a "- -" skeleton placeholder before the real value
        // streams in; a single fixed wait sometimes samples that placeholder rather
        // than a missing report. Poll a few times (same page, no re-navigation)
        // before concluding the report genuinely has no data for this domain.
        let data = null;
        let globalRank = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            data = await page.evaluate(evalScript);
            globalRank = data && data.global ? parseCompactNumber(data.global.value) : null;
            if (globalRank !== null)
                break;
            await page.wait(3);
        }

        if (globalRank === null) {
            throw new EmptyResultError('similarweb overview', 'Similarweb overview did not render a global rank; check the domain, or Similarweb may not have data for very low-traffic sites');
        }

        return [{
            domain,
            global_rank: globalRank,
            country: data.countryRank ? data.countryRank.info : '',
            country_rank: data.countryRank ? parseCompactNumber(data.countryRank.value) : null,
            category: data.categoryRank ? data.categoryRank.info : '',
            category_rank: data.categoryRank ? parseCompactNumber(data.categoryRank.value) : null,
            monthly_visits: parseCompactNumber(data.monthlyVisits),
            visits_change_pct: parsePercent(data.visitsChange),
            bounce_rate_pct: parsePercent(data.bounceRate),
            pages_per_visit: data.pagesPerVisit ? Number.parseFloat(data.pagesPerVisit) : null,
            avg_visit_duration_sec: parseDurationSeconds(data.avgDuration),
            top_countries: (data.countries || []).map((c) => ({
                country: c.country,
                share_pct: parsePercent(c.share),
                change_pct: parsePercent(c.change),
            })),
            top_traffic_sources: (data.sources || []).map((s) => ({
                source: s.source,
                share_pct: parsePercent(s.percentage),
                rank: s.position,
            })),
        }];
    },
});
