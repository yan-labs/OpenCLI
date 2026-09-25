/**
 * Submit-outcome verification — ported from
 * yan-skills/backlink/scripts/lib-submit-outcome.mjs (see that file's header
 * comment for the full rationale). The short version: "our URL appears
 * somewhere in the page" is not evidence of success, because a validation
 * failure on many directory sites silently re-renders the *same* submission
 * form with the just-typed value echoed back into `<input value="...">` —
 * that value is real DOM content, so a naive text-scan finds it and reports
 * `submitted` for a submission that never happened.
 *
 * The fix is the same one lib-submit-outcome.mjs uses: dual evidence.
 *   positive — our URL / acceptance copy appears OUTSIDE any form (an
 *              `<input value>` never contributes to `innerText`, so this
 *              region excludes exactly the echo case above);
 *   negative — the submission form is still present, still shows our value,
 *              has a validation-error marker inside it, or the URL/title
 *              never left the submit page.
 * Only "positive and no negative" is `submitted`. This module keeps the
 * same five states and the same selectors/keywords as the original so the
 * two pipelines never quietly disagree about what "submitted" means.
 *
 * JEV's role here is an ASSIST, not the decision-maker: run.ts may ask one
 * extra `noul` question ("does this look accepted?") and attach it to the
 * result for a human to read, but `classifySubmitOutcome()` below decides
 * the actual `state` from `evidence` alone — never from the JEV answer.
 */

import type { SubmitOutcomeEvidence, SubmitOutcomeResult, SubmitOutcomeState } from './types.js';

/** Field name/id/placeholder shape that marks a form as "submitting a URL", not a search/subscribe box. Same regex as lib-submit-outcome.mjs's SUBMISSION_FIELD. */
export const SUBMISSION_FIELD_RE = /url|website|site|link|homepage/i;

/** Validation-error markers inside a form. Same selector list as lib-submit-outcome.mjs's FORM_ERROR_SELECTOR. */
export const FORM_ERROR_SELECTOR =
  '.error,.errors,.error-message,.is-invalid,.has-error,.invalid-feedback,.field-error,' +
  '[aria-invalid="true"],[role="alert"],.alert-danger,.text-danger';

/** Acceptance copy, only counted when found outside any form. Same regex as lib-submit-outcome.mjs's ACCEPTANCE_COPY. */
export const ACCEPTANCE_COPY_RE =
  /thank you|thanks for|success|received|has been submitted|been added|pending (approval|review)|awaiting (approval|review)|under review|提交成功|已提交|等待审核|审核中|感谢/i;

/**
 * Self-contained in-page probe (no external bindings — evaluated via
 * page.evaluate()). Mirrors lib-submit-outcome.mjs's readSubmitOutcome()
 * exactly, adapted from "instantiate against a passed-in `documentTarget`"
 * (that file's dependency-injection style for offline testing) to "run
 * directly against the live `document`", since IPage.evaluate() already
 * gives us that isolation for free.
 */
export function outcomeProbeJs(submittedUrl: string): string {
  return `
    (() => {
      const submissionFieldRe = ${SUBMISSION_FIELD_RE.toString()};
      const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
      const target = clean(${JSON.stringify(submittedUrl)});
      const forms = Array.from(document.forms || []);
      const fieldKey = (el) => (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '');
      const isSubmissionForm = (form) => Array.from(form.elements || []).some((el) => submissionFieldRe.test(fieldKey(el)));
      const live = forms.filter(isSubmissionForm);

      const echoed = target !== '' && live.some((form) =>
        Array.from(form.elements || []).some((el) => clean(el.value) === target));

      const validationError = live.some((form) => {
        try { return !!form.querySelector(${JSON.stringify(FORM_ERROR_SELECTOR)}); } catch { return false; }
      });

      let confirmationText = clean(document.body && document.body.innerText);
      const bodyText = confirmationText;
      for (const form of live) {
        const formText = clean(form.innerText);
        if (formText) confirmationText = confirmationText.split(formText).join(' ');
      }
      confirmationText = clean(confirmationText);

      return {
        submittedUrl: target,
        formStillPresent: live.length > 0,
        echoedSubmittedValue: echoed,
        validationError,
        urlInConfirmationRegion: target !== '' && confirmationText.includes(target),
        confirmationText: confirmationText.slice(0, 600),
        bodyText: bodyText.slice(0, 600),
        title: clean(document.title),
        afterUrl: location.href,
      };
    })()
  `.trim();
}

const norm = (value: unknown): string => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

/**
 * Pure classifier — ported 1:1 from lib-submit-outcome.mjs's
 * classifySubmitOutcome(). Given the probe's evidence (plus beforeUrl/
 * beforeTitle captured just before the submit click), returns one of five
 * states with the positive/negative evidence lists that produced it.
 */
export function classifySubmitOutcome(evidence: SubmitOutcomeEvidence): Pick<SubmitOutcomeResult, 'state' | 'positive' | 'negative'> {
  const positive: string[] = [];
  const negative: string[] = [];

  if (evidence.urlInConfirmationRegion) positive.push('our-url-outside-any-form');
  if (ACCEPTANCE_COPY_RE.test(String(evidence.confirmationText || ''))) positive.push('acceptance-copy-outside-any-form');

  if (evidence.formStillPresent && evidence.echoedSubmittedValue) {
    negative.push('submission-form-redisplayed-with-our-value');
  } else if (evidence.formStillPresent) {
    negative.push('submission-form-still-present');
  }
  if (evidence.validationError) negative.push('validation-error-inside-the-form');

  const urlUnchanged = Boolean(evidence.beforeUrl) && evidence.afterUrl === evidence.beforeUrl;
  const titleUnchanged = Boolean(evidence.beforeTitle) && norm(evidence.title) === norm(evidence.beforeTitle);
  if (urlUnchanged && titleUnchanged) negative.push('still-on-the-submit-page');

  let state: SubmitOutcomeState;
  if (evidence.challenge) state = 'gated-captcha-on-confirm';
  else if (positive.length && !negative.length) state = 'submitted';
  else if (positive.length) state = 'submitted-inconclusive';
  else if (!negative.length && evidence.beforeUrl && evidence.afterUrl && evidence.afterUrl !== evidence.beforeUrl) state = 'submitted-unconfirmed';
  else state = 'outcome-unknown';

  return { state, positive, negative };
}
