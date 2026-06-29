# Contributing

## Setup

```bash
pnpm install
pnpm ci          # build + typecheck + test the packages (what CI runs)
```

Per-package: `pnpm --filter @convex-localfirst/core test`, etc.

## Making a change

1. Edit code under `packages/*`.
2. Add a changeset describing the change (this is what drives the next release):

   ```bash
   pnpm changeset
   ```

   Pick the bump (patch/minor/major) and write a one-line summary. All
   `@convex-localfirst/*` packages are versioned in lockstep (`fixed` in
   `.changeset/config.json`), so one changeset bumps them together.
3. Commit the code **and** the generated `.changeset/*.md` file.

## Releasing (automated)

Releases run from CI via [`changesets/action`](https://github.com/changesets/action):

- Merging changesets to `main` opens a **"Version Packages"** PR that bumps versions
  and writes each package's `CHANGELOG.md`.
- Merging that PR publishes the new versions to npm (with provenance) and tags the release.

Requires a repo secret **`NPM_TOKEN`** — a granular npm token with read+write on the
`@convex-localfirst` scope and **Bypass 2FA** enabled.

To publish manually instead:

```bash
pnpm version-packages   # changeset version
pnpm release            # build + changeset publish
```
