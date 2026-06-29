---
"@convex-localfirst/cli": patch
---

`convex-localfirst check` now also warns when the generated manifest is older than a
`lf.table` source — the stale-manifest guard that previously lived in the (now removed)
`@convex-localfirst/vite` plugin — so CI catches a manifest you forgot to regenerate.
Adds `repository` / `homepage` / `bugs` / `engines` metadata across the published packages.
