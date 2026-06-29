import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { ConvexProvider, ConvexReactClient } from "@convex-localfirst/react";
import { IndexedDbStore, createClientId, createConvexTransport } from "@convex-localfirst/core";
import { api } from "../convex/_generated/api";
import { App } from "./App";
import { localFirstManifest } from "./convex-localfirst/generated";

const userId = "demo-user";
const clientId = createClientId();
// Fallback URL lets the client construct offline; if there is no backend the
// app still works fully offline (IndexedDB). Run `npx convex dev` for live sync.
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210");

// IndexedDB persistence so todos survive a page refresh (offline-first).
const store = new IndexedDbStore({ databaseName: "todo-perfect-dx", namespace: userId });

// Online sync against the deployed sync.push / sync.pull functions.
const transport = createConvexTransport({ client: convex, push: api.sync.push, pull: api.sync.pull, clientId, userId });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConvexProvider
      client={convex}
      localFirst={{
        manifest: localFirstManifest,
        store,
        transport,
        clientId,
        userId
        // nameOf defaults to Convex's getFunctionName (api.todos.list -> "todos:list").
      }}
    >
      <App />
    </ConvexProvider>
  </React.StrictMode>
);
