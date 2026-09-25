import { describe, expect, it, vi } from 'vitest';
import { runAuto } from './run.js';
import type { RawFormState } from './field-groups.js';
import type { CallJevFn, JevCallResult } from './types.js';
import type { IPage } from '../../types.js';

// ── A minimal fake IPage: a tiny world of pages keyed by URL, with
// page.click(ref) able to "navigate" via a transition map. Only the methods
// runAuto.ts actually calls are implemented; everything else throws so an
// accidental new dependency fails loudly instead of silently no-opping. ──

interface FakePageSpec {
  url: string;
  title: string;
  snapshotBody: string; // the interactive-ref lines, without the url/title/--- header
  formState?: RawFormState;
  transitions?: Record<string, string>; // ref -> next page url, applied on click
  /** Overrides run.ts's page-gate probe (captcha/login-wall) while this page is current. */
  gate?: { captchaDetected: boolean; captchaEvidence?: string; loginWallDetected: boolean; loginWallEvidence?: string };
}

interface FakePageOptions {
  /** Overrides run.ts's outcome-check probe result (everything but beforeUrl/beforeTitle, which run.ts fills in itself). */
  outcomeProbe?: Record<string, unknown>;
}

function emptyFormState(): RawFormState {
  return { forms: [], orphanFields: [] };
}

const NO_GATE = { captchaDetected: false, loginWallDetected: false };

function makeFakePage(pages: Record<string, FakePageSpec>, startUrl: string, options: FakePageOptions = {}) {
  let current = startUrl;
  const clickLog: string[] = [];
  const fillLog: Array<{ ref: string; text: string }> = [];
  const checkLog: string[] = [];

  const page: Partial<IPage> = {
    async snapshot() {
      const p = pages[current];
      return `url: ${p.url}\ntitle: ${p.title}\nviewport: 1280x900\n---\n${p.snapshotBody}\n`;
    },
    async getFormState() {
      return pages[current].formState ?? emptyFormState();
    },
    async click(ref: string) {
      clickLog.push(ref);
      const next = pages[current].transitions?.[ref];
      if (next) current = next;
      return { matches_n: 1, match_level: 'exact' as const };
    },
    async fillText(ref: string, text: string) {
      fillLog.push({ ref, text });
      return { filled: true, verified: true, expected: text, actual: text, length: text.length, matches_n: 1, match_level: 'exact' as const };
    },
    async setChecked(ref: string) {
      checkLog.push(ref);
      return { checked: true, changed: true, matches_n: 1, match_level: 'exact' as const };
    },
    async wait() {},
    // Dispatches by a marker string unique to each probe generator (see
    // page-gates.ts / outcome-check.ts / select-by-ref.ts) rather than
    // parsing real JS — good enough for a test double, and fails loudly
    // (via the thrown default) for any evaluate() this suite doesn't expect.
    async evaluate(js: unknown) {
      const src = String(js);
      if (src.includes('captchaDetected')) return pages[current].gate ?? NO_GATE;
      if (src.includes('submittedUrl') && src.includes('afterUrl')) {
        return {
          submittedUrl: '', formStillPresent: false, echoedSubmittedValue: false, validationError: false,
          urlInConfirmationRegion: false, confirmationText: '', bodyText: '', title: pages[current].title, afterUrl: pages[current].url,
          ...(options.outcomeProbe ?? {}),
        };
      }
      throw new Error(`evaluate() not stubbed for this JS in this test: ${src.slice(0, 80)}`);
    },
  };

  return { page: page as IPage, clickLog, fillLog, checkLog, getCurrent: () => current };
}

describe('runAuto — pure navigation (no forms)', () => {
  const pages: Record<string, FakePageSpec> = {
    start: { url: 'https://example.com/', title: 'Example Domain', snapshotBody: '[1]<a href=/learn>Learn more</a>', transitions: { '1': 'help' } },
    help: { url: 'https://iana.org/help', title: 'Example Domains', snapshotBody: '[1]<a href=/domains>IANA-managed Reserved Domains</a>', transitions: { '1': 'domains' } },
    domains: { url: 'https://iana.org/domains', title: 'Root Zone Database', snapshotBody: '(nothing left to click, goal reached)' },
  };

  it('walks multiple pages via JEV choice and stops on JEV-chosen DONE', async () => {
    const { page, clickLog } = makeFakePage(pages, 'start');
    const callJev: CallJevFn = async (_state, questions): Promise<JevCallResult> => {
      const criteria = questions.next.criteria ?? {};
      // Always click the first non-DONE candidate until none remain besides DONE.
      const clickable = Object.keys(criteria).find((k) => k !== 'DONE');
      const choice = clickable ?? 'DONE';
      const probabilities = Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 0.95 : 0.01]));
      return { answers: { next: { type: 'choice', choice, probabilities, confidence: 0.95 } }, usage: { input_tokens: 500 }, ms: 3 };
    };

    const result = await runAuto(page, { goal: 'reach the IANA root zone page', maxSteps: 10, minConfidence: 0.55, allowSubmit: false, dryRun: false, confirmTerms: false }, { callJev });

    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('done');
    expect(clickLog).toEqual(['1', '1']);
    expect(result.finalUrl).toBe('https://iana.org/domains');
    // 2 real "next" JEV calls (start->help, help->domains); the 3rd step has
    // only DONE left so it must NOT cost a JEV call.
    expect(result.jevCalls).toBe(2);
  });

  it('stops for a human when JEV confidence is below --min-confidence', async () => {
    const { page, clickLog } = makeFakePage(pages, 'start');
    const callJev: CallJevFn = async (_state, questions): Promise<JevCallResult> => {
      const criteria = questions.next.criteria ?? {};
      const choice = Object.keys(criteria)[0];
      const probabilities = Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 0.4 : 0.3]));
      return { answers: { next: { type: 'choice', choice, probabilities, confidence: 0.4 } }, usage: { input_tokens: 400 }, ms: 2 };
    };

    const result = await runAuto(page, { goal: 'reach the IANA root zone page', maxSteps: 10, minConfidence: 0.55, allowSubmit: false, dryRun: false, confirmTerms: false }, { callJev });

    expect(result.status).toBe('stopped_for_human');
    expect(result.stopReason).toBe('low_confidence');
    expect(clickLog).toEqual([]); // never executed — stopped before acting
    expect(result.steps).toHaveLength(1);
  });

  it('stops at --max-steps when JEV keeps choosing an action that never satisfies DONE', async () => {
    const loopingPages: Record<string, FakePageSpec> = {
      start: { url: 'https://example.com/', title: 'x', snapshotBody: '[1]<a href=#>Refresh</a>' }, // no transition — clicking never advances
    };
    const { page, clickLog } = makeFakePage(loopingPages, 'start');
    const callJev: CallJevFn = vi.fn(async (_state, questions): Promise<JevCallResult> => {
      const criteria = questions.next.criteria ?? {};
      return { answers: { next: { type: 'choice', choice: 'CLICK_1', probabilities: { CLICK_1: 0.9, DONE: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 100 }, ms: 1 };
    });

    const result = await runAuto(page, { goal: 'never satisfiable', maxSteps: 3, minConfidence: 0.55, allowSubmit: false, dryRun: false, confirmTerms: false }, { callJev });

    expect(result.status).toBe('stopped_for_human');
    expect(result.stopReason).toBe('max_steps');
    expect(clickLog).toEqual(['1', '1', '1']);
    expect(callJev).toHaveBeenCalledTimes(3);
  });

  it('dry-run previews one step and executes nothing', async () => {
    const { page, clickLog } = makeFakePage(pages, 'start');
    const callJev: CallJevFn = async (_state, questions): Promise<JevCallResult> => {
      const criteria = questions.next.criteria ?? {};
      const choice = Object.keys(criteria).find((k) => k !== 'DONE') ?? 'DONE';
      return { answers: { next: { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 50 }, ms: 1 };
    };

    const result = await runAuto(page, { goal: 'reach the IANA root zone page', maxSteps: 10, minConfidence: 0.55, allowSubmit: false, dryRun: true, confirmTerms: false }, { callJev });

    expect(result.stopReason).toBe('dry_run');
    expect(result.status).toBe('stopped_for_human');
    expect(clickLog).toEqual([]);
    expect(result.jevCalls).toBe(1);
  });
});

describe('runAuto — form filling', () => {
  function formPage(): FakePageSpec {
    return {
      url: 'https://httpbin.org/forms/post',
      title: 'Pizza order form',
      snapshotBody: [
        '[1]<input type=text name=custname />',
        '[2]<input type=submit value=Submit order />',
      ].join('\n'),
      formState: {
        forms: [{
          id: null, name: null, action: '/post', method: 'POST',
          fields: [{ tag: 'input', type: 'text', name: 'custname', ref: '1', label: 'Customer name', value: '', required: false, disabled: false }],
        }],
        orphanFields: [],
      },
    };
  }

  it('maps the field once, fills it via a JEV-chosen fill candidate, then stops "awaiting_submit" without --allow-submit and without a 3rd JEV call', async () => {
    const pages = { form: formPage() };
    const { page, fillLog, clickLog } = makeFakePage(pages, 'form');

    const callJev: CallJevFn = vi.fn(async (state, questions): Promise<JevCallResult> => {
      // Field-mapping call: one question keyed by the group, criteria include data keys.
      if ('text:custname:1' in questions) {
        return { answers: { 'text:custname:1': { type: 'choice', choice: 'full_name', probabilities: { full_name: 0.9, NONE: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 200 }, ms: 4 };
      }
      // Per-step action call: must pick the FILL candidate over DONE.
      const criteria = questions.next.criteria ?? {};
      const fillId = Object.keys(criteria).find((k) => k.startsWith('FILL_')) ?? 'DONE';
      return { answers: { next: { type: 'choice', choice: fillId, probabilities: { [fillId]: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 300 }, ms: 2 };
    });

    const result = await runAuto(page, { goal: 'fill the pizza order form', data: { full_name: 'Ada Lovelace' }, maxSteps: 10, minConfidence: 0.55, allowSubmit: false, dryRun: false, confirmTerms: false }, { callJev });

    expect(fillLog).toEqual([{ ref: '1', text: 'Ada Lovelace' }]);
    expect(clickLog).toEqual([]); // submit never clicked
    expect(result.status).toBe('stopped_for_human');
    expect(result.stopReason).toBe('awaiting_submit');
    expect(result.filledFields).toEqual([{ groupKey: 'text:custname:1', label: 'Customer name', dataKey: 'full_name', value: 'Ada Lovelace' }]);
    // 1 mapping call + 1 action call choosing FILL; the trivial "only DONE
    // left" step after filling must not spend a 3rd JEV call.
    expect(callJev).toHaveBeenCalledTimes(2);
  });

  it('resumes correctly on a fresh invocation when the live DOM already carries a previous run\'s value — does not re-offer or re-count an already-filled field', async () => {
    // Simulates re-running `auto` against the same still-open tab after an
    // earlier invocation (a separate process, so appliedRefs starts empty
    // here) already filled custname. Regression test for the bug where a
    // second invocation deterministically re-chose the exact same first
    // action every time and never progressed (see run.ts's
    // syncAppliedRefsFromLiveState and model-driven.md's known limitations).
    const pageSpec = formPage();
    pageSpec.formState!.forms[0].fields[0].value = 'Ada Lovelace'; // already filled on the live page
    const pages = { form: pageSpec };
    const { page, fillLog } = makeFakePage(pages, 'form');

    const callJev: CallJevFn = vi.fn(async (_state, questions): Promise<JevCallResult> => {
      if ('text:custname:1' in questions) {
        return { answers: { 'text:custname:1': { type: 'choice', choice: 'full_name', probabilities: { full_name: 0.9, NONE: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 200 }, ms: 4 };
      }
      throw new Error('should not reach the per-step action call: FILL_text:custname:1 must never be offered once the live value already matches');
    });

    const result = await runAuto(page, { goal: 'fill the pizza order form', data: { full_name: 'Ada Lovelace' }, maxSteps: 10, minConfidence: 0.55, allowSubmit: false, dryRun: false, confirmTerms: false }, { callJev });

    expect(fillLog).toEqual([]); // never re-filled
    expect(result.status).toBe('stopped_for_human'); // submit still suppressed
    expect(result.stopReason).toBe('awaiting_submit');
    expect(result.filledFields).toEqual([{ groupKey: 'text:custname:1', label: 'Customer name', dataKey: 'full_name', value: 'Ada Lovelace' }]);
    expect(callJev).toHaveBeenCalledTimes(1); // only the mapping call — the trivial-DONE step costs nothing
  });

  it('clicks submit when --allow-submit is passed, landing on a confirmation page with nothing left to do', async () => {
    const pages = {
      form: formPage(),
      confirmed: { url: 'https://httpbin.org/forms/post', title: 'Thank you', snapshotBody: '<p>Order received</p>', formState: emptyFormState() },
    };
    pages.form.transitions = { '2': 'confirmed' };
    const { page, clickLog } = makeFakePage(pages, 'form');
    const callJev: CallJevFn = vi.fn(async (_state, questions): Promise<JevCallResult> => {
      const criteria = questions.next.criteria ?? {};
      const submitId = Object.keys(criteria).find((k) => k.startsWith('CLICK_')) ?? 'DONE';
      return { answers: { next: { type: 'choice', choice: submitId, probabilities: { [submitId]: 0.9 }, confidence: 0.9 } }, usage: { input_tokens: 100 }, ms: 1 };
    });

    // No --data: the text field maps to NONE (skipped, logged, not invented) and the submit click is offered because --allow-submit is set.
    const result = await runAuto(page, { goal: 'submit the form', maxSteps: 5, minConfidence: 0.55, allowSubmit: true, dryRun: false, confirmTerms: false }, { callJev });

    expect(clickLog).toEqual(['2']);
    expect(result.skippedFields).toEqual([{ groupKey: 'text:custname:1', label: 'Customer name', reason: 'no_data_file' }]);
  });
});
