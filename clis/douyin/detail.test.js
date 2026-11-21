import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { extractVideoId, resolveToId } from './detail.js';
const id = '7665918107357121842';
const command = [...getRegistry().values()].find(c => c.site === 'douyin' && c.name === 'detail');
afterEach(() => vi.unstubAllGlobals());
function pageFor(body, status = 200) {
    return {
        goto: vi.fn(), wait: vi.fn(),
        evaluate: async script => new Function('fetch', `return (${script})`)(async url => {
            expect(new URL(url).searchParams.get('aweme_id')).toBe(id);
            return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
        }),
    };
}
describe('douyin detail', () => {
    it.each([id, `https://www.douyin.com/video/${id}`, `https://www.iesdouyin.com/share/video/${id}/`, `https://www.douyin.com/?modal_id=${id}`])('accepts %s', input => {
        expect(extractVideoId(input)).toBe(id);
    });
    it.each([`https://evil.test/douyin.com/video/${id}`, `https://douyin.com.evil.test/video/${id}`, `http://www.douyin.com/video/${id}`, `https://user@www.douyin.com/video/${id}`, `https://www.douyin.com:444/video/${id}`, '123', ''])('rejects %s', async input => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        await expect(resolveToId(input)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('resolves relative and final redirects without fetching the video', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response(null, {status:302, headers:{location:'/next/'}}))
            .mockResolvedValueOnce(new Response(null, {status:302, headers:{location:`https://www.douyin.com/video/${id}`}}));
        vi.stubGlobal('fetch', fetch);
        await expect(resolveToId('https://v.douyin.com/abc/')).resolves.toBe(id);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][1].redirect).toBe('manual');
    });
    it('rejects external redirects before following them', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(null, {status:302, headers:{location:`https://evil.test/?modal_id=${id}`}}));
        vi.stubGlobal('fetch', fetch);
        await expect(resolveToId('https://v.douyin.com/abc/')).rejects.toThrow('Only HTTPS');
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('detects redirect loops', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {status:302, headers:{location:'/abc/'}})));
        await expect(resolveToId('https://v.douyin.com/abc/')).rejects.toThrow('loop');
    });
    it.each([200,403,429,500])('rejects non-redirect HTTP %s', async status => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {status})));
        await expect(resolveToId('https://v.douyin.com/abc/')).rejects.toThrow(`HTTP ${status}`);
    });
    it('returns video and image details through the actual browser script', async () => {
        const page = pageFor({status_code:0, aweme_detail:{aweme_id:id, desc:'caption', author:{nickname:'Author',sec_uid:'sec'}, statistics:{digg_count:3}, create_time:1700000000, video:{duration:12345,play_addr:{url_list:['https://media.test/video']},cover:{url_list:['cover']}},images:[{url_list:['image']}],music:{title:'Music'},share_url:'share'}});
        const [row] = await command.func(page, {target:id});
        expect(row).toMatchObject({aweme_id:id,desc:'caption',author:'Author',author_sec_uid:'sec',digg:3,duration_s:12,images:['image'],music:'Music'});
        expect(Object.keys(row).sort()).toEqual([...command.columns].sort());
        expect(page.goto).toHaveBeenCalledWith(`https://www.douyin.com/video/${id}`);
    });
    it.each([403,429,500])('does not accept success JSON over HTTP %s', async status => {
        await expect(command.func(pageFor({status_code:0,aweme_detail:{aweme_id:id}},status),{target:id})).rejects.toThrow(String(status));
    });
    it.each(['', '<html>challenge</html>', {status_code:0}, {aweme_detail:{aweme_id:'7665918107357121843'}}, {aweme_detail:{aweme_id:Number(id)}}, {aweme_detail:{aweme_id:id,images:{}}}])('rejects unusable detail %j', async body => {
        await expect(command.func(pageFor(body),{target:id})).rejects.toThrow();
    });
});
