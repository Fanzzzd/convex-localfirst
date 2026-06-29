# Convex Local-First — documentation site

The user-facing docs for `@convex-localfirst/*`, built with **Fumadocs**
(Next.js App Router + MDX + Tailwind v4) — the same stack [Better Auth](https://better-auth.com)
uses for its docs.

Content lives in [`content/docs`](./content/docs) as MDX; the sidebar order is in
the `meta.json` files.

## Develop

```bash
cd website
npm install        # also runs `fumadocs-mdx` (postinstall) to generate .source
npm run dev        # http://localhost:3000  (redirects / → /docs)
```

## Build

```bash
npm run build      # static export of every docs page
npm run start      # serve the production build
```

## Structure

```text
content/docs/        the MDX pages (+ meta.json for ordering)
app/                 Next.js App Router (layout, /docs route, redirect)
lib/source.ts        fumadocs loader over the generated .source
source.config.ts     fumadocs-mdx collection config
mdx-components.tsx    MDX component map (adds <Callout>)
```

This site is an isolated npm project (its own `node_modules`); it is **not** part
of the pnpm workspace, so installing it never touches the framework packages.
