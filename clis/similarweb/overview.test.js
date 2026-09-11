import { describe, expect, it, vi } from 'vitest';
import { getRegistry, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import './overview.js';

const FIXTURE = {
    global: { value: '#7,941', info: '' },
    countryRank: { value: '#12,471', info: '美国' },
    categoryRank: { value: '#28031', info: '计算机电子与技术 > 编程和开发软件（在美国）' },
    monthlyVisits: '9.3M',
    visitsChange: '23.65%',
    bounceRate: '65.15%',
    pagesPerVisit: '2.06',
    avgDuration: '00:02:30',
    countries: [
        { country: '美国', share: '13.29%', change: '23.72%' },
        { country: '英国', share: '9.61%', change: '74.88%' },
    ],
    sources: [
        { source: '显示广告', percentage: '46.46%', position: '第 1 名' },
        { source: '直接', percentage: '', position: '第 2 名' },
        { source: '外链', percentage: '', position: '第 3 名' },
    ],
};

function createPageMock({ data = FIXTURE } = {}) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValueOnce(data),
    };
}

describe('similarweb overview', () => {
    const command = getRegistry().get('similarweb/overview');

    it('is registered as a read-only UI command', () => {
        expect(command).toMatchObject({ access: 'read', strategy: Strategy.UI });
    });

    it('parses the public overview report into the documented columns', async () => {
        const page = createPageMock();
        const rows = await command.func(page, { domain: 'example.com' });
        expect(rows).toEqual([{
            domain: 'example.com',
            global_rank: 7941,
            country: '美国',
            country_rank: 12471,
            category: '计算机电子与技术 > 编程和开发软件（在美国）',
            category_rank: 28031,
            monthly_visits: 9300000,
            visits_change_pct: 23.65,
            bounce_rate_pct: 65.15,
            pages_per_visit: 2.06,
            avg_visit_duration_sec: 150,
            top_countries: [
                { country: '美国', share_pct: 13.29, change_pct: 23.72 },
                { country: '英国', share_pct: 9.61, change_pct: 74.88 },
            ],
            top_traffic_sources: [
                { source: '显示广告', share_pct: 46.46, rank: '第 1 名' },
                { source: '直接', share_pct: null, rank: '第 2 名' },
                { source: '外链', share_pct: null, rank: '第 3 名' },
            ],
        }]);
        expect(page.goto).toHaveBeenCalledWith('https://www.similarweb.com/website/example.com/');
    });

    it('strips protocol and path from a full URL argument', async () => {
        const page = createPageMock();
        await command.func(page, { domain: 'https://example.com/some/path' });
        expect(page.goto).toHaveBeenCalledWith('https://www.similarweb.com/website/example.com/');
    });

    it('throws EmptyResultError when the report did not render', async () => {
        const page = createPageMock({ data: { global: null } });
        await expect(command.func(page, { domain: 'example.com' })).rejects.toBeInstanceOf(EmptyResultError);
    });

    it('throws EmptyResultError instead of returning an all-null row when the rank card is stuck on its "- -" loading placeholder', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue({ ...FIXTURE, global: { value: '- -', info: '' } }),
        };
        await expect(command.func(page, { domain: 'example.com' })).rejects.toBeInstanceOf(EmptyResultError);
        // 4 poll attempts, each followed by a wait — never a 5th evaluate call.
        expect(page.evaluate).toHaveBeenCalledTimes(4);
    });

    it('polls past a transient "- -" loading placeholder instead of failing immediately', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce({ ...FIXTURE, global: { value: '- -', info: '' } })
                .mockResolvedValueOnce(FIXTURE),
        };
        const rows = await command.func(page, { domain: 'example.com' });
        expect(rows[0].global_rank).toBe(7941);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
    });
});
