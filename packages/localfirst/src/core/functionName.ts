import type { FunctionName } from "./types.js";

export type FunctionNameResolver = (reference: unknown) => FunctionName;

export function defaultFunctionName(reference: unknown): FunctionName {
  if (typeof reference === "string") {
    return reference;
  }

  if (reference && typeof reference === "object") {
    const record = reference as Record<string, unknown>;
    const candidates = [record._name, record.name, record.functionName, record.path];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Unable to resolve Convex function name. Inject the official getFunctionName resolver in the React adapter.",
  );
}
