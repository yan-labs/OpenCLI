import { describe, expect, it } from 'vitest';
import { parseCompactNumber, parsePercent, parseDurationSeconds } from './utils.js';

describe('similarweb utils: parseCompactNumber', () => {
    it('parses K/M/B suffixes and rank hashes', () => {
        expect(parseCompactNumber('9.3M')).toBe(9300000);
        expect(parseCompactNumber('#7,941')).toBe(7941);
        expect(parseCompactNumber('#12,471')).toBe(12471);
    });

    it('returns null for placeholder / unknown values', () => {
        expect(parseCompactNumber('??B')).toBeNull();
        expect(parseCompactNumber(null)).toBeNull();
        expect(parseCompactNumber('')).toBeNull();
    });
});

describe('similarweb utils: parsePercent', () => {
    it('parses percentages', () => {
        expect(parsePercent('65.15%')).toBe(65.15);
        expect(parsePercent('23.65%')).toBe(23.65);
    });

    it('returns null for non-percentage input', () => {
        expect(parsePercent(null)).toBeNull();
        expect(parsePercent('n/a')).toBeNull();
    });
});

describe('similarweb utils: parseDurationSeconds', () => {
    it('parses mm:ss', () => {
        expect(parseDurationSeconds('02:30')).toBe(150);
        expect(parseDurationSeconds('00:02:30')).toBe(150);
    });

    it('returns null for unparsable input', () => {
        expect(parseDurationSeconds(null)).toBeNull();
        expect(parseDurationSeconds('n/a')).toBeNull();
    });
});
