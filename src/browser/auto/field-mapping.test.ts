import { describe, expect, it } from 'vitest';
import { buildMappingQuestions, mapFieldsToData } from './field-mapping.js';
import { groupFormFields, type RawFormState } from './field-groups.js';
import type { CallJevFn, JevCallResult } from './types.js';

function httpbinGroups() {
  const state: RawFormState = {
    forms: [{
      id: null, name: null, action: '/post', method: 'POST',
      fields: [
        { tag: 'input', type: 'text', name: 'custname', ref: '1', label: 'Customer name', value: '', required: false, disabled: false },
        { tag: 'input', type: 'tel', name: 'custtel', ref: '2', label: 'Telephone', value: '', required: false, disabled: false },
        { tag: 'input', type: 'email', name: 'custemail', ref: '3', label: 'E-mail address', value: '', required: false, disabled: false },
        { tag: 'input', type: 'radio', name: 'size', ref: '4', label: 'Small', value: false, required: false, disabled: false },
        { tag: 'input', type: 'radio', name: 'size', ref: '5', label: 'Medium', value: false, required: false, disabled: false },
        { tag: 'input', type: 'radio', name: 'size', ref: '6', label: 'Large', value: false, required: false, disabled: false },
        { tag: 'input', type: 'checkbox', name: 'topping', ref: '7', label: 'Bacon', value: false, required: false, disabled: false },
        { tag: 'input', type: 'checkbox', name: 'topping', ref: '8', label: 'Cheese', value: false, required: false, disabled: false },
        { tag: 'textarea', type: 'textarea', name: 'comments', ref: '9', label: 'Delivery instructions', value: '', required: false, disabled: false },
      ],
    }],
    orphanFields: [],
  };
  return groupFormFields(state);
}

// Deliberately mismatched key names, mirroring the real-device test plan
// (data keys don't equal field names — that's the whole point of asking JEV).
const DATA = {
  full_name: 'Ada Lovelace',
  phone_number: '555-0100',
  email_address: 'ada@example.com',
  pizza_size: 'Large',
  topping_choice: ['Bacon', 'Cheese'],
  notes: 'Ring the bell twice',
};

describe('buildMappingQuestions', () => {
  it('asks one choice question per group, batched into a single call shape', () => {
    const groups = httpbinGroups();
    const questions = buildMappingQuestions(groups, DATA);
    expect(Object.keys(questions).sort()).toEqual(groups.map((g) => g.groupKey).sort());
    for (const q of Object.values(questions)) {
      expect(q.type).toBe('choice');
      expect(Object.keys(q.criteria ?? {})).toEqual(expect.arrayContaining([...Object.keys(DATA), 'NONE']));
    }
  });

  it('includes each option label in the instructions for radio/checkbox groups', () => {
    const groups = httpbinGroups();
    const size = groups.find((g) => g.kind === 'radio')!;
    const questions = buildMappingQuestions([size], DATA);
    expect(questions[size.groupKey].instructions).toContain('Small');
    expect(questions[size.groupKey].instructions).toContain('Large');
  });
});

/** A mock JEV that always picks the criteria key whose description string contains `wanted`. */
function mockJevPreferring(pickByGroupKey: Record<string, string>): CallJevFn {
  return async (_state, questions): Promise<JevCallResult> => {
    const answers: JevCallResult['answers'] = {};
    for (const [key, q] of Object.entries(questions)) {
      const criteria = q.criteria ?? {};
      const choice = pickByGroupKey[key] ?? 'NONE';
      const probabilities: Record<string, number> = Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 0.9 : 0.01]));
      answers[key] = { type: 'choice', choice, probabilities, confidence: choice === 'NONE' ? 0.4 : 0.9 };
    }
    return { answers, usage: { input_tokens: 123 }, ms: 5 };
  };
}

describe('mapFieldsToData', () => {
  it('resolves a single JEV call for all groups (batched, not one call per field)', async () => {
    const groups = httpbinGroups();
    let calls = 0;
    const callJev: CallJevFn = async (state, questions) => {
      calls++;
      return mockJevPreferring({})(state, questions);
    };
    await mapFieldsToData(groups, DATA, { callJev });
    expect(calls).toBe(1);
  });

  it('maps mismatched key names onto text fields by JEV choice, verbatim value', async () => {
    const groups = httpbinGroups();
    const custname = groups.find((g) => g.name === 'custname')!;
    const callJev = mockJevPreferring({ [custname.groupKey]: 'full_name' });
    const { results } = await mapFieldsToData([custname], DATA, { callJev });
    expect(results[0].dataKey).toBe('full_name');
    expect(results[0].resolvedValue).toBe('Ada Lovelace');
    expect(results[0].matchedRefs).toEqual(['1']);
  });

  it('resolves a radio group to the single matching option ref by fuzzy label match', async () => {
    const groups = httpbinGroups();
    const size = groups.find((g) => g.kind === 'radio')!;
    const callJev = mockJevPreferring({ [size.groupKey]: 'pizza_size' });
    const { results } = await mapFieldsToData([size], DATA, { callJev });
    expect(results[0].dataKey).toBe('pizza_size');
    // "Large" ref is '6' per the fixture order (Small=4, Medium=5, Large=6).
    expect(results[0].matchedRefs).toEqual(['6']);
  });

  it('resolves a checkbox group to every matching option ref from an array value', async () => {
    const groups = httpbinGroups();
    const topping = groups.find((g) => g.kind === 'checkbox')!;
    const callJev = mockJevPreferring({ [topping.groupKey]: 'topping_choice' });
    const { results } = await mapFieldsToData([topping], DATA, { callJev });
    expect(results[0].dataKey).toBe('topping_choice');
    expect(results[0].matchedRefs.sort()).toEqual(['7', '8']); // Bacon, Cheese
  });

  it('marks a field NONE and skips it when JEV finds no matching data key — never inventing a value', async () => {
    const groups = httpbinGroups();
    const comments = groups.find((g) => g.name === 'comments')!;
    const callJev = mockJevPreferring({}); // defaults to NONE
    const { results } = await mapFieldsToData([comments], DATA, { callJev });
    expect(results[0].dataKey).toBe('NONE');
    expect(results[0].matchedRefs).toEqual([]);
    expect(results[0].skippedReason).toBe('no_matching_data_key');
  });

  it('skips a radio/checkbox group when the chosen data value matches none of the page options', async () => {
    const groups = httpbinGroups();
    const size = groups.find((g) => g.kind === 'radio')!;
    const callJev = mockJevPreferring({ [size.groupKey]: 'notes' }); // "Ring the bell twice" matches no size option
    const { results } = await mapFieldsToData([size], DATA, { callJev });
    expect(results[0].matchedRefs).toEqual([]);
    expect(results[0].skippedReason).toMatch(/^no_option_matches_value/);
  });

  it('returns no JEV call and no results for an empty group list', async () => {
    let calls = 0;
    const callJev: CallJevFn = async (s, q) => { calls++; return mockJevPreferring({})(s, q); };
    const { results, jevMs } = await mapFieldsToData([], DATA, { callJev });
    expect(results).toEqual([]);
    expect(jevMs).toBe(0);
    expect(calls).toBe(0);
  });
});
