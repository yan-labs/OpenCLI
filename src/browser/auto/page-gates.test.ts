import { describe, expect, it } from 'vitest';
import { pageGateProbeJs } from './page-gates.js';

describe('pageGateProbeJs', () => {
  const js = pageGateProbeJs();

  it('generates syntactically valid JS', () => {
    expect(() => new Function(js)).not.toThrow();
  });

  it('checks for common CAPTCHA/challenge vendor markers', () => {
    expect(js).toContain('captcha');
    expect(js).toContain('turnstile');
    expect(js).toContain('recaptcha');
    expect(js).toContain('hcaptcha');
    expect(js).toContain('data-sitekey');
    expect(js).toContain('challenges.cloudflare.com');
  });

  it('has a text-based CAPTCHA fallback for widgets with no matching selector', () => {
    expect(js).toContain('security challenge');
    expect(js).toContain('bodyText');
  });

  it('checks for a login form via action containing "login" or a password field', () => {
    expect(js).toContain('login');
    expect(js).toContain('password');
    expect(js).toContain('document.forms');
  });

  it('also catches a bare password field outside any <form>', () => {
    expect(js).toContain('outside any');
  });

  it('returns the four documented result fields', () => {
    expect(js).toContain('captchaDetected');
    expect(js).toContain('captchaEvidence');
    expect(js).toContain('loginWallDetected');
    expect(js).toContain('loginWallEvidence');
  });
});
