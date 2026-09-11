import { describe, expect, it, vi } from 'vitest';
import { getRegistry, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import './analytics-overview.js';

const FIXTURE = {
    as: ['Authority Score', '53', '高'],
    ot: ['自然流量', '61.5K', '-27%'],
    pt: ['付费流量', '235', '-71%'],
    ref: ['引荐域名', '730.8K'],
    ok: ['自然搜索关键词', '1.8K', '-0.7%'],
    pk: ['付费关键词', '8', '-50%'],
    bl: ['反向链接', '321.5M'],
};

function createPageMock({ url = 'https://zh.semrush.com/analytics/overview/?q=example.com&searchType=domain', data = FIXTURE } = {}) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn()
            .mockResolvedValueOnce(url)
            .mockResolvedValueOnce(data),
    };
}

describe('semrush analytics-overview', () => {
    const command = getRegistry().get('semrush/analytics-overview');

    it('is registered as a read-only UI command', () => {
        expect(command).toMatchObject({ access: 'read', strategy: Strategy.UI });
    });

    it('parses the Domain Overview summary card into the documented columns', async () => {
        const page = createPageMock();
        const rows = await command.func(page, { domain: 'example.com' });
        expect(rows).toEqual([{
            domain: 'example.com',
            authority_score: 53,
            authority_rating: '高',
            organic_traffic: 61500,
            organic_traffic_change_pct: -27,
            paid_traffic: 235,
            paid_traffic_change_pct: -71,
            referring_domains: 730800,
            organic_keywords: 1800,
            organic_keywords_change_pct: -0.7,
            paid_keywords: 8,
            paid_keywords_change_pct: -50,
            backlinks: 321500000,
        }]);
        expect(page.goto).toHaveBeenCalledWith('https://www.semrush.com/analytics/overview/?q=example.com&searchType=domain');
    });

    it('strips protocol and path from a full URL argument', async () => {
        const page = createPageMock();
        await command.func(page, { domain: 'https://example.com/some/path' });
        expect(page.goto.mock.calls[0][0]).toContain('q=example.com&');
    });

    it('throws AuthRequiredError when redirected to the login page', async () => {
        const page = createPageMock({ url: 'https://www.semrush.com/sso/login?next=/analytics/overview/' });
        await expect(command.func(page, { domain: 'example.com' })).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('throws EmptyResultError when the summary card did not render', async () => {
        const page = createPageMock({ data: { as: null } });
        await expect(command.func(page, { domain: 'example.com' })).rejects.toBeInstanceOf(EmptyResultError);
    });
});
