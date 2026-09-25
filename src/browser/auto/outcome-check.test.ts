import { describe, expect, it } from 'vitest';
import { ACCEPTANCE_COPY_RE, classifySubmitOutcome, FORM_ERROR_SELECTOR, SUBMISSION_FIELD_RE } from './outcome-check.js';
import type { SubmitOutcomeEvidence } from './types.js';

function evidence(partial: Partial<SubmitOutcomeEvidence>): SubmitOutcomeEvidence {
  return {
    submittedUrl: 'https://our.site/',
    formStillPresent: false,
    echoedSubmittedValue: false,
    validationError: false,
    urlInConfirmationRegion: false,
    confirmationText: '',
    title: '',
    ...partial,
  };
}

describe('classifySubmitOutcome — the core case this module exists for', () => {
  it('reports "submitted" when confirmation copy appears outside any form and nothing negative is present', () => {
    const result = classifySubmitOutcome(evidence({
      urlInConfirmationRegion: true,
      confirmationText: 'Thank you! Your site has been submitted for review.',
      beforeUrl: 'https://directory.example/submit', afterUrl: 'https://directory.example/thank-you',
    }));
    expect(result.state).toBe('submitted');
    expect(result.positive).toEqual(expect.arrayContaining(['our-url-outside-any-form', 'acceptance-copy-outside-any-form']));
    expect(result.negative).toEqual([]);
  });

  it('DOES NOT report "submitted" for the form-silently-rerenders-with-our-value failure mode — this is the bug lib-submit-outcome.mjs exists to prevent', () => {
    // Our URL is technically present on the page (echoed back into the input
    // value), and the page might even coincidentally contain "submit" in its
    // markup — but the submission form is still there with our value in it.
    // A naive "does the page contain our URL" check would wrongly say yes.
    const result = classifySubmitOutcome(evidence({
      formStillPresent: true,
      echoedSubmittedValue: true,
      urlInConfirmationRegion: false, // the echo lives inside the form, not outside it
      confirmationText: '',
      beforeUrl: 'https://directory.example/submit', afterUrl: 'https://directory.example/submit',
    }));
    expect(result.state).not.toBe('submitted');
    expect(result.negative).toContain('submission-form-redisplayed-with-our-value');
  });

  it('reports "submitted-inconclusive" when positive evidence exists but so does negative evidence', () => {
    const result = classifySubmitOutcome(evidence({
      urlInConfirmationRegion: true,
      formStillPresent: true,
      validationError: true,
    }));
    expect(result.state).toBe('submitted-inconclusive');
    expect(result.negative).toContain('validation-error-inside-the-form');
  });

  it('reports "submitted-unconfirmed" when the page navigated away with no negative signal but no positive copy either', () => {
    const result = classifySubmitOutcome(evidence({
      beforeUrl: 'https://directory.example/submit', afterUrl: 'https://directory.example/step2',
      beforeTitle: 'Submit your site', title: 'Almost done',
    }));
    expect(result.state).toBe('submitted-unconfirmed');
  });

  it('reports "outcome-unknown" when nothing changed and nothing positive appeared', () => {
    const result = classifySubmitOutcome(evidence({
      beforeUrl: 'https://directory.example/submit', afterUrl: 'https://directory.example/submit',
      beforeTitle: 'Submit your site', title: 'Submit your site',
    }));
    expect(result.state).toBe('outcome-unknown');
    expect(result.negative).toContain('still-on-the-submit-page');
  });

  it('reports "gated-captcha-on-confirm" when a challenge appears at the confirm step, regardless of other evidence', () => {
    const result = classifySubmitOutcome(evidence({ urlInConfirmationRegion: true, challenge: true }));
    expect(result.state).toBe('gated-captcha-on-confirm');
  });
});

describe('the ported constants stay aligned with backlink/scripts/lib-submit-outcome.mjs', () => {
  it('SUBMISSION_FIELD_RE matches url/website/site/link/homepage field names', () => {
    for (const name of ['website_url', 'siteUrl', 'homepage', 'link']) {
      expect(SUBMISSION_FIELD_RE.test(name)).toBe(true);
    }
    expect(SUBMISSION_FIELD_RE.test('customer_name')).toBe(false);
  });

  it('ACCEPTANCE_COPY_RE matches common EN+ZH confirmation phrasing', () => {
    expect(ACCEPTANCE_COPY_RE.test('Thanks for your submission!')).toBe(true);
    expect(ACCEPTANCE_COPY_RE.test('提交成功，等待审核')).toBe(true);
    expect(ACCEPTANCE_COPY_RE.test('Please fill in all required fields')).toBe(false);
  });

  it('FORM_ERROR_SELECTOR is a non-empty CSS selector list', () => {
    expect(FORM_ERROR_SELECTOR.length).toBeGreaterThan(10);
    expect(FORM_ERROR_SELECTOR).toContain('aria-invalid');
  });
});
