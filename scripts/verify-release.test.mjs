import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { verifyProvenance, verifyRelease } from './verify-release.mjs';

const expected = {
  name: '@jackwener/opencli', version: '2.0.2', repository: 'jackwener/OpenCLI',
  ref: 'refs/tags/v2.0.2', commit: '1234567890abcdef', sha512: 'abcd', integrity: 'sha512-q80=',
};
const predicateType = 'https://slsa.dev/provenance/v1';
function statement() {
  return {
    predicateType,
    subject: [{ name: 'pkg:npm/%40jackwener/opencli@2.0.2', digest: { sha512: expected.sha512 } }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/jackwener/opencli',
            path: '.github/workflows/release.yml', ref: expected.ref,
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/jackwener/OpenCLI@${expected.ref}`,
          digest: { gitCommit: expected.commit },
        }],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
    },
  };
}
function bundle(value = statement()) {
  return { attestations: [{ predicateType, bundle: {
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(value)).toString('base64') },
  } }] };
}
function metadata() {
  return {
    name: expected.name, version: expected.version,
    dist: { integrity: expected.integrity, attestations: { provenance: { predicateType } } },
  };
}
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
function harness(responses) {
  let time = 0;
  const urls = [];
  return {
    urls,
    fetchImpl: async url => {
      urls.push(url);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, 'Unexpected extra request');
      return next;
    },
    now: () => time, wait: async ms => { time += ms; },
    timeoutMs: 30, intervalMs: 10, log: () => {},
  };
}

test('accepts matching npm SLSA v1 provenance, including repository case normalization', () => {
  verifyProvenance(bundle(), expected);
});

for (const [name, mutate, error] of [
  ['package subject', s => { s.subject[0].name = 'pkg:npm/other@2.0.2'; }, /tarball/],
  ['tarball digest', s => { s.subject[0].digest.sha512 = 'bad'; }, /tarball/],
  ['predicate', s => { s.predicateType = 'other'; }, /predicate/],
  ['repository', s => { s.predicate.buildDefinition.externalParameters.workflow.repository += '-other'; }, /repository/],
  ['workflow', s => { s.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; }, /workflow/],
  ['tag', s => { s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main'; }, /tag/],
  ['commit', s => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'other'; }, /commit/],
  ['dependency URI', s => { s.predicate.buildDefinition.resolvedDependencies[0].uri = 'git+https://github.com/other/repo'; }, /commit/],
  ['builder', s => { s.predicate.runDetails.builder.id = 'local'; }, /builder/],
]) {
  test(`rejects mismatched ${name}`, () => {
    const value = statement();
    mutate(value);
    assert.throws(() => verifyProvenance(bundle(value), expected), error);
  });
}

test('rejects missing provenance rather than accepting a publish attestation', () => {
  assert.throws(() => verifyProvenance({ attestations: [] }, expected), /missing/);
});

test('waits for the version and provenance to propagate, then verifies', async () => {
  const unpublished = metadata();
  delete unpublished.dist.attestations;
  const options = harness([
    response(null, 404), response(unpublished), response(metadata()), response(bundle()),
  ]);
  await verifyRelease(expected, options);
  assert.equal(options.urls.length, 4);
  assert.ok(options.urls.every(url => new URL(url).origin === 'https://registry.npmjs.org'));
});

test('retries temporary network and registry failures', async () => {
  const options = harness([
    new TypeError('fetch failed'), response(null, 503), response(metadata()), response(bundle()),
  ]);
  await verifyRelease(expected, options);
});

test('retries an attestation endpoint that is not ready', async () => {
  const options = harness([
    response(metadata()), response(null, 429), response(metadata()), response(bundle()),
  ]);
  await verifyRelease(expected, options);
});

for (const [field, error] of [['name', /package mismatch/], ['version', /version mismatch/], ['integrity', /integrity mismatch/]]) {
  test(`fails immediately on immutable registry ${field} mismatch`, async () => {
    const value = metadata();
    if (field === 'integrity') value.dist.integrity = 'sha512-other';
    else value[field] = 'other';
    const options = harness([response(value)]);
    await assert.rejects(verifyRelease(expected, options), error);
    assert.equal(options.urls.length, 1);
  });
}

test('fails immediately on registry authorization errors', async () => {
  await assert.rejects(verifyRelease(expected, harness([response(null, 401)])), /HTTP 401/);
});

test('bounds the wait for a package without provenance', async () => {
  const value = metadata();
  delete value.dist.attestations;
  const options = harness([response(value), response(value), response(value)]);
  await assert.rejects(verifyRelease(expected, options), /Timed out.*provenance.*do not republish locally/);
  assert.equal(options.urls.length, 3);
});

test('CLI refuses to run without the tarball argument', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('release uses OIDC and verifies before announcing; provenance is required by default', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/release.yml', 'utf8'));
  assert.equal(workflow.permissions['id-token'], 'write');
  const steps = workflow.jobs.release.steps;
  const publish = steps.findIndex(s => s.name === 'Publish to npm with provenance');
  const identity = steps.findIndex(s => s.name === 'Verify the published package and provenance identity');
  const signatures = steps.findIndex(s => s.name === 'Verify signatures and installed CLI');
  const mise = steps.findIndex(s => s.name === 'Verify mise installation with default trust policy');
  const release = steps.findIndex(s => s.name === 'Create verified GitHub Release');
  assert.ok(publish >= 0 && publish < identity && identity < signatures && signatures < mise && mise < release);
  assert.doesNotMatch(JSON.stringify(workflow), /NPM_TOKEN|NODE_AUTH_TOKEN|trust_policy_excludes|npm\.shell_out/);
  assert.equal(JSON.parse(readFileSync('package.json')).publishConfig.provenance, true);
});
