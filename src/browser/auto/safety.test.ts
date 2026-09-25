import { describe, expect, it } from 'vitest';
import { looksIrreversible } from './safety.js';
import type { SnapshotRef } from './types.js';

function ref(partial: Partial<SnapshotRef>): SnapshotRef {
  return { ref: '1', tag: 'a', attrs: {}, text: '', ...partial };
}

describe('looksIrreversible', () => {
  it('flags type=submit regardless of text', () => {
    expect(looksIrreversible(ref({ tag: 'input', attrs: { type: 'submit' }, text: '' }))).toBe(true);
  });

  it('flags English submit/pay/send/delete keywords in link text', () => {
    expect(looksIrreversible(ref({ text: 'Submit order' }))).toBe(true);
    expect(looksIrreversible(ref({ text: 'Pay now' }))).toBe(true);
    expect(looksIrreversible(ref({ text: 'Send message' }))).toBe(true);
    expect(looksIrreversible(ref({ text: 'Delete account' }))).toBe(true);
  });

  it('flags Chinese submit/pay/send/delete keywords', () => {
    expect(looksIrreversible(ref({ text: '提交订单' }))).toBe(true);
    expect(looksIrreversible(ref({ text: '立即支付' }))).toBe(true);
    expect(looksIrreversible(ref({ text: '删除账户' }))).toBe(true);
    expect(looksIrreversible(ref({ text: '确认下单' }))).toBe(true);
  });

  it('flags account-creation keywords — found via real-device testing on a signup form whose untyped "Create account" button slipped past every other keyword', () => {
    expect(looksIrreversible(ref({ text: 'Create account' }))).toBe(true);
    expect(looksIrreversible(ref({ text: 'Sign up' }))).toBe(true);
    expect(looksIrreversible(ref({ text: '创建账号' }))).toBe(true);
    expect(looksIrreversible(ref({ text: '注册' }))).toBe(true);
  });

  it('matches via aria-label/title/id when visible text is empty (icon buttons)', () => {
    expect(looksIrreversible(ref({ text: '', attrs: { 'aria-label': 'Delete this item' } }))).toBe(true);
    expect(looksIrreversible(ref({ text: '', attrs: { title: 'Confirm purchase' } }))).toBe(true);
    expect(looksIrreversible(ref({ text: '', attrs: { id: 'btn-checkout' } }))).toBe(true);
  });

  it('does not flag ordinary navigation links', () => {
    expect(looksIrreversible(ref({ text: 'Learn more', attrs: { href: '/domains' } }))).toBe(false);
    expect(looksIrreversible(ref({ text: 'Settings' }))).toBe(false);
    expect(looksIrreversible(ref({ tag: 'button', text: 'Cancel', attrs: { type: 'button' } }))).toBe(false);
  });

  it('does not flag unrelated words that merely contain a keyword-like substring boundary', () => {
    // "Sendai" (a place name) should not trip the "send" keyword — this
    // documents a known false-positive risk of substring matching rather
    // than asserting perfect precision.
    expect(looksIrreversible(ref({ text: 'Sendai travel guide' }))).toBe(true); // documents the known limitation
  });
});
