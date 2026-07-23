// Blueprint: permission-aware issue UI + undo/redo (DX v4 §6–§7) for Plane.
//
// Mirrors the server's authorization in the browser so buttons enable/disable BEFORE a
// push is attempted, and gives Linear-class undo. Like IssueDocEditor.tsx this lives
// OUTSIDE convex/ so the example's `tsc` (which only compiles convex/) does not require the
// React peer dep — but the pieces it uses (issues.clientCan, useRole/useCan/useUndo) are
// compiled + tested in the package.
//
// The write rule itself is declared ONCE, next to the table, in convex/issues.ts
// (`clientCan.write`) — the SAME isomorphic module the server reads. Nothing is restated
// here; the client just reads the synced role and evaluates that mirror.

import { useCan, useRole, useUndo, type TableRowOf } from "convex-localfirst/react";
import type * as issuesModule from "../convex/issues";

// The db-root modules type — pass it to useCan for typed table names + row shapes.
type Modules = { issues: typeof issuesModule };

// The issue row type, derived straight from the schema (shape + id + timestamps) — no
// hand-rolled duplicate. This is exactly what useLiveQuery(db.issues…) returns.
type Issue = TableRowOf<Modules, "issues">;

export function IssueToolbar({ workspaceId, issue }: { workspaceId: string; issue: Issue }) {
  // The caller's ws_members role in this workspace: number | null (denied) | undefined
  // (not yet synced). Rides the pull response — no extra round-trip.
  const role = useRole<number>({ workspace_id: workspaceId });

  // The client mirror of access.write, typed to the schema. Every method returns `true`
  // when the role hasn't synced yet (advisory — the server stays authoritative).
  const can = useCan<Modules>();

  // Undo/redo scoped to this workspace. Emits ordinary local-first mutations (they sync
  // like any op); a batch group undoes as one unit.
  const { undo, redo, canUndo, canRedo } = useUndo({ workspace_id: workspaceId });

  if (role === undefined) return <span>Loading…</span>;
  if (role === null) return <span>No access to this workspace.</span>;

  return (
    <div className="issue-toolbar">
      <button disabled={!can.patch("issues", issue, { name: "renamed" })}>Rename</button>
      <button disabled={!can.remove("issues", issue)}>Delete</button>
      <button disabled={!canUndo} onClick={() => void undo()}>
        Undo
      </button>
      <button disabled={!canRedo} onClick={() => void redo()}>
        Redo
      </button>
    </div>
  );
}
