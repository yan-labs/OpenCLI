/**
 * Maps form field groups onto keys of the user-supplied `--data` JSON, via
 * one batched JEV call (one `choice` question per group, all in a single
 * HTTP request — this is the "可以对每个字段出一道 choice，也可以批量出题"
 * option the brief calls out, batched for cost).
 *
 * JEV only ever picks a *data key* — it never invents a value. Applying the
 * chosen value to the page (matching a radio/checkbox option's label, or
 * using the text verbatim for a text field) is deterministic string work
 * done here, not a second model judgment.
 */

import type { CallJevFn, FieldGroup, FieldMappingResult, JevQuestion } from './types.js';

const MAX_VALUE_PREVIEW = 60;

function truncate(s: string, n = MAX_VALUE_PREVIEW): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => String(v)).join(', ')}]`;
  if (value && typeof value === 'object') return truncate(JSON.stringify(value));
  return truncate(String(value));
}

function buildCriteria(data: Record<string, unknown>): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    criteria[key] = `data key "${key}" = ${describeValue(value)}`;
  }
  criteria.NONE = 'No data key matches this field — leave it unfilled.';
  return criteria;
}

function groupInstructions(group: FieldGroup): string {
  const optionHint = group.kind === 'radio' || group.kind === 'checkbox'
    ? ` Its options are: ${group.members.map((m) => m.optionLabel || '(unlabeled)').join(', ')}.`
    : '';
  const requiredHint = group.required ? ' This field is required.' : '';
  return (
    `You are filling a web form. Pick the data key whose value belongs in the form field ` +
    `labeled "${group.label}" (name="${group.name ?? ''}", type=${group.kind}).` +
    optionHint + requiredHint +
    ' Match by meaning, not by exact string equality — the data key names may differ from the field label ' +
    '(e.g. a field labeled "Customer name" may map to a data key called "full_name"). ' +
    'Choose NONE if nothing fits.'
  );
}

/** Build the batched JEV questions object: one `choice` question per field group. */
export function buildMappingQuestions(groups: FieldGroup[], data: Record<string, unknown>): Record<string, JevQuestion> {
  const criteria = buildCriteria(data);
  const questions: Record<string, JevQuestion> = {};
  for (const group of groups) {
    questions[group.groupKey] = {
      type: 'choice',
      instructions: groupInstructions(group),
      criteria,
    };
  }
  return questions;
}

/** Case/space-insensitive match: exact first, then substring either direction. */
function findMatchingMembers(group: FieldGroup, wanted: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const wantedNorm = wanted.map(norm).filter(Boolean);
  const matched: string[] = [];
  for (const member of group.members) {
    if (member.disabled) continue;
    const label = norm(member.optionLabel);
    if (!label) continue;
    const hit = wantedNorm.some((w) => label === w || label.includes(w) || w.includes(label));
    if (hit) matched.push(member.ref);
  }
  return matched;
}

function valueToWantedList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return value.split(/[,|/]/).map((s) => s.trim()).filter(Boolean);
  if (value == null) return [];
  return [String(value)];
}

export interface ResolveMappingDeps {
  callJev: CallJevFn;
}

export interface MappingCallOutcome {
  results: FieldMappingResult[];
  jevMs: number;
  jevInputTokens?: number;
}

/**
 * Runs the batched mapping call for `groups` against `data`, then resolves
 * each JEV choice into concrete refs/values. Groups are expected to be
 * "fresh" (fields JEV hasn't been asked about yet) — callers should not
 * re-ask about a group that already produced a mapping.
 */
export async function mapFieldsToData(
  groups: FieldGroup[],
  data: Record<string, unknown>,
  deps: ResolveMappingDeps,
): Promise<MappingCallOutcome> {
  if (groups.length === 0) return { results: [], jevMs: 0 };

  const questions = buildMappingQuestions(groups, data);
  const state = {
    task: 'form_field_data_mapping',
    data_keys: Object.keys(data),
  };
  const response = await deps.callJev(state, questions);

  const results: FieldMappingResult[] = groups.map((group) => {
    const answer = response.answers[group.groupKey];
    if (!answer || answer.type !== 'choice') {
      return { groupKey: group.groupKey, group, dataKey: 'NONE', confidence: 0, matchedRefs: [], skippedReason: 'jev_answer_missing' };
    }
    const dataKey = answer.choice;
    if (dataKey === 'NONE' || !(dataKey in data)) {
      return {
        groupKey: group.groupKey,
        group,
        dataKey: 'NONE',
        confidence: answer.confidence,
        matchedRefs: [],
        skippedReason: dataKey === 'NONE' ? 'no_matching_data_key' : 'jev_chose_unknown_key',
      };
    }

    const rawValue = data[dataKey];
    if (group.kind === 'radio' || group.kind === 'checkbox') {
      const wanted = valueToWantedList(rawValue);
      const matchedRefs = findMatchingMembers(group, group.kind === 'radio' ? wanted.slice(0, 1) : wanted);
      if (matchedRefs.length === 0) {
        return {
          groupKey: group.groupKey, group, dataKey, confidence: answer.confidence, matchedRefs: [],
          skippedReason: `no_option_matches_value:${describeValue(rawValue)}`,
        };
      }
      return { groupKey: group.groupKey, group, dataKey, confidence: answer.confidence, resolvedValue: wanted.join(', '), matchedRefs };
    }

    if (group.kind === 'select') {
      const resolvedValue = String(rawValue ?? '');
      if (!resolvedValue) {
        return { groupKey: group.groupKey, group, dataKey, confidence: answer.confidence, matchedRefs: [], skippedReason: 'empty_value' };
      }
      return { groupKey: group.groupKey, group, dataKey, confidence: answer.confidence, resolvedValue, matchedRefs: [group.members[0].ref] };
    }

    // text / textarea / email / tel / ...
    const resolvedValue = String(rawValue ?? '');
    if (!resolvedValue) {
      return { groupKey: group.groupKey, group, dataKey, confidence: answer.confidence, matchedRefs: [], skippedReason: 'empty_value' };
    }
    return { groupKey: group.groupKey, group, dataKey, confidence: answer.confidence, resolvedValue, matchedRefs: [group.members[0].ref] };
  });

  return { results, jevMs: response.ms, jevInputTokens: response.usage?.input_tokens };
}
