import { fromJson } from '@bufbuild/protobuf'
import type { DescMessage, JsonObject, JsonReadOptions, JsonValue, MessageShape, Registry } from '@bufbuild/protobuf'
import { AnySchema } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'

/**
 * Wire-level facts about a gateway error, preserved alongside the
 * ConnectError so callers can rebuild legacy error shapes (HTTP status code,
 * raw response body).
 */
export interface GatewayErrorInfo {
  httpStatus: number
  rawBody: JsonValue | string | undefined
}

const errorInfoMap = new WeakMap<ConnectError, GatewayErrorInfo>()

/**
 * Returns the HTTP status and raw body for an error produced by the gateway
 * transport, or undefined for any other error.
 */
export function gatewayErrorInfo(error: unknown): GatewayErrorInfo | undefined {
  return error instanceof ConnectError ? errorInfoMap.get(error) : undefined
}

// Reverse of grpc-gateway's HTTPStatusFromCode, for responses that did not
// carry a google.rpc.Status body (LB/proxy errors, HTML error pages).
const HTTP_STATUS_CODES: Record<number, Code> = {
  400: Code.InvalidArgument,
  401: Code.Unauthenticated,
  403: Code.PermissionDenied,
  404: Code.NotFound,
  408: Code.DeadlineExceeded,
  409: Code.Aborted,
  412: Code.FailedPrecondition,
  413: Code.ResourceExhausted,
  429: Code.ResourceExhausted,
  431: Code.ResourceExhausted,
  499: Code.Canceled,
  501: Code.Unimplemented,
  502: Code.Unavailable,
  503: Code.Unavailable,
  504: Code.DeadlineExceeded
}

export function codeFromHttpStatus(status: number): Code {
  return HTTP_STATUS_CODES[status] ?? (status >= 500 ? Code.Internal : Code.Unknown)
}

function isStatusJson(body: unknown): body is JsonObject & { code?: number; message?: string; details?: JsonValue[] } {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
}

/**
 * Converts a grpc-gateway error response into a ConnectError. The body is the
 * protojson form of google.rpc.Status ({code, message, details: [Any...]}).
 * Falls back to an HTTP-status mapping when the body is not a Status. Error
 * details decode into ConnectError.details (findDetails-compatible) when the
 * registry knows the type; the raw body stays available via gatewayErrorInfo.
 */
export function gatewayErrorFromBody(
  body: JsonValue | string | undefined,
  httpStatus: number,
  headers?: Headers,
  registry?: Registry
): ConnectError {
  let code = codeFromHttpStatus(httpStatus)
  let message = `HTTP ${httpStatus}`
  let detailsJson: JsonValue[] = []
  if (isStatusJson(body)) {
    const statusCode = body.code
    if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode > 0 && statusCode <= 16) {
      code = statusCode as Code
    }
    if (typeof body.message === 'string') {
      message = body.message
    }
    if (Array.isArray(body.details)) {
      detailsJson = body.details
    }
  } else if (typeof body === 'string' && body.trim() !== '') {
    message = body.length > 300 ? `${body.slice(0, 300)}…` : body
  }
  const error = new ConnectError(message, code, headers)
  for (const detail of detailsJson) {
    if (registry === undefined) {
      break
    }
    try {
      const any = fromJson(AnySchema, detail, { registry })
      error.details.push({
        type: any.typeUrl.substring(any.typeUrl.lastIndexOf('/') + 1),
        value: any.value,
        debug: detail
      })
    } catch {
      // Type not in the registry — the raw detail remains in gatewayErrorInfo.
    }
  }
  errorInfoMap.set(error, { httpStatus, rawBody: body })
  return error
}

/**
 * Reads an error response body as JSON when possible, else as text.
 */
export async function readErrorBody(response: Response): Promise<JsonValue | string | undefined> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return text
  }
}

/**
 * fromJson with decode failures wrapped into a ConnectError.
 */
export function decodeJsonMessage<O extends DescMessage>(
  schema: O,
  json: JsonValue,
  jsonRead: Partial<JsonReadOptions>,
  headers?: Headers
): MessageShape<O> {
  try {
    return fromJson(schema, json, jsonRead)
  } catch (cause) {
    throw new ConnectError(`failed to decode ${schema.typeName} from response JSON`, Code.Internal, headers, [], cause)
  }
}
