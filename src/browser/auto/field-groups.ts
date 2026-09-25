/**
 * Groups the flat field list from `page.getFormState()` (see
 * getFormStateJs() in src/browser/dom-snapshot.ts) into the units a human
 * would fill one at a time: a single text/email/tel/textarea/select input
 * is its own group; same-`name` radios collapse into one group (pick one
 * member); same-`name` checkboxes collapse into one group (pick zero or more
 * members). This is what field-mapping.ts asks JEV to map onto a data key,
 * and what candidates.ts turns into per-step fill/check candidates.
 */

import type { FieldGroup, FieldGroupKind, FieldGroupMember } from './types.js';
import { isTermsLikeGroup } from './terms-guard.js';

export interface RawFormField {
  tag: string;
  type: string;
  name: string | null;
  ref: string | null;
  label: string | null;
  value: unknown;
  required: boolean;
  disabled: boolean;
}

export interface RawFormState {
  forms: Array<{ id: string | null; name: string | null; action: string | null; method: string; fields: RawFormField[] }>;
  orphanFields: RawFormField[];
}

function kindOf(field: RawFormField): FieldGroupKind {
  if (field.type === 'checkbox') return 'checkbox';
  if (field.type === 'radio') return 'radio';
  if (field.tag === 'select') return 'select';
  return 'text';
}

/**
 * Flatten forms + orphanFields into one ordered list, dropping fields the
 * snapshot never annotated with a ref (can't be acted on), and dropping
 * `<button>` elements outright.
 *
 * getFormStateJs()'s extractField() (dom-snapshot.ts) infers `type` as
 * `el.getAttribute('type') || 'text'` for anything that isn't a
 * textarea/select — correct for `<input>` (whose implicit type really is
 * "text"), but wrong for `<button>`: an untyped `<button>` inside a form
 * defaults to `type=submit` per the HTML spec, not "text". A page like
 * httpbin's `<button>Submit order</button>` (no explicit type attribute)
 * therefore comes back misclassified as a nameless text field. Filtering
 * `tag === 'button'` here is a defensive guard in *our* module rather than
 * touching the shared dom-snapshot.ts — the submit button still shows up
 * correctly as a click candidate (and gets caught by safety.ts's keyword
 * check on its "Submit order" text either way).
 */
function allFields(state: RawFormState): RawFormField[] {
  const out: RawFormField[] = [];
  for (const form of state.forms ?? []) out.push(...form.fields);
  out.push(...(state.orphanFields ?? []));
  return out.filter((f) => typeof f.ref === 'string' && f.ref.length > 0 && f.tag !== 'button');
}

/**
 * Groups fields by kind: radios/checkboxes sharing a `name` become one
 * FieldGroup with multiple members; everything else is a singleton group.
 * Fields without a `name` attribute (rare, but legal) fall back to a
 * per-ref group key so they don't collide with each other.
 */
export function groupFormFields(state: RawFormState): FieldGroup[] {
  const fields = allFields(state);
  const groups = new Map<string, FieldGroup>();
  let anonCounter = 0;

  for (const field of fields) {
    const kind = kindOf(field);
    const needsGrouping = kind === 'radio' || kind === 'checkbox';
    const groupKey = needsGrouping && field.name
      ? `${kind}:${field.name}`
      : `${kind}:${field.name ?? `field${anonCounter++}`}:${field.ref}`;

    // For radio/checkbox the per-option label (e.g. "Small", "Bacon") is what
    // matters for matching against data values; for text/select fields the
    // "member" and "group" label are the same thing.
    const member: FieldGroupMember = {
      ref: field.ref as string,
      optionLabel: field.label ?? field.name ?? '',
      checked: typeof field.value === 'boolean' ? field.value : undefined,
      disabled: field.disabled,
      currentValue: typeof field.value === 'string' ? field.value : undefined,
    };

    const existing = groups.get(groupKey);
    if (existing) {
      existing.members.push(member);
      existing.required = existing.required || field.required;
      continue;
    }
    groups.set(groupKey, {
      groupKey,
      kind,
      label: field.label ?? field.name ?? groupKey,
      name: field.name,
      required: field.required,
      members: [member],
    });
  }

  const result = Array.from(groups.values());
  // Checkbox groups only — a terms/consent acknowledgement is always a
  // checkbox, and flagging radio/select/text groups too would risk matching
  // an unrelated field whose label happens to contain "agree" or "consent"
  // (e.g. a "How did you hear about us?" text field is never a checkbox).
  for (const g of result) {
    if (g.kind !== 'checkbox') continue;
    const haystack = [g.label, g.name ?? '', ...g.members.map((m) => m.optionLabel)].join(' ');
    if (isTermsLikeGroup(haystack)) g.isTermsLike = true;
  }
  return result;
}
