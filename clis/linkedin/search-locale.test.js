import { describe, expect, it, vi } from 'vitest';

const registration = vi.hoisted(() => ({ command: null }));

vi.mock('@jackwener/opencli/registry', () => ({
    cli: (command) => { registration.command = command; },
    Strategy: { COOKIE: 'cookie' },
}));

import './search.js';

describe('LinkedIn search on a localized page', () => {
    it('uses authenticated API results without requiring an English navigation label', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockRejectedValue(new Error('Text not found: Jobs')),
            getCookies: vi.fn().mockResolvedValue([
                { name: 'JSESSIONID', value: '"fixture-session"' },
            ]),
            evaluate: vi.fn()
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce({
                    elements: [{
                        jobCardUnion: {
                            jobPostingCard: {
                                jobPostingUrn: 'urn:li:jobPosting:123',
                                jobPostingTitle: '数据科学实习生',
                                primaryDescription: { text: '研究实验室' },
                                secondaryDescription: { text: '香港' },
                            },
                        },
                    }],
                }),
        };

        const rows = await registration.command.func(page, {
            query: 'research intern', location: 'Hong Kong', limit: 1,
        });

        expect(rows).toEqual([{
            rank: 1,
            title: '数据科学实习生',
            company: '研究实验室',
            location: '香港',
            listed: '',
            salary: '',
            url: 'https://www.linkedin.com/jobs/view/123',
        }]);
        expect(page.wait).not.toHaveBeenCalled();
        expect(page.evaluate).toHaveBeenCalledTimes(2);
    });
});
