import type { DescMessage, JsonObject, JsonReadOptions, JsonValue, MessageShape, Registry } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { decodeJsonMessage, gatewayErrorFromBody } from './error.js'

/**
 * Reads grpc-gateway's server-streaming wire format: newline-delimited JSON
 * chunks, each {"result": <message>} or {"error": <google.rpc.Status>}. An
 * error chunk terminates iteration by throwing the mapped ConnectError.
 * Abandoned iteration cancels the underlying reader.
 */
export async function* readNdjsonStream<O extends DescMessage>(
  body: ReadableStream<Uint8Array>,
  schema: O,
  jsonRead: Partial<JsonReadOptions>,
  registry: Registry | undefined,
  responseHeaders: Headers
): AsyncGenerator<MessageShape<O>, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const parseChunk = (line: string): MessageShape<O> => {
    let json: JsonValue
    try {
      json = JSON.parse(line) as JsonValue
    } catch (cause) {
      throw new ConnectError('malformed stream chunk: invalid JSON', Code.Internal, responseHeaders, [], cause)
    }
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      const obj = json as JsonObject
      if (obj.error !== undefined && obj.error !== null) {
        throw gatewayErrorFromBody(obj.error, 200, responseHeaders, registry)
      }
      if (obj.result !== undefined) {
        return decodeJsonMessage(schema, obj.result, jsonRead, responseHeaders)
      }
    }
    throw new ConnectError('unexpected stream chunk shape (expected {"result": ...} or {"error": ...})', Code.Internal)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') {
          yield parseChunk(line)
        }
      }
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail !== '') {
      yield parseChunk(tail)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
