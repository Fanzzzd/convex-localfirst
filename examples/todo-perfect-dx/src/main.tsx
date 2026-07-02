import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { ConvexProvider, ConvexReactClient } from "@convex-localfirst/react";
import { App } from "./App";
// The client imports the SAME lf.table modules the server deploys — the local
// manifest is built from them at runtime (no codegen, nothing to regenerate).
import * as comments from "../convex/comments";
import * as docUpdates from "../convex/docUpdates";
import * as documents from "../convex/documents";
import * as issues from "../convex/issues";
import * as labels from "../convex/labels";
import * as projects from "../convex/projects";
import * as todos from "../convex/todos";

const userId = "demo-user";
// Fallback URL lets the client construct offline; if there is no backend the
// app still works fully offline (IndexedDB). Run `npx convex dev` for live sync.
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210");

// Everything else is defaulted: IndexedDB persistence (namespaced by userId),
// the Convex transport against api.sync.push / api.sync.pull, and a client id.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConvexProvider
      client={convex}
      localFirst={{
        modules: { todos, issues, projects, comments, labels, documents, docUpdates },
        userId,
        databaseName: "todo-perfect-dx"
      }}
    >
      <App />
    </ConvexProvider>
  </React.StrictMode>
);
