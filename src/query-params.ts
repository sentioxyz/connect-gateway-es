import type { DescMessage, JsonObject, JsonValue } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'

export type QueryParamCase = 'json' | 'proto'

// These serialize to arbitrary JSON; grpc-gateway parses the raw query value
// with the type's UnmarshalJSON, so we send the JSON text as a single param.
// ListValue is NOT included: the gateway's query parser rejects it.
const JSON_BLOB_TYPES = new Set(['google.protobuf.Struct', 'google.protobuf.Value'])

function scalarToString(value: JsonValue): string {
  return typeof value === 'string' ? value : String(value)
}

// protojson camelCases FieldMask paths ('display_name' -> 'displayName'), but
// grpc-gateway's query parser stores the comma-split paths verbatim with no
// reversal (that only happens for request bodies). Convert back to snake_case
// so the server sees the proto field paths. Lossless: protobuf-es toJson
// already rejects irreversible paths.
function fieldMaskToQueryValue(protojsonValue: string): string {
  return protojsonValue
    .split(',')
    .map((path) => path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join(',')
}

function unsupported(fullKey: string, why: string): ConnectError {
  return new ConnectError(`field "${fullKey}" cannot be encoded as a query parameter: ${why}`, Code.Internal)
}

/**
 * Flattens the leftover request fields (a protojson object produced by toJson,
 * minus path variables and body) into grpc-gateway query parameters: nested
 * messages become dotted keys, repeated scalars repeat the key, well-known
 * types keep their protojson scalar encoding.
 */
export function flattenQueryParams(
  json: JsonObject,
  schema: DescMessage,
  caseMode: QueryParamCase
): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = []
  flattenInto(json, schema, caseMode, '', pairs)
  return pairs
}

function flattenInto(
  json: JsonObject,
  schema: DescMessage,
  caseMode: QueryParamCase,
  prefix: string,
  sink: Array<readonly [string, string]>
): void {
  for (const field of schema.fields) {
    const value = json[field.jsonName]
    if (value === undefined) {
      continue
    }
    const key = caseMode === 'json' ? field.jsonName : field.name
    const fullKey = prefix === '' ? key : `${prefix}.${key}`
    switch (field.fieldKind) {
      case 'scalar':
      case 'enum':
        if (value === null || typeof value === 'object') {
          throw unsupported(fullKey, `unexpected JSON ${value === null ? 'null' : 'object'}`)
        }
        sink.push([fullKey, scalarToString(value)])
        break
      case 'list': {
        if (field.listKind === 'message' && JSON_BLOB_TYPES.has(field.message.typeName)) {
          // Scalar-serialized Value elements would lose their JSON typing and
          // the gateway rejects repeated Struct either way.
          throw unsupported(fullKey, `repeated ${field.message.typeName} is not supported in query strings`)
        }
        for (const element of value as JsonValue[]) {
          if (element === null || typeof element === 'object') {
            throw unsupported(fullKey, 'repeated message values are not supported in query strings')
          }
          sink.push([fullKey, scalarToString(element)])
        }
        break
      }
      case 'map':
        // grpc-gateway can parse key[mapKey]=value pairs, but the encoding is
        // version-sensitive; rejecting keeps the dialect predictable.
        throw unsupported(fullKey, 'map fields are not supported in query strings')
      case 'message': {
        const typeName = field.message.typeName
        if (JSON_BLOB_TYPES.has(typeName)) {
          sink.push([fullKey, JSON.stringify(value)])
          break
        }
        if (
          typeName === 'google.api.HttpBody' ||
          typeName === 'google.protobuf.Any' ||
          typeName === 'google.protobuf.ListValue'
        ) {
          throw unsupported(fullKey, `${typeName} is not supported in query strings`)
        }
        if (value === null) {
          break
        }
        if (typeName === 'google.protobuf.FieldMask') {
          if (typeof value === 'string' && value !== '') {
            sink.push([fullKey, fieldMaskToQueryValue(value)])
          }
          break
        }
        if (typeof value !== 'object') {
          // Scalar-serializing well-known types: Timestamp, Duration and the
          // wrapper types.
          sink.push([fullKey, scalarToString(value)])
          break
        }
        if (Array.isArray(value)) {
          throw unsupported(fullKey, 'unexpected JSON array')
        }
        flattenInto(value, field.message, caseMode, fullKey, sink)
        break
      }
    }
  }
}

/**
 * Encodes query pairs with URLSearchParams semantics (spaces become '+'),
 * matching what grpc-gateway's net/url parsing expects.
 */
export function encodeQueryString(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) {
    return ''
  }
  const params = new URLSearchParams()
  for (const [key, value] of pairs) {
    params.append(key, value)
  }
  return params.toString()
}
