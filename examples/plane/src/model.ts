// Domain model glue: row types straight from the Convex schema (single source of
// truth), the relation graph for issues, and the Plane-flavored constants (state
// groups, priorities, default project setup).
import type { Doc } from "../convex/_generated/dataModel";
import { rel } from "./convex-localfirst/relations";

export type Project = Doc<"projects">;
export type State = Doc<"states">;
export type Label = Doc<"labels">;
export type Comment = Doc<"issue_comments">;

// Declared once, reused via collection("issues").withRelations(issueRelations).
export const issueRelations = {
  project: rel.one("projects", "projectId"), // issue.projectId -> projects
  state: rel.one("states", "stateId"), // issue.stateId -> states
  labels: rel.manyToMany("labels", "issue_labels", "issueId", "labelId") // via join (N:N)
};

export type Issue = Doc<"issues"> & {
  project?: Project;
  state?: State;
  labels?: Label[];
  _conflict?: unknown;
};

// --- workflow state groups (Plane's column kinds) ---------------------------
export const STATE_GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export type StateGroup = (typeof STATE_GROUP_ORDER)[number];

export const STATE_GROUP_META: Record<StateGroup, { label: string; color: string }> = {
  backlog: { label: "Backlog", color: "#a3a3a3" },
  unstarted: { label: "Todo", color: "#3b82f6" },
  started: { label: "In Progress", color: "#f59e0b" },
  completed: { label: "Done", color: "#22c55e" },
  cancelled: { label: "Cancelled", color: "#ef4444" }
};

// Seeded for every new project (Plane's default workflow).
export const DEFAULT_STATES: { name: string; group: StateGroup; color: string }[] = [
  { name: "Backlog", group: "backlog", color: "#a3a3a3" },
  { name: "Todo", group: "unstarted", color: "#3b82f6" },
  { name: "In Progress", group: "started", color: "#f59e0b" },
  { name: "Done", group: "completed", color: "#22c55e" },
  { name: "Cancelled", group: "cancelled", color: "#ef4444" }
];

// --- priorities -------------------------------------------------------------
export const PRIORITY_ORDER = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "#ef4444" },
  high: { label: "High", color: "#f97316" },
  medium: { label: "Medium", color: "#eab308" },
  low: { label: "Low", color: "#3b82f6" },
  none: { label: "None", color: "#a3a3a3" }
};

// --- palettes ---------------------------------------------------------------
export const PROJECT_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#ec4899"];
export const LABEL_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

/** PROJ-123 display id. */
export const issueKey = (project: Project | undefined, seq: number) =>
  `${project?.identifier ?? "ISSUE"}-${seq}`;
