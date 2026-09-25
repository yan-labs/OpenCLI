/**
 * Direct client for the JEV (TypeSafe System One) decision protocol.
 *
 * `POST https://api.typesafe.ai/v1/systemone` with `{ model, state, questions }`,
 * answered with calibrated probabilities per typed question (choice/noul/score).
 * This is NOT an OpenAI/Anthropic-compatible chat endpoint — no messages array,
 * no tool calls, no streaming. See yan-skills/opencli/references/model-driven.md
 * and yan-skills/agent-fleet/src/judge-task.mjs for prior art this mirrors.
 *
 * The API key is read from `TYPESAFE_API_KEY` only, at call time, and is never
 * logged, echoed, or included in any thrown error message.
 */

import { CliError, EXIT_CODES } from '../../errors.js';
import type { CallJevFn, JevCallResult, JevQuestion, JevResponse } from './types.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export class JevConfigError extends CliError {
  constructor(message: string, hint?: string) {
    super('JEV_CONFIG', message, hint, EXIT_CODES.CONFIG_ERROR);
  }
}

export class JevRequestError extends CliError {
  constructor(message: string, hint?: string) {
    super('JEV_REQUEST', message, hint, EXIT_CODES.SERVICE_UNAVAIL);
  }
}

/** Real network implementation of CallJevFn. Tests should inject a mock instead. */
export const callJev: CallJevFn = async (state, questions) => {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    throw new JevConfigError(
      'TYPESAFE_API_KEY is not set.',
      'Export TYPESAFE_API_KEY in the environment before running `opencli browser <session> auto`.',
    );
  }
  if (!questions || Object.keys(questions).length === 0) {
    throw new JevConfigError('No questions to ask JEV — the candidate set was empty.');
  }

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JevRequestError(`Failed to reach ${JEV_ENDPOINT}: ${msg}`);
  }

  const text = await res.text();
  let body: JevResponse | null = null;
  try {
    body = text ? (JSON.parse(text) as JevResponse) : null;
  } catch {
    // Non-JSON body — surface truncated raw text below.
  }

  if (!res.ok) {
    throw new JevRequestError(`JEV HTTP ${res.status}: ${(body ? JSON.stringify(body) : text).slice(0, 300)}`);
  }
  if (!body || typeof body !== 'object' || !body.answers) {
    throw new JevRequestError(`JEV returned an unexpected payload: ${text.slice(0, 300)}`);
  }

  const result: JevCallResult = { ...body, ms: Date.now() - t0 };
  return result;
};

/** Narrow a JEV choice answer's `choice` value against the criteria it was asked with — defends against a hallucinated key. */
export function coerceChoice(criteria: Record<string, string>, rawChoice: string): string | null {
  return Object.prototype.hasOwnProperty.call(criteria, rawChoice) ? rawChoice : null;
}

export type { CallJevFn, JevQuestion };
