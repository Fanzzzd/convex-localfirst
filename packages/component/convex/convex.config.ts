import { defineComponent } from "convex/server";

// The component's schema is auto-discovered from ./schema.ts. Mounting apps do
// `app.use(localfirst)` and call its public functions via
// `components.convexLocalFirst.*` (see the todo-perfect-dx example's sync.ts).
const component = defineComponent("convexLocalFirst");

export default component;
