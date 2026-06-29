# TODO

## ✅ Published to npm — v0.1.0 (all 7 packages, public, scope @convex-localfirst)

core · react · server · component · cli · vite · yjs — all live at `0.1.0`.

> **`@convex-localfirst/vite` has since been removed from the repo** (its only live feature,
> the stale-manifest warning, was absorbed into `convex-localfirst check`; alias mode +
> virtual manifest were unused — both examples already used explicit imports). The published
> `vite@0.1.0` still exists on npm; deprecate it when convenient: `npm deprecate
> "@convex-localfirst/vite@0.1.0" "removed — use explicit imports + the CLI"` (needs login).
> Do NOT republish a vite package; the next release is 6 packages.
Done as part of the release: MIT `LICENSE` (root + per package), `version` 0.1.0,
`files` allowlist, `publishConfig.access: public`, description + keywords, per-package
README, build verified, `workspace:*` → `0.1.0` rewrite confirmed in the published tarballs.

## ✅ Release engineering (done)

- [x] Root `.gitignore`; `git init` (branch `main`) + initial commit.
- [x] Deleted cruft: `.codex-review/`, `website/.next/`, `AGENT_LOOP_GOAL_PROMPT.md`, `HANDOFF_SUMMARY.md`.
- [x] Changesets: `.changeset/config.json` (public access, lockstep `@convex-localfirst/*`, examples ignored) + root scripts `changeset` / `version-packages` / `release`.
- [x] GitHub Actions: `ci.yml` (build+typecheck+test on PR/push) and `release.yml` (changesets/action → version PR + publish with npm provenance).
- [x] `CONTRIBUTING.md` documenting the changeset + release flow.

## ✅ GitHub repo + metadata (done)

- [x] `repository` / `homepage` / `bugs` / `author` / `engines` (`node >=18`) added to all 6 packages.
- [x] GitHub repo `Fanzzzd/convex-localfirst` created (public) + `main` pushed.

## 👉 Only-you steps left

1. Add repo secret **`NPM_TOKEN`** so the release workflow can auto-publish — a granular npm
   token (read+write on `@convex-localfirst`, **Bypass 2FA**), set at
   `github.com/Fanzzzd/convex-localfirst/settings/secrets/actions/new`. **Create + paste it in
   the GitHub web UI, NOT in chat** (a chat-pasted token is compromised). Without it, CI tests
   still run; only auto-publish is blocked (you can always `pnpm release` locally).
2. (Optional) switch changelog to `@changesets/changelog-github` for PR links (needs GITHUB_TOKEN at version time).
3. (Optional) `npm deprecate "@convex-localfirst/vite@0.1.0" "removed — use explicit imports + the CLI"`.

## Remaining package hygiene (nice-to-have)

- [ ] Add `sourceMap` + `declarationMap` to the tsconfigs (and ship `src`) for consumer go-to-definition.

## Deferred refactors (quality, not slop — bigger diffs, want review)

- [ ] `engine.ts` is a 1154-line god object; consider extracting the reactive-watch
      and connectivity concerns. Low urgency — it's well-tested.
- [ ] `engine.ts` `pushSingleOperation` / `pushPendingOperations` share ~50 lines of
      retry/apply/ack logic. Mergeable, but they guard different cases — watch the test net.
- [ ] `serverSync.ts` `applyOp` is ~200 lines; split into `applyDelete/applyInsert/applyPatch`.
- [ ] `cli/codegen.ts` parses DSL closures via `fn.toString()` + string slicing (fragile
      on `}`/`return` inside strings). `check.ts` already uses the real TS AST — make codegen consistent.
- [ ] `examples/plane` has a pre-existing typecheck error (`src/model.ts`: `"issue_labels"` not a TableName).

## CLI direction (decided)

- Convex's own codegen (`convex dev` → `convex/_generated`) is NOT extensible — no plugin/hook
  to inject custom generation. So our manifest `codegen` MUST be its own step → keep the CLI.
- [ ] Move `check` (static "no direct LF-table writes") out of the CLI into an **ESLint rule** —
  runs in-editor + CI, better DX than a bespoke command. The CLI keeps `codegen`/`init`/`dev`.
