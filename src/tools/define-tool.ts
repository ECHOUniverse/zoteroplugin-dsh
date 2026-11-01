/**
 * Local `defineTool` mirror producing the exact runtime `ToolDefinition`
 * shape `ctx.tools.register` accepts (`@deepseek-ai/dsh-tools` 0.2.1-rc.2).
 *
 * Documented deviation: the official `defineTool` export lives in the DSH
 * runtime's `@deepseek-ai/dsh-tools` package, which is not published to npm
 * in the 0.2.1-rc.2 line and therefore cannot be imported from this plugin's
 * install. This module mirrors the official compile step structurally —
 * author-facing `ValueSchemaSpec`/`ParameterSchemaSpec` (subset documented
 * below) compiled to raw JSON Schema, argument validation before `execute`,
 * and identity-preserving `render`/`presentationMeta`/presenter wrapping —
 * so the registered definition is indistinguishable at the registry boundary
 * from one produced by the official helper. When the official package
 * becomes importable, this file is replaced by `import { defineTool }`.
 *
 * Supported spec subset (all this plugin's tools need): `string` (with
 * `enum`), `integer`, `number`, `boolean`, `array` (with `items`), and
 * `object` (`additionalProperties: false`) — plus `description`, `default`.
 *
 * @module @hanxu131/dsh-zotero/tools/define-tool
 */

/** Author-facing annotation keywords shared by every schema node (official `ValueSchemaAnnotations`). */
export interface ValueSchemaAnnotations {
  description?: string
  title?: string
  default?: unknown
}

/** String value schema with literal constraints. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
}

export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  minimum?: number
  maximum?: number
}

export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  minimum?: number
  maximum?: number
}

export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
}

export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
}

export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/** Explicit object node; openness mandatory (official `ObjectValueSchemaSpec`). */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: Record<string, ValueSchemaSpec & { required?: true }>
  additionalProperties: boolean
}

/** Exact-one union (official `OneOfValueSchemaSpec`); ≥2 branches. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | IntegerValueSchemaSpec
  | NumberValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | OneOfValueSchemaSpec

/** One parameter property, optionally required (official `ParameterPropertySpec`). */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/** Implicit parameter object root; requiredness is per-property (official `ParameterSchemaSpec`). */
export type ParameterSchemaSpec = Record<string, ParameterPropertySpec>

/** Raw JSON Schema node as `ToolSchema.parameters` / `ToolOutputDefinition.schema` carry. */
export type JsonSchemaNode = Record<string, unknown>

/** Model-facing content block (official `ContentBlock` `text` variant). */
export interface TextContentBlock {
  type: 'text'
  text: string
}

export type ContentBlock = TextContentBlock

/** Tool run context (official `ToolRunContext`, narrowed to what we read). */
export interface ToolRunContext {
  readonly callId?: unknown
  readonly agent?: unknown
  readonly signal?: AbortSignal
}

/** Compiled definition as `ToolRuntime.register` accepts it. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: {
    schema: JsonSchemaNode
    render(args: unknown, value: unknown): ContentBlock[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** Thrown when model-generated arguments violate the declared parameters (official `ToolArgsError`). */
export class ToolArgsError extends Error {
  readonly violations: string[]
  constructor(violations: string[]) {
    super(`Invalid tool arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/** Compile one author-facing value spec into the enforced raw JSON Schema node. */
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  if ('oneOf' in spec) {
    // The official raw-schema validator supports type unions only through
    // `oneOf` (type arrays are rejected).
    const node: JsonSchemaNode = { oneOf: spec.oneOf.map((branch) => valueSchemaSpecToJsonSchema(branch)) }
    if (spec.description !== undefined) node.description = spec.description
    return node
  }
  switch (spec.type) {
    case 'string': {
      const node: JsonSchemaNode = { type: 'string' }
      if (spec.enum !== undefined) node.enum = [...spec.enum]
      if (spec.description !== undefined) node.description = spec.description
      if (spec.default !== undefined) node.default = spec.default
      return node
    }
    case 'integer': {
      const node: JsonSchemaNode = { type: 'integer' }
      if (spec.minimum !== undefined) node.minimum = spec.minimum
      if (spec.maximum !== undefined) node.maximum = spec.maximum
      if (spec.description !== undefined) node.description = spec.description
      if (spec.default !== undefined) node.default = spec.default
      return node
    }
    case 'number': {
      const node: JsonSchemaNode = { type: 'number' }
      if (spec.minimum !== undefined) node.minimum = spec.minimum
      if (spec.maximum !== undefined) node.maximum = spec.maximum
      if (spec.description !== undefined) node.description = spec.description
      if (spec.default !== undefined) node.default = spec.default
      return node
    }
    case 'boolean': {
      const node: JsonSchemaNode = { type: 'boolean' }
      if (spec.description !== undefined) node.description = spec.description
      if (spec.default !== undefined) node.default = spec.default
      return node
    }
    case 'null': {
      const node: JsonSchemaNode = { type: 'null' }
      if (spec.description !== undefined) node.description = spec.description
      return node
    }
    case 'array': {
      const node: JsonSchemaNode = { type: 'array' }
      if (spec.items !== undefined) node.items = valueSchemaSpecToJsonSchema(spec.items)
      if (spec.description !== undefined) node.description = spec.description
      if (spec.default !== undefined) node.default = spec.default
      return node
    }
    case 'object': {
      const node: JsonSchemaNode = { type: 'object', additionalProperties: spec.additionalProperties === true }
      if (spec.properties !== undefined) {
        const properties: Record<string, JsonSchemaNode> = {}
        const required: string[] = []
        for (const [name, property] of Object.entries(spec.properties)) {
          properties[name] = valueSchemaSpecToJsonSchema(property)
          if (property.required === true) required.push(name)
        }
        node.properties = properties
        if (required.length > 0) node.required = required
      }
      if (spec.description !== undefined) node.description = spec.description
      return node
    }
  }
}

/** Compile the implicit open parameter object (official `parameterSchemaSpecToJsonSchema`). */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [name, property] of Object.entries(spec)) {
    properties[name] = valueSchemaSpecToJsonSchema(property)
    if (property.required === true) required.push(name)
  }
  const node: JsonSchemaNode = { type: 'object', properties, additionalProperties: true }
  if (required.length > 0) node.required = required
  return node
}

/** Validate candidate arguments against a compiled parameter schema; returns path-qualified violations. */
export function validateArgs(schema: JsonSchemaNode, args: unknown): string[] {
  const violations: string[] = []
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return ['arguments must be a JSON object']
  }
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>
  const required = (schema.required ?? []) as string[]
  for (const name of required) {
    if (args[name as keyof typeof args] === undefined) violations.push(`${name} is required`)
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name]
    if (property === undefined) continue // the implicit root stays open (official semantics)
    validateValue(property, value, name, violations)
  }
  return violations
}

/** Non-collecting match test used by `oneOf` (returns the first violation or undefined). */
function validateValueMatches(schema: JsonSchemaNode, value: unknown): boolean {
  const violations: string[] = []
  validateValue(schema, value, 'value', violations)
  return violations.length === 0
}

function validateValue(schema: JsonSchemaNode, value: unknown, path: string, violations: string[]): void {
  if (value === undefined) return // absence is only a violation for required names
  const type = schema.type
  const mismatch = (expected: string): void => {
    violations.push(`${path} must be ${expected}`)
  }
  switch (type) {
    case 'string': {
      if (typeof value !== 'string') return mismatch('a string')
      const allowed = schema.enum as readonly string[] | undefined
      if (allowed !== undefined && !allowed.includes(value)) mismatch(`one of ${allowed.map((item) => JSON.stringify(item)).join(', ')}`)
      return
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return mismatch('an integer')
      const minimum = schema.minimum as number | undefined
      const maximum = schema.maximum as number | undefined
      if (minimum !== undefined && value < minimum) mismatch(`at least ${minimum}`)
      if (maximum !== undefined && value > maximum) mismatch(`at most ${maximum}`)
      return
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return mismatch('a number')
      return
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return mismatch('a boolean')
      return
    }
    case 'null': {
      if (value !== null) return mismatch('null')
      return
    }
    case 'oneOf': {
      const branches = (schema.oneOf ?? []) as JsonSchemaNode[]
      const matches = branches.filter((branch) => validateValueMatches(branch, value)).length
      if (matches !== 1) mismatch(`exactly one oneOf branch (matched ${matches})`)
      return
    }
    case 'array': {
      if (!Array.isArray(value)) return mismatch('an array')
      const items = schema.items as JsonSchemaNode | undefined
      if (items !== undefined) {
        value.forEach((item, index) => validateValue(items, item, `${path}[${index}]`, violations))
      }
      return
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return mismatch('an object')
      const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (properties[key] === undefined) violations.push(`${path}.${key} is not a declared property`)
        }
      }
      const required = (schema.required ?? []) as string[]
      for (const name of required) {
        if ((value as Record<string, unknown>)[name] === undefined) violations.push(`${path}.${name} is required`)
      }
      for (const [key, property] of Object.entries(properties)) {
        const inner = (value as Record<string, unknown>)[key]
        if (inner !== undefined) validateValue(property, inner, `${path}.${key}`, violations)
      }
      return
    }
    default:
      return
  }
}

/** Options for `defineTool` (official `DefineToolOptions`, mirrored subset). */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  name: string
  description: string
  parameters: S
  output: {
    schema: O
    render(args: Record<string, unknown>, value: unknown): ContentBlock[]
    presentationMeta?(args: Record<string, unknown>, value: unknown): unknown
  }
  isConcurrencySafe?(args: Record<string, unknown>): boolean
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
}

/**
 * Define a registry-ready tool: compile schemas, validate arguments before
 * the body, and pass renders through unchanged — the same registry-boundary
 * contract the official `defineTool` establishes.
 */
export function defineTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return options.output.render(args as Record<string, unknown>, value)
      },
      ...(options.output.presentationMeta !== undefined
        ? {
            presentationMeta(args, value) {
              return options.output.presentationMeta!(args as Record<string, unknown>, value)
            },
          }
        : {}),
    },
    ...(options.isConcurrencySafe !== undefined
      ? {
          isConcurrencySafe(args: unknown): boolean {
            return options.isConcurrencySafe!(args as Record<string, unknown>)
          },
        }
      : {}),
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return options.execute(args as Record<string, unknown>, exec)
    },
  }
}
