import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { SEARCH_EVAL, buildRedditSearchUrl } from './search.js';

describe('reddit search adapter', () => {
  const command = getRegistry().get('reddit/search');

  it('exposes the full search-result shape including the 4 media columns', () => {
    expect(command?.columns).toEqual([
      'id', 'title', 'subreddit', 'author', 'score', 'comments', 'url',
      'created_utc', 'selftext',
      'post_hint', 'url_overridden_by_dest', 'preview_image_url', 'gallery_urls',
    ]);
  });

  it('navigates to the real search page instead of the reddit.com home feed', () => {
    // The home feed is heavy (often past the 15s navigation budget) and shows the user
    // nothing about the query. The visible tab must be the search results page.
    expect(command?.navigateBefore).toBe(false);
    expect(typeof command?.func).toBe('function');
    expect(buildRedditSearchUrl({ query: 'clipboard manager', subreddit: '', sort: 'new', time: 'month' }))
      .toBe('https://www.reddit.com/search/?q=clipboard+manager&sort=new&t=month');
    expect(buildRedditSearchUrl({ query: 'launchpad', subreddit: 'r/macapps', sort: 'relevance', time: 'all' }))
      .toBe('https://www.reddit.com/r/macapps/search/?q=launchpad&sort=relevance&t=all&restrict_sr=1');
  });

  it('keeps the in-page JSON fetch and media extraction', () => {
    expect(SEARCH_EVAL).toContain('function extractRedditMedia');
    expect(SEARCH_EVAL).toContain('...extractRedditMedia(c.data)');
    expect(SEARCH_EVAL).toContain('/search.json');
    expect(SEARCH_EVAL).toContain('__ARGS__');
    // Failures must be distinguishable from "no posts": HTML or non-2xx come back tagged.
    expect(SEARCH_EVAL).toContain("__error: 'not_json'");
    expect(SEARCH_EVAL).toContain("__error: 'http_'");
  });
});
