/** Shared helpers for Similarweb adapters. */

const SUFFIX_MULTIPLIER = { K: 1e3, M: 1e6, B: 1e9 };

/** Parse a Similarweb-formatted compact number like "9.3M", "65.15%", "#7,941". */
export function parseCompactNumber(input) {
    if (input === null || input === undefined)
        return null;
    const raw = String(input).trim();
    if (!raw || /^(n\/a|--?|-|\?\?[A-Z]?)$/i.test(raw))
        return null;
    const m = raw.match(/^#?([\d,.]+)\s*([KMB])?$/i);
    if (!m)
        return null;
    const num = Number.parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(num))
        return null;
    const suffix = m[2] ? m[2].toUpperCase() : '';
    const mult = suffix ? SUFFIX_MULTIPLIER[suffix] : 1;
    return num * mult;
}

/** Parse a percentage string like "65.15%" or "23.65%" into a plain number. */
export function parsePercent(input) {
    if (input === null || input === undefined)
        return null;
    const raw = String(input).trim();
    const m = raw.match(/^(-?[\d.]+)\s*%$/);
    if (!m)
        return null;
    const num = Number.parseFloat(m[1]);
    return Number.isNaN(num) ? null : num;
}

/** Parse "mm:ss" or "hh:mm:ss" duration text into total seconds. */
export function parseDurationSeconds(input) {
    if (input === null || input === undefined)
        return null;
    const raw = String(input).trim();
    const parts = raw.split(':').map((p) => Number.parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p)))
        return null;
    if (parts.length === 2)
        return parts[0] * 60 + parts[1];
    if (parts.length === 3)
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

export const __test__ = { SUFFIX_MULTIPLIER };
