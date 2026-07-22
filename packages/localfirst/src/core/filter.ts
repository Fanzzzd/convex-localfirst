import { compareValues } from "./ordering.js";

type Defined<Value> = Exclude<Value, undefined>;
type ElementOf<Value> = NonNullable<Value> extends readonly (infer Element)[]
  ? Element
  : NonNullable<Value> extends ReadonlySet<infer Element>
    ? Element
    : never;
type EqualitySugar<Value> = Defined<Value>;

export type FilterOperators<Value> = {
  readonly eq?: Defined<Value>;
  readonly ne?: Defined<Value>;
  readonly in?: readonly Defined<Value>[];
  readonly nin?: readonly Defined<Value>[];
  readonly lt?: Defined<Value>;
  readonly lte?: Defined<Value>;
  readonly gt?: Defined<Value>;
  readonly gte?: Defined<Value>;
} & ([ElementOf<Value>] extends [never]
  ? object
  : {
      readonly contains?: ElementOf<Value>;
      readonly overlaps?: readonly ElementOf<Value>[];
    });

/** A typed, JSON-serializable local filter. Fields and logical clauses at the same
 * level are ANDed; use `OR`, `AND`, and `NOT` for nesting. */
export type FilterSpec<Shape extends Record<string, unknown> = Record<string, unknown>> = {
  readonly [Field in keyof Shape]?: EqualitySugar<Shape[Field]> | FilterOperators<Shape[Field]>;
} & {
  readonly OR?: readonly FilterSpec<Shape>[];
  readonly AND?: readonly FilterSpec<Shape>[];
  readonly NOT?: FilterSpec<Shape>;
};

export type FilterParseError = {
  readonly code: "invalid_json" | "invalid_filter" | "invalid_operator" | "invalid_operand";
  readonly path: string;
  readonly message: string;
};

export type FilterParseResult<Shape extends Record<string, unknown> = Record<string, unknown>> =
  | { readonly ok: true; readonly value: FilterSpec<Shape> }
  | { readonly ok: false; readonly error: FilterParseError };

const OPERATORS = new Set(["eq", "ne", "in", "nin", "lt", "lte", "gt", "gte", "contains", "overlaps"]);
const ARRAY_OPERATORS = new Set(["in", "nin", "overlaps"]);

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function collectionHas(value: unknown, needle: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => sameValue(item, needle));
  if (value instanceof Set) {
    for (const item of value) if (sameValue(item, needle)) return true;
  }
  return false;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (!plainObject(condition)) return sameValue(value, condition);
  const entries = Object.entries(condition);
  if (entries.length === 0) return sameValue(value, condition);
  // Preserve wave-1 `.filter({ objectField: objectValue })` reference equality.
  // Persisted object operands use `{ eq: objectValue }`, which is unambiguous to parse.
  if (entries.some(([operator]) => !OPERATORS.has(operator))) return sameValue(value, condition);
  for (const [operator, operand] of entries) {
    if (operator === "eq" && !sameValue(value, operand)) return false;
    if (operator === "ne" && sameValue(value, operand)) return false;
    if (operator === "in" && (!Array.isArray(operand) || !operand.some((item) => sameValue(value, item)))) return false;
    if (operator === "nin" && (!Array.isArray(operand) || operand.some((item) => sameValue(value, item)))) return false;
    if (operator === "lt" && compareValues(value, operand) >= 0) return false;
    if (operator === "lte" && compareValues(value, operand) > 0) return false;
    if (operator === "gt" && compareValues(value, operand) <= 0) return false;
    if (operator === "gte" && compareValues(value, operand) < 0) return false;
    if (operator === "contains" && !collectionHas(value, operand)) return false;
    if (
      operator === "overlaps" &&
      (!Array.isArray(operand) || !operand.some((item) => collectionHas(value, item)))
    ) return false;
  }
  return true;
}

/** Evaluate a filter with the same JS equality and shared Convex-style ordering used
 * by local `.where()` predicates and `.order()`. Malformed clauses fail closed. */
export function matchesFilter<Row extends Record<string, unknown>>(row: Row, filter: FilterSpec<Row>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "OR") {
      if (!Array.isArray(condition) || !condition.some((child) => plainObject(child) && matchesFilter(row, child as FilterSpec<Row>))) return false;
    } else if (field === "AND") {
      if (!Array.isArray(condition) || !condition.every((child) => plainObject(child) && matchesFilter(row, child as FilterSpec<Row>))) return false;
    } else if (field === "NOT") {
      if (!plainObject(condition) || matchesFilter(row, condition as FilterSpec<Row>)) return false;
    } else if (!matchesCondition(row[field], condition)) {
      return false;
    }
  }
  return true;
}

function error(
  code: FilterParseError["code"],
  path: string,
  message: string
): { readonly ok: false; readonly error: FilterParseError } {
  return { ok: false, error: { code, path, message } };
}

function validateJsonValue(value: unknown, path: string, seen?: WeakSet<object>): FilterParseError | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : { code: "invalid_operand", path, message: "Filter numbers must be finite." };
  }
  if (typeof value !== "object" || value === null) {
    return { code: "invalid_operand", path, message: "Filter operands must be JSON values." };
  }
  if (seen) {
    if (seen.has(value)) return { code: "invalid_operand", path, message: "Filter values must not be circular." };
    seen.add(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const childError = validateJsonValue(value[index], `${path}[${index}]`, seen);
      if (childError) return childError;
    }
  } else if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childError = validateJsonValue(child, `${path}.${key}`, seen);
      if (childError) return childError;
    }
  } else {
    return { code: "invalid_operand", path, message: "Filter operands must be JSON values." };
  }
  if (seen) seen.delete(value);
  return null;
}

function validateFilter(value: unknown, path = "$", seen?: WeakSet<object>): FilterParseError | null {
  if (!plainObject(value)) return { code: "invalid_filter", path, message: "Expected a filter object." };
  if (seen) {
    if (seen.has(value)) return { code: "invalid_operand", path, message: "Filter values must not be circular." };
    seen.add(value);
  }
  for (const [field, condition] of Object.entries(value)) {
    const fieldPath = `${path}.${field}`;
    if (field === "OR" || field === "AND") {
      if (!Array.isArray(condition)) {
        return { code: "invalid_operand", path: fieldPath, message: `${field} must be an array of filters.` };
      }
      for (let index = 0; index < condition.length; index++) {
        const childError = validateFilter(condition[index], `${fieldPath}[${index}]`, seen);
        if (childError) return childError;
      }
      continue;
    }
    if (field === "NOT") {
      const childError = validateFilter(condition, fieldPath, seen);
      if (childError) return childError;
      continue;
    }
    if (!plainObject(condition)) {
      const operandError = validateJsonValue(condition, fieldPath, seen);
      if (operandError) return operandError;
      continue;
    }
    const entries = Object.entries(condition);
    if (entries.length === 0) {
      return { code: "invalid_operand", path: fieldPath, message: "An operator object must not be empty." };
    }
    for (const [operator, operand] of entries) {
      const operatorPath = `${fieldPath}.${operator}`;
      if (!OPERATORS.has(operator)) {
        return { code: "invalid_operator", path: operatorPath, message: `Unknown filter operator "${operator}".` };
      }
      if (ARRAY_OPERATORS.has(operator) && !Array.isArray(operand)) {
        return { code: "invalid_operand", path: operatorPath, message: `${operator} must be an array.` };
      }
      const operandError = validateJsonValue(operand, operatorPath, seen);
      if (operandError) return operandError;
    }
  }
  if (seen) seen.delete(value);
  return null;
}

/** Parse untrusted saved-filter JSON without throwing. The discriminated result keeps
 * syntax/shape/operator failures typed and safe to surface in application UI. */
export function parseFilter<Shape extends Record<string, unknown> = Record<string, unknown>>(
  json: string
): FilterParseResult<Shape> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    return error("invalid_json", "$", cause instanceof Error ? cause.message : "Invalid JSON.");
  }
  const validationError = validateFilter(value);
  return validationError
    ? { ok: false, error: validationError }
    : { ok: true, value: value as FilterSpec<Shape> };
}

/** Validate and serialize a filter for storage as a saved view. */
export function serializeFilter<Shape extends Record<string, unknown>>(filter: FilterSpec<Shape>): string {
  const validationError = validateFilter(filter, "$", new WeakSet());
  if (validationError) throw new TypeError(`${validationError.path}: ${validationError.message}`);
  const json = JSON.stringify(filter);
  if (json === undefined) throw new TypeError("Filter is not JSON-serializable.");
  return json;
}
