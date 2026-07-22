import { describe, expect, it } from "vitest";
import { gc } from "../../component/convex/changes";
import schema from "../../component/convex/schema";

function handlerOf(fn: unknown): (ctx: any, args: any) => Promise<any> {
  return (fn as { _handler: (ctx: any, args: any) => Promise<any> })._handler;
}

type Row = { _id: string; [key: string]: unknown };

class FakeDb {
  ops: Row[] = [];
  changes: Row[] = [];
  gcState: Row[] = [];
  private id = 0;

  query(table: "ops" | "changes" | "gcState") {
    return {
      withIndex: (_index: string, build: (q: any) => any) => {
        let filter: { field: string; op: "lt" | "eq"; value: unknown } | null = null;
        const q = {
          lt: (field: string, value: unknown) => {
            filter = { field, op: "lt", value };
            return q;
          },
          eq: (field: string, value: unknown) => {
            filter = { field, op: "eq", value };
            return q;
          }
        };
        build(q);
        const rows = () => {
          const all = this[table];
          if (!filter) return [...all];
          const { field, op, value } = filter;
          return all.filter((row) =>
            op === "eq" ? row[field] === value : Number(row[field]) < Number(value)
          );
        };
        return {
          first: async () => rows()[0] ?? null,
          paginate: async ({ cursor, numItems }: { cursor: string | null; numItems: number }) => {
            const timeField = table === "ops" ? "committedAt" : "serverTime";
            const after = cursor === null ? -Infinity : Number(cursor);
            const remaining = rows()
              .filter((row) => Number(row[timeField]) > after)
              .sort((a, b) => Number(a[timeField]) - Number(b[timeField]));
            const page = remaining.slice(0, numItems);
            return {
              page,
              isDone: page.length === remaining.length,
              continueCursor: String(page.at(-1)?.[timeField] ?? after)
            };
          }
        };
      }
    };
  }

  async delete(id: string) {
    for (const table of ["ops", "changes", "gcState"] as const) {
      this[table] = this[table].filter((row) => row._id !== id);
    }
  }

  async patch(id: string, patch: Record<string, unknown>) {
    const row = this.gcState.find((candidate) => candidate._id === id)!;
    Object.assign(row, patch);
  }

  async insert(table: "gcState", value: Record<string, unknown>) {
    const id = `id-${++this.id}`;
    this[table].push({ _id: id, ...value });
    return id;
  }
}

describe("component GC", () => {
  it("keeps only replay-required fields in the operation ledger", () => {
    const exported = JSON.parse((schema as unknown as { export(): string }).export());
    const ops = exported.tables.find((table: { tableName: string }) => table.tableName === "ops");
    expect(Object.keys(ops.documentType.value).sort()).toEqual([
      "changesJson",
      "committedAt",
      "error",
      "opId",
      "schemaVersion",
      "status",
      "userId"
    ]);
  });

  it("uses persistent cursors to prune expired ledger and idle-scope changes across runs", async () => {
    const db = new FakeDb();
    for (let i = 1; i <= 70; i++) {
      db.ops.push({ _id: `op-${i}`, committedAt: i });
      db.changes.push({ _id: `change-${i}`, serverTime: i, scopeKey: `idle-${i}` });
    }
    db.ops.push({ _id: "op-fresh", committedAt: 150 });
    db.changes.push({ _id: "change-fresh", serverTime: 150, scopeKey: "idle-fresh" });

    const runGc = handlerOf(gc);
    const first = await runGc({ db }, { now: 200, retentionMs: 100 });
    expect(first).toMatchObject({ ops: 32, changes: 32, done: false });
    expect(db.gcState[0]).toMatchObject({ opsCursor: "32", changesCursor: "32" });

    const second = await runGc({ db }, { now: 200, retentionMs: 100 });
    const third = await runGc({ db }, { now: 200, retentionMs: 100 });
    expect([second.ops, third.ops]).toEqual([32, 6]);
    expect(third.done).toBe(true);
    expect(db.ops.map((row) => row._id)).toEqual(["op-fresh"]);
    expect(db.changes.map((row) => row._id)).toEqual(["change-fresh"]);
  });
});
