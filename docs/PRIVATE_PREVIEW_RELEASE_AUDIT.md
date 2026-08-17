# Codexzxm Private Preview Release Audit

Release candidate: `0.8.1-preview.0`
Audit date: 2026-08-17
Scope: source tree, Git history, packaging boundary, local Stable contract, Doctor, tunnel readiness, and friend-onboarding safety.

## Result

Status: PASS for private preview distribution.

The repository should remain private until the maintainer explicitly decides to open-source it. A friend/tester must be added as a GitHub collaborator and must create independent machine credentials, tunnel identity, Codex authorization, and ChatGPT connection.

## Security checks

- [x] Tracked source scan found no common OpenAI/GitHub token formats, AWS access-key format, private-key block, or credential-bearing URL.
- [x] Full Git patch history scan found no common token/private-key/credential URL format.
- [x] Full Git history scan found no maintainer Windows username path or maintainer GitHub email.
- [x] Machine-specific `.workbench/` runtime logs and tunnel status files are Git-ignored and were not found in committed history.
- [x] `.gitignore` additionally blocks `.npmrc`, DPAPI blobs, common private-key/container formats, token files, `secrets/`, and local tunnel JSON state.
- [x] Runtime/Admin API keys are not stored in repository source.
- [x] Friend onboarding explicitly forbids copying DPAPI/Keychain data, tunnel profiles, root registry, browser sessions, `.workbench`, or another user's runtime/admin keys.

## Repository / Git checks

- [x] GitHub repository remains private.
- [x] Local repository now has `origin = 1519511/Codexzxm` and preserves `upstream = liyana31811/Codexless`.
- [x] The old local parallel history was preserved in `backup/local-pre-origin-sync-20260817` before aligning local `main` to `origin/main`.
- [x] Local `main` tracks `origin/main`; future normal incremental pushes no longer require history replacement.
- [x] `package.json` remains `"private": true`; this private preview is not an npm public release.

## Packaging boundary

`npm pack --dry-run --json` passed for `0.8.1-preview.0`.

- [x] `.workbench/` is not packaged.
- [x] `.env` and machine secret files are not packaged.
- [x] Runtime tunnel configuration and DPAPI/Keychain material are not packaged.
- [x] Package content remains restricted by the explicit `files` allowlist in `package.json`.

The friend guide is distributed through the private GitHub source/release. It is intentionally not required for the npm package while `private=true`.

## Runtime validation

- [x] `npm test` exited 0.
- [x] Stable contract remains 121 registered tools = 118 model-visible + 3 app-only.
- [x] Experimental Pro Bridge surface remains 124 registered tools when explicitly enabled.
- [x] Public compatibility surface remains 21 tools.
- [x] `npm run doctor` reported `Codexzxm Stable doctor: OK` for `0.8.1-preview.0`.
- [x] Local tunnel runtime was independently checked and was running, healthy, and ready at audit time.
- [x] No Codex model turn was started by Doctor.

Validation note: the live Notepad Computer Use smoke test was intentionally skipped by the test harness because a user Notepad window was already open. The contract suite still exited 0; the existing user window was not closed or modified for release validation.

Doctor note: Browser Reader was reported conditional/unavailable in the Doctor environment. This is not a Stable Core failure; Browser Reader remains an optional backend.

## Friend-install acceptance criteria

Before considering another machine ready:

- [ ] Friend has explicit collaborator access to the private repository.
- [ ] Friend clones the repository using their own GitHub account.
- [ ] Friend runs the platform installer and Doctor successfully.
- [ ] Friend creates or is assigned a distinct Secure MCP Tunnel.
- [ ] Friend uses a distinct Runtime API Key; any Admin key is used only for tunnel administration and is not persisted in the daemon.
- [ ] Friend connects the tunnel to their own ChatGPT account/workspace.
- [ ] Friend starts with a narrow test directory rather than immediately authorizing an entire system drive.
- [ ] Read-only MCP invocation succeeds before testing mutations.
- [ ] Restart/autostart recovery succeeds on the friend's machine.
- [ ] Friend understands that ChatGPT plan/workspace policy may expose fewer actions than the 121-tool Stable server registers.

## Current release boundary

This audit approves private preview sharing with specifically invited testers. It does not yet approve making the GitHub repository public. A future public release should repeat the full history scan, dependency/license review, public documentation review, and platform installation test on a clean Windows VM and a clean Apple Silicon Mac.
