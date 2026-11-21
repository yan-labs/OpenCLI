import { describe, expect, it } from 'vitest';
import { Strategy, getRegistry } from '@jackwener/opencli/registry';
import './hot.js';
import './posts.js';
import './read.js';
import './search.js';
describe('tieba commands', () => {

    it('rejects tieba read results when navigation lands on the wrong page number', async () => {
        const read = getRegistry().get('tieba/read');
        expect(read).toBeDefined();
        expect(typeof read?.func).toBe('function');
        const run = read?.func;
        if (!run)
            throw new Error('tieba/read did not register a handler');
        const page = {
            goto: async () => undefined,
            evaluate: async () => ({
                pageMeta: {
                    pathname: '/p/10163164720',
                    pn: '1',
                },
                mainPost: {
                    title: '测试帖子',
                    author: '作者',
                    contentText: '正文',
                    structuredText: '',
                    visibleTime: '2026-03-29 12:00',
                    structuredTime: 0,
                    hasMedia: false,
                },
                replies: [],
            }),
        };
        await expect(run(page, {
            id: '10163164720',
            page: 2,
            limit: 5,
        })).rejects.toMatchObject({
            code: 'EMPTY_RESULT',
            hint: expect.stringMatching(/requested page/i),
        });
    });
});
