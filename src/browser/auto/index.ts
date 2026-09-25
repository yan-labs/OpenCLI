export { runAuto, type RunAutoDeps } from './run.js';
export { callJev, JEV_ENDPOINT, JEV_MODEL, JevConfigError, JevRequestError } from './jev-client.js';
export { parseSnapshotRefs, parseSnapshotHeader } from './snapshot-parse.js';
export { looksIrreversible } from './safety.js';
export { groupFormFields, type RawFormState, type RawFormField } from './field-groups.js';
export { buildMappingQuestions, mapFieldsToData } from './field-mapping.js';
export { buildCandidates, candidatesToJevCriteria } from './candidates.js';
export type {
  ActionCandidate,
  AutoOptions,
  AutoResult,
  FieldGroup,
  FieldMappingResult,
  StepLog,
  StopReason,
} from './types.js';
