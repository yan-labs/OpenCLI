import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { getRegistry } from '@jackwener/opencli/registry';
import { dblpFetchSearch, dblpFetchXml } from './browser.js';
import './search.js';
import './author.js';
import './venue.js';
import './paper.js';
const doms = [];
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });
const record = '<inproceedings key="conf/test/Example"><author>J&ouml;rg 0001</author><title>A &amp; B.</title><year>2026</year><booktitle>TEST</booktitle><ee>https://doi.org/10.1/example</ee></inproceedings>';
const searchXml = info => `<result><status code="200">OK</status><hits total="1"><hit score="1" id="0"><info>${info}</info></hit></hits></result>`;
function fixture(responses) {
    const dom = new JSDOM('<title>dblp</title>', { url: 'https://example.invalid', runScripts: 'outside-only' });
    doms.push(dom);
    const fetch = vi.fn(async url => {
        const response = responses.shift();
        if (!response) throw new Error('Unexpected extra request');
        return { ok: (response.status || 200) < 400, status: response.status || 200, url, headers: { get: () => response.type || 'application/xml' }, text: async () => response.text };
    });
    dom.window.fetch = fetch;
    const page = {
        goto: vi.fn(async url => dom.reconfigure({ url })),
        wait: vi.fn(),
        evaluate: vi.fn(async script => dom.window.eval(script)),
        evaluateOnce: vi.fn(async script => dom.window.eval(script)),
    };
    return { page, fetch, dom };
}
describe('DBLP browser transport', () => {
    it('runs publication search through XML and maps one hit, multiple authors and mixed title markup', async () => {
        const f = fixture([{ text: searchXml('<authors><author pid="1/2">J&ouml;rg 0001</author><author>Other</author></authors><title>A <i>mixed</i> title.</title><key>conf/test/Example</key><year>2026</year><type>Conference and Workshop Papers</type>') }]);
        const rows = await getRegistry().get('dblp/search').func(f.page, { query: 'A & B', limit: 1 });
        expect(rows).toMatchObject([{ title: 'A mixed title', authors: 'Jörg, Other', type: 'conf', key: 'conf/test/Example' }]);
        const url = new URL(f.fetch.mock.calls[0][0]);
        expect(url.searchParams.get('q')).toBe('A & B');
        expect(url.searchParams.get('format')).toBe('xml');
        expect(f.page.goto).toHaveBeenCalledTimes(1);
        expect(f.page.evaluateOnce).toHaveBeenCalledTimes(1);
    });
    it('resolves an author and fetches publications in the same browser context', async () => {
        const f = fixture([{ text: searchXml('<author>Jörg</author><url>https://dblp.org/pid/1/2</url>') }, { text: `<dblpperson><r>${record}</r></dblpperson>` }]);
        const rows = await getRegistry().get('dblp/author').func(f.page, { author: 'Jörg' });
        expect(rows).toMatchObject([{ pid: '1/2', title: 'A & B', authors: 'Jörg' }]);
        expect(f.fetch).toHaveBeenCalledTimes(2);
        expect(f.page.goto).toHaveBeenCalledTimes(1);
    });
    it('reads paper metadata including named DTD characters', async () => {
        const f = fixture([{ text: `<?xml version="1.0"?><!DOCTYPE dblp SYSTEM "dblp.dtd"><dblp>${record}</dblp>` }]);
        await expect(getRegistry().get('dblp/paper').func(f.page, { key: 'conf/test/Example' })).resolves.toMatchObject([{ authors: 'Jörg', title: 'A & B' }]);
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('reads venue metadata', async () => {
        const f = fixture([{ text: searchXml('<venue>Test Conference</venue><acronym>TEST</acronym><type>Conference or Workshop</type><url>https://dblp.org/db/conf/test/</url>') }]);
        await expect(getRegistry().get('dblp/venue').func(f.page, { query: 'TEST' })).resolves.toMatchObject([{ acronym: 'TEST', type: 'conf' }]);
    });
    it.each([
        [{ status: 202, type: 'text/html', text: '<html><title>Making sure you are not a bot!</title>anubis</html>' }, 'SECURITY_BLOCK'],
        [{ status: 429, text: 'slow down' }, 'RATE_LIMITED'],
        [{ status: 404, text: '' }, 'EMPTY_RESULT'],
        [{ text: '<html><title>Homepage</title></html>', type: 'text/html' }, 'COMMAND_EXEC'],
        [{ text: '<dblp><broken>' }, 'COMMAND_EXEC'],
        [{ text: '<other/>' }, 'COMMAND_EXEC'],
    ])('reports unsuccessful responses without retry or empty success', async (response, code) => {
        const f = fixture([response]);
        await expect(dblpFetchXml(f.page, '/rec/test.xml', 'test')).rejects.toMatchObject({ code });
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('waits boundedly for a browser challenge and does not issue API requests', async () => {
        const f = fixture([]); f.dom.window.document.title = 'Making sure you are not a bot!';
        await expect(dblpFetchSearch(f.page, '/search/publ/api', 'test')).rejects.toMatchObject({ code: 'SECURITY_BLOCK' });
        expect(f.page.wait).toHaveBeenCalledTimes(15);
        expect(f.fetch).not.toHaveBeenCalled();
    });
    it('continues when normal browser verification settles', async () => {
        const f = fixture([{ text: '<result><status code="200">OK</status><hits total="0"/></result>' }]);
        f.dom.window.document.title = 'Anubis';
        f.page.wait.mockImplementation(async () => { f.dom.window.document.title = 'dblp'; });
        await expect(getRegistry().get('dblp/search').func(f.page, { query: 'none' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('rejects invalid arguments before navigation or page reads', async () => {
        const f = fixture([]);
        await expect(getRegistry().get('dblp/paper').func(f.page, { key: 'invalid' })).rejects.toMatchObject({ code: 'ARGUMENT' });
        expect(f.page.goto).not.toHaveBeenCalled();
        expect(f.page.evaluate).not.toHaveBeenCalled();
    });
    it('preserves API failures instead of returning empty search rows', async () => {
        const f = fixture([{ text: '<result><status code="500">Unavailable</status><hits total="0"/></result>' }]);
        await expect(dblpFetchSearch(f.page, '/search/publ/api', 'test')).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    });
});
