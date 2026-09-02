import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';

/** 这次查询对应的搜索结果页——用户在标签页里看到的就是它。 */
export function buildRedditSearchUrl({ query, subreddit, sort, time }) {
    const sub = String(subreddit ?? '').trim().replace(/^r\//, '');
    const base = sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search/` : 'https://www.reddit.com/search/';
    const params = new URLSearchParams({ q: String(query ?? ''), sort: String(sort ?? 'relevance'), t: String(time ?? 'all') });
    if (sub) params.set('restrict_sr', '1');
    return `${base}?${params.toString()}`;
}

/**
 * 页内执行：在已登录的 reddit.com 页面里 fetch /search.json，`__ARGS__` 由 func 注入。
 * 只采集不判读：返回原始字段，空数组就是空数组。
 */
export const SEARCH_EVAL = `(async () => {
  const __args = __ARGS__;
  function decodeHtml(s) {
    if (typeof s !== 'string' || !s) return '';
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/gi, "'")
      .replace(/&#39;/g, "'");
  }
  function extractRedditMedia(d) {
    const post_hint = d?.post_hint || '';
    const url_overridden_by_dest = d?.url_overridden_by_dest || '';
    const preview_image_url = decodeHtml(d?.preview?.images?.[0]?.source?.url || '');
    const gallery_urls = [];
    const items = d?.gallery_data?.items;
    const meta = d?.media_metadata;
    if (Array.isArray(items) && meta) {
      for (const it of items) {
        const m = it && meta[it.media_id];
        const u = m?.s?.u;
        if (u) gallery_urls.push(decodeHtml(u));
      }
    }
    return { post_hint, url_overridden_by_dest, preview_image_url, gallery_urls };
  }
  const q = encodeURIComponent(__args.query);
  const sub = __args.subreddit;
  const sort = __args.sort;
  const time = __args.time;
  const limit = __args.limit;
  const basePath = sub ? '/r/' + encodeURIComponent(sub) + '/search.json' : '/search.json';
  const params = 'q=' + q + '&sort=' + sort + '&t=' + time + '&limit=' + limit
    + '&restrict_sr=' + (sub ? 'on' : 'off') + '&raw_json=1';
  const res = await fetch(basePath + '?' + params, { credentials: 'include' });
  if (!res.ok) return { __error: 'http_' + res.status };
  let d;
  try { d = await res.json(); } catch (e) { return { __error: 'not_json' }; }
  return (d?.data?.children || []).map(c => ({
    id: c.data.id,
    title: c.data.title,
    subreddit: c.data.subreddit_name_prefixed,
    author: c.data.author,
    score: c.data.score,
    comments: c.data.num_comments,
    url: 'https://www.reddit.com' + c.data.permalink,
    created_utc: c.data.created_utc,
    selftext: c.data.selftext || '',
    ...extractRedditMedia(c.data),
  }));
})()`;

cli({
    site: 'reddit',
    name: 'search',
    access: 'read',
    description: 'Search Reddit Posts',
    domain: 'reddit.com',
    strategy: Strategy.COOKIE,
    browser: true,
    // 不走框架默认的「先导航到 reddit.com 根」：首页 feed 很重，经常 15s 内加载不完，用户看到的只是一个
    // 反复刷新的首页，看不出在搜什么（搜索其实是页内 fetch）。改为直接导航到这次查询的搜索结果页——
    // 页面本身就是可见证据，再在页内 fetch /search.json 取结构化结果。
    navigateBefore: false,
    args: [
        { name: 'query', type: 'string', required: true, positional: true, help: 'Reddit search query' },
        {
            name: 'subreddit',
            type: 'string',
            default: '',
            help: 'Search within a specific subreddit',
        },
        {
            name: 'sort',
            type: 'string',
            default: 'relevance',
            help: 'Sort order: relevance, hot, top, new, comments',
        },
        {
            name: 'time',
            type: 'string',
            default: 'all',
            help: 'Time filter: hour, day, week, month, year, all',
        },
        { name: 'limit', type: 'int', default: 15 },
    ],
    columns: ['id', 'title', 'subreddit', 'author', 'score', 'comments', 'url', 'created_utc', 'selftext', 'post_hint', 'url_overridden_by_dest', 'preview_image_url', 'gallery_urls'],
    func: async (page, kwargs) => {
        const query = String(kwargs.query ?? '').trim();
        const subreddit = String(kwargs.subreddit ?? '').trim().replace(/^r\//, '');
        const sort = String(kwargs.sort ?? 'relevance');
        const time = String(kwargs.time ?? 'all');
        const limit = Math.min(100, Number(kwargs.limit ?? 15) || 15);
        await page.goto(buildRedditSearchUrl({ query, subreddit, sort, time }), { waitUntil: 'none', settleMs: 300 });
        const rows = await page.evaluate(SEARCH_EVAL.replace('__ARGS__', JSON.stringify({ query, subreddit, sort, time, limit })));
        if (rows && typeof rows === 'object' && !Array.isArray(rows) && rows.__error) {
            throw new CommandExecutionError(
                `Reddit search.json failed: ${rows.__error}`,
                rows.__error === 'not_json'
                    ? 'reddit.com answered with HTML instead of JSON — usually a login wall or an anti-bot page. Make sure Chrome is logged in to reddit.com, then retry.'
                    : 'Reddit rate-limited or rejected the request. Slow down (a few seconds between calls) and retry.',
            );
        }
        if (!Array.isArray(rows)) {
            throw new CommandExecutionError('Reddit search did not return a list', 'Retry; if it persists, run with --trace retain-on-failure and inspect the page.');
        }
        return rows.slice(0, limit);
    },
});
