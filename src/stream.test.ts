import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Code, ConnectError } from '@connectrpc/connect'
import { StringValueSchema } from '@bufbuild/protobuf/wkt'
import { readNdjsonStream } from './stream.js'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const msg of readNdjsonStream(body, StringValueSchema, {}, undefined, new Headers())) {
    out.push(msg.value)
  }
  return out
}

describe('readNdjsonStream', () => {
  it('parses newline-delimited result chunks', async () => {
    assert.deepEqual(await collect(streamOf('{"result":"a"}\n{"result":"b"}\n')), ['a', 'b'])
  })

  it('handles chunk boundaries splitting a line', async () => {
    assert.deepEqual(await collect(streamOf('{"res', 'ult":"a"}', '\n{"result"', ':"b"}\n')), ['a', 'b'])
  })

  it('parses a trailing line without a newline', async () => {
    assert.deepEqual(await collect(streamOf('{"result":"a"}\n{"result":"b"}')), ['a', 'b'])
  })

  it('tolerates CRLF and blank lines', async () => {
    assert.deepEqual(await collect(streamOf('{"result":"a"}\r\n\r\n{"result":"b"}\r\n')), ['a', 'b'])
  })

  it('handles multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"result":"中文"}\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 13))
        controller.enqueue(bytes.slice(13))
        controller.close()
      }
    })
    assert.deepEqual(await collect(body), ['中文'])
  })

  it('throws the mapped ConnectError on error chunks', async () => {
    const results: string[] = []
    await assert.rejects(
      async () => {
        for await (const msg of readNdjsonStream(
          streamOf('{"result":"a"}\n{"error":{"code":8,"message":"too much"}}\n'),
          StringValueSchema,
          {},
          undefined,
          new Headers()
        )) {
          results.push(msg.value)
        }
      },
      (err: unknown) => err instanceof ConnectError && err.code === Code.ResourceExhausted
    )
    assert.deepEqual(results, ['a'])
  })

  it('throws on malformed chunks', async () => {
    await assert.rejects(() => collect(streamOf('not json\n')), ConnectError)
    await assert.rejects(() => collect(streamOf('{"neither":1}\n')), ConnectError)
  })

  it('cancels the reader when iteration is abandoned', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":"a"}\n{"result":"b"}\n'))
      },
      cancel() {
        cancelled = true
      }
    })
    for await (const msg of readNdjsonStream(body, StringValueSchema, {}, undefined, new Headers())) {
      assert.equal(msg.value, 'a')
      break
    }
    assert.equal(cancelled, true)
  })
})
