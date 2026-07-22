import { useEffect, useRef, useState } from "react";
import { collection, useLiveQuery, useMutation, usePresence, useQuery, useSyncStatus } from "convex-localfirst/react";
import { ChevronLeft, ChevronRight, Loader2, MessageSquare, Plus, Tag, Users, Wifi, WifiOff, X } from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { issueRelations, type Issue, type IssueStatus } from "./types";
import { DocsView } from "./DocsView";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { db } from "./db";

// Workspace is selectable via ?ws= so the demo is multi-workspace and the e2e
// can isolate each run into a fresh scope (otherwise a shared workspace
// accumulates every run's issues and a cold device takes ever longer to pull).
const WORKSPACE = new URLSearchParams(window.location.search).get("ws") || "acme";
const USER = "demo-user"; // must match the userId wired in main.tsx

const COLUMNS: { status: IssueStatus; label: string; dot: string }[] = [
  { status: "backlog", label: "Backlog", dot: "bg-slate-400" },
  { status: "in_progress", label: "In Progress", dot: "bg-amber-500" },
  { status: "done", label: "Done", dot: "bg-emerald-500" }
];
const ORDER: IssueStatus[] = ["backlog", "in_progress", "done"];

const PRIORITY: Record<number, { label: string; className: string }> = {
  0: { label: "Urgent", className: "bg-red-500/15 text-red-600 dark:text-red-400" },
  1: { label: "High", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  2: { label: "Medium", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  3: { label: "Low", className: "bg-muted text-muted-foreground" }
};

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export function App() {
  const sync = useSyncStatus();
  // Live "who's here": heartbeats into the mounted component, TTL-expired reads.
  // 2s beats keep the demo (and the e2e) snappy; production defaults to 10s.
  const { peers } = usePresence({ workspace: WORKSPACE }, { name: USER }, { heartbeatMs: 2000 });

  // Plain Convex (not local-first) → exercises the drop-in fallback path (I11).
  const join = useMutation(api.workspaces.join);
  const memberCount = useQuery(api.workspaces.memberCount, { workspaceId: WORKSPACE });

  // Relation targets — workspace-scoped local-first tables, read locally.
  const projectsRaw = useLiveQuery(db.projects.scope({ workspaceId: WORKSPACE }).orderBy("name"));
  const labels = useLiveQuery(collection<Doc<"labels">>("labels").scope({ workspaceId: WORKSPACE }).order("name")) ?? [];
  const projects = projectsRaw ?? [];

  // The headline: ONE local query that joins issues -> project (one),
  // comments (one-to-many) and labels (many-to-many via issue_labels). Relations
  // are declared once in types.ts and reused here via .withRelations — the query
  // is a single line. All resolved in memory off the synced scope, fully typed.
  const issues =
    useLiveQuery(
      collection<Issue>("issues").scope({ workspaceId: WORKSPACE }).withRelations(issueRelations).order("createdAt", "asc")
    ) ?? [];

  const createIssue = useMutation(api.issues.create);
  const setStatus = useMutation(api.issues.setStatus);
  const setPriority = useMutation(api.issues.setPriority);
  const removeIssue = useMutation(api.issues.remove);
  const createProject = useMutation(api.projects.create);
  const createLabel = useMutation(api.labels.create);
  const linkLabel = useMutation(api.labels.link);
  const addComment = useMutation(api.comments.add);

  const [title, setTitle] = useState("");
  const [priority, setPriorityInput] = useState(1);
  const [projectId, setProjectId] = useState<string>("");
  const [view, setView] = useState<"board" | "docs">("board");

  // Ensure this user is a member of the workspace so issues can sync (idempotent).
  useEffect(() => {
    void join({ userId: USER, workspaceId: WORKSPACE });
  }, [join]);

  // Seed a couple of projects + labels ONCE, only if the workspace is *still*
  // empty AFTER the first pull settled (sync.lastPullAt). Gating on the pull —
  // not just on projectsRaw having loaded — is what stops a fresh device from
  // re-seeding duplicates: an empty local store reads as [] instantly, before
  // the workspace's existing projects have synced in. A real app seeds in
  // onboarding; this keeps the demo self-bootstrapping without that race.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || projectsRaw === undefined || sync.lastPullAt === null) return;
    if (projectsRaw.length > 0) {
      seeded.current = true; // workspace already populated — never seed
      return;
    }
    seeded.current = true;
    void createProject({ workspaceId: WORKSPACE, name: "Platform", color: "#6366f1" });
    void createProject({ workspaceId: WORKSPACE, name: "Mobile", color: "#10b981" });
    void createLabel({ workspaceId: WORKSPACE, name: "bug", color: "#ef4444" });
    void createLabel({ workspaceId: WORKSPACE, name: "feature", color: "#3b82f6" });
  }, [projectsRaw, sync.lastPullAt, createProject, createLabel]);

  const activeProject = projectId || projects[0]?._id || "";

  const move = (issue: Issue, delta: number) => {
    const next = ORDER[Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(issue.status) + delta))];
    if (next !== issue.status) {
      void setStatus({ id: issue._id, status: next }).local;
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
              L
            </div>
            <div>
              <h1 className="text-xl font-semibold leading-tight">Linear-lite</h1>
              <p className="text-sm text-muted-foreground">
                Workspace <span className="font-medium text-foreground">{WORKSPACE}</span>
              </p>
            </div>
          </div>

          <div
            data-testid="sync-status"
            className="flex items-center gap-3 rounded-full border bg-card px-4 py-2 text-sm shadow-sm"
          >
            <span className={cn("flex items-center gap-1.5 font-medium", sync.online ? "text-emerald-600" : "text-red-600")}>
              {sync.online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
              {sync.online ? "online" : "offline"}
            </span>
            <span className="text-border">|</span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {sync.syncing ? <Loader2 className="size-3.5 animate-spin" /> : null}
              <span data-testid="pending">{sync.pendingMutations}</span> pending
            </span>
            <span className="text-border">|</span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Users className="size-4" />
              <span data-testid="member-count">{memberCount ?? "—"}</span>
            </span>
            <span className="text-border">|</span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              <span data-testid="presence-count">{peers.length}</span> here
            </span>
            {sync.blockedBySchemaMismatch ? <Badge variant="destructive">schema mismatch</Badge> : null}
          </div>
        </header>

        <nav className="mb-6 flex gap-1 border-b">
          {(["board", "docs"] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`tab-${v}`}
              onClick={() => setView(v)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize",
                view === v ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {v === "board" ? "Board" : "Docs"}
            </button>
          ))}
        </nav>

        {view === "docs" ? (
          <DocsView workspaceId={WORKSPACE} user={USER} />
        ) : (
          <>
            <form
              className="mb-8 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = title.trim();
            if (!text) return;
            void createIssue({ workspaceId: WORKSPACE, projectId: activeProject, title: text, priority, assignee: USER }).local;
            setTitle("");
          }}
        >
          <Input
            data-testid="new-issue-title"
            value={title}
            placeholder="Create a new issue…"
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="min-w-[200px] flex-1"
          />
          <Select value={activeProject} onValueChange={setProjectId}>
            <SelectTrigger data-testid="new-issue-project" className="w-[150px]">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p._id} value={p._id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(priority)} onValueChange={(v) => setPriorityInput(Number(v))}>
            <SelectTrigger data-testid="new-issue-priority" className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0, 1, 2, 3].map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {PRIORITY[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button data-testid="create-issue" type="submit">
            <Plus className="size-4" /> Add issue
          </Button>
        </form>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const colIssues = issues
              .filter((issue) => issue.status === col.status)
              .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
            return (
              <section key={col.status} data-testid={`column-${col.status}`} className="flex flex-col">
                <div className="mb-3 flex items-center gap-2 px-1">
                  <span className={cn("size-2.5 rounded-full", col.dot)} />
                  <h2 className="text-sm font-semibold">{col.label}</h2>
                  <span data-testid={`count-${col.status}`} className="text-sm text-muted-foreground">
                    {colIssues.length}
                  </span>
                </div>

                <div className="flex flex-1 flex-col gap-2.5 rounded-xl bg-muted/40 p-2.5">
                  {colIssues.length === 0 ? (
                    <p className="px-2 py-8 text-center text-sm text-muted-foreground">No issues</p>
                  ) : null}
                  {colIssues.map((issue) => {
                    const conflicted = Boolean(issue._conflict);
                    const pr = PRIORITY[issue.priority] ?? PRIORITY[3];
                    // Cross-table data, joined locally:
                    const project = issue.project; // one
                    const comments = issue.comments; // many
                    const issueLabels = issue.labels; // many-to-many
                    return (
                      <Card
                        key={issue._id}
                        data-testid="issue-card"
                        data-status={issue.status}
                        data-title={issue.title}
                        className={cn(
                          "group gap-0 p-3 transition-shadow hover:shadow-md",
                          conflicted && "border-destructive/50 opacity-70"
                        )}
                      >
                        {project ? (
                          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <span className="size-2 rounded-full" style={{ background: project.color }} />
                            {project.name}
                          </div>
                        ) : null}
                        <div className="mb-2 text-sm font-medium leading-snug">{issue.title}</div>

                        {issueLabels.length > 0 ? (
                          <div data-testid="issue-labels" className="mb-2 flex flex-wrap gap-1">
                            {issueLabels.map((label) => (
                              <span
                                key={label._id}
                                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                                style={{ background: `${label.color}22`, color: label.color }}
                              >
                                {label.name}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <div className="mb-3 flex items-center gap-2">
                          <button
                            type="button"
                            title="Cycle priority"
                            onClick={() => void setPriority({ id: issue._id, priority: (issue.priority + 1) % 4 }).local}
                          >
                            <Badge className={cn("cursor-pointer", pr.className)}>{pr.label}</Badge>
                          </button>
                          {conflicted ? <Badge variant="destructive">conflict</Badge> : null}
                          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="flex items-center gap-0.5" title="comments">
                              <MessageSquare className="size-3.5" />
                              <span data-testid="comment-count">{comments.length}</span>
                            </span>
                            <span className="flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground">
                              {initials(issue.assignee)}
                            </span>
                          </span>
                        </div>

                        <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            data-testid="move-left"
                            aria-label="Move issue to previous column"
                            disabled={issue.status === "backlog"}
                            onClick={() => move(issue, -1)}
                          >
                            <ChevronLeft />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            data-testid="move-right"
                            aria-label="Move issue to next column"
                            disabled={issue.status === "done"}
                            onClick={() => move(issue, 1)}
                          >
                            <ChevronRight />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            data-testid="add-comment"
                            title="Add comment"
                            aria-label="Add comment"
                            onClick={() =>
                              void addComment({ workspaceId: WORKSPACE, issueId: issue._id, author: USER, body: "Looks good" }).local
                            }
                          >
                            <MessageSquare />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            data-testid="add-label"
                            title="Add label"
                            aria-label="Add label"
                            disabled={labels.length === 0}
                            onClick={() => {
                              const next = labels.find((l) => !issueLabels.some((il) => il._id === l._id));
                              if (next) void linkLabel({ workspaceId: WORKSPACE, issueId: issue._id, labelId: next._id }).local;
                            }}
                          >
                            <Tag />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="ml-auto size-7 text-muted-foreground hover:text-destructive"
                            data-testid="delete-issue"
                            aria-label="Delete issue"
                            onClick={() => void removeIssue({ id: issue._id }).local}
                          >
                            <X />
                          </Button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
          </>
        )}
      </div>
    </div>
  );
}
