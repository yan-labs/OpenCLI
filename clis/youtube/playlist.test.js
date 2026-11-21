import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import './playlist.js';

function video(id, modern) {
  return modern ? { lockupViewModel: {
    contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: { title: { content: `Video ${id}` }, metadata: { contentMetadataViewModel: {
      metadataRows: [{ metadataParts: [{ text: { content: 'Channel' } }] }, { metadataParts: [{ text: { content: '42 views' } }, { text: { content: 'Yesterday' } }] }],
    } } } },
    contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '1:23' } }] } }] } },
  } } : { playlistVideoRenderer: { videoId: id, title: { runs: [{ text: `Video ${id}` }] }, shortBylineText: { runs: [{ text: 'Channel' }] }, lengthText: { simpleText: '1:23' }, videoInfo: { runs: [{ text: '42 views' }, { text: ' • ' }, { text: 'Yesterday' }] } } };
}
function continuation(token, modern) {
  return modern ? { continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token } } } } }
    : { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } };
}
function pageFor(modern, tail) {
  const dom = new JSDOM('', { url: 'https://www.youtube.com', runScripts: 'outside-only' });
  dom.window.ytcfg = { data_: { INNERTUBE_API_KEY: 'fixture', INNERTUBE_CONTEXT: { client: {} } } };
  const items = [video('one', modern), continuation('videos-next', modern)];
  const initial = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: modern ? items : [{ playlistVideoListRenderer: { contents: items } }] } },
    continuation('wrong-section-token', modern),
  ] } } } }] } } };
  dom.window.fetch = vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.continuation && body.continuation !== 'videos-next') throw new Error('Wrong continuation');
    return { ok: true, json: async () => body.continuation ? tail : initial };
  });
  return { dom, page: { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn(script => dom.window.eval(script)) } };
}

describe('youtube playlist payload compatibility', () => {
  it.each([false, true])('reads and paginates the actual injected script (modern=%s)', async modern => {
    const { page, dom } = pageFor(modern, { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [video('two', modern), video('one', modern)] } }] });
    try {
      const rows = await getRegistry().get('youtube/playlist').func(page, { id: 'PLfixture', limit: 3 });
      expect(rows.map(row => row.rank)).toEqual([1, 2, 3]);
      expect(rows.map(row => row.title)).toEqual(['Video one', 'Video two', 'Video one']);
      expect(rows[1]).toMatchObject({ channel: 'Channel', duration: '1:23', views: '42 views', published: 'Yesterday', url: 'https://www.youtube.com/watch?v=two' });
      expect(dom.window.fetch).toHaveBeenCalledTimes(2);
    } finally { dom.window.close(); }
  });

  it('rejects a repeated continuation instead of looping or silently inventing complete results', async () => {
    const { page, dom } = pageFor(true, { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [video('two', true), continuation('videos-next', true)] } }] });
    try {
      await expect(getRegistry().get('youtube/playlist').func(page, { id: 'PLfixture', limit: 10 })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('continuation') });
      expect(dom.window.fetch).toHaveBeenCalledTimes(2);
    } finally { dom.window.close(); }
  });
});
