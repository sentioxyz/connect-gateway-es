import assert from 'node:assert/strict'
import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { create, createRegistry, toJson } from '@bufbuild/protobuf'
import type { DescMessage, MessageInitShape } from '@bufbuild/protobuf'
import { DurationSchema } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError, createClient, createContextValues } from '@connectrpc/connect'
import type { Client } from '@connectrpc/connect'
import { gatewayBindingKey } from '../../src/context.js'
import { gatewayErrorInfo } from '../../src/error.js'
import { unboundMethodsFallback } from '../../src/route.js'
import { createGatewayTransport } from '../../src/transport.js'
import type { GatewayTransportOptions } from '../../src/options.js'
import {
  Color,
  EchoService,
  GetNestedRequestSchema,
  GetPatternRequestSchema,
  GetSimpleRequestSchema,
  GetWildcardRequestSchema,
  KitchenSinkRequestSchema,
  PostBodyRequestSchema,
  PostNamedBodyRequestSchema,
  ZeroPathRequestSchema
} from '../gen/clean/connectgateway/testing/echo_pb.js'

const conformanceDir = fileURLToPath(new URL('../../conformance', import.meta.url))

let server: ChildProcess
let baseUrl: string

function startServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    server = spawn('./bin/echo-server', [], { cwd: conformanceDir, stdio: ['ignore', 'pipe', 'inherit'] })
    const timer = setTimeout(() => reject(new Error('echo server did not report a port in time')), 30_000)
    let buffer = ''
    server.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /PORT=(\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    })
    server.on('error', reject)
    server.on('exit', (code) => reject(new Error(`echo server exited early with code ${code}`)))
  })
}

before(async () => {
  execSync('go build -o bin/echo-server ./server', { cwd: conformanceDir, stdio: 'inherit' })
  baseUrl = await startServer()
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${baseUrl}/healthz`)
      if (res.ok) break
    } catch {
      // not up yet
    }
    if (i > 100) throw new Error('echo server never became healthy')
    await new Promise((r) => setTimeout(r, 50))
  }
})

after(() => {
  server?.kill('SIGKILL')
})

function makeClient(extra: Partial<GatewayTransportOptions> = {}): Client<typeof EchoService> {
  return createClient(EchoService, createGatewayTransport({ baseUrl, ...extra }))
}

/**
 * The core conformance assertion: the server echoes the request message it
 * decoded (as protojson); it must deep-equal the protojson of what the client
 * meant to send.
 */
function assertDecoded<S extends DescMessage>(decodedRequest: unknown, schema: S, init: MessageInitShape<S>): void {
  assert.deepEqual(decodedRequest, toJson(schema, create(schema, init)))
}

describe('conformance against a real grpc-gateway', () => {
  it('GetSimple: path variable with encoding + query leftovers', async () => {
    const init = { id: 'a b中文%x', note: 'hello world' }
    const res = await makeClient().getSimple(init)
    assert.equal(res.observedMethod, 'GET')
    assertDecoded(res.decodedRequest, GetSimpleRequestSchema, init)
  })

  it('GetSimple: slashes in single-segment variables 404 on default-config gateways', async () => {
    // grpc-gateway's default (legacy) unescaping mode decodes %2F before
    // routing, so a '/' inside a single-segment variable cannot match. This
    // pins the dialect; gateways opting into UnescapingModeAllExceptReserved
    // lift the limitation. Use a {var=**} template if values contain slashes.
    const err = await makeClient()
      .getSimple({ id: 'a/b' })
      .catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.NotFound)
  })

  it('GetNested: nested field path variables', async () => {
    const init = { ownerAndSlug: { ownerName: 'own er', slug: 'slug-1' }, filter: 'f=1&g' }
    const res = await makeClient().getNested(init)
    assertDecoded(res.decodedRequest, GetNestedRequestSchema, init)
  })

  it('GetWildcard: double wildcard preserves slashes', async () => {
    const init = { project: 'p1', chainId: 'eth/mainnet/0', extra: 'e' }
    const res = await makeClient().getWildcard(init)
    assert.equal(res.observedPath, '/v1/wild/p1/eth/mainnet/0')
    assertDecoded(res.decodedRequest, GetWildcardRequestSchema, init)
  })

  it('GetPattern: mixed literal pattern', async () => {
    const init = { name: 'items/i-1' }
    const res = await makeClient().getPattern(init)
    assertDecoded(res.decodedRequest, GetPatternRequestSchema, init)
  })

  for (const method of ['postBody', 'putBody', 'patchBody'] as const) {
    it(`${method}: body:"*" round-trips and excludes path fields from the body`, async () => {
      const init = {
        id: 'id-1',
        name: 'n',
        amount: 9007199254740993n,
        inner: { a: 'aa', b: -5n, values: [1.5, 0] }
      }
      const res = await makeClient()[method](init)
      assertDecoded(res.decodedRequest, PostBodyRequestSchema, init)
    })
  }

  it('DeleteSimple: DELETE with query leftovers', async () => {
    const init = { id: 'gone', note: 'why' }
    const res = await makeClient().deleteSimple(init)
    assert.equal(res.observedMethod, 'DELETE')
    assertDecoded(res.decodedRequest, GetSimpleRequestSchema, init)
  })

  it('PostNamedBody: named body field + query leftovers', async () => {
    const init = { id: 'i', payload: { a: 'x', b: 1n }, extra: 'e' }
    const res = await makeClient().postNamedBody(init)
    assertDecoded(res.decodedRequest, PostNamedBodyRequestSchema, init)
  })

  it('MultiBind: every additional binding reaches the same RPC', async () => {
    const client = makeClient()
    const init = { id: '7', name: 'n' }
    for (const [selector, expectMethod] of [
      [undefined, 'POST'],
      [{ verb: 'GET' }, 'GET'],
      [{ verb: 'PUT' }, 'PUT'],
      [{ index: 3 }, 'DELETE']
    ] as const) {
      const res = await client.multiBind(
        init,
        selector === undefined ? {} : { contextValues: createContextValues().set(gatewayBindingKey, selector) }
      )
      assert.equal(res.observedMethod, expectMethod, `selector ${JSON.stringify(selector)}`)
      assertDecoded(res.decodedRequest, PostBodyRequestSchema, init)
    }
  })

  for (const queryParamCase of ['json', 'proto'] as const) {
    it(`QueryKitchenSink: every query-encodable field type round-trips (${queryParamCase} keys)`, async () => {
      const init = {
        str: 's s+&=?#',
        i32: -7,
        i64: 9007199254740993n,
        u64: 18446744073709551615n,
        flag: true,
        dbl: 1.25,
        data: new Uint8Array([1, 2, 254]),
        color: Color.RED,
        tags: ['a', 'b b'],
        bigTags: [1n, -2n],
        inner: { a: 'x', b: 3n, values: [0.5, 1] },
        optStr: '',
        optZero: 0,
        createdAt: { seconds: 1781260245n, nanos: 0 },
        ttl: { seconds: 90n, nanos: 0 },
        // multi-word paths pin the camelCase->snake_case query conversion
        mask: { paths: ['big_tags', 'inner.a', 'opt_str'] },
        strValue: 'wrapped',
        i64Value: 5n,
        boolValue: false,
        metadata: { k: 'v', n: 1 },
        choice: { case: 'oneofStr' as const, value: 'picked' }
      }
      const res = await makeClient({ queryParamCase }).queryKitchenSink(init)
      assertDecoded(res.decodedRequest, KitchenSinkRequestSchema, init)
    })
  }

  it('GetZeros: zero-valued numeric/bool/enum path variables route and decode', async () => {
    const init = { note: 'n' }
    const res = await makeClient().getZeros(init)
    assert.equal(res.observedPath, '/v1/zeros/0/false/COLOR_UNSPECIFIED/0')
    assertDecoded(res.decodedRequest, ZeroPathRequestSchema, init)
    const nonZero = { i32: -3, flag: true, color: Color.GREEN, i64: 8n }
    const res2 = await makeClient().getZeros(nonZero)
    assert.equal(res2.observedPath, '/v1/zeros/-3/true/COLOR_GREEN/8')
    assertDecoded(res2.decodedRequest, ZeroPathRequestSchema, nonZero)
  })

  it('GetRaw: HttpBody response passes through raw bytes and content type', async () => {
    const res = await makeClient().getRaw({ id: 'xyz' })
    assert.equal(res.contentType, 'text/x-raw; charset=utf-8')
    assert.equal(new TextDecoder().decode(res.data), 'raw:xyz')
  })

  it('PostRaw: HttpBody request passes through raw bytes and content type', async () => {
    const payload = new Uint8Array([0, 97, 115, 109, 255])
    const res = await makeClient().postRaw({ contentType: 'application/wasm', data: payload })
    assert.equal(res.contentType, 'application/wasm')
    assert.deepEqual(new Uint8Array(res.data), payload)
  })

  it('Fail: status code, message, details and HTTP status all map', async () => {
    const client = makeClient({ registry: createRegistry(DurationSchema) })
    const err = await client.fail({ code: 9, message: 'cannot do that', withDetail: true }).catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.FailedPrecondition)
    assert.equal(err.rawMessage, 'cannot do that')
    assert.equal(gatewayErrorInfo(err)?.httpStatus, 400)
    const details = err.findDetails(DurationSchema)
    assert.equal(details.length, 1)
    assert.equal(details[0].seconds, 3n)
  })

  it('Fail: unauthenticated maps to HTTP 401', async () => {
    const err = await makeClient()
      .fail({ code: 16, message: 'no token' })
      .catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.Unauthenticated)
    assert.equal(gatewayErrorInfo(err)?.httpStatus, 401)
  })

  it('StreamEcho: NDJSON server streaming round-trips', async () => {
    const sequences: number[] = []
    for await (const res of makeClient().streamEcho({ count: 3 })) {
      sequences.push(res.sequence)
      assert.equal(res.message, 'StreamEcho')
    }
    assert.deepEqual(sequences, [1, 2, 3])
  })

  it('StreamEcho: mid-stream errors surface as ConnectError after earlier results', async () => {
    const sequences: number[] = []
    const err = await (async () => {
      try {
        for await (const res of makeClient().streamEcho({ count: 5, failAt: 3 })) {
          sequences.push(res.sequence)
        }
        return undefined
      } catch (e) {
        return e
      }
    })()
    assert.deepEqual(sequences, [1, 2])
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.Internal)
    assert.equal(err.rawMessage, 'stream failed')
  })

  it('StreamEcho: errors before the first chunk carry code and message', async () => {
    const err = await (async () => {
      try {
        for await (const res of makeClient().streamEcho({ count: 5, failAt: 1 })) {
          void res
        }
        return undefined
      } catch (e) {
        return e
      }
    })()
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.Internal)
    assert.equal(err.rawMessage, 'stream failed')
  })

  it('NoAnnotation: unboundMethodsFallback matches generate_unbound_methods routing', async () => {
    const init = { id: 'u', note: 'n' }
    const res = await makeClient({ fallbackRule: unboundMethodsFallback }).noAnnotation(init)
    assert.equal(res.observedMethod, 'POST')
    assert.equal(res.observedPath, '/connectgateway.testing.EchoService/NoAnnotation')
    assertDecoded(res.decodedRequest, GetSimpleRequestSchema, init)
  })

  it('headers reach the backend as grpc metadata-compatible HTTP headers', async () => {
    // The annotator only records method/path/query; this asserts the call
    // itself succeeds with the typical sentio-style custom headers present.
    const res = await makeClient().getSimple(
      { id: '1' },
      { headers: { authorization: 'Bearer t', 'share-dashboard': 'd/1', 'x-admin-mode': 'true' } }
    )
    assert.equal(res.message, 'GetSimple')
  })
})
