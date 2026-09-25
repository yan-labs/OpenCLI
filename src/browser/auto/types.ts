/**
 * Shared types for the JEV-driven `browser <session> auto` command.
 *
 * See references/model-driven.md in yan-skills/opencli for the design背景:
 * JEV (TypeSafe System One) only answers typed questions (choice/noul/score)
 * over an already-enumerated candidate set — it never generates text or
 * calls tools. This module's job is to enumerate candidates from the page
 * (snapshot + form state), ask JEV to pick one per step, execute it through
 * the existing IPage primitives (click / fillText / setChecked / evaluate),
 * and stop deterministically when the goal looks done, confidence drops,
 * the step budget runs out, or an irreversible action would be required.
 */

// ── JEV protocol ────────────────────────────────────────────────────────

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  [key: string]: unknown;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevQuestion {
  type: 'choice' | 'noul' | 'score';
  instructions: string;
  /** Required for 'choice': candidate id -> human-readable description shown to JEV. */
  criteria?: Record<string, string>;
}

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}

/** A JEV response plus timing, as returned by callJev(). */
export interface JevCallResult extends JevResponse {
  ms: number;
}

/** Injectable JEV caller — lets tests substitute a mock without network access. */
export type CallJevFn = (
  state: unknown,
  questions: Record<string, JevQuestion>,
) => Promise<JevCallResult>;

// ── Page snapshot parsing ───────────────────────────────────────────────

/** One `[N]<tag attr=val ...>text` line parsed out of `page.snapshot()` text. */
export interface SnapshotRef {
  ref: string;
  tag: string;
  attrs: Record<string, string | true>;
  text: string;
}

// ── Form field grouping ─────────────────────────────────────────────────

export type FieldGroupKind = 'text' | 'select' | 'radio' | 'checkbox';

export interface FieldGroupMember {
  ref: string;
  /** Visible label/option text for this specific member (radio/checkbox option, or the field's own label). */
  optionLabel: string;
  checked?: boolean;
  disabled?: boolean;
  currentValue?: string;
}

export interface FieldGroup {
  /** Stable id used as the JEV question key and as the candidate id suffix. */
  groupKey: string;
  kind: FieldGroupKind;
  /** Best-effort human label for the whole group (name attr, or first member's label). */
  label: string;
  name: string | null;
  required: boolean;
  members: FieldGroupMember[];
  /** A checkbox group whose label/name looks like terms/consent/privacy-policy — see terms-guard.ts. */
  isTermsLike?: boolean;
}

// ── Field -> data key mapping ───────────────────────────────────────────

export interface FieldMappingResult {
  groupKey: string;
  group: FieldGroup;
  dataKey: string | 'NONE';
  confidence: number;
  /** Resolved scalar value (text/select/radio) used to pick the target. */
  resolvedValue?: string;
  /** Refs to act on: fillText target for text/select-by-text, click/setChecked targets for radio/checkbox. */
  matchedRefs: string[];
  skippedReason?: string;
}

// ── Action candidates (the per-step JEV choice menu) ────────────────────

export type ActionKind = 'click' | 'fill' | 'select' | 'check' | 'done';

export interface ActionCandidate {
  id: string;
  kind: ActionKind;
  description: string;
  ref?: string;
  /** Value to apply for fill/select/check actions. */
  value?: string;
  dataKey?: string;
  /** True when this candidate was excluded from the JEV menu as an irreversible action. */
  suppressedIrreversible?: boolean;
  /** True when this click candidate looked irreversible (safety.ts) AND was kept in the menu because --allow-submit was passed — flags it for a mandatory post-click outcome-check. */
  isSubmitLike?: boolean;
}

// ── Run options & results ───────────────────────────────────────────────

export interface AutoOptions {
  goal: string;
  data?: Record<string, unknown>;
  maxSteps: number;
  minConfidence: number;
  allowSubmit: boolean;
  dryRun: boolean;
  /**
   * Hard gate: without this, terms/consent/privacy-policy checkboxes are
   * excluded from the JEV candidate menu entirely (never mapped, never
   * offered to check) — mirrors backlink's known-forms.md `termsCheckbox`
   * policy ("the driver always stages, never ticks it, unless
   * --confirm-terms"). Defaults to false.
   */
  confirmTerms: boolean;
}

export type StopReason =
  | 'done'
  | 'awaiting_submit'
  | 'low_confidence'
  | 'max_steps'
  | 'no_candidates'
  | 'dry_run'
  | 'error'
  | 'captcha_detected'
  | 'login_wall_detected'
  | 'submit_unverified';

// ── Safety gates: CAPTCHA / login wall ──────────────────────────────────
//
// Both are deterministic DOM probes (ported from backlink's safe-fill.mjs
// heuristics) run every step, BEFORE candidate-building or any JEV call —
// zero cost, and the whole point is stopping before an agent or JEV ever
// gets a chance to try solving a challenge or entering credentials.

export interface PageGateResult {
  captchaDetected: boolean;
  captchaEvidence?: string;
  loginWallDetected: boolean;
  loginWallEvidence?: string;
}

// ── Submit outcome verification ─────────────────────────────────────────
//
// Ported from backlink's lib-submit-outcome.mjs: a submit click's "did it
// actually work" question is answered by dual evidence (positive AND no
// negative), never by a single "does confirmation text appear anywhere"
// scan — see that file's header comment for the form-silently-rerenders
// failure mode this defends against. JEV's noul judgment is an ASSIST on
// top of this deterministic classification, never a replacement for it.

export type SubmitOutcomeState =
  | 'submitted'
  | 'submitted-inconclusive'
  | 'submitted-unconfirmed'
  | 'outcome-unknown'
  | 'gated-captcha-on-confirm';

export interface SubmitOutcomeEvidence {
  submittedUrl: string;
  formStillPresent: boolean;
  echoedSubmittedValue: boolean;
  validationError: boolean;
  urlInConfirmationRegion: boolean;
  confirmationText: string;
  title: string;
  beforeUrl?: string;
  beforeTitle?: string;
  afterUrl?: string;
  challenge?: boolean;
}

export interface SubmitOutcomeResult {
  state: SubmitOutcomeState;
  positive: string[];
  negative: string[];
  evidence: SubmitOutcomeEvidence;
  /** JEV noul assist: calibrated P(the submission looks accepted), advisory only — classification above is decided by `evidence` alone. */
  jevAssist?: { likelySuccess: number };
}

export interface StepLog {
  step: number;
  url: string;
  title: string;
  candidateCount: number;
  suppressedCount: number;
  choice: string;
  confidence: number;
  topChoices: Array<{ id: string; probability: number }>;
  action?: ActionCandidate;
  executed: boolean;
  jevMs: number;
  jevInputTokens?: number;
  note?: string;
}

export interface FieldMappingLog {
  step: 'field_mapping';
  groups: number;
  jevMs: number;
  jevInputTokens?: number;
  results: Array<{
    groupKey: string;
    label: string;
    kind: FieldGroupKind;
    dataKey: string;
    confidence: number;
    matchedRefs: string[];
    skippedReason?: string;
  }>;
}

export interface AutoResult {
  status: 'completed' | 'stopped_for_human' | 'error';
  stopReason: StopReason;
  message: string;
  steps: StepLog[];
  fieldMapping?: FieldMappingLog;
  finalUrl: string;
  finalTitle: string;
  jevCalls: number;
  jevTotalInputTokens: number;
  jevTotalMs: number;
  durationMs: number;
  filledFields: Array<{ groupKey: string; label: string; dataKey: string; value?: string }>;
  skippedFields: Array<{ groupKey: string; label: string; reason: string }>;
  /** Present only when a submit-like click actually ran (--allow-submit). See SubmitOutcomeResult. */
  outcomeCheck?: SubmitOutcomeResult;
  /** Terms/consent checkboxes that were excluded from candidates entirely (hard gate, not just "no data key matched"). */
  termsCheckboxesBlocked: Array<{ groupKey: string; label: string }>;
}
