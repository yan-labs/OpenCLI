import { describe, expect, it } from 'vitest';
import { normalizeCompanyId } from './company.js';

describe('51job company ID input contract', () => {
    it('accepts a URL-safe encrypted ID containing a hyphen unchanged', () => {
        const encCoId = 'UTYHYwNhBTsOalQ-XT4CPA';
        expect(normalizeCompanyId(encCoId)).toBe(encCoId);
    });

    it('preserves alphanumeric IDs and trims surrounding whitespace', () => {
        expect(normalizeCompanyId(' AG9QNF88UmQGYFYxAWA ')).toBe('AG9QNF88UmQGYFYxAWA');
        expect(normalizeCompanyId('company_id')).toBe('company_id');
    });

    it.each([undefined, null, '', '   '])('rejects missing IDs: %s', (value) => {
        expect(() => normalizeCompanyId(value)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    });

    it.each(['../company', 'company/id', 'company?id=1', 'company#fragment', 'co%2fid', 'co id', 'co\\id'])('rejects URL delimiters and path injection: %s', (value) => {
        expect(() => normalizeCompanyId(value)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    });
});
