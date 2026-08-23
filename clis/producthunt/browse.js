/**
 * Product Hunt category browse.
 *
 * Navigates to a Product Hunt category page and scrapes the top-rated products.
 * Shows all-time best products for a category (ranked by review score, not daily votes).
 *
 * Strategy: UI (DOM). Contract: visible-ui.
 * Why not INTERCEPT (the previous implementation): the category page is server
 * rendered, so no matching XHR fires after navigation and
 * `waitForCapture(5)` failed with "No network capture within 5s" on every run.
 * The DOM scrape below was already correct — it just never got to run.
 * The Apollo store on this page carries `Product` entities without review
 * counts, so the card DOM stays the source for `reviews`.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { PRODUCTHUNT_CATEGORY_SLUGS } from './utils.js';
cli({
    site: 'producthunt',
    name: 'browse',
    access: 'read',
    description: 'Best products in a Product Hunt category',
    domain: 'www.producthunt.com',
    strategy: Strategy.UI,
    args: [
        {
            name: 'category',
            type: 'string',
            positional: true,
            required: true,
            help: `Category slug, e.g. vibe-coding, ai-agents, developer-tools`,
        },
        { name: 'limit', type: 'int', default: 20, help: 'Number of results (max 50)' },
    ],
    columns: ['rank', 'name', 'tagline', 'reviews', 'url'],
    func: async (page, args) => {
        const count = Math.min(Number(args.limit) || 20, 50);
        const slug = String(args.category || '').trim().toLowerCase();
        await page.goto(`https://www.producthunt.com/categories/${slug}`);
        await page.wait({ selector: 'a[href^="/products/"]', timeout: 20000 }).catch(() => { });
        const domItems = await page.evaluate(`
      (() => {
        const seen = new Set();
        const results = [];

        // Card links: <a class="...flex-col" href="/products/<slug>"> (not review links)
        const cardLinks = Array.from(document.querySelectorAll('a[href^="/products/"]')).filter(a => {
          const href = a.getAttribute('href') || '';
          const cls = a.className || '';
          return cls.includes('flex-col') && !href.includes('/reviews');
        });

        for (const cardLink of cardLinks) {
          const href = cardLink.getAttribute('href');
          if (!href || seen.has(href)) continue;

          // Name: two card shapes coexist on the same page.
          //   big card:   <a><div><span class="...text-primary">Name</span></div>...
          //   small card: <a><span class="...text-primary">Name</span>...   (no <div>)
          // Both keep the name inside this <a>, so read the primary span first and
          // only fall back to the wrapper <div>. Reading the <div> alone yielded
          // an empty name for every small card, and the "if (!name) continue"
          // guard below then dropped them silently (3 of 18 cards on
          // /categories/ai-agents, verified 2026-08-24).
          // NOTE: this whole block lives inside a template literal — no backticks.
          const nameEl = cardLink.querySelector('span[class*="text-primary"]')
            || cardLink.querySelector('div');
          const rawName = nameEl?.textContent?.trim() || '';
          const name = rawName
            .replace(/\\s*Launched\\s+this\\s+(month|week|year|day)\\s*/gi, '')
            .replace(/\\s*Featured\\s*/gi, '')
            .trim();

          // Tagline: span.text-secondary, queried on the card <a> itself.
          // querySelector only walks this anchor's own subtree, and each card holds
          // exactly one such span and zero nested <a> (checked across all 18 cards of
          // /categories/ai-agents, 2026-08-24), so it cannot bleed into a neighbour.
          const taglineEl = cardLink.querySelector('span.text-secondary, span[class*="text-secondary"]');
          const tagline = taglineEl?.textContent?.trim() || '';

          if (!name) continue;

          // Find reviews count from sibling /reviews link
          let reviews = '';
          let container = cardLink.parentElement;
          for (let i = 0; i < 5 && container; i++) {
            const reviewLink = container.querySelector('a[href="' + href + '/reviews"]');
            if (reviewLink) {
              reviews = (reviewLink.textContent?.trim() || '').replace(/\\s*reviews?\\s*/i, '').trim();
              break;
            }
            container = container.parentElement;
          }

          seen.add(href);
          results.push({
            name,
            tagline: tagline.slice(0, 120),
            reviews: reviews || '0',
            url: 'https://www.producthunt.com' + href,
          });
        }

        return results;
      })()
    `);
        const items = Array.isArray(domItems) ? domItems : [];
        if (items.length === 0) {
            throw new CliError('NO_DATA', `No products found for category "${slug}"`, 'Check the category slug or try: ' + PRODUCTHUNT_CATEGORY_SLUGS.slice(0, 5).join(', '));
        }
        return items.slice(0, count).map((item, i) => ({
            rank: i + 1,
            name: item.name,
            tagline: item.tagline,
            reviews: item.reviews,
            url: item.url,
        }));
    },
});
