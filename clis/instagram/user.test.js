import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './user.js';

async function runUserEvaluate(fetchFn, args = { username: 'sleepcycleapp', limit: 2 }) {
  const page = { goto: vi.fn(), evaluate: async script => new Function('fetch', `return (${script})`)(async (...args) => {
    const response = await fetchFn(...args);
    return { ...response, text: response.text ?? (async () => JSON.stringify(await response.json())) };
  }) };
  return getRegistry().get('instagram/user').func(page, args);
}

describe('instagram/user feed fetch', () => {
  it('fetches recent posts directly by username', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            caption: { text: 'First post\nwith newline' },
            like_count: 12,
            comment_count: 3,
            media_type: 1,
            taken_at: 1784451600,
          },
          {
            caption: { text: 'Second post' },
            like_count: 4,
            comment_count: 1,
            media_type: 2,
          },
        ],
      }),
    });

    const result = await runUserEvaluate(fetchFn, { username: 'sleep cycle/app', limit: 2 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://www.instagram.com/api/v1/feed/user/sleep%20cycle%2Fapp/username/?count=2');
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      credentials: 'include',
      headers: { 'X-IG-App-ID': '936619743392459' },
    });
    expect(fetchFn.mock.calls[0][0]).not.toContain('web_profile_info');
    expect(result).toEqual([
      { index: 1, caption: 'First post with newline', likes: 12, comments: 3, type: 'photo', date: expect.any(String) },
      { index: 2, caption: 'Second post', likes: 4, comments: 1, type: 'video', date: '' },
    ]);
  });

  it('reports unsuccessful feed requests as typed HTTP failures', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    await expect(runUserEvaluate(fetchFn)).rejects.toThrow('Instagram feed-by-username failed: HTTP 400');
  });
});
