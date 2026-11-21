import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { userCommand, parseProfileCapture } from './user.js';
import { BROWSER_HELPERS } from './utils.js';
import './auth.js';
const doms = [];
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });
const item = (id, author = 'nasa') => ({ id, author: { uniqueId: author, secUid: author === 'nasa' ? 'sec-nasa' : 'other' }, desc: `Video ${id}`, createTime: Number(id), stats: { playCount: 12 }, video: { cover: 'https://example.com/cover.jpg' } });
const entry = (items, hasMore = false, extra = {}) => ({ url: 'https://www.tiktok.com/api/post/item_list/?secUid=sec-nasa&X-Bogus=not-replayed', responseStatus: 200, captureComplete: true, responsePreview: JSON.stringify({ itemList: items, hasMore, statusCode: 0 }), ...extra });
function fixture(batches = [], data = { __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'nasa', secUid: 'sec-nasa' }, stats: { videoCount: 51 } } } } }) {
    const dom = new JSDOM(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`, { url: 'https://www.tiktok.com/@nasa', runScripts: 'outside-only' });
    doms.push(dom);
    dom.window.fetch = vi.fn(() => { throw new Error('Adapter must not fetch unsigned or replayed requests'); });
    const page = { goto: vi.fn(), wait: vi.fn(), autoScroll: vi.fn(), startNetworkCapture: vi.fn().mockResolvedValue(true), readNetworkCapture: vi.fn(async () => batches.shift() || []), evaluate: vi.fn(script => dom.window.eval(script)), getCookies: vi.fn(async () => [{ name: 'sessionid' }]) };
    return { dom, page };
}
describe('TikTok page-owned profile responses', () => {
    it('captures before navigation, waits for completion, scrolls and returns deduplicated full rows', async () => {
        const f = fixture([[entry([], true, { captureComplete: false, responsePreview: undefined })], [], [entry([item('1'), item('2')], true)], [entry([item('2'), item('3')])]]);
        const rows = await userCommand.func(f.page, { username: 'nasa', limit: 3 });
        expect(rows.map(row => row.id)).toEqual(['3', '2', '1']);
        expect(rows.every(row => row.source === 'profile-network' && row.plays === 12 && row.cover.endsWith('cover.jpg'))).toBe(true);
        expect(f.page.startNetworkCapture.mock.invocationCallOrder[0]).toBeLessThan(f.page.goto.mock.invocationCallOrder[0]);
        expect(f.page.autoScroll).toHaveBeenCalled();
        expect(f.page.readNetworkCapture).toHaveBeenCalledWith({ retainIncomplete: true });
        expect(f.dom.window.fetch).not.toHaveBeenCalled();
    });
    it('ignores other accounts and stale captures, without accepting conflicting author identity', async () => {
        const f = fixture([[entry([item('9')], false, { timestamp: 1 }), entry([item('8')], false, { url: 'https://www.tiktok.com/api/post/item_list/?secUid=other' }), entry([item('2'), item('7', 'other')])]]);
        const rows = await userCommand.func(f.page, { username: 'nasa', limit: 3 });
        expect(rows.map(row => row.id)).toEqual(['2']);
    });
    it('does not convert missing responses for an active profile into EMPTY_RESULT', async () => {
        const f = fixture();
        await expect(userCommand.func(f.page, { username: 'nasa', limit: 5 })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('completed video response') });
        expect(f.page.readNetworkCapture).toHaveBeenCalledTimes(10);
        expect(f.page.autoScroll).toHaveBeenCalledTimes(4);
    });
    it('recognizes an explicitly complete empty list', async () => {
        const f = fixture([[entry([])]]);
        await expect(userCommand.func(f.page, { username: 'nasa' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    });
    it('rejects a mismatched-author response instead of reporting empty', async () => {
        const f = fixture([[entry([item('1', 'other')])]]);
        await expect(userCommand.func(f.page, { username: 'nasa' })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });
    it('returns bounded partial rows with a warning when pagination stalls', async () => {
        const f = fixture([[entry([item('1')], true)]]);
        expect(await userCommand.func(f.page, { username: 'nasa', limit: 2 })).toHaveLength(1);
        expect(f.page.readNetworkCapture).toHaveBeenCalledTimes(10);
    });
    it('does not return partial success after a later rate limit', async () => {
        const f = fixture([[entry([item('1')], true)], [entry([], false, { responseStatus: 429 })]]);
        await expect(userCommand.func(f.page, { username: 'nasa', limit: 2 })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('429') });
    });
});
describe('TikTok capture parsing', () => {
    it.each([
        [{ responsePreview: '' }, 'COMMAND_EXEC'],
        [{ responsePreview: '<html>challenge</html>' }, 'COMMAND_EXEC'],
        [{ responseStatus: 403 }, 'AUTH_REQUIRED'],
        [{ responseStatus: 429 }, 'COMMAND_EXEC'],
        [{ responseBodyTruncated: true }, 'COMMAND_EXEC'],
        [{ responsePreview: '{}' }, 'COMMAND_EXEC'],
        [{ responsePreview: '{"statusCode":8}' }, 'AUTH_REQUIRED'],
        [{ responsePreview: '{"itemList":[],"hasMore":"false"}' }, 'COMMAND_EXEC'],
    ])('rejects unusable responses %j', (extra, code) => {
        expect(() => parseProfileCapture(entry([], false, extra), 'sec-nasa')).toThrow(expect.objectContaining({ code }));
    });
    it('decodes base64 response bodies', () => {
        const responsePreview = 'base64:' + Buffer.from(JSON.stringify({ itemList: [item('1')], hasMore: 0 })).toString('base64');
        expect(parseProfileCapture(entry([], false, { responsePreview }), 'sec-nasa').items).toHaveLength(1);
    });
    it('does not consume incomplete or off-site responses', () => {
        expect(parseProfileCapture(entry([], false, { captureComplete: false }), 'sec-nasa')).toBeNull();
        expect(parseProfileCapture(entry([], false, { url: 'https://evil.invalid/api/post/item_list/?secUid=sec-nasa' }), 'sec-nasa')).toBeNull();
    });
    it('shared fetch helper rejects empty successful API bodies', async () => {
        const f = fixture(); f.dom.window.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
        await expect(f.dom.window.eval(`(async()=>{${BROWSER_HELPERS};return await fetchJson('/api/user/detail/');})()`)).rejects.toThrow(/empty response/);
    });
});
describe('TikTok current identity', () => {
    it('reads app-context user without owner flags', async () => {
        const f = fixture([], { __DEFAULT_SCOPE__: { 'webapp.app-context': { user: { secUid: 'self', uniqueId: 'me', nickName: 'Me' } }, 'webapp.user-detail': { userInfo: { user: { secUid: 'other', uniqueId: 'someone' } } } } });
        expect(await getRegistry().get('tiktok/whoami').func(f.page)).toMatchObject({ logged_in: true, sec_uid: 'self', username: 'me', nickname: 'Me' });
    });
    it('does not use a viewed profile as the current account', async () => {
        const f = fixture();
        await expect(getRegistry().get('tiktok/whoami').func(f.page)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    });
    it('still requires session cookies', async () => {
        const f = fixture(); f.page.getCookies.mockResolvedValue([]);
        await expect(getRegistry().get('tiktok/whoami').func(f.page)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
        expect(f.page.goto).not.toHaveBeenCalled();
    });
});
