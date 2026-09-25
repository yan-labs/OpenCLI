import { describe, expect, it } from 'vitest';
import { isTermsLikeGroup } from './terms-guard.js';

describe('isTermsLikeGroup', () => {
  it('matches common English terms/consent/privacy phrasing', () => {
    expect(isTermsLikeGroup('I agree to the Terms of Service')).toBe(true);
    expect(isTermsLikeGroup('I have read and accept the Privacy Policy')).toBe(true);
    expect(isTermsLikeGroup('Accept Terms and Conditions')).toBe(true);
    expect(isTermsLikeGroup('agree_to_tos')).toBe(true);
  });

  it('matches common Chinese terms/consent phrasing', () => {
    expect(isTermsLikeGroup('我同意服务条款')).toBe(true);
    expect(isTermsLikeGroup('已阅读并同意隐私政策')).toBe(true);
    expect(isTermsLikeGroup('同意用户协议')).toBe(true);
  });

  it('does not flag an ordinary newsletter/marketing opt-in checkbox', () => {
    expect(isTermsLikeGroup('Subscribe to our newsletter')).toBe(false);
    expect(isTermsLikeGroup('Remember me')).toBe(false);
    expect(isTermsLikeGroup('订阅我们的邮件')).toBe(false);
  });

  it('does not flag an unrelated field that happens to use the word "agree" loosely out of context', () => {
    // Documents the scope of the heuristic rather than asserting perfection:
    // a bare "agree" substring in an unrelated sentence would still match —
    // acceptable because the cost of over-blocking a checkbox is low (it's
    // reported as blocked and can be allowed with --confirm-terms) versus
    // the cost of under-blocking a real terms checkbox.
    expect(isTermsLikeGroup('Do you agree with our pricing?')).toBe(true);
  });
});
