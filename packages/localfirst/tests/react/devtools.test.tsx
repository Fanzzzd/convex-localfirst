import { describe, expect, it, afterEach } from "vitest";
import { anyApi } from "convex/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocalFirstDevtools } from "../../src/devtools/index.js";
import { createTestHarness } from "../../src/testing/index.js";
import { todoModules } from "./harnessFixtures.js";

const api = anyApi as { todos: { create: never } };

afterEach(cleanup);

describe("LocalFirstDevtools", () => {
  it("renders inside a harness provider", () => {
    const t = createTestHarness({ modules: todoModules, userId: "u1" });
    const Provider = t.Provider;
    render(
      <Provider>
        <LocalFirstDevtools defaultOpen />
      </Provider>
    );
    expect(screen.getByTestId("lf-devtools")).toBeTruthy();
    expect(screen.getByTestId("lf-devtools-panel-sync")).toBeTruthy();
    t.dispose();
  });

  it("shows a pending op in the outbox tab", async () => {
    const t = createTestHarness({ modules: todoModules, userId: "u1" });
    t.goOffline();
    await act(async () => {
      await t.engine.mutate(api.todos.create, { text: "pending!" }).local;
    });
    const Provider = t.Provider;
    render(
      <Provider>
        <LocalFirstDevtools defaultOpen pollMs={20} />
      </Provider>
    );
    fireEvent.click(screen.getByTestId("lf-devtools-tab-outbox"));
    const op = await screen.findByTestId("lf-devtools-op");
    expect(op.textContent).toContain("todos");
    t.dispose();
  });

  it("the offline toggle flips the engine's online state", () => {
    const t = createTestHarness({ modules: todoModules, userId: "u1" });
    const Provider = t.Provider;
    render(
      <Provider>
        <LocalFirstDevtools defaultOpen />
      </Provider>
    );
    expect(t.engine.getStatus().online).toBe(true);
    fireEvent.click(screen.getByTestId("lf-devtools-offline-toggle"));
    expect(t.engine.getStatus().online).toBe(false);
    t.dispose();
  });

  it("renders nothing without an engine in context", () => {
    const { container } = render(<LocalFirstDevtools defaultOpen />);
    expect(container.firstChild).toBeNull();
  });
});
