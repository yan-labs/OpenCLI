/**
 * Terms/consent checkbox hard gate.
 *
 * backlink's known-forms.md documents a `termsCheckbox` recipe field with a
 * hard policy: "the driver always stages, never ticks it, unless
 * --confirm-terms" — but that policy is enforced there via an *exact*,
 * human-verified field match recorded per-domain in a recipe file. `auto`
 * has no recipe system (it works on arbitrary, never-seen forms), so there
 * is no existing generic (non-recipe) terms-detector to port — safe-fill.mjs
 * itself has none. This is a new, intentionally conservative EN+ZH keyword
 * heuristic designed to enforce the *same policy* generically: without
 * `--confirm-terms`, a checkbox whose label/name mentions terms/consent/
 * privacy is excluded from the JEV candidate menu entirely (not just left
 * unmapped) — the model is never given the option to check it, the same
 * mechanism safety.ts already uses for irreversible clicks.
 */

const TERMS_KEYWORDS_RE = new RegExp(
  [
    'terms (of|and) (service|use|conditions)?',
    'terms and conditions',
    '\\bt&c\\b',
    'privacy policy',
    '\\bconsent\\b',
    '\\bagree\\b',
    '\\bi agree\\b',
    '同意',
    '条款',
    '隐私政策',
    '服务条款',
    '用户协议',
  ].join('|'),
  'i',
);

/**
 * True when a checkbox group's label/name looks like a terms/consent/
 * privacy-policy acknowledgement. Underscores/hyphens are normalized to
 * spaces first so a raw `name` attribute like `agree_to_tos` (no visible
 * label text) still matches `\bagree\b` — `_` counts as a word character,
 * so without this normalization "agree_to_tos" is one unbroken regex "word"
 * and the boundary never matches.
 */
export function isTermsLikeGroup(labelOrName: string): boolean {
  return TERMS_KEYWORDS_RE.test(labelOrName.replace(/[_-]+/g, ' '));
}

export { TERMS_KEYWORDS_RE };
