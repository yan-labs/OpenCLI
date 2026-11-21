import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import './company.js';

const { normalizeCompanyInfo, normalizeCompanyUrl } = await import('./company.js').then((m) => m.__test__);

function makePage(evaluateResult) {
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        // assertLinkedInAuthenticated + the extraction both call evaluate; the
        // first returns the auth-wall boolean (false = authed), the second the info.
        evaluate: vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(evaluateResult),
    };
}

describe('linkedin company', () => {
    it('reads current h2/sibling facts and legacy h1/definition-list layouts through the command', async () => {
        for (const modern of [true, false]) {
            const facts = [['Website', 'https://example.com'], ['Industry', 'Software'], ['Company size', '11-50 employees'], ['Headquarters', 'Paris'], ['Founded', '2020'], ['Specialties', 'Tools']];
            const html = `<main><${modern ? 'h2' : 'h1'}>Example Corp</${modern ? 'h2' : 'h1'}><section><h2>Overview</h2><p>Useful tools.</p>${facts.map(([label, value]) => modern ? `<div><p><span>${label}</span></p><p>${value}</p></div>` : `<dl><dt>${label}</dt><dd>${value}</dd></dl>`).join('')}</section></main>`;
            const dom = new JSDOM(html, { url: 'https://www.linkedin.com/company/example/about/', runScripts: 'outside-only' });
            Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
            const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce(false).mockImplementation(script => dom.window.eval(script)) };
            try {
                const rows = await getRegistry().get('linkedin/company').func(page, { company: 'example' });
                expect(rows[0]).toMatchObject({ name: 'Example Corp', industry: 'Software', size: '11-50 employees', headquarters: 'Paris', founded: '2020', website: 'https://example.com', specialties: 'Tools' });
            } finally { dom.window.close(); }
        }
    });

    it('normalizes bare name, path, and URL to the about page', () => {
        expect(normalizeCompanyUrl('nvidia')).toBe('https://www.linkedin.com/company/nvidia/about/');
        expect(normalizeCompanyUrl('/company/nvidia')).toBe('https://www.linkedin.com/company/nvidia/about/');
        expect(normalizeCompanyUrl('https://www.linkedin.com/company/databricks/')).toBe('https://www.linkedin.com/company/databricks/about/');
    });

    it('rejects empty or malformed company identifiers', () => {
        expect(() => normalizeCompanyUrl('')).toThrow(CommandExecutionError);
        expect(() => normalizeCompanyUrl('bad name!')).toThrow(CommandExecutionError);
        expect(() => normalizeCompanyUrl('https://www.linkedin.com/in/someone/')).toThrow(CommandExecutionError);
        expect(() => normalizeCompanyUrl('https://evil.example/company/nvidia/')).toThrow(CommandExecutionError);
        expect(() => normalizeCompanyUrl('https://www.linkedin.com/company/%E0%A4%A')).toThrow(CommandExecutionError);
    });

    it('maps extracted company facts to a row', async () => {
        const cmd = getRegistry().get('linkedin/company');
        expect(cmd?.func).toBeTypeOf('function');
        const page = makePage({
            url: 'https://www.linkedin.com/company/nvidia/about/',
            name: 'NVIDIA',
            industry: 'Computer Hardware Manufacturing',
            size: '10,001+ employees',
            headquarters: 'Santa Clara, CA',
            founded: '1993',
            website: 'http://www.nvidia.com',
            specialties: 'GPU, AI',
            followers: '42040089',
            about: 'Accelerated computing.',
        });
        await expect(cmd.func(page, { company: 'nvidia' })).resolves.toEqual([
            {
                name: 'NVIDIA',
                industry: 'Computer Hardware Manufacturing',
                size: '10,001+ employees',
                headquarters: 'Santa Clara, CA',
                founded: '1993',
                website: 'http://www.nvidia.com',
                specialties: 'GPU, AI',
                followers: 42040089,
                about: 'Accelerated computing.',
                url: 'https://www.linkedin.com/company/nvidia/about/',
            },
        ]);
    });

    it('throws when no company name is found', async () => {
        const cmd = getRegistry().get('linkedin/company');
        const page = makePage({ url: 'x', name: '', industry: '' });
        await expect(cmd.func(page, { company: 'ghost' })).rejects.toBeInstanceOf(CommandExecutionError);
    });

    it('normalizes the emitted URL to a LinkedIn company about URL', () => {
        expect(normalizeCompanyInfo({
            url: 'https://www.linkedin.com/company/nvidia/posts/?trk=public_profile',
            name: 'NVIDIA',
            followers: '123',
        }, 'https://www.linkedin.com/company/nvidia/about/')).toMatchObject({
            url: 'https://www.linkedin.com/company/nvidia/about/',
            followers: 123,
        });
    });

    it('throws when extraction ends outside a LinkedIn company page', () => {
        expect(() => normalizeCompanyInfo({
            url: 'https://www.linkedin.com/in/not-a-company/',
            name: 'NVIDIA',
        }, 'https://www.linkedin.com/company/nvidia/about/')).toThrow(CommandExecutionError);
        expect(() => normalizeCompanyInfo({
            url: 'https://evil.example/company/nvidia/',
            name: 'NVIDIA',
        }, 'https://www.linkedin.com/company/nvidia/about/')).toThrow(CommandExecutionError);
    });

    it('throws on malformed follower counts instead of emitting NaN', () => {
        expect(() => normalizeCompanyInfo({
            url: 'https://www.linkedin.com/company/nvidia/about/',
            name: 'NVIDIA',
            followers: 'many',
        }, 'https://www.linkedin.com/company/nvidia/about/')).toThrow(CommandExecutionError);
    });
});
