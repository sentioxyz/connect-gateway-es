import { create, toJson } from '@bufbuild/protobuf'
import type { DescMessage, JsonWriteOptions, MessageInitShape, MessageShape } from '@bufbuild/protobuf'

export const HTTP_BODY_TYPE_NAME = 'google.api.HttpBody'

/**
 * Detects google.api.HttpBody by type name so the transport core needs no
 * static import of the vendored httpbody schema.
 */
export function isHttpBody(desc: DescMessage): boolean {
  return desc.typeName === HTTP_BODY_TYPE_NAME
}

export interface HttpBodyLike {
  contentType: string
  data: Uint8Array
}

export type HttpBodyRequestMode = 'raw' | 'json'

/**
 * Builds the HTTP request parts for an RPC whose input is google.api.HttpBody.
 * 'raw' sends data as the body with content_type as Content-Type (matching
 * gateways registered with an HTTPBodyMarshaler); 'json' sends the protojson
 * form of the HttpBody message itself (plain JSONPb gateways).
 */
export function httpBodyRequestParts(
  schema: DescMessage,
  message: HttpBodyLike,
  mode: HttpBodyRequestMode,
  jsonWrite: Partial<JsonWriteOptions>
): { body: BodyInit; contentType: string } {
  if (mode === 'json') {
    return {
      body: JSON.stringify(toJson(schema, message as unknown as MessageShape<DescMessage>, jsonWrite)),
      contentType: 'application/json'
    }
  }
  return {
    body: (message.data as Uint8Array<ArrayBuffer>) ?? new Uint8Array(),
    contentType: message.contentType !== '' ? message.contentType : 'application/octet-stream'
  }
}

/**
 * Builds the HttpBody response message from a raw gateway response: body bytes
 * plus the Content-Type header.
 */
export async function httpBodyFromResponse<O extends DescMessage>(
  schema: O,
  response: Response
): Promise<MessageShape<O>> {
  const data = new Uint8Array(await response.arrayBuffer())
  return create(schema, {
    contentType: response.headers.get('content-type') ?? '',
    data
  } as unknown as MessageInitShape<O>)
}
