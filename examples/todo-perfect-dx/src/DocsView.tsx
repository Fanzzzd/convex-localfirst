import { useEffect, useMemo, useRef, useState } from "react";
import { collection, useLiveQuery, useMutation } from "@convex-localfirst/react";
import { ChevronRight, FileText, Plus, Trash2 } from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DocEditor } from "./DocEditor";

type DocRow = Doc<"documents"> & { _conflict?: unknown };

const ICONS = ["📄", "📝", "📊", "🚀", "🐛", "💡", "📌", "🎯", "🔖", "📚"];

export function DocsView({ workspaceId, user }: { workspaceId: string; user: string }) {
  const docs = useLiveQuery(collection<DocRow>("documents").scope({ workspaceId }).order("position")) ?? [];
  const createDocument = useMutation(api.documents.create);
  const renameDocument = useMutation(api.documents.rename);
  const setIcon = useMutation(api.documents.setIcon);
  const removeDocument = useMutation(api.documents.remove);

  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [titleDraft, setTitleDraft] = useState("");
  // Debounce title saves: typing a title shouldn't fire one rename patch (and one
  // push) per keystroke. Update the draft instantly; persist when typing pauses,
  // and flush immediately on blur so nothing is lost.
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build the page tree by parentId. A dangling parentId (parent deleted) is
  // treated as a root, so deleting a parent never hides its children.
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set<string>(docs.map((d) => d._id));
    const childrenOf = new Map<string, DocRow[]>();
    const roots: DocRow[] = [];
    for (const d of docs) {
      const parent = d.parentId && ids.has(d.parentId) ? d.parentId : null;
      if (parent) {
        const list = childrenOf.get(parent) ?? [];
        list.push(d);
        childrenOf.set(parent, list);
      } else {
        roots.push(d);
      }
    }
    return { roots, childrenOf };
  }, [docs]);

  // Keep a valid selection; default to the first page once data loads.
  useEffect(() => {
    if (selected && docs.some((d) => d._id === selected)) return;
    setSelected(docs[0]?._id ?? null);
  }, [docs, selected]);

  const selectedDoc = docs.find((d) => d._id === selected) ?? null;
  // Re-seed the title input only when switching pages (local draft keeps typing
  // responsive without round-tripping every keystroke through the live query).
  useEffect(() => {
    setTitleDraft(selectedDoc?.title ?? "");
  }, [selectedDoc?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const createPage = async (parentId?: string) => {
    // .local resolves to the optimistic LocalCommit — its id is the new page's
    // localId, so we can select the page we just created with zero guesswork.
    const commit = await createDocument({ workspaceId, title: "Untitled", icon: "📄", parentId, position: Date.now() }).local;
    if (parentId) setExpanded((e) => new Set(e).add(parentId));
    setSelected(commit.id);
  };

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const renderNode = (doc: DocRow, depth: number) => {
    const kids = childrenOf.get(doc._id) ?? [];
    const isOpen = expanded.has(doc._id);
    return (
      <div key={doc._id}>
        <div
          data-testid="doc-item"
          data-title={doc.title}
          className={cn(
            "group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-muted",
            selected === doc._id && "bg-muted font-medium"
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setSelected(doc._id)}
        >
          <button
            type="button"
            aria-label={isOpen ? "Collapse children" : "Expand children"}
            className={cn(
              "flex size-4 items-center justify-center text-muted-foreground transition-transform",
              kids.length ? "" : "invisible",
              isOpen && "rotate-90"
            )}
            onClick={(e) => {
              e.stopPropagation();
              toggle(doc._id);
            }}
          >
            <ChevronRight className="size-3.5" />
          </button>
          <span>{doc.icon ?? "📄"}</span>
          <span className="flex-1 truncate">{doc.title || "Untitled"}</span>
          <button
            type="button"
            data-testid="add-subpage"
            aria-label="Add sub-page"
            className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
            title="Add sub-page"
            onClick={(e) => {
              e.stopPropagation();
              void createPage(doc._id);
            }}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {isOpen ? kids.map((k) => renderNode(k, depth + 1)) : null}
      </div>
    );
  };

  return (
    <div className="flex gap-4" style={{ minHeight: "70vh" }}>
      <aside className="w-64 shrink-0 rounded-xl border bg-card p-2">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pages</span>
          <Button data-testid="new-page" aria-label="New page" size="icon" variant="ghost" className="size-7" onClick={() => void createPage()}>
            <Plus className="size-4" />
          </Button>
        </div>
        <div data-testid="doc-tree" className="flex flex-col gap-0.5">
          {roots.length === 0 ? (
            <p data-testid="docs-empty" className="px-2 py-6 text-center text-sm text-muted-foreground">
              No pages yet
            </p>
          ) : null}
          {roots.map((d) => renderNode(d, 0))}
        </div>
      </aside>

      <section className="min-w-0 flex-1 rounded-xl border bg-card">
        {selectedDoc ? (
          <div className="px-8 py-6">
            <div className="mb-4 flex items-center gap-3">
              <button
                type="button"
                title="Change icon"
                className="text-3xl leading-none"
                onClick={() =>
                  void setIcon({
                    id: selectedDoc._id,
                    icon: ICONS[(ICONS.indexOf(selectedDoc.icon ?? "📄") + 1) % ICONS.length]!
                  }).local
                }
              >
                {selectedDoc.icon ?? "📄"}
              </button>
              <Input
                data-testid="doc-title"
                value={titleDraft}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  const id = selectedDoc._id;
                  setTitleDraft(value);
                  if (renameTimer.current) clearTimeout(renameTimer.current);
                  renameTimer.current = setTimeout(() => void renameDocument({ id, title: value }).local, 300);
                }}
                onBlur={() => {
                  if (renameTimer.current) {
                    clearTimeout(renameTimer.current);
                    renameTimer.current = null;
                  }
                  if (selectedDoc.title !== titleDraft) void renameDocument({ id: selectedDoc._id, title: titleDraft }).local;
                }}
                placeholder="Untitled"
                className="h-auto border-0 px-0 !text-3xl font-bold shadow-none focus-visible:ring-0"
              />
              <Button
                type="button"
                data-testid="delete-page"
                aria-label="Delete page"
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  void removeDocument({ id: selectedDoc._id }).local;
                  setSelected(null);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <DocEditor key={selectedDoc._id} docId={selectedDoc._id} workspaceId={workspaceId} user={user} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
            <FileText className="size-10" />
            <p>Select or create a page</p>
            <Button data-testid="new-page-empty" onClick={() => void createPage()}>
              <Plus className="size-4" /> New page
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
