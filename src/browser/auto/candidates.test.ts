import { describe, expect, it } from 'vitest';
import { buildCandidates, candidatesToJevCriteria } from './candidates.js';
import type { FieldGroup, FieldMappingResult, SnapshotRef } from './types.js';

function ref(partial: Partial<SnapshotRef>): SnapshotRef {
  return { ref: '1', tag: 'a', attrs: {}, text: '', ...partial };
}

function radioGroup(): FieldGroup {
  return {
    groupKey: 'radio:size', kind: 'radio', label: 'size', name: 'size', required: false,
    members: [
      { ref: '10', optionLabel: 'Small' },
      { ref: '11', optionLabel: 'Large' },
    ],
  };
}

describe('buildCandidates — click candidates', () => {
  it('offers ordinary links and buttons as click candidates, plus DONE', () => {
    const refs = [ref({ ref: '1', tag: 'a', text: 'Learn more' }), ref({ ref: '2', tag: 'button', text: 'Expand' })];
    const { candidates } = buildCandidates({ refs, formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.map((c) => c.id).sort()).toEqual(['CLICK_1', 'CLICK_2', 'DONE'].sort());
  });

  it('excludes refs that belong to a form field (they surface as fill/check candidates instead)', () => {
    const refs = [ref({ ref: '1', tag: 'input', attrs: { type: 'text' } })];
    const { candidates } = buildCandidates({ refs, formRefs: new Set(['1']), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.map((c) => c.id)).toEqual(['DONE']);
  });

  it('always appends exactly one DONE candidate', () => {
    const { candidates } = buildCandidates({ refs: [], formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.filter((c) => c.kind === 'done')).toHaveLength(1);
  });
});

describe('buildCandidates — irreversible-action filtering', () => {
  it('drops a submit-typed click from candidates without --allow-submit, and reports it as suppressed', () => {
    const refs = [ref({ ref: '9', tag: 'input', attrs: { type: 'submit', value: 'Submit order' } })];
    const { candidates, suppressedIrreversible } = buildCandidates({ refs, formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.find((c) => c.id === 'CLICK_9')).toBeUndefined();
    expect(suppressedIrreversible).toHaveLength(1);
    expect(suppressedIrreversible[0].suppressedIrreversible).toBe(true);
  });

  it('keeps a submit-typed click when --allow-submit is set', () => {
    const refs = [ref({ ref: '9', tag: 'input', attrs: { type: 'submit', value: 'Submit order' } })];
    const { candidates, suppressedIrreversible } = buildCandidates({ refs, formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: true });
    expect(candidates.find((c) => c.id === 'CLICK_9')).toBeDefined();
    expect(suppressedIrreversible).toHaveLength(0);
  });

  it('drops a delete/pay/send-worded link without --allow-submit', () => {
    const refs = [ref({ ref: '5', tag: 'a', text: 'Delete this post' })];
    const { candidates } = buildCandidates({ refs, formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.find((c) => c.id === 'CLICK_5')).toBeUndefined();
  });

  it('does not suppress ordinary navigation links', () => {
    const refs = [ref({ ref: '3', tag: 'a', text: 'Root Zone Database' })];
    const { candidates, suppressedIrreversible } = buildCandidates({ refs, formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.find((c) => c.id === 'CLICK_3')).toBeDefined();
    expect(suppressedIrreversible).toHaveLength(0);
  });
});

describe('buildCandidates — fill/select/check candidates from field mapping', () => {
  it('offers a fill candidate for a mapped, unapplied text field', () => {
    const group: FieldGroup = { groupKey: 'text:custname:1', kind: 'text', label: 'Customer name', name: 'custname', required: false, members: [{ ref: '1', optionLabel: 'Customer name' }] };
    const mapping: FieldMappingResult = { groupKey: group.groupKey, group, dataKey: 'full_name', confidence: 0.9, resolvedValue: 'Ada Lovelace', matchedRefs: ['1'] };
    const { candidates } = buildCandidates({ refs: [], formRefs: new Set(['1']), pendingFieldActions: [mapping], appliedRefs: new Set(), allowSubmit: false });
    const fill = candidates.find((c) => c.kind === 'fill');
    expect(fill?.ref).toBe('1');
    expect(fill?.value).toBe('Ada Lovelace');
    expect(fill?.dataKey).toBe('full_name');
  });

  it('does not re-offer a fill candidate once the ref is already applied', () => {
    const group: FieldGroup = { groupKey: 'text:custname:1', kind: 'text', label: 'Customer name', name: 'custname', required: false, members: [{ ref: '1', optionLabel: 'Customer name' }] };
    const mapping: FieldMappingResult = { groupKey: group.groupKey, group, dataKey: 'full_name', confidence: 0.9, resolvedValue: 'Ada Lovelace', matchedRefs: ['1'] };
    const { candidates } = buildCandidates({ refs: [], formRefs: new Set(['1']), pendingFieldActions: [mapping], appliedRefs: new Set(['1']), allowSubmit: false });
    expect(candidates.find((c) => c.kind === 'fill')).toBeUndefined();
  });

  it('skips a NONE-mapped field entirely — no candidate offered, no value invented', () => {
    const group: FieldGroup = { groupKey: 'text:comments:9', kind: 'text', label: 'Delivery instructions', name: 'comments', required: false, members: [{ ref: '9', optionLabel: 'Delivery instructions' }] };
    const mapping: FieldMappingResult = { groupKey: group.groupKey, group, dataKey: 'NONE', confidence: 0.3, matchedRefs: [], skippedReason: 'no_matching_data_key' };
    const { candidates } = buildCandidates({ refs: [], formRefs: new Set(['9']), pendingFieldActions: [mapping], appliedRefs: new Set(), allowSubmit: false });
    expect(candidates.find((c) => c.kind === 'fill' || c.kind === 'check')).toBeUndefined();
  });

  it('offers one check candidate per still-unchecked matched radio/checkbox member', () => {
    const group = radioGroup();
    const mapping: FieldMappingResult = { groupKey: group.groupKey, group, dataKey: 'pizza_size', confidence: 0.9, resolvedValue: 'Large', matchedRefs: ['11'] };
    const { candidates } = buildCandidates({ refs: [], formRefs: new Set(['10', '11']), pendingFieldActions: [mapping], appliedRefs: new Set(), allowSubmit: false });
    const checks = candidates.filter((c) => c.kind === 'check');
    expect(checks).toHaveLength(1);
    expect(checks[0].ref).toBe('11');
  });
});

describe('candidatesToJevCriteria', () => {
  it('maps candidate id -> description 1:1', () => {
    const { candidates } = buildCandidates({ refs: [ref({ ref: '1', text: 'Home' })], formRefs: new Set(), pendingFieldActions: [], appliedRefs: new Set(), allowSubmit: false });
    const criteria = candidatesToJevCriteria(candidates);
    expect(Object.keys(criteria).sort()).toEqual(candidates.map((c) => c.id).sort());
    expect(criteria.DONE).toBe(candidates.find((c) => c.id === 'DONE')?.description);
  });
});
