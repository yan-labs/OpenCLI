# Releases

Push a `v<package.json version>` tag from a reviewed commit on `main`.
`.github/workflows/release.yml` publishes the CLI and attaches the extension ZIP.
Chrome Web Store review remains a separate submission.

## npm authentication

The npm package `@jackwener/opencli` must have a GitHub Actions Trusted Publisher:

- Owner: `jackwener`
- Repository: `OpenCLI`
- Workflow filename: `release.yml`
- Environment: empty (the release job does not use a GitHub environment)
- Allow direct `npm publish`

The workflow uses OIDC and does not consume `NPM_TOKEN`. After the first
successful OIDC release, remove the obsolete GitHub secret and revoke the
corresponding npm publish token.

## Completion and recovery

The workflow packs once, publishes that tarball with provenance, waits up to
15 minutes for registry metadata, and checks its integrity and provenance
repository, workflow, tag, and commit. It then verifies signatures with
`npm audit signatures` and installs through mise with its default trust policy.
Only after those checks does it create the GitHub Release and update the website.
The npm package is public while these post-publish checks run.

For an authentication failure, correct the Trusted Publisher configuration and
rerun the failed workflow. For a registry delay, rerun after propagation. Reruns
verify any existing version against the rebuilt tarball and source identity;
they never silently accept an existing version. The original tarball is also
retained as an Actions artifact for inspection.

Do not fall back to a local publish or disable provenance/trust checks.
`publishConfig.provenance` makes provenance the default for manual invocations
too. An already published version cannot be overwritten: if it has the wrong
bytes or missing provenance, fix the cause and release a new version.
