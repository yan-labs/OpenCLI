import { describe, expect, it, vi } from 'vitest';
import { getRegistry, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, EmptyResultError } from '@jackwener/opencli/errors';
import './keyword-magic.js';

const ROW = {
    keyword: 'running shoes​',
    intent: 'C',
    volume: '246.0K',
    kd: '71',
    cpc: '0.88',
    comp: '1.00',
    serpFeatures: '9',
    results: '238',
    updated: '1 个月',
};

function createPageMock({ url = 'https://www.semrush.com/analytics/keywordmagic/?q=running+shoes&db=us', rows = [ROW] } = {}) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn()
            .mockResolvedValueOnce(url)
            .mockResolvedValueOnce(rows),
    };
}

describe('semrush keyword-magic', () => {
    const command = getRegistry().get('semrush/keyword-magic');

    it('is registered as a read-only UI command', () => {
        expect(command).toMatchObject({ access: 'read', strategy: Strategy.UI });
    });

    it('parses table rows into the documented columns and strips zero-width chars', async () => {
        const page = createPageMock();
        const rows = await command.func(page, { seed: 'running shoes', country: 'us', limit: 20 });
        expect(rows).toEqual([{
            keyword: 'running shoes',
            intent: 'C',
            volume: 246000,
            kd: 71,
            cpc: 0.88,
            competition: 1,
            serp_features: 9,
            results: 238,
            updated: '1 个月',
        }]);
    });

    it('respects the limit argument', async () => {
        const page = createPageMock({ rows: [ROW, { ...ROW, keyword: 'trail running shoes' }, { ...ROW, keyword: 'best running shoes' }] });
        const rows = await command.func(page, { seed: 'running shoes', limit: 2 });
        expect(rows).toHaveLength(2);
    });

    it('throws AuthRequiredError when redirected to the login page', async () => {
        const page = createPageMock({ url: 'https://www.semrush.com/sso/login' });
        await expect(command.func(page, { seed: 'running shoes' })).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('throws EmptyResultError when the table did not render (e.g. plan/quota block)', async () => {
        const page = createPageMock({ rows: [] });
        await expect(command.func(page, { seed: 'running shoes' })).rejects.toBeInstanceOf(EmptyResultError);
    });

    it('drops empty placeholder rows for paywalled/blurred results on a free plan', async () => {
        const EMPTY_ROW = { keyword: '', intent: '', volume: '', kd: '', cpc: '', comp: '', serpFeatures: '', results: '', updated: '' };
        const page = createPageMock({ rows: [ROW, EMPTY_ROW, EMPTY_ROW] });
        const rows = await command.func(page, { seed: 'running shoes', limit: 20 });
        expect(rows).toHaveLength(1);
        expect(rows[0].keyword).toBe('running shoes');
    });
});
