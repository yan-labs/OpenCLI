import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, CommandExecutionError, LoginWallError } from '@jackwener/opencli/errors';
import { fetchLinuxDoJson, __test__ } from './feed.js';
describe('linux-do feed metadata resolution', () => {
    afterEach(() => {
        __test__.resetMetadataCaches();
    });

    it('executes the browser sniffer for an HTML 403 response', async () => {
        const page = {
            evaluate: vi.fn((source) => new Function('fetch', `return ${source}`)(vi.fn().mockResolvedValue({
                status: 403,
                ok: false,
                url: 'https://linux.do/latest.json',
                headers: { get: () => 'text/html; charset=utf-8' },
                text: async () => '<html><title>Access denied</title>',
            }))),
        };
        await expect(fetchLinuxDoJson(page, '/latest.json', { skipNavigate: true }))
            .rejects.toBeInstanceOf(LoginWallError);
    });

    it('maps a valid browser JSON envelope and uses the shared response sniffer', async () => {
        const page = {
            evaluate: vi.fn().mockResolvedValue({ kind: 'ok', data: { topic_list: { topics: [] } } }),
        };
        await expect(fetchLinuxDoJson(page, '/latest.json', { skipNavigate: true }))
            .resolves.toEqual({ topic_list: { topics: [] } });
        expect(page.evaluate.mock.calls[0][0]).toContain('fetchJsonOrLoginWall');
    });

    it('distinguishes login walls, auth responses, rate limits, and bridge failures', async () => {
        const loginWall = {
            kind: 'login-wall',
            sentinel: {
                __loginWall: true,
                status: 403,
                url: 'https://linux.do/latest.json',
                contentType: 'text/html',
                bodyPreview: '<html><title>Access denied</title>',
            },
        };
        await expect(fetchLinuxDoJson({ evaluate: vi.fn().mockResolvedValue(loginWall) }, '/latest.json', { skipNavigate: true }))
            .rejects.toBeInstanceOf(LoginWallError);
        await expect(fetchLinuxDoJson({ evaluate: vi.fn().mockResolvedValue({ kind: 'http', status: 403 }) }, '/latest.json', { skipNavigate: true }))
            .rejects.toBeInstanceOf(AuthRequiredError);
        await expect(fetchLinuxDoJson({ evaluate: vi.fn().mockResolvedValue({ kind: 'http', status: 429 }) }, '/latest.json', { skipNavigate: true }))
            .rejects.toMatchObject({ hint: expect.stringContaining('Stop retrying') });
        await expect(fetchLinuxDoJson({ evaluate: vi.fn().mockResolvedValue({ kind: 'http', status: 'bad' }) }, '/latest.json', { skipNavigate: true }))
            .rejects.toThrow('non-numeric HTTP status');
        await expect(fetchLinuxDoJson({ evaluate: vi.fn().mockResolvedValue({ kind: 'exception', detail: 'bridge failed' }) }, '/latest.json', { skipNavigate: true }))
            .rejects.toBeInstanceOf(CommandExecutionError);
    });
    it('builds the replacement URL for legacy latest', async () => {
        const request = await __test__.resolveFeedRequest(null, {
            view: 'latest',
            limit: 20,
        });
        expect(request.url).toBe('/latest.json?per_page=20');
    });
    it('builds the replacement URL for legacy hot weekly', async () => {
        const request = await __test__.resolveFeedRequest(null, {
            view: 'top',
            period: 'weekly',
            limit: 20,
        });
        expect(request.url).toBe('/top.json?per_page=20&period=weekly');
    });
    it('prefers live tag metadata over the bundled snapshot', async () => {
        __test__.setLiveMetadataForTests({
            tags: [{ id: 9999, slug: 'fresh-tag', name: 'Fresh Tag' }],
        });
        const request = await __test__.resolveFeedRequest(null, {
            tag: 'Fresh Tag',
            view: 'latest',
            limit: 20,
        });
        expect(request.url).toBe('/tag/fresh-tag/9999.json?per_page=20');
    });
    it('uses live category metadata with parent paths for subcategories', async () => {
        __test__.setLiveMetadataForTests({
            categories: [
                {
                    id: 10,
                    name: 'Parent',
                    description: '',
                    slug: 'parent',
                    parentCategoryId: null,
                    parent: null,
                },
                {
                    id: 11,
                    name: 'Fresh Child',
                    description: '',
                    slug: 'fresh-child',
                    parentCategoryId: 10,
                    parent: {
                        id: 10,
                        name: 'Parent',
                        description: '',
                        slug: 'parent',
                        parentCategoryId: null,
                    },
                },
            ],
        });
        const request = await __test__.resolveFeedRequest(null, {
            category: 'Fresh Child',
            view: 'hot',
            limit: 20,
        });
        expect(request.url).toBe('/c/parent/fresh-child/11/l/hot.json?per_page=20');
    });
    it('accepts parent/name category paths for subcategories', async () => {
        __test__.setLiveMetadataForTests({
            categories: [
                {
                    id: 10,
                    name: 'Parent',
                    description: '',
                    slug: 'parent',
                    parentCategoryId: null,
                    parent: null,
                },
                {
                    id: 11,
                    name: 'Fresh Child',
                    description: '',
                    slug: 'fresh-child',
                    parentCategoryId: 10,
                    parent: {
                        id: 10,
                        name: 'Parent',
                        description: '',
                        slug: 'parent',
                        parentCategoryId: null,
                    },
                },
            ],
        });
        const request = await __test__.resolveFeedRequest(null, {
            category: 'Parent / Fresh Child',
            view: 'latest',
            limit: 20,
        });
        expect(request.url).toBe('/c/parent/fresh-child/11.json?per_page=20');
    });
    it('builds the replacement URL for legacy category id', async () => {
        __test__.setLiveMetadataForTests({
            categories: [
                {
                    id: 4,
                    name: '开发调优',
                    description: '',
                    slug: 'develop',
                    parentCategoryId: null,
                    parent: null,
                },
            ],
        });
        const request = await __test__.resolveFeedRequest(null, {
            category: '4',
            view: 'latest',
            limit: 20,
        });
        expect(request.url).toBe('/c/develop/4.json?per_page=20');
    });
    it('falls back to cached metadata when live metadata is unavailable', async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-linux-do-cache-'));
        __test__.setCacheDirForTests(cacheDir);
        fs.writeFileSync(path.join(cacheDir, 'tags.json'), JSON.stringify({
            fetchedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            data: [{ id: 3, slug: 'chatgpt', name: 'ChatGPT' }],
        }));
        fs.writeFileSync(path.join(cacheDir, 'categories.json'), JSON.stringify({
            fetchedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            data: [{
                    id: 4,
                    name: '开发调优',
                    description: '',
                    slug: 'develop',
                    parentCategoryId: null,
                    parent: null,
                }],
        }));
        const request = await __test__.resolveFeedRequest(null, {
            tag: 'ChatGPT',
            category: '开发调优',
            view: 'top',
            period: 'monthly',
            limit: 20,
        });
        expect(request.url).toContain('/tags/c/develop/4/chatgpt/3/l/top.json');
        expect(request.url).toContain('per_page=20');
        expect(request.url).toContain('period=monthly');
    });
});
