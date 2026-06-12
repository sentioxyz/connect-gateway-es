import { ScalarType, toJson } from '@bufbuild/protobuf'
import type { DescField, DescMessage, JsonObject, JsonValue, JsonWriteOptions, MessageShape } from '@bufbuild/protobuf'
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'
import { flattenQueryParams } from './query-params.js'
import type { QueryParamCase } from './query-params.js'
import { renderPath } from './path-template.js'
import type { PathValue } from './path-template.js'
import type { GatewayBinding } from './route.js'

export interface TranscodeOptions {
  jsonWriteOptions?: Partial<JsonWriteOptions>
  queryParamCase: QueryParamCase
}

export interface TranscodedRequest {
  /** Percent-encoded URL path with all template variables substituted. */
  path: string
  /** Query parameters in emit order, unencoded key/value pairs. */
  query: ReadonlyArray<readonly [string, string]>
  /** JSON request body, or null when the binding sends no body. */
  body: string | null
}

interface ResolvedField {
  value: JsonValue | undefined
  /** The chain of protojson object keys leading to the value. */
  jsonKeyChain: string[]
  /** The descriptor of the final path segment's field. */
  leaf: DescField | undefined
}

function fieldByProtoName(schema: DescMessage, name: string): DescField | undefined {
  return schema.fields.find((f) => f.name === name || f.jsonName === name)
}

function resolveByProtoPath(schema: DescMessage, json: JsonObject, fieldPath: readonly string[]): ResolvedField {
  let curSchema: DescMessage = schema
  let curJson: JsonValue | undefined = json
  const jsonKeyChain: string[] = []
  let leaf: DescField | undefined
  for (const [index, segment] of fieldPath.entries()) {
    const field = fieldByProtoName(curSchema, segment)
    if (field === undefined) {
      throw new ConnectError(
        `path template field "${fieldPath.join('.')}" does not exist on ${schema.typeName}`,
        Code.Internal
      )
    }
    jsonKeyChain.push(field.jsonName)
    leaf = field
    if (curJson === undefined || curJson === null || typeof curJson !== 'object' || Array.isArray(curJson)) {
      curJson = undefined
    } else {
      curJson = (curJson as JsonObject)[field.jsonName]
    }
    if (index < fieldPath.length - 1) {
      if (field.fieldKind !== 'message') {
        throw new ConnectError(
          `path template field "${fieldPath.join('.')}" traverses non-message field "${segment}" on ${curSchema.typeName}`,
          Code.Internal
        )
      }
      curSchema = field.message
    }
  }
  return { value: curJson, jsonKeyChain, leaf }
}

/**
 * The protojson zero value for an implicit-presence scalar/enum field. For
 * such fields "unset" IS the zero value (proto3 cannot tell them apart), so a
 * path variable resolving to an omitted field must render the zero — the
 * gateway happily routes /v1/things/0 — rather than fail as "missing".
 */
function implicitZeroValue(field: DescField): PathValue | undefined {
  if (field.presence !== FeatureSet_FieldPresence.IMPLICIT) {
    return undefined
  }
  if (field.fieldKind === 'enum') {
    return field.enum.values.find((v) => v.number === 0)?.name ?? '0'
  }
  if (field.fieldKind !== 'scalar') {
    return undefined
  }
  switch (field.scalar) {
    case ScalarType.BOOL:
      return false
    case ScalarType.STRING:
    case ScalarType.BYTES:
      // The zero is the empty string, which cannot occupy a path segment;
      // renderPath produces the proper "must not be empty" error.
      return ''
    default:
      // All numeric kinds (including 64-bit, which protojson renders as a
      // decimal string) stringify to '0'.
      return 0
  }
}

function deleteAtChain(json: JsonObject, chain: readonly string[]): void {
  let cur: JsonValue | undefined = json
  for (let i = 0; i < chain.length - 1; i++) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return
    }
    cur = (cur as JsonObject)[chain[i]]
  }
  if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
    delete (cur as JsonObject)[chain[chain.length - 1]]
  }
}

/**
 * Splits one request message into the three transport parts of a gateway
 * binding: rendered URL path, query parameters and JSON body. Strategy is
 * toJson-carving — serialize the whole message once with protojson (which
 * already matches the value formats grpc-gateway accepts: int64 as string,
 * enums as names, bytes as base64, Timestamp as RFC 3339, implicit zero
 * fields omitted), then carve out path variables and the body.
 */
export function transcodeRequest<I extends DescMessage>(
  binding: GatewayBinding,
  schema: I,
  message: MessageShape<I>,
  opts: TranscodeOptions
): TranscodedRequest {
  // toJson returns a fresh tree per call, so it can be carved up in place.
  const remaining = toJson(schema, message, opts.jsonWriteOptions)
  if (remaining === null || typeof remaining !== 'object' || Array.isArray(remaining)) {
    throw new ConnectError(`request message ${schema.typeName} did not serialize to a JSON object`, Code.Internal)
  }

  const path = renderPath(binding.template, (fieldPath) => {
    const resolved = resolveByProtoPath(schema, remaining, fieldPath)
    if (resolved.value === undefined) {
      // Implicit-presence zero fields are omitted by protojson but are
      // perfectly valid path values.
      return resolved.leaf === undefined ? undefined : implicitZeroValue(resolved.leaf)
    }
    deleteAtChain(remaining, resolved.jsonKeyChain)
    return resolved.value as PathValue
  })

  let body: string | null = null
  if (binding.body === '*') {
    body = JSON.stringify(remaining)
    return { path, query: [], body }
  }
  if (binding.body !== undefined) {
    const field = fieldByProtoName(schema, binding.body[0])
    if (field === undefined) {
      throw new ConnectError(`body field "${binding.body[0]}" does not exist on ${schema.typeName}`, Code.Internal)
    }
    const bodyValue = remaining[field.jsonName]
    deleteAtChain(remaining, [field.jsonName])
    body = JSON.stringify(bodyValue === undefined ? {} : bodyValue)
  }
  const query = flattenQueryParams(remaining, schema, opts.queryParamCase)
  return { path, query, body }
}
