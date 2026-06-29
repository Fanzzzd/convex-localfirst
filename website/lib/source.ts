import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";

// `collections/*` is aliased to `./.source/*` (tsconfig paths, which Next's
// bundler also honors). fumadocs-mdx generates `.source/server.ts`.
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource()
});
