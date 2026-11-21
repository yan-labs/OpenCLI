import { describe, expect, it } from 'vitest';
import { formatChinaDate, stripHtml } from './utils.js';

describe('formatChinaDate', () => {
    it('returns the Asia/Shanghai date for a UTC ms at China midnight', () => {
        expect(formatChinaDate(Date.UTC(2026, 4, 7, 16, 0, 0))).toBe('2026-05-08');
    });
    it('returns the same China date for a moment late in the day', () => {
        expect(formatChinaDate(Date.UTC(2026, 4, 8, 14, 0, 0))).toBe('2026-05-08');
    });
    it('formats representative A-share and US-market bars on xueqiu Beijing dates', () => {
        expect(formatChinaDate(Date.UTC(2026, 4, 7, 16, 0, 0))).toBe('2026-05-08');
        expect(formatChinaDate(Date.UTC(2026, 4, 10, 16, 0, 0))).toBe('2026-05-11');
    });
    it('crosses the China day boundary at 16:00 UTC', () => {
        expect(formatChinaDate(Date.UTC(2026, 0, 1, 15, 59, 59))).toBe('2026-01-01');
        expect(formatChinaDate(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe('2026-01-02');
    });
    it('always returns an ISO calendar date string, not a locale-shaped slash date', () => {
        expect(formatChinaDate(Date.UTC(2026, 0, 1, 16, 0, 0))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    it('returns null for nullish input', () => {
        expect(formatChinaDate(null)).toBeNull();
        expect(formatChinaDate(undefined)).toBeNull();
    });
});

describe('stripHtml', () => {
    it('removes HTML tags', () => {
        expect(stripHtml('<p>Hello <strong>Xueqiu</strong></p>')).toBe('Hello Xueqiu');
    });
    it('decodes current named entities before trimming', () => {
        expect(stripHtml(' &nbsp;A&amp;B&lt;C&gt; &nbsp; ')).toBe('A&B<C>');
    });
    it('returns empty strings for nullish and empty input', () => {
        expect(stripHtml(null)).toBe('');
        expect(stripHtml(undefined)).toBe('');
        expect(stripHtml('')).toBe('');
    });
    it('does not insert spaces between adjacent block tags', () => {
        expect(stripHtml('<p>first</p><p>second</p>')).toBe('firstsecond');
    });
    it('does not decode numeric entities', () => {
        expect(stripHtml('&#65; &#x42;')).toBe('&#65; &#x42;');
    });
    it('does not collapse whitespace', () => {
        expect(stripHtml('a   b')).toBe('a   b');
    });
});

import { fetchXueqiuJson, responseSummary } from './utils.js';
function scriptPage(body, status = 200, contentType = 'application/json') {
    return { evaluate: async script => new Function('fetch', `return (${script})`)(async () => new Response(body, {status, headers:{'content-type':contentType}})) };
}
describe('Xueqiu page response diagnostics', () => {
    it('preserves successful payloads', async () => {
        await expect(fetchXueqiuJson(scriptPage('{"stocks":[]}'), 'https://xueqiu.com/stock/search.json')).resolves.toEqual({stocks:[]});
    });
    it.each([401,403])('classifies HTTP %s as auth', async status => {
        await expect(fetchXueqiuJson(scriptPage('{}',status),'https://xueqiu.com/test')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    });
    it('classifies explicit HTML challenge on HTTP 200 as auth', async () => {
        await expect(fetchXueqiuJson(scriptPage('<html>安全验证 captcha</html>',200,'text/html'),'https://xueqiu.com/test')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    });
    it('does not call generic HTML an authentication failure', async () => {
        await expect(fetchXueqiuJson(scriptPage('<html>unavailable</html>',200,'text/html'),'https://xueqiu.com/test')).rejects.toMatchObject({code:'COMMAND_EXEC',message:expect.stringContaining('content-type=text/html')});
    });
    it('honors HTTP failures despite success-shaped JSON', async () => {
        await expect(fetchXueqiuJson(scriptPage('{"stocks":[]}',429),'https://xueqiu.com/test')).rejects.toMatchObject({code:'COMMAND_EXEC',message:expect.stringContaining('HTTP 429')});
    });
    it('wraps page-side network exceptions as typed errors', async () => {
        await expect(fetchXueqiuJson({evaluate:async()=>{throw new TypeError('Failed to fetch');}},'https://xueqiu.com/test')).rejects.toMatchObject({code:'COMMAND_EXEC'});
    });
    it.each(['','null','[]','1','broken'])('rejects unusable JSON %s', async body => {
        await expect(fetchXueqiuJson(scriptPage(body),'https://xueqiu.com/test')).rejects.toMatchObject({code:'COMMAND_EXEC'});
    });
    it('summarizes shape without exposing response values or raw HTML', () => {
        const summary = responseSummary({status:200,contentType:'application/json',json:{token:'SECRET',message:'PRIVATE'},textSnippet:'SENSITIVE HTML'});
        expect(summary).toContain('keys=[token,message]');
        expect(summary).not.toMatch(/SECRET|PRIVATE|SENSITIVE/);
    });
});

import { getRegistry } from '@jackwener/opencli/registry';
import './hot.js';
import './search.js';
it.each(['hot','search'])('does not turn missing %s payload into empty success', async name => {
    const page = {...scriptPage('{"error_code":"changed"}'), goto:async()=>{}};
    const command = getRegistry().get(`xueqiu/${name}`);
    await expect(command.func(page,{query:'test',limit:1})).rejects.toMatchObject({code:'COMMAND_EXEC',message:expect.stringContaining('array')});
});
