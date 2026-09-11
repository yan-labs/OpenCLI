import { describe, expect, it, vi } from 'vitest';
import { getRegistry, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import './keyword-overview.js';

const FIXTURE = {
    volume: '246.0K',
    globalVolume: '657.4K',
    kd: '71%困难',
    intent: '意图商务',
    metrics: 'CPC$0.88竞争激烈程度1.00谷歌购物广告不可用广告不可用',
    trendBars: [81, 44, 66, 66, 54, 66, 44, 54, 44, 81, 100, 81],
};

function createPageMock({ url = 'https://www.semrush.com/analytics/keywordoverview/?q=running+shoes&db=us', data = FIXTURE } = {}) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn()
            .mockResolvedValueOnce(url)
            .mockResolvedValueOnce(data),
    };
}

describe('semrush keyword-overview', () => {
    const command = getRegistry().get('semrush/keyword-overview');

    it('is registered as a read-only UI command', () => {
        expect(command).toMatchObject({ access: 'read', strategy: Strategy.UI });
    });

    it('parses the Keyword Overview widgets into the documented columns', async () => {
        const page = createPageMock();
        const rows = await command.func(page, { keyword: 'running shoes', country: 'us' });
        expect(rows).toEqual([{
            keyword: 'running shoes',
            country: 'us',
            volume: 246000,
            global_volume: 657400,
            kd: 71,
            kd_label: '困难',
            intent: '商务',
            cpc: 0.88,
            competition: 1,
            trend_relative: FIXTURE.trendBars,
        }]);
        expect(page.goto.mock.calls[0][0]).toContain('q=running+shoes');
        expect(page.goto.mock.calls[0][0]).toContain('db=us');
    });

    it('defaults country to us when not given', async () => {
        const page = createPageMock();
        await command.func(page, { keyword: 'running shoes' });
        expect(page.goto.mock.calls[0][0]).toContain('db=us');
    });

    it('throws AuthRequiredError when redirected to the login page', async () => {
        const page = createPageMock({ url: 'https://www.semrush.com/sso/login' });
        await expect(command.func(page, { keyword: 'running shoes' })).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('throws EmptyResultError when volume did not render', async () => {
        const page = createPageMock({ data: { volume: null } });
        await expect(command.func(page, { keyword: 'running shoes' })).rejects.toBeInstanceOf(EmptyResultError);
    });
});
