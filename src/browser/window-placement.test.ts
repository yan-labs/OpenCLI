import { describe, expect, it } from 'vitest';

import {
  parseAutoSelect,
  parseForeignTabPolicy,
  parseWindowBounds,
  resolveDedicatedPlacement,
} from './window-placement.js';

describe('parseWindowBounds', () => {
  it('parses "x,y,w,h" into a bounds rect', () => {
    expect(parseWindowBounds('100,200,1280,900', 'OPENCLI_WINDOW_BOUNDS')).toEqual({
      left: 100, top: 200, width: 1280, height: 900,
    });
  });

  it('allows negative x/y (a display to the left of/above the primary)', () => {
    expect(parseWindowBounds('-2560,-1440,1280,900', 'OPENCLI_WINDOW_BOUNDS')).toEqual({
      left: -2560, top: -1440, width: 1280, height: 900,
    });
  });

  it('rejects a value with the wrong number of parts', () => {
    expect(() => parseWindowBounds('100,200,1280', 'OPENCLI_WINDOW_BOUNDS')).toThrow(/OPENCLI_WINDOW_BOUNDS must be/);
  });

  it('rejects non-integer parts', () => {
    expect(() => parseWindowBounds('100,200,12.5,900', 'OPENCLI_WINDOW_BOUNDS')).toThrow(/OPENCLI_WINDOW_BOUNDS must be/);
    expect(() => parseWindowBounds('a,200,1280,900', 'OPENCLI_WINDOW_BOUNDS')).toThrow(/OPENCLI_WINDOW_BOUNDS must be/);
  });

  it('rejects width/height <= 0', () => {
    expect(() => parseWindowBounds('0,0,0,900', 'OPENCLI_WINDOW_BOUNDS')).toThrow(/width\/height > 0/);
    expect(() => parseWindowBounds('0,0,1280,-1', 'OPENCLI_WINDOW_BOUNDS')).toThrow(/width\/height > 0/);
  });

  it('names the variable passed in, so --window-bounds and OPENCLI_WINDOW_BOUNDS produce distinct messages', () => {
    expect(() => parseWindowBounds('bad', '--window-bounds')).toThrow(/^--window-bounds must be/);
  });
});

describe('parseForeignTabPolicy', () => {
  it('accepts evict and tolerate', () => {
    expect(parseForeignTabPolicy('evict', 'OPENCLI_DEDICATED_FOREIGN_TABS')).toBe('evict');
    expect(parseForeignTabPolicy('tolerate', 'OPENCLI_DEDICATED_FOREIGN_TABS')).toBe('tolerate');
  });

  it('throws naming the variable on anything else', () => {
    expect(() => parseForeignTabPolicy('ignore', 'OPENCLI_DEDICATED_FOREIGN_TABS'))
      .toThrow(/OPENCLI_DEDICATED_FOREIGN_TABS must be one of: evict, tolerate/);
  });
});

describe('parseAutoSelect', () => {
  it('accepts the truthy tokens', () => {
    for (const tok of ['1', 'true', 'on', 'TRUE', 'On']) {
      expect(parseAutoSelect(tok, 'OPENCLI_WINDOW_AUTOSELECT')).toBe(true);
    }
  });

  it('accepts the falsy tokens', () => {
    for (const tok of ['0', 'false', 'off', 'FALSE', 'Off']) {
      expect(parseAutoSelect(tok, 'OPENCLI_WINDOW_AUTOSELECT')).toBe(false);
    }
  });

  it('throws naming the variable on anything else', () => {
    expect(() => parseAutoSelect('yes', 'OPENCLI_WINDOW_AUTOSELECT')).toThrow(/OPENCLI_WINDOW_AUTOSELECT must be one of/);
  });
});

describe('resolveDedicatedPlacement', () => {
  it('returns an empty object when nothing is set', () => {
    expect(resolveDedicatedPlacement({}, null)).toEqual({});
  });

  it('reads each field from its env var when no override is given', () => {
    const env = {
      OPENCLI_WINDOW_SLOT: 'semrush',
      OPENCLI_WINDOW_BOUNDS: '0,0,1280,900',
      OPENCLI_WINDOW_DISPLAY: '虚拟 16:9',
      OPENCLI_WINDOW_AUTOSELECT: 'off',
      OPENCLI_DEDICATED_FOREIGN_TABS: 'tolerate',
    };
    expect(resolveDedicatedPlacement(env, null)).toEqual({
      windowSlot: 'semrush',
      windowBounds: { left: 0, top: 0, width: 1280, height: 900 },
      windowDisplay: '虚拟 16:9',
      autoSelect: false,
      foreignTabPolicy: 'tolerate',
    });
  });

  it('ignores empty-string env values (treated as unset)', () => {
    const env = { OPENCLI_WINDOW_SLOT: '', OPENCLI_WINDOW_BOUNDS: '  ' };
    expect(resolveDedicatedPlacement(env, null)).toEqual({});
  });

  it('an in-process override wins over env for every field', () => {
    const env = {
      OPENCLI_WINDOW_SLOT: 'from-env',
      OPENCLI_WINDOW_BOUNDS: '0,0,100,100',
      OPENCLI_WINDOW_DISPLAY: 'from-env-display',
      OPENCLI_WINDOW_AUTOSELECT: 'off',
      OPENCLI_DEDICATED_FOREIGN_TABS: 'tolerate',
    };
    const overrides = {
      slot: 'from-override',
      bounds: { left: 1, top: 2, width: 3, height: 4 },
      display: 'from-override-display',
      autoSelect: true,
      foreignTabPolicy: 'evict' as const,
    };
    expect(resolveDedicatedPlacement(env, overrides)).toEqual({
      windowSlot: 'from-override',
      windowBounds: { left: 1, top: 2, width: 3, height: 4 },
      windowDisplay: 'from-override-display',
      autoSelect: true,
      foreignTabPolicy: 'evict',
    });
  });

  it('a partial override falls back to env per-field, not all-or-nothing', () => {
    const env = { OPENCLI_WINDOW_DISPLAY: 'from-env-display', OPENCLI_DEDICATED_FOREIGN_TABS: 'tolerate' };
    const overrides = { slot: 'from-override' };
    expect(resolveDedicatedPlacement(env, overrides)).toEqual({
      windowSlot: 'from-override',
      windowDisplay: 'from-env-display',
      foreignTabPolicy: 'tolerate',
    });
  });

  it('throws on a malformed OPENCLI_WINDOW_BOUNDS naming the variable', () => {
    expect(() => resolveDedicatedPlacement({ OPENCLI_WINDOW_BOUNDS: 'nope' }, null))
      .toThrow(/OPENCLI_WINDOW_BOUNDS must be/);
  });

  it('throws on a malformed OPENCLI_DEDICATED_FOREIGN_TABS naming the variable', () => {
    expect(() => resolveDedicatedPlacement({ OPENCLI_DEDICATED_FOREIGN_TABS: 'nope' }, null))
      .toThrow(/OPENCLI_DEDICATED_FOREIGN_TABS must be/);
  });

  it('throws on a malformed OPENCLI_WINDOW_AUTOSELECT naming the variable', () => {
    expect(() => resolveDedicatedPlacement({ OPENCLI_WINDOW_AUTOSELECT: 'nope' }, null))
      .toThrow(/OPENCLI_WINDOW_AUTOSELECT must be/);
  });

  it('does not validate env vars that an override already supplies (override short-circuits parsing)', () => {
    // Malformed env for bounds/autoSelect/foreignTabPolicy would normally throw,
    // but an override for that exact field must win without ever parsing env.
    const env = {
      OPENCLI_WINDOW_BOUNDS: 'garbage',
      OPENCLI_WINDOW_AUTOSELECT: 'garbage',
      OPENCLI_DEDICATED_FOREIGN_TABS: 'garbage',
    };
    const overrides = {
      bounds: { left: 0, top: 0, width: 1, height: 1 },
      autoSelect: true,
      foreignTabPolicy: 'evict' as const,
    };
    expect(resolveDedicatedPlacement(env, overrides)).toEqual({
      windowBounds: { left: 0, top: 0, width: 1, height: 1 },
      autoSelect: true,
      foreignTabPolicy: 'evict',
    });
  });
});
