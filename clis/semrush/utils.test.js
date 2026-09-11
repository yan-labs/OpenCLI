import { describe, expect, it } from 'vitest';
import { parseCompactNumber, parsePercent, parseLeadingNumber } from './utils.js';

describe('semrush utils: parseCompactNumber', () => {
    it('parses K/M/B suffixes', () => {
        expect(parseCompactNumber('61.5K')).toBe(61500);
        expect(parseCompactNumber('321.5M')).toBe(321500000);
        expect(parseCompactNumber('1.2B')).toBe(1200000000);
    });

    it('parses plain integers', () => {
        expect(parseCompactNumber('235')).toBe(235);
        expect(parseCompactNumber('8')).toBe(8);
    });

    it('parses values with thousands separators', () => {
        expect(parseCompactNumber('1,234')).toBe(1234);
    });

    it('returns null for N/A-ish or empty input', () => {
        expect(parseCompactNumber('不可用')).toBeNull();
        expect(parseCompactNumber('N/A')).toBeNull();
        expect(parseCompactNumber('')).toBeNull();
        expect(parseCompactNumber(null)).toBeNull();
        expect(parseCompactNumber(undefined)).toBeNull();
    });

    it('returns null for unparsable garbage instead of NaN', () => {
        expect(parseCompactNumber('abc')).toBeNull();
    });
});

describe('semrush utils: parsePercent', () => {
    it('parses signed percentages', () => {
        expect(parsePercent('-27%')).toBe(-27);
        expect(parsePercent('-0.7%')).toBe(-0.7);
        expect(parsePercent('83%')).toBe(83);
    });

    it('returns null for non-percentage input', () => {
        expect(parsePercent('不可用')).toBeNull();
        expect(parsePercent(null)).toBeNull();
        expect(parsePercent('N/A')).toBeNull();
    });
});

describe('semrush utils: parseLeadingNumber', () => {
    it('extracts the leading number and drops trailing labels', () => {
        expect(parseLeadingNumber('71%困难')).toBe(71);
        expect(parseLeadingNumber('0.88')).toBe(0.88);
        expect(parseLeadingNumber('1.00')).toBe(1);
    });

    it('returns null when there is no leading number', () => {
        expect(parseLeadingNumber('不可用')).toBeNull();
        expect(parseLeadingNumber(null)).toBeNull();
    });
});
