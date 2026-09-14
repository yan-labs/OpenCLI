/**
 * Dedicated-window placement resolution — pure, unit-testable parsing/merging
 * logic shared by the CLI transport (daemon-client.ts sendCommandRaw) and the
 * `opencli browser window ensure` command.
 *
 * Precedence for every field is: explicit call-site params > in-process
 * override (CLI --window-slot/--window-bounds/--window-display for the
 * current invocation, see setDaemonWindowPlacement in daemon-client.ts) >
 * environment variable. This module only implements the override+env tier
 * (`resolveDedicatedPlacement`); the caller layers the "explicit params" tier
 * on top with a plain `??`.
 *
 * Kept dependency-free (no imports from '../runtime.js') to avoid a circular
 * import through browser/index.ts, matching the existing convention of
 * inlining the BrowserWindowMode literal union at each use site.
 */

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ForeignTabPolicy = 'evict' | 'tolerate';

/** In-process override set once per CLI invocation from --window-slot/--window-bounds/--window-display/--foreign-tabs. */
export interface DedicatedWindowPlacementOverride {
  slot?: string;
  bounds?: WindowBounds;
  display?: string;
  autoSelect?: boolean;
  foreignTabPolicy?: ForeignTabPolicy;
}

/** Resolved fields ready to attach onto a DaemonCommand (only when dedicated / a window op). */
export interface ResolvedDedicatedPlacement {
  windowSlot?: string;
  windowBounds?: WindowBounds;
  windowDisplay?: string;
  autoSelect?: boolean;
  foreignTabPolicy?: ForeignTabPolicy;
  dedicatedIdleMs?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * Parse `x,y,w,h` into a bounds rect. x/y may be negative (multi-monitor
 * setups with a display to the left of/above the primary); width/height must
 * be positive integers. Throws naming `varName` (e.g. `OPENCLI_WINDOW_BOUNDS`
 * or `--window-bounds`) on any malformed input.
 */
export function parseWindowBounds(raw: string, varName: string): WindowBounds {
  const fail = (): never => {
    throw new Error(`${varName} must be "x,y,w,h" integers (width/height > 0). Received: "${raw}"`);
  };
  const parts = raw.split(',');
  if (parts.length !== 4) fail();
  const nums = parts.map((p) => p.trim());
  if (nums.some((p) => p === '' || !/^-?\d+$/.test(p))) fail();
  const [left, top, width, height] = nums.map((p) => Number.parseInt(p, 10));
  if (width <= 0 || height <= 0) fail();
  return { left, top, width, height };
}

/** Parse `evict` / `tolerate`. Throws naming `varName` on any other non-empty value. */
export function parseForeignTabPolicy(raw: string, varName: string): ForeignTabPolicy {
  if (raw === 'evict' || raw === 'tolerate') return raw;
  throw new Error(`${varName} must be one of: evict, tolerate. Received: "${raw}"`);
}

const AUTOSELECT_TRUE = new Set(['1', 'true', 'on']);
const AUTOSELECT_FALSE = new Set(['0', 'false', 'off']);

/** Parse `1/0/true/false/on/off` (case-insensitive). Throws naming `varName` on any other value. */
export function parseAutoSelect(raw: string, varName: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (AUTOSELECT_TRUE.has(normalized)) return true;
  if (AUTOSELECT_FALSE.has(normalized)) return false;
  throw new Error(`${varName} must be one of: 1, 0, true, false, on, off. Received: "${raw}"`);
}

/**
 * Parse a positive integer milliseconds value (OPENCLI_DEDICATED_IDLE_MS).
 * Unlike the other parsers here, an invalid value is dropped silently (returns
 * undefined) rather than thrown: a stray/malformed idle-TTL override must
 * never fail an otherwise-unrelated command, it just falls back to the
 * extension's own default idle TTL.
 */
function parseDedicatedIdleMs(raw: string): number | undefined {
  const num = Number(raw);
  return Number.isFinite(num) && Number.isInteger(num) && num > 0 ? num : undefined;
}

/**
 * Resolve the override+env tier of dedicated-window placement. Pure function
 * of its two inputs so tests never touch the real process.env or module-level
 * state. Only fields with a resolved (non-empty) value are present on the
 * result — callers must not synthesize defaults for absent fields (e.g.
 * autoSelect's "default true when dedicated" is the extension's job, not
 * ours: sending nothing lets it apply that default).
 */
export function resolveDedicatedPlacement(
  env: NodeJS.ProcessEnv,
  overrides?: DedicatedWindowPlacementOverride | null,
): ResolvedDedicatedPlacement {
  const result: ResolvedDedicatedPlacement = {};

  const slot = overrides?.slot ?? nonEmpty(env.OPENCLI_WINDOW_SLOT);
  if (slot !== undefined) result.windowSlot = slot;

  if (overrides?.bounds) {
    result.windowBounds = overrides.bounds;
  } else {
    const rawBounds = nonEmpty(env.OPENCLI_WINDOW_BOUNDS);
    if (rawBounds !== undefined) result.windowBounds = parseWindowBounds(rawBounds, 'OPENCLI_WINDOW_BOUNDS');
  }

  const display = overrides?.display ?? nonEmpty(env.OPENCLI_WINDOW_DISPLAY);
  if (display !== undefined) result.windowDisplay = display;

  if (overrides?.autoSelect !== undefined) {
    result.autoSelect = overrides.autoSelect;
  } else {
    const rawAutoSelect = nonEmpty(env.OPENCLI_WINDOW_AUTOSELECT);
    if (rawAutoSelect !== undefined) result.autoSelect = parseAutoSelect(rawAutoSelect, 'OPENCLI_WINDOW_AUTOSELECT');
  }

  if (overrides?.foreignTabPolicy !== undefined) {
    result.foreignTabPolicy = overrides.foreignTabPolicy;
  } else {
    const rawForeign = nonEmpty(env.OPENCLI_DEDICATED_FOREIGN_TABS);
    if (rawForeign !== undefined) result.foreignTabPolicy = parseForeignTabPolicy(rawForeign, 'OPENCLI_DEDICATED_FOREIGN_TABS');
  }

  // No override tier for this field (no --window-idle-ms CLI flag exists) — env only.
  const rawIdleMs = nonEmpty(env.OPENCLI_DEDICATED_IDLE_MS);
  if (rawIdleMs !== undefined) {
    const parsed = parseDedicatedIdleMs(rawIdleMs);
    if (parsed !== undefined) result.dedicatedIdleMs = parsed;
  }

  return result;
}
