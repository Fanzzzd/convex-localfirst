import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

// Shared layout config (nav title, links) for both the docs layout and any
// future home layout.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Convex Local-First",
    },
    links: [
      {
        text: "Getting started",
        url: "/docs/getting-started",
      },
      {
        text: "API",
        url: "/docs/reference/api",
      },
    ],
  };
}
