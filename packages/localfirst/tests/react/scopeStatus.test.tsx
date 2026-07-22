import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useScopeStatus } from "../../src/react/index.js";
import { createTestHarness } from "../../src/testing/index.js";
import { docModules, todoModules } from "./harnessFixtures.js";

afterEach(cleanup);

describe("useScopeStatus (React)", () => {
  it("transitions hydrating → hydrated after the first sync", async () => {
    const t = createTestHarness({ modules: todoModules, userId: "u1" });
    const { result } = renderHook(() => useScopeStatus({}), { wrapper: t.Provider });
    expect(result.current.hydrated).toBe(false);
    await act(async () => {
      await t.settled();
    });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.denied).toBe(false);
    t.dispose();
  });

  it("reports denied when membership is refused", async () => {
    const t = createTestHarness({
      modules: docModules,
      userId: "u1",
      access: { member: () => null },
    });
    const { result } = renderHook(() => useScopeStatus({ wsId: "w1" }), { wrapper: t.Provider });
    await act(async () => {
      await t.engine.syncScope({ wsId: "w1" });
    });
    expect(result.current.denied).toBe(true);
    t.dispose();
  });
});
