import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// Static export for GitHub Pages (served under /convex-localfirst).
// BASE_PATH is set by the docs workflow; local `pnpm dev`/`pnpm build` stay rootless.
/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: "export",
  basePath: process.env.BASE_PATH ?? "",
  images: { unoptimized: true },
};

export default withMDX(config);
