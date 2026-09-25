import { describe, expect, it } from 'vitest';
import { groupFormFields, type RawFormState } from './field-groups.js';

function httpbinLikeForm(): RawFormState {
  return {
    forms: [
      {
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
          { tag: 'input', type: 'checkbox', name: 'topping', ref: '9', label: 'Onion', value: false, required: false, disabled: false },
          { tag: 'textarea', type: 'textarea', name: 'comments', ref: '10', label: 'Delivery instructions', value: '', required: false, disabled: false },
          // Note: a real page's submit <input> never reaches this list — the
          // browser-side extractField() in getFormStateJs() (dom-snapshot.ts)
          // already returns null for type=submit/button/hidden/reset before
          // page.getFormState() resolves. Submit-click suppression is instead
          // tested in candidates.test.ts against looksIrreversible().
        ],
      },
    ],
    orphanFields: [],
  };
}

describe('groupFormFields', () => {
  const groups = groupFormFields(httpbinLikeForm());

  it('produces exactly one group per distinct field name (4 text-like + 2 grouped)', () => {
    expect(groups).toHaveLength(6);
  });

  it('keeps single text/tel/email/textarea fields as their own singleton groups', () => {
    const names = groups.filter((g) => g.kind === 'text').map((g) => g.name);
    expect(names.sort()).toEqual(['comments', 'custemail', 'custname', 'custtel'].sort());
    for (const g of groups.filter((g) => g.kind === 'text')) {
      expect(g.members).toHaveLength(1);
    }
  });

  it('collapses same-name radios into one group with all options as members', () => {
    const size = groups.find((g) => g.name === 'size');
    expect(size?.kind).toBe('radio');
    expect(size?.members.map((m) => m.optionLabel)).toEqual(['Small', 'Medium', 'Large']);
  });

  it('collapses same-name checkboxes into one group with all options as members', () => {
    const topping = groups.find((g) => g.name === 'topping');
    expect(topping?.kind).toBe('checkbox');
    expect(topping?.members.map((m) => m.optionLabel)).toEqual(['Bacon', 'Cheese', 'Onion']);
  });

  it('ignores fields with no ref (not annotated by a prior snapshot)', () => {
    const state: RawFormState = {
      forms: [{ id: null, name: null, action: null, method: 'GET', fields: [
        { tag: 'input', type: 'text', name: 'x', ref: null, label: null, value: '', required: false, disabled: false },
      ] }],
      orphanFields: [],
    };
    expect(groupFormFields(state)).toHaveLength(0);
  });

  it('drops an untyped <button> even though getFormStateJs misreports its type as "text" (real httpbin.org/forms/post bug)', () => {
    // Real observed payload: <button>Submit order</button> has no `type`
    // attribute, so extractField()'s `el.getAttribute('type') || 'text'`
    // fallback mis-tags it type=text instead of the HTML-spec default
    // (submit). Must not surface as a fillable text field.
    const state: RawFormState = {
      forms: [{
        id: null, name: null, action: '/post', method: 'POST',
        fields: [
          { tag: 'input', type: 'text', name: 'custname', ref: '1', label: 'Customer name', value: '', required: false, disabled: false },
          { tag: 'button', type: 'text', name: null, ref: '13', label: null, value: 'Submit order', required: false, disabled: false },
        ],
      }],
      orphanFields: [],
    };
    const groups = groupFormFields(state);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('custname');
  });

  it('marks a group required when any member is required', () => {
    const state: RawFormState = {
      forms: [{ id: null, name: null, action: null, method: 'GET', fields: [
        { tag: 'input', type: 'radio', name: 'plan', ref: '1', label: 'Free', value: false, required: false, disabled: false },
        { tag: 'input', type: 'radio', name: 'plan', ref: '2', label: 'Pro', value: false, required: true, disabled: false },
      ] }],
      orphanFields: [],
    };
    expect(groupFormFields(state)[0].required).toBe(true);
  });
});
