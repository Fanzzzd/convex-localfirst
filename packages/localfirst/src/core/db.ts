import { collectManifest } from "./collect.js";
import { collection, type LocalQueryPlan, type RelationsResult } from "./collection.js";
import type { ScopeDefinition } from "./manifest.js";
import {
  many as relationMany,
  one as relationOne,
  viaIds,
  type BackrefRelationDescriptor,
  type DeclaredRelationDescriptor,
  type DeclaredRelations,
  type ManyRelationDescriptor,
  type OneRelationDescriptor,
  type RelationSpec
} from "./relations.js";
import type { LocalQuery } from "./collection.js";
import type { RowValue } from "./types.js";

/** Compile-time table declaration carried by every `lf.table` builder and its
 * query/mutation exports. The property is phantom: server metadata remains the
 * sole runtime source consumed by `collectManifest`. */
export type LocalTableDeclaration<
  Name extends string,
  Row extends Record<string, unknown>,
  Shape extends object,
  Scope extends ScopeDefinition,
  Relations extends DeclaredRelations
> = {
  readonly __localFirstTableType: LocalTableTypeInfo<Name, Row, Shape, Scope, Relations>;
};

export type LocalTableTypeInfo<
  Name extends string,
  Row extends Record<string, unknown>,
  Shape extends object,
  Scope extends ScopeDefinition,
  Relations extends DeclaredRelations
> = {
  readonly name: Name;
  readonly row: Row;
  readonly shape: Shape;
  readonly scope: Scope;
  readonly relations: Relations;
};

type TableInfoFromValue<Value> = Value extends { readonly __localFirstTableType: infer Info } ? Info : never;

type TableDeclarations<Modules extends Record<string, unknown>> = {
  [ModuleKey in keyof Modules]: Modules[ModuleKey] extends object
    ? {
        [ExportKey in keyof Modules[ModuleKey]]: TableInfoFromValue<Modules[ModuleKey][ExportKey]>;
      }[keyof Modules[ModuleKey]]
    : never;
}[keyof Modules];

type DeclarationName<Declaration> = Declaration extends { readonly name: infer Name extends string }
  ? Name
  : never;

type DeclarationForName<Declaration, Name extends string> = Declaration extends { readonly name: Name }
  ? Declaration
  : never;

type RowOf<Declaration> = Declaration extends { readonly row: infer Row extends Record<string, unknown> }
  ? Row
  : never;

type ShapeOf<Declaration> = Declaration extends { readonly shape: infer Shape extends object }
  ? Shape
  : never;

type ScopeOf<Declaration> = Declaration extends { readonly scope: infer Scope extends ScopeDefinition }
  ? Scope
  : never;

type RelationsOf<Declaration> = Declaration extends { readonly relations: infer Relations extends DeclaredRelations }
  ? Relations
  : never;

type ScopeField<Scope> = Scope extends { readonly kind: "byUser"; readonly field: infer Field extends string }
  ? Field
  : Scope extends { readonly kind: "byWorkspace"; readonly workspaceIdField: infer Field extends string }
    ? Field
    : Scope extends { readonly kind: "byProject"; readonly projectIdField: infer Field extends string }
      ? Field
      : never;

type ScopeValues<Declaration> = ScopeField<ScopeOf<Declaration>> extends infer Field extends string
  ? Field extends keyof ShapeOf<Declaration>
    ? { [Key in Field]: ShapeOf<Declaration>[Key] }
    : never
  : never;

type ShapeField<Declaration> = Extract<keyof ShapeOf<Declaration>, string>;

type TargetRow<Modules extends Record<string, unknown>, Descriptor> = Descriptor extends {
  readonly table: infer Table extends string;
}
  ? RowOf<DeclarationForName<TableDeclarations<Modules>, Table>>
  : never;

type DeclaredRelationsResult<
  Modules extends Record<string, unknown>,
  Relations extends DeclaredRelations,
  Names extends keyof Relations
> = {
  [Name in Names]: Relations[Name] extends OneRelationDescriptor
    ? TargetRow<Modules, Relations[Name]> | null
    : Relations[Name] extends ManyRelationDescriptor | BackrefRelationDescriptor
      ? Array<TargetRow<Modules, Relations[Name]>>
      : never;
};

/** A table-specific `LocalQueryPlan`: every chain stays typed from its `lf.table`
 * declaration, and can still be passed directly to the existing engine/hooks. */
export type TypedTableQuery<
  Modules extends Record<string, unknown>,
  Declaration,
  Rel = Record<never, never>
> = LocalQueryPlan<RowOf<Declaration>, Rel> & {
  scope(values: ScopeValues<Declaration>): TypedTableQuery<Modules, Declaration, Rel>;
  filter(values: Partial<ShapeOf<Declaration>>): TypedTableQuery<Modules, Declaration, Rel>;
  where(predicate: (row: RowOf<Declaration>) => boolean): TypedTableQuery<Modules, Declaration, Rel>;
  where<Field extends ShapeField<Declaration>>(
    field: Field,
    value: ShapeOf<Declaration>[Field]
  ): TypedTableQuery<Modules, Declaration, Rel>;
  order<Field extends ShapeField<Declaration>>(
    field: Field,
    direction?: "asc" | "desc"
  ): TypedTableQuery<Modules, Declaration, Rel>;
  orderBy: {
    <Field extends ShapeField<Declaration>>(
      field: Field,
      direction?: "asc" | "desc"
    ): TypedTableQuery<Modules, Declaration, Rel>;
    readonly field: string;
    readonly dir: "asc" | "desc";
  };
  limit(n: number): TypedTableQuery<Modules, Declaration, Rel>;
  related<Name extends string, Target extends Record<string, unknown>, Many extends boolean>(
    name: Name,
    spec: RelationSpec<Target, Many>
  ): TypedTableQuery<Modules, Declaration, Rel & { [Key in Name]: Many extends true ? Target[] : Target | undefined }>;
  withRelations<Specs extends Record<string, RelationSpec>>(
    specs: Specs
  ): TypedTableQuery<Modules, Declaration, Rel & RelationsResult<Specs>>;
  with<const Names extends ReadonlyArray<Extract<keyof RelationsOf<Declaration>, string>>>(
    ...names: Names
  ): TypedTableQuery<
    Modules,
    Declaration,
    Rel & DeclaredRelationsResult<Modules, RelationsOf<Declaration>, Names[number]>
  >;
};

export type LocalDb<Modules extends Record<string, unknown>> = {
  [Name in DeclarationName<TableDeclarations<Modules>>]: TypedTableQuery<
    Modules,
    DeclarationForName<TableDeclarations<Modules>, Name>
  >;
};

class LocalDbQuery<Row extends Record<string, unknown>> implements LocalQueryPlan<Row, unknown> {
  readonly __localFirstQuery = true as const;
  declare readonly __rel: unknown;
  readonly orderBy: ((field: keyof Row, direction?: "asc" | "desc") => LocalDbQuery<Row>) & {
    readonly field: string;
    readonly dir: "asc" | "desc";
  };

  constructor(
    private readonly query: LocalQuery<Row, unknown>,
    private readonly declaredRelations: DeclaredRelations
  ) {
    const orderBy = (field: keyof Row, direction: "asc" | "desc" = "asc") => this.order(field, direction);
    Object.defineProperties(orderBy, {
      field: { get: () => this.query.orderBy?.field ?? "" },
      dir: { get: () => this.query.orderBy?.dir ?? "asc" }
    });
    this.orderBy = orderBy as typeof this.orderBy;
  }

  get table(): string {
    return this.query.table;
  }

  get scopeValues(): Record<string, unknown> | undefined {
    return this.query.scopeValues;
  }

  get relations() {
    return this.query.relations;
  }

  get orderSpec(): { readonly field: string; readonly dir: "asc" | "desc" } | undefined {
    return this.query.orderBy;
  }

  get rowLimit(): number | undefined {
    return this.query.rowLimit;
  }

  get predicateCount(): number {
    return this.query.predicateCount;
  }

  run(rows: readonly RowValue[]): Row[] {
    return this.query.run(rows);
  }

  scope(values: Record<string, unknown>): LocalDbQuery<Row> {
    return new LocalDbQuery(this.query.scope(values as Partial<Row>), this.declaredRelations);
  }

  filter(values: Record<string, unknown>): LocalDbQuery<Row> {
    return this.where((row) => Object.entries(values).every(([field, value]) => Object.is(row[field], value)));
  }

  where(predicate: (row: Row) => boolean): LocalDbQuery<Row>;
  where(field: string, value: unknown): LocalDbQuery<Row>;
  where(predicateOrField: ((row: Row) => boolean) | string, value?: unknown): LocalDbQuery<Row> {
    const predicate =
      typeof predicateOrField === "function"
        ? predicateOrField
        : (row: Row) => Object.is(row[predicateOrField], value);
    return new LocalDbQuery(this.query.where(predicate), this.declaredRelations);
  }

  order(field: keyof Row, direction: "asc" | "desc" = "asc"): LocalDbQuery<Row> {
    return new LocalDbQuery(this.query.order(field, direction), this.declaredRelations);
  }

  limit(n: number): LocalDbQuery<Row> {
    return new LocalDbQuery(this.query.limit(n), this.declaredRelations);
  }

  related(name: string, spec: RelationSpec): LocalDbQuery<Row> {
    return new LocalDbQuery(this.query.related(name, spec), this.declaredRelations);
  }

  withRelations(specs: Record<string, RelationSpec>): LocalDbQuery<Row> {
    return new LocalDbQuery(this.query.withRelations(specs), this.declaredRelations);
  }

  with(...names: readonly string[]): LocalDbQuery<Row> {
    const specs: Record<string, RelationSpec> = {};
    for (const name of names) {
      const descriptor = this.declaredRelations[name];
      if (!descriptor) {
        throw new Error(`createLocalDb: relation "${name}" is not declared on table "${this.table}".`);
      }
      specs[name] = relationSpec(descriptor);
    }
    return this.withRelations(specs);
  }
}

function relationSpec(descriptor: DeclaredRelationDescriptor): RelationSpec {
  if (descriptor.kind === "one") {
    return { ...relationOne(descriptor.table, descriptor.foreignKey), nullWhenMissing: true };
  }
  if (descriptor.kind === "many") {
    return viaIds(descriptor.table, descriptor.via);
  }
  return relationMany(descriptor.table, descriptor.foreignKey);
}

/** Build a fully typed table root from the same module object passed to the
 * provider. Runtime plans are ordinary `LocalQueryPlan`s over the existing
 * collection/relation implementation. */
export function createLocalDb<const Modules extends Record<string, unknown>>(modules: Modules): LocalDb<Modules> {
  const manifest = collectManifest(modules);
  const db: Record<string, LocalDbQuery<Record<string, unknown>>> = {};
  for (const [table, definition] of Object.entries(manifest.tables)) {
    db[table] = new LocalDbQuery(collection(table), definition.relations ?? {});
  }
  return db as unknown as LocalDb<Modules>;
}
