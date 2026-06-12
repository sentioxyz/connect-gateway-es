import { toJson } from '@bufbuild/protobuf'
import type { DescField, DescMessage, JsonObject, JsonValue, JsonWriteOptions, MessageShape } from '@bufbuild/protobuf'
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
}

function fieldByProtoName(schema: DescMessage, name: string): DescField | undefined {
  return schema.fields.find((f) => f.name === name || f.jsonName === name)
}

function resolveByProtoPath(schema: DescMessage, json: JsonObject, fieldPath: readonly string[]): ResolvedField {
  let curSchema: DescMessage = schema
  let curJson: JsonValue | undefined = json
  const jsonKeyChain: string[] = []
  for (const [index, segment] of fieldPath.entries()) {
    const field = fieldByProtoName(curSchema, segment)
    if (field === undefined) {
      throw new ConnectError(
        `path template field "${fieldPath.join('.')}" does not exist on ${schema.typeName}`,
        Code.Internal
      )
    }
    jsonKeyChain.push(field.jsonName)
    if (curJson === undefined || curJson === null || typeof curJson !== 'object' || Array.isArray(curJson)) {
      return { value: undefined, jsonKeyChain }
    }
    curJson = (curJson as JsonObject)[field.jsonName]
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
  return { value: curJson, jsonKeyChain }
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
  const json = toJson(schema, message, opts.jsonWriteOptions)
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ConnectError(`request message ${schema.typeName} did not serialize to a JSON object`, Code.Internal)
  }
  const remaining = structuredClone(json)

  const path = renderPath(binding.template, (fieldPath) => {
    const resolved = resolveByProtoPath(schema, remaining, fieldPath)
    if (resolved.value === undefined) {
      return undefined
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
