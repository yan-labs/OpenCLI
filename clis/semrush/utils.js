/** Shared helpers for Semrush adapters (Domain Overview / Keyword Overview / Keyword Magic Tool). */

const SUFFIX_MULTIPLIER = { K: 1e3, M: 1e6, B: 1e9 };

/**
 * Parse a Semrush-formatted compact number like "61.5K", "321.5M", "235", "1.8K"
 * into a plain number. Returns null for "不可用" / "N/A" / empty / unparsable input.
 */
export function parseCompactNumber(input) {
    if (input === null || input === undefined)
        return null;
    const raw = String(input).trim();
    if (!raw || /^(n\/a|不可用|--?|-)$/i.test(raw))
        return null;
    const m = raw.match(/^([\d,.]+)\s*([KMB])?$/i);
    if (!m)
        return null;
    const num = Number.parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(num))
        return null;
    const suffix = m[2] ? m[2].toUpperCase() : '';
    const mult = suffix ? SUFFIX_MULTIPLIER[suffix] : 1;
    return num * mult;
}

/**
 * Parse a signed percentage string like "-27%", "-0.7%", "83%" into a number
 * (sign preserved, no "%"). Returns null for unparsable input.
 */
export function parsePercent(input) {
    if (input === null || input === undefined)
        return null;
    const raw = String(input).trim();
    if (!raw || /^(n\/a|不可用|--?|-)$/i.test(raw))
        return null;
    const m = raw.match(/^(-?[\d.]+)\s*%$/);
    if (!m)
        return null;
    const num = Number.parseFloat(m[1]);
    return Number.isNaN(num) ? null : num;
}

/** Extract the leading integer/float from a string like "71%困难" -> 71, "0.88" -> 0.88. */
export function parseLeadingNumber(input) {
    if (input === null || input === undefined)
        return null;
    const raw = String(input).trim();
    const m = raw.match(/^(-?[\d,.]+)/);
    if (!m)
        return null;
    const num = Number.parseFloat(m[1].replace(/,/g, ''));
    return Number.isNaN(num) ? null : num;
}

export const __test__ = { SUFFIX_MULTIPLIER };
