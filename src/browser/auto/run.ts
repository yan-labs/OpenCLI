/**
 * Orchestrates `browser <session> auto`: snapshot -> candidates -> one JEV
 * choice call -> execute -> log, repeated up to `maxSteps`, with a field
 * mapping sub-call the first time new form fields show up (only when
 * `--data` was given). See types.ts for the full result shape and
 * yan-skills/opencli/references/model-driven.md for the design rationale.
 */

import type { IPage } from '../../types.js';
import { callJev as realCallJev } from './jev-client.js';
import { parseSnapshotHeader, parseSnapshotRefs } from './snapshot-parse.js';
import { groupFormFields, type RawFormState } from './field-groups.js';
import { mapFieldsToData } from './field-mapping.js';
import { buildCandidates, candidatesToJevCriteria } from './candidates.js';
import { selectByRefJs } from './select-by-ref.js';
import { pageGateProbeJs, type PageGateProbeResult } from './page-gates.js';
import { classifySubmitOutcome, outcomeProbeJs } from './outcome-check.js';
import type {
  ActionCandidate,
  AutoOptions,
  AutoResult,
  CallJevFn,
  FieldGroup,
  FieldMappingLog,
  FieldMappingResult,
  StepLog,
  StopReason,
  SubmitOutcomeEvidence,
  SubmitOutcomeResult,
} from './types.js';

export interface RunAutoDeps {
  callJev: CallJevFn;
}

const DEFAULT_DEPS: RunAutoDeps = { callJev: realCallJev };

function topChoices(probabilities: Record<string, number>, n = 3): Array<{ id: string; probability: number }> {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, probability]) => ({ id, probability }));
}

function stepInstructions(): string {
  return (
    'You are operating a web browser to accomplish `goal`. Pick the single best next action from the ' +
    'candidate list: a click (navigate/interact), a fill/select/check (set a form field to an already-decided ' +
    'value), or DONE if `goal` is already satisfied by the current page. Prefer completing outstanding form ' +
    'fields before clicking away from the form, and prefer DONE only when the page visibly reflects the goal.'
  );
}

export async function runAuto(page: IPage, options: AutoOptions, deps: RunAutoDeps = DEFAULT_DEPS): Promise<AutoResult> {
  const startedAt = Date.now();
  const steps: StepLog[] = [];
  const appliedRefs = new Set<string>();
  const mappedGroupKeys = new Set<string>();
  const fieldMappingResults: FieldMappingResult[] = [];
  let fieldMappingLog: FieldMappingLog | undefined;
  let jevCalls = 0;
  let jevTotalInputTokens = 0;
  let jevTotalMs = 0;
  let finalUrl = '';
  let finalTitle = '';
  const termsBlockedKeys = new Set<string>();
  const termsCheckboxesBlocked: AutoResult['termsCheckboxesBlocked'] = [];

  function finish(status: AutoResult['status'], stopReason: StopReason, message: string, outcomeCheck?: SubmitOutcomeResult): AutoResult {
    return {
      status,
      stopReason,
      message,
      steps,
      fieldMapping: fieldMappingLog,
      finalUrl,
      finalTitle,
      jevCalls,
      jevTotalInputTokens,
      jevTotalMs,
      durationMs: Date.now() - startedAt,
      filledFields: fieldMappingResults
        .filter((r) => r.dataKey !== 'NONE' && r.matchedRefs.some((ref) => appliedRefs.has(ref)))
        .map((r) => ({ groupKey: r.groupKey, label: r.group.label, dataKey: r.dataKey, value: r.resolvedValue })),
      skippedFields: fieldMappingResults
        .filter((r) => r.dataKey === 'NONE' || (r.skippedReason && !r.matchedRefs.some((ref) => appliedRefs.has(ref))))
        .map((r) => ({ groupKey: r.groupKey, label: r.group.label, reason: r.skippedReason ?? 'not_applied' })),
      outcomeCheck,
      termsCheckboxesBlocked,
    };
  }

  try {
    for (let step = 1; step <= options.maxSteps; step++) {
      const snapshotText = String(await page.snapshot({ viewportExpand: 2000, interactive: true, source: 'dom' }));
      const header = parseSnapshotHeader(snapshotText);
      finalUrl = header.url;
      finalTitle = header.title;
      const refs = parseSnapshotRefs(snapshotText);

      // Deterministic safety gates, every step, before any JEV call: a page
      // either has a CAPTCHA widget or a login form in its DOM or it doesn't
      // — this is a fact to check, not a judgment to ask JEV for. Checked
      // every step (not just once) because a challenge can appear mid-flow,
      // e.g. right after a click. See page-gates.ts.
      const gate = (await page.evaluate(pageGateProbeJs())) as PageGateProbeResult;
      if (gate.captchaDetected) {
        steps.push({ step, url: header.url, title: header.title, candidateCount: 0, suppressedCount: 0, choice: '', confidence: 0, topChoices: [], executed: false, jevMs: 0, note: `captcha_detected: ${gate.captchaEvidence ?? '(no detail)'}` });
        return finish('stopped_for_human', 'captcha_detected', `Stopped: a CAPTCHA/challenge was detected (${gate.captchaEvidence ?? 'no detail'}). auto never attempts to solve one.`);
      }
      if (gate.loginWallDetected) {
        steps.push({ step, url: header.url, title: header.title, candidateCount: 0, suppressedCount: 0, choice: '', confidence: 0, topChoices: [], executed: false, jevMs: 0, note: `login_wall_detected: ${gate.loginWallEvidence ?? '(no detail)'}` });
        return finish('stopped_for_human', 'login_wall_detected', `Stopped: a login form was detected (${gate.loginWallEvidence ?? 'no detail'}). auto never creates accounts or enters credentials.`);
      }

      const rawFormState = (await page.getFormState()) as RawFormState;
      const groups = groupFormFields(rawFormState);
      // formRefs includes terms-like checkboxes too, on purpose: it's what
      // keeps a blocked checkbox's ref OUT of the plain-click candidate set
      // in buildCandidates (see isClickWorthy) — excluding it from formRefs
      // instead would let a blocked terms checkbox reappear as an ordinary
      // CLICK_<ref> candidate, defeating the hard gate below.
      const formRefs = new Set<string>();
      for (const g of groups) for (const m of g.members) formRefs.add(m.ref);

      for (const g of groups) {
        if (g.isTermsLike && !options.confirmTerms && !termsBlockedKeys.has(g.groupKey)) {
          termsBlockedKeys.add(g.groupKey);
          termsCheckboxesBlocked.push({ groupKey: g.groupKey, label: g.label });
        }
      }
      // Hard gate: terms/consent checkboxes never enter the mapping or
      // candidate pipeline without --confirm-terms — not "no data key
      // matched", but never offered to JEV at all (see terms-guard.ts).
      const usableGroups = options.confirmTerms ? groups : groups.filter((g) => !g.isTermsLike);

      const newGroups = usableGroups.filter((g) => !mappedGroupKeys.has(g.groupKey));
      if (newGroups.length > 0 && options.data) {
        const outcome = await mapFieldsToData(newGroups, options.data, { callJev: deps.callJev });
        for (const g of newGroups) mappedGroupKeys.add(g.groupKey);
        fieldMappingResults.push(...outcome.results);
        jevCalls++;
        jevTotalInputTokens += outcome.jevInputTokens ?? 0;
        jevTotalMs += outcome.jevMs;
        const entries = outcome.results.map((r) => ({
          groupKey: r.groupKey,
          label: r.group.label,
          kind: r.group.kind,
          dataKey: r.dataKey,
          confidence: r.confidence,
          matchedRefs: r.matchedRefs,
          skippedReason: r.skippedReason,
        }));
        fieldMappingLog = fieldMappingLog
          ? {
            ...fieldMappingLog,
            groups: fieldMappingLog.groups + newGroups.length,
            jevMs: fieldMappingLog.jevMs + outcome.jevMs,
            jevInputTokens: (fieldMappingLog.jevInputTokens ?? 0) + (outcome.jevInputTokens ?? 0),
            results: [...fieldMappingLog.results, ...entries],
          }
          : { step: 'field_mapping', groups: newGroups.length, jevMs: outcome.jevMs, jevInputTokens: outcome.jevInputTokens, results: entries };
      } else if (newGroups.length > 0 && !options.data) {
        for (const g of newGroups) {
          mappedGroupKeys.add(g.groupKey);
          fieldMappingResults.push({ groupKey: g.groupKey, group: g, dataKey: 'NONE', confidence: 0, matchedRefs: [], skippedReason: 'no_data_file' });
        }
      }

      // A field can already carry the wanted value/checked-state on the live
      // page without this *process* having applied it — most commonly a
      // fresh `auto` invocation resuming after a previous run stopped for a
      // human (low confidence / max-steps) on the same still-open page.
      // Cross-check this step's freshly-read `groups` (not the possibly
      // stale group snapshot captured inside fieldMappingResults at mapping
      // time) against each mapping's resolved target so those refs don't
      // get re-offered as candidates — without this, a re-invocation would
      // deterministically re-choose the exact same first action every time
      // and never progress past whatever tripped the first stop.
      syncAppliedRefsFromLiveState(usableGroups, fieldMappingResults, appliedRefs);

      const { candidates, suppressedIrreversible } = buildCandidates({
        refs,
        formRefs,
        pendingFieldActions: fieldMappingResults,
        appliedRefs,
        allowSubmit: options.allowSubmit,
      });

      // Only DONE remains: either the goal is truly finished, or the only
      // outstanding step is an irreversible click we're not allowed to take.
      if (candidates.length === 1) {
        const stopReason: StopReason = suppressedIrreversible.length > 0 ? 'awaiting_submit' : 'done';
        steps.push({
          step, url: header.url, title: header.title, candidateCount: 1, suppressedCount: suppressedIrreversible.length,
          choice: 'DONE', confidence: 1, topChoices: [{ id: 'DONE', probability: 1 }],
          action: candidates[0], executed: false, jevMs: 0,
          note: stopReason === 'awaiting_submit' ? 'only suppressed irreversible actions remain; not calling JEV' : 'no actions remain besides DONE; not calling JEV',
        });
        return finish(
          stopReason === 'awaiting_submit' ? 'stopped_for_human' : 'completed',
          stopReason,
          stopReason === 'awaiting_submit'
            ? 'Form appears filled; the only remaining action is an irreversible submit/confirm and --allow-submit was not passed.'
            : 'No further actions available; goal appears satisfied.',
        );
      }

      if (options.dryRun) {
        const criteria = candidatesToJevCriteria(candidates);
        const state = buildStepState(options, header, fieldMappingResults, appliedRefs);
        const response = await deps.callJev(state, { next: { type: 'choice', instructions: stepInstructions(), criteria } });
        jevCalls++;
        jevTotalInputTokens += response.usage?.input_tokens ?? 0;
        jevTotalMs += response.ms;
        const answer = response.answers.next;
        const choice = answer && answer.type === 'choice' ? answer.choice : 'DONE';
        const confidence = answer && answer.type === 'choice' ? answer.confidence : 0;
        const action = candidates.find((c) => c.id === choice);
        steps.push({
          step, url: header.url, title: header.title, candidateCount: candidates.length, suppressedCount: suppressedIrreversible.length,
          choice, confidence, topChoices: answer && answer.type === 'choice' ? topChoices(answer.probabilities) : [],
          action, executed: false, jevMs: response.ms, jevInputTokens: response.usage?.input_tokens,
          note: 'dry-run preview — not executed',
        });
        return finish('stopped_for_human', 'dry_run', `Dry run: would have chosen "${choice}" (${action?.description ?? 'unknown'}).`);
      }

      const criteria = candidatesToJevCriteria(candidates);
      const state = buildStepState(options, header, fieldMappingResults, appliedRefs);
      const response = await deps.callJev(state, { next: { type: 'choice', instructions: stepInstructions(), criteria } });
      jevCalls++;
      jevTotalInputTokens += response.usage?.input_tokens ?? 0;
      jevTotalMs += response.ms;

      const answer = response.answers.next;
      if (!answer || answer.type !== 'choice') {
        steps.push({ step, url: header.url, title: header.title, candidateCount: candidates.length, suppressedCount: suppressedIrreversible.length, choice: '', confidence: 0, topChoices: [], executed: false, jevMs: response.ms, note: 'jev_answer_missing' });
        return finish('error', 'error', 'JEV did not return a valid choice answer for the "next" question.');
      }

      const rawChoice = answer.choice;
      const chosenId = criteria[rawChoice] !== undefined ? rawChoice : 'DONE';
      const action = candidates.find((c) => c.id === chosenId) ?? candidates[candidates.length - 1];
      const confidence = answer.confidence;
      const top3 = topChoices(answer.probabilities);

      // On a page with several simultaneously-valid, order-agnostic fill/check
      // targets (a long form), JEV's probability mass legitimately spreads
      // across all of them — real-device testing on httpbin.org/forms/post
      // saw a *correct* fill candidate top out around 0.25-0.35 confidence
      // simply because 4-5 other fields were equally fine to do first, not
      // because the choice was actually risky. Gate on whichever is higher:
      // JEV's own confidence for the top choice, or (only when the top choice
      // is itself a fill/select/check — never for click/DONE, which stay
      // gated on raw confidence since a wrong click or a premature DONE is
      // the actually risky outcome) the combined probability mass across all
      // fill/select/check candidates, since executing *any* of them is a
      // safe, correct step regardless of order.
      let gateConfidence = confidence;
      let fillMassNote: string | undefined;
      if (action.kind === 'fill' || action.kind === 'select' || action.kind === 'check') {
        const fillLikeMass = candidates
          .filter((c) => c.kind === 'fill' || c.kind === 'select' || c.kind === 'check')
          .reduce((sum, c) => sum + (answer.probabilities[c.id] ?? 0), 0);
        if (fillLikeMass > gateConfidence) {
          gateConfidence = fillLikeMass;
          fillMassNote = `gated on combined fill/check probability mass ${fillLikeMass.toFixed(2)} (top-1 confidence was ${confidence.toFixed(2)})`;
        }
      }

      if (gateConfidence < options.minConfidence) {
        steps.push({
          step, url: header.url, title: header.title, candidateCount: candidates.length, suppressedCount: suppressedIrreversible.length,
          choice: chosenId, confidence, topChoices: top3, action, executed: false, jevMs: response.ms, jevInputTokens: response.usage?.input_tokens,
          note: `confidence ${gateConfidence.toFixed(2)} below --min-confidence ${options.minConfidence}`,
        });
        return finish('stopped_for_human', 'low_confidence', `Stopped: JEV confidence ${gateConfidence.toFixed(2)} is below the ${options.minConfidence} threshold.`);
      }

      if (action.kind === 'done') {
        steps.push({ step, url: header.url, title: header.title, candidateCount: candidates.length, suppressedCount: suppressedIrreversible.length, choice: chosenId, confidence, topChoices: top3, action, executed: false, jevMs: response.ms, jevInputTokens: response.usage?.input_tokens });
        return finish('completed', 'done', 'JEV judged the goal satisfied by the current page.');
      }

      const execNote = await executeAction(page, action, appliedRefs);
      steps.push({
        step, url: header.url, title: header.title, candidateCount: candidates.length, suppressedCount: suppressedIrreversible.length,
        choice: chosenId, confidence, topChoices: top3, action, executed: execNote.executed, jevMs: response.ms, jevInputTokens: response.usage?.input_tokens,
        note: [fillMassNote, execNote.note].filter(Boolean).join('; ') || undefined,
      });
      if (action.kind === 'click') await page.wait(1);

      // A submit-like click just ran (only possible with --allow-submit).
      // Don't let a later step's JEV DONE choice be the last word on whether
      // it actually worked — run the deterministic dual-evidence outcome
      // check right now and terminate here either way. See outcome-check.ts.
      if (action.kind === 'click' && action.isSubmitLike && execNote.executed) {
        await page.wait(1); // let a redirect/AJAX confirmation settle before probing
        const submittedUrl = typeof options.data?.url === 'string' ? options.data.url : '';
        const probe = (await page.evaluate(outcomeProbeJs(submittedUrl))) as Omit<SubmitOutcomeEvidence, 'beforeUrl' | 'beforeTitle'>;
        const evidence: SubmitOutcomeEvidence = { ...probe, beforeUrl: header.url, beforeTitle: header.title };
        const classified = classifySubmitOutcome(evidence);

        // JEV noul assist — advisory only. classified.state above already
        // decided the outcome from deterministic evidence; this is recorded
        // alongside for a human to cross-check, never used to override it.
        let jevAssist: SubmitOutcomeResult['jevAssist'];
        try {
          const assist = await deps.callJev(
            { task: 'submit_outcome_assist', confirmation_text: evidence.confirmationText, form_still_present: evidence.formStillPresent, validation_error: evidence.validationError },
            { likely_success: { type: 'noul', instructions: 'Does this look like a website/form submission was accepted (e.g. a thank-you or pending-review message), as opposed to the same submission form or a validation error still showing?' } },
          );
          jevCalls++;
          jevTotalInputTokens += assist.usage?.input_tokens ?? 0;
          jevTotalMs += assist.ms;
          const a = assist.answers.likely_success;
          if (a && a.type === 'noul') jevAssist = { likelySuccess: a.noul };
        } catch {
          // Assist is best-effort — a JEV hiccup here must not block reporting the deterministic outcome-check result.
        }

        const outcomeCheck: SubmitOutcomeResult = { ...classified, evidence, jevAssist };
        steps.push({
          step, url: evidence.afterUrl ?? header.url, title: evidence.title ?? header.title, candidateCount: 0, suppressedCount: 0,
          choice: 'OUTCOME_CHECK', confidence: 1, topChoices: [], executed: true, jevMs: 0,
          note: `submit outcome: ${classified.state} (positive=[${classified.positive.join(',')}] negative=[${classified.negative.join(',')}])`,
        });

        if (classified.state === 'submitted') {
          return finish('completed', 'done', 'Submitted, and verified via dual-evidence outcome-check (state=submitted).', outcomeCheck);
        }
        return finish('stopped_for_human', 'submit_unverified', `Clicked the submit-like action, but outcome-check could not confirm success (state=${classified.state}). Needs human review.`, outcomeCheck);
      }
    }

    return finish('stopped_for_human', 'max_steps', `Stopped: reached --max-steps ${options.maxSteps} without JEV choosing DONE.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish('error', 'error', message);
  }
}

function syncAppliedRefsFromLiveState(
  freshGroups: FieldGroup[],
  fieldMappingResults: FieldMappingResult[],
  appliedRefs: Set<string>,
): void {
  const liveByRef = new Map<string, FieldGroup['members'][number]>();
  for (const g of freshGroups) for (const m of g.members) liveByRef.set(m.ref, m);

  for (const mapping of fieldMappingResults) {
    if (mapping.dataKey === 'NONE') continue;
    for (const ref of mapping.matchedRefs) {
      if (appliedRefs.has(ref)) continue;
      const live = liveByRef.get(ref);
      if (!live) continue;
      if (mapping.group.kind === 'radio' || mapping.group.kind === 'checkbox') {
        if (live.checked === true) appliedRefs.add(ref);
      } else {
        const wanted = (mapping.resolvedValue ?? '').trim();
        if (wanted && (live.currentValue ?? '').trim() === wanted) appliedRefs.add(ref);
      }
    }
  }
}

function buildStepState(
  options: AutoOptions,
  header: { url: string; title: string },
  fieldMappingResults: FieldMappingResult[],
  appliedRefs: Set<string>,
) {
  const filled = fieldMappingResults
    .filter((r) => r.dataKey !== 'NONE' && r.matchedRefs.some((ref) => appliedRefs.has(ref)))
    .map((r) => r.group.label);
  const remainingRequired = fieldMappingResults
    .filter((r) => r.group.required && !r.matchedRefs.every((ref) => appliedRefs.has(ref)))
    .map((r) => r.group.label);
  return {
    goal: options.goal,
    current_page: { url: header.url, title: header.title },
    progress: { filled, remaining_required: remainingRequired },
  };
}

async function executeAction(page: IPage, action: ActionCandidate, appliedRefs: Set<string>): Promise<{ executed: boolean; note?: string }> {
  if (!action.ref) return { executed: false, note: 'action had no ref to act on' };
  try {
    if (action.kind === 'click') {
      await page.click(action.ref);
      return { executed: true };
    }
    if (action.kind === 'fill') {
      const result = await page.fillText(action.ref, action.value ?? '');
      if (result.verified) appliedRefs.add(action.ref);
      return { executed: true, note: result.verified ? undefined : `fill not verified: expected "${result.expected}" got "${result.actual}"` };
    }
    if (action.kind === 'select') {
      const result = (await page.evaluate(selectByRefJs(action.ref, action.value ?? ''))) as { selected?: string; error?: string; available?: string[] };
      if (result?.selected) {
        appliedRefs.add(action.ref);
        return { executed: true };
      }
      return { executed: false, note: `select failed: ${result?.error ?? 'unknown'}` };
    }
    if (action.kind === 'check') {
      await page.setChecked?.(action.ref, true);
      appliedRefs.add(action.ref);
      return { executed: true };
    }
    return { executed: false, note: `unhandled action kind: ${action.kind}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { executed: false, note: `execution failed: ${message}` };
  }
}
