/**
 * Builds the per-step JEV choice menu: clickable elements (links/buttons/
 * other interactive refs that aren't form fields) + outstanding fill/select/
 * check actions from a resolved field mapping + a DONE sentinel. Irreversible
 * clicks (submit/pay/send/delete/confirm) are dropped here — before JEV ever
 * sees them — unless `allowSubmit` is set.
 */

import type { ActionCandidate, FieldMappingResult, SnapshotRef } from './types.js';
import { attrString } from './snapshot-parse.js';
import { looksIrreversible } from './safety.js';

export interface BuildCandidatesInput {
  refs: SnapshotRef[];
  /** Refs that belong to a form field (radio/checkbox members, text/select inputs) — excluded from generic click candidates. */
  formRefs: Set<string>;
  /** Field mapping results with at least one unmatched/unapplied ref. */
  pendingFieldActions: FieldMappingResult[];
  /** Refs already successfully filled/checked this run — excluded even if still "pending" due to a stale mapping. */
  appliedRefs: Set<string>;
  allowSubmit: boolean;
}

export interface BuildCandidatesOutput {
  candidates: ActionCandidate[];
  suppressedIrreversible: ActionCandidate[];
}

function describeClickable(ref: SnapshotRef): string {
  const text = ref.text || attrString(ref.attrs, 'aria-label') || attrString(ref.attrs, 'title') || attrString(ref.attrs, 'value') || '(no text)';
  const href = attrString(ref.attrs, 'href');
  return href ? `${ref.tag} "${text}" -> ${href}` : `${ref.tag} "${text}"`;
}

/**
 * True for elements the click candidate set should offer: not a plain form
 * field (those are represented as fill/select/check candidates instead).
 *
 * Membership in `formRefs` (built from `page.getFormState()`'s field list)
 * is the sole test — NOT the tag name. getFormStateJs()'s extractField()
 * already excludes type=submit/button/reset/hidden inputs from that list
 * (see field-groups.ts), so an `<input type=submit>` or `<button
 * type=submit>` never lands in formRefs and correctly falls through here as
 * a click candidate; a text/email/checkbox/radio/select/textarea field
 * always does land in formRefs and is correctly excluded. Tag-name-based
 * filtering would wrongly drop `<input type=submit>` too.
 */
function isClickWorthy(ref: SnapshotRef, formRefs: Set<string>): boolean {
  return !formRefs.has(ref.ref);
}

export function buildCandidates(input: BuildCandidatesInput): BuildCandidatesOutput {
  const candidates: ActionCandidate[] = [];
  const suppressedIrreversible: ActionCandidate[] = [];

  for (const ref of input.refs) {
    if (!isClickWorthy(ref, input.formRefs)) continue;
    const candidate: ActionCandidate = {
      id: `CLICK_${ref.ref}`,
      kind: 'click',
      ref: ref.ref,
      description: describeClickable(ref),
    };
    const irreversible = looksIrreversible(ref);
    if (irreversible && !input.allowSubmit) {
      suppressedIrreversible.push({ ...candidate, suppressedIrreversible: true });
      continue;
    }
    // Kept only because --allow-submit was passed — flag it so run.ts knows
    // to run a mandatory post-click outcome-check rather than trusting a
    // later JEV DONE choice at face value.
    candidates.push(irreversible ? { ...candidate, isSubmitLike: true } : candidate);
  }

  for (const mapping of input.pendingFieldActions) {
    if (mapping.dataKey === 'NONE' || mapping.matchedRefs.length === 0) continue;
    const outstanding = mapping.matchedRefs.filter((r) => !input.appliedRefs.has(r));
    if (outstanding.length === 0) continue;

    if (mapping.group.kind === 'text' || mapping.group.kind === 'select') {
      const kind = mapping.group.kind === 'select' ? 'select' : 'fill';
      candidates.push({
        id: `${kind.toUpperCase()}_${mapping.groupKey}`,
        kind,
        ref: outstanding[0],
        value: mapping.resolvedValue,
        dataKey: mapping.dataKey,
        description: `${kind} "${mapping.group.label}" with data.${mapping.dataKey} = "${mapping.resolvedValue}"`,
      });
      continue;
    }

    // radio: one member to click. checkbox: one candidate per still-unchecked matched member.
    for (const ref of outstanding) {
      const member = mapping.group.members.find((m) => m.ref === ref);
      candidates.push({
        id: `CHECK_${ref}`,
        kind: 'check',
        ref,
        value: 'true',
        dataKey: mapping.dataKey,
        description: `check "${member?.optionLabel ?? mapping.group.label}" (${mapping.group.kind}) — matches data.${mapping.dataKey}`,
      });
    }
  }

  candidates.push({ id: 'DONE', kind: 'done', description: 'The goal is already satisfied by the current page state — stop here.' });

  return { candidates, suppressedIrreversible };
}

export function candidatesToJevCriteria(candidates: ActionCandidate[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.id] = c.description;
  return criteria;
}
