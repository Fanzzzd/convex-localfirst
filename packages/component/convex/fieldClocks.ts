import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Per-field write clocks for `timestampLww` tables, per (table, localId). clocksJson is an
// opaque JSON map field -> { ts, tiebreaker } owned by serverSync; the component just stores it.
// Public component API — mirrors idMaps (resolve by (table, localId); membership is enforced
// separately on the push path).

export const get = query({
  args: {
    table: v.string(),
    localId: v.string()
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("fieldClocks")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first(); // first-by-index = oldest; deterministic under legacy duplicate rows (never wedge)
    return row?.clocksJson ?? null;
  }
});

export const put = mutation({
  args: {
    table: v.string(),
    localId: v.string(),
    clocksJson: v.string()
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("fieldClocks")
      .withIndex("by_table_local", (q) => q.eq("table", args.table).eq("localId", args.localId))
      .first(); // first-by-index = oldest; deterministic under legacy duplicate rows (never wedge)
    if (existing) {
      await ctx.db.patch(existing._id, { clocksJson: args.clocksJson, updatedAt: Date.now() });
      return existing._id;
    }
    return await ctx.db.insert("fieldClocks", {
      table: args.table,
      localId: args.localId,
      clocksJson: args.clocksJson,
      updatedAt: Date.now()
    });
  }
});
