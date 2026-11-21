import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const registry = 'https://registry.npmjs.org';
const predicateType = 'https://slsa.dev/provenance/v1';

// npm audit signatures verifies the signatures in the release workflow.
// This check additionally binds the published bytes and provenance to this run.
export function verifyProvenance(attestations, expected) {
  const attestation = attestations.attestations?.find(a => a.predicateType === predicateType);
  assert.ok(attestation?.bundle?.dsseEnvelope?.payload, 'SLSA provenance bundle is missing');
  const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString());
  assert.equal(statement.predicateType, predicateType, 'Unexpected provenance predicate');
  const subjectName = `pkg:npm/${expected.name.replace('@', '%40')}@${expected.version}`;
  assert.ok(statement.subject?.some(subject =>
    subject.name === subjectName && subject.digest?.sha512 === expected.sha512),
  'Provenance does not describe the uploaded tarball');

  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const repository = `https://github.com/${expected.repository}`.toLowerCase();
  assert.equal(workflow?.repository?.toLowerCase(), repository, 'Provenance repository mismatch');
  assert.equal(workflow?.path, '.github/workflows/release.yml', 'Provenance workflow mismatch');
  assert.equal(workflow?.ref, expected.ref, 'Provenance tag mismatch');
  assert.ok(definition?.resolvedDependencies?.some(dependency =>
    dependency.uri?.toLowerCase() === `git+${repository}@${expected.ref}`.toLowerCase()
    && dependency.digest?.gitCommit === expected.commit),
  'Provenance commit mismatch');
  assert.equal(statement.predicate?.runDetails?.builder?.id,
    'https://github.com/actions/runner/github-hosted', 'Unexpected provenance builder');
}

export async function verifyRelease(expected, {
  fetchImpl = fetch, wait = sleep, now = Date.now, timeoutMs = 15 * 60_000, intervalMs = 10_000,
  log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  const packagePath = `${encodeURIComponent(expected.name)}/${expected.version}`;
  const attestationPath = `${encodeURIComponent(expected.name)}@${expected.version}`;
  let reason = 'package is not visible yet';
  const get = url => fetchImpl(url, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
  });

  while (now() < deadline) {
    try {
      const response = await get(`${registry}/${packagePath}`);
      if (response.ok) {
        const metadata = await response.json();
        assert.equal(metadata.name, expected.name, 'Registry package mismatch');
        assert.equal(metadata.version, expected.version, 'Registry version mismatch');
        assert.equal(metadata.dist?.integrity, expected.integrity, 'Registry tarball integrity mismatch');
        if (metadata.dist?.attestations?.provenance?.predicateType === predicateType) {
          const response = await get(`${registry}/-/npm/v1/attestations/${attestationPath}`);
          if (response.ok) {
            verifyProvenance(await response.json(), expected);
            log(`Verified ${expected.name}@${expected.version}: tarball, repository, workflow, tag and commit.`);
            return;
          }
          assert.ok(response.status === 404 || response.status === 429 || response.status >= 500,
            `Attestations request failed: HTTP ${response.status}`);
          reason = `attestations HTTP ${response.status}`;
        } else {
          reason = 'provenance is not visible yet';
        }
      } else {
        assert.ok(response.status === 404 || response.status === 429 || response.status >= 500,
          `Registry request failed: HTTP ${response.status}`);
        reason = `registry HTTP ${response.status}`;
      }
    } catch (error) {
      // Retry only transport failures. Immutable metadata mismatches must fail immediately.
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
      reason = error.message;
    }
    log(`Waiting for npm: ${reason}`);
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Timed out verifying ${expected.name}@${expected.version}: ${reason}. Retry in CI; do not republish locally.`);
}

async function main() {
  const tarball = process.argv[2];
  assert.ok(tarball, 'Usage: node scripts/verify-release.mjs <published.tgz>');
  const { name, version } = JSON.parse(await readFile('package.json', 'utf8'));
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: commit, GITHUB_REF: ref } = process.env;
  assert.ok(repository && commit && ref, 'Release verification requires GitHub repository, commit and ref');
  assert.equal(ref, `refs/tags/v${version}`, 'Release tag must match package.json version');
  const bytes = await readFile(tarball);
  const digest = createHash('sha512').update(bytes).digest();
  await verifyRelease({
    name, version, repository, commit, ref,
    integrity: `sha512-${digest.toString('base64')}`, sha512: digest.toString('hex'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
