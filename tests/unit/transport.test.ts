import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { create, toJson } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient, createContextValues } from '@connectrpc/connect'
import type { Interceptor } from '@connectrpc/connect'
import { gatewayBindingKey, gatewayRequestInitKey } from '../../src/context.js'
import { gatewayErrorInfo } from '../../src/error.js'
import { unboundMethodsFallback } from '../../src/route.js'
import { createGatewayTransport } from '../../src/transport.js'
import { EchoResponseSchema, EchoService, GetSimpleRequestSchema } from '../gen/clean/connectgateway/testing/echo_pb.js'
import { HttpBodySchema } from '../gen/clean/google/api/httpbody_pb.js'

interface RecordedCall {
  url: string
  init: RequestInit
  headers: Headers
  bodyText: string | undefined
}

function fakeFetch(respond: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const impl: typeof globalThis.fetch = async (input, init) => {
    if (init?.signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError')
    }
    const req: RecordedCall = {
      url: String(input),
      init: init ?? {},
      headers: new Headers(init?.headers),
      bodyText:
        init?.body === undefined || init.body === null
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : new TextDecoder().decode(init.body as Uint8Array)
    }
    calls.push(req)
    return respond(req)
  }
  return { calls, impl }
}

const okJson = (body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('createGatewayTransport unary', () => {
  it('issues a GET with path and query parameters, no body', async () => {
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const res = await client.getSimple({ id: 'a b', note: 'n' })
    assert.equal(res.message, 'ok')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/v1/simple/a%20b?note=n')
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].bodyText, undefined)
    assert.equal(calls[0].headers.get('accept'), 'application/json')
    assert.equal(calls[0].headers.get('content-type'), null)
  })

  it('issues a POST with a JSON body excluding path fields', async () => {
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(
      EchoService,
      createGatewayTransport({ baseUrl: 'https://api.example.com/', fetch: impl })
    )
    await client.postBody({ id: 'x', name: 'n', amount: 5n })
    assert.equal(calls[0].url, 'https://api.example.com/v1/things/x')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].headers.get('content-type'), 'application/json')
    assert.deepEqual(JSON.parse(calls[0].bodyText!), { name: 'n', amount: '5' })
  })

  it('runs interceptors and forwards per-call headers', async () => {
    const order: string[] = []
    const auth: Interceptor = (next) => async (req) => {
      order.push('auth')
      req.header.set('authorization', 'Bearer t')
      assert.ok(req.url.endsWith('/v1/simple/{id}'), 'interceptors see the un-substituted template URL')
      return next(req)
    }
    const outer: Interceptor = (next) => async (req) => {
      order.push('outer')
      return next(req)
    }
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(
      EchoService,
      createGatewayTransport({
        baseUrl: '',
        fetch: impl,
        interceptors: [outer, auth],
        headers: { 'x-default': 'd' }
      })
    )
    await client.getSimple({ id: '1' }, { headers: { 'share-dashboard': 's/1' } })
    assert.deepEqual(order, ['outer', 'auth'])
    assert.equal(calls[0].headers.get('authorization'), 'Bearer t')
    assert.equal(calls[0].headers.get('share-dashboard'), 's/1')
    assert.equal(calls[0].headers.get('x-default'), 'd')
  })

  it('maps gateway error bodies to ConnectError and preserves wire facts', async () => {
    const { impl } = fakeFetch(
      () => new Response(JSON.stringify({ code: 5, message: 'nope', details: [] }), { status: 404 })
    )
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const err = await client.getSimple({ id: 'x' }).catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.NotFound)
    assert.equal(err.rawMessage, 'nope')
    assert.deepEqual(gatewayErrorInfo(err)?.httpStatus, 404)
  })

  it('demangles Grpc-Metadata-* response headers', async () => {
    const { impl } = fakeFetch(() => okJson({ message: 'ok' }, { 'Grpc-Metadata-X-Trace': 'abc' }))
    const transport = createGatewayTransport({ baseUrl: '', fetch: impl })
    const res = await transport.unary(
      EchoService.method.getSimple,
      undefined,
      undefined,
      undefined,
      create(GetSimpleRequestSchema, { id: '1' }),
      undefined
    )
    assert.equal(res.header.get('x-trace'), 'abc')
    assert.equal(res.header.has('grpc-metadata-x-trace'), false)
  })

  it('returns raw bytes for HttpBody responses', async () => {
    const { impl } = fakeFetch(() => new Response('raw text', { headers: { 'content-type': 'text/plain' } }))
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const res = await client.getRaw({ id: '1' })
    assert.equal(res.contentType, 'text/plain')
    assert.equal(new TextDecoder().decode(res.data), 'raw text')
  })

  it('sends HttpBody requests raw by default', async () => {
    const { calls, impl } = fakeFetch(() => okJson(toJson(HttpBodySchema, create(HttpBodySchema, {}))))
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    await client.postRaw({ contentType: 'application/wasm', data: new Uint8Array([0, 97]) })
    assert.equal(calls[0].url, '/v1/raw')
    assert.equal(calls[0].headers.get('content-type'), 'application/wasm')
  })

  it('honors gatewayBindingKey set by an interceptor', async () => {
    const pickGet: Interceptor = (next) => async (req) => {
      req.contextValues.set(gatewayBindingKey, { verb: 'GET' })
      return next(req)
    }
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(
      EchoService,
      createGatewayTransport({ baseUrl: '', fetch: impl, interceptors: [pickGet] })
    )
    await client.multiBind({ id: '7', name: 'n' })
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].url, '/v1/multi/7?name=n')
  })

  it('rejects useProtoFieldName at transport creation', () => {
    assert.throws(
      () => createGatewayTransport({ baseUrl: '', jsonOptions: { useProtoFieldName: true } }),
      /useProtoFieldName/
    )
  })

  it('selects additional bindings per call via gatewayBindingKey', async () => {
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    await client.multiBind(
      { id: '7', name: 'n' },
      { contextValues: createContextValues().set(gatewayBindingKey, { verb: 'GET' }) }
    )
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].url, '/v1/multi/7?name=n')
    await client.multiBind({ id: '7' }, { contextValues: createContextValues().set(gatewayBindingKey, { index: 3 }) })
    assert.equal(calls[1].init.method, 'DELETE')
  })

  it('merges requestInit defaults with per-call overrides', async () => {
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(
      EchoService,
      createGatewayTransport({ baseUrl: '', fetch: impl, requestInit: { credentials: 'omit', cache: 'no-store' } })
    )
    await client.getSimple({ id: '1' })
    assert.equal(calls[0].init.credentials, 'omit')
    await client.getSimple(
      { id: '1' },
      { contextValues: createContextValues().set(gatewayRequestInitKey, { credentials: 'include' }) }
    )
    assert.equal(calls[1].init.credentials, 'include')
    assert.equal(calls[1].init.cache, 'no-store')
  })

  it('rejects unannotated methods unless a fallbackRule routes them', async () => {
    const { calls, impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const bare = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const err = await bare.noAnnotation({ id: '1' }).catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.Unimplemented)

    const routed = createClient(
      EchoService,
      createGatewayTransport({ baseUrl: '', fetch: impl, fallbackRule: unboundMethodsFallback })
    )
    await routed.noAnnotation({ id: '1' })
    assert.equal(calls[0].url, '/connectgateway.testing.EchoService/NoAnnotation')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].bodyText!), { id: '1' })
  })

  it('propagates aborts as Canceled', async () => {
    const { impl } = fakeFetch(() => okJson({ message: 'ok' }))
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const controller = new AbortController()
    controller.abort()
    const err = await client.getSimple({ id: '1' }, { signal: controller.signal }).catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.Canceled)
  })

  it('wraps network failures in ConnectError', async () => {
    const failing: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: failing }))
    const err = await client.getSimple({ id: '1' }).catch((e: unknown) => e)
    assert.ok(err instanceof ConnectError)
  })
})

describe('createGatewayTransport streaming', () => {
  const chunk = (sequence: number) =>
    JSON.stringify({ result: toJson(EchoResponseSchema, create(EchoResponseSchema, { sequence })) })

  it('iterates NDJSON result chunks', async () => {
    const { calls, impl } = fakeFetch(
      () =>
        new Response(`${chunk(1)}\n${chunk(2)}\n`, {
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        })
    )
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const seen: number[] = []
    for await (const res of client.streamEcho({ count: 2 })) {
      seen.push(res.sequence)
    }
    assert.deepEqual(seen, [1, 2])
    assert.equal(calls[0].url, '/v1/stream?count=2')
    assert.equal(calls[0].init.method, 'GET')
  })

  it('throws the mapped error for mid-stream error chunks', async () => {
    const { impl } = fakeFetch(
      () => new Response(`${chunk(1)}\n{"error":{"code":13,"message":"boom"}}\n`, { status: 200 })
    )
    const client = createClient(EchoService, createGatewayTransport({ baseUrl: '', fetch: impl }))
    const seen: number[] = []
    const err = await (async () => {
      try {
        for await (const res of client.streamEcho({ count: 2 })) {
          seen.push(res.sequence)
        }
        return undefined
      } catch (e) {
        return e
      }
    })()
    assert.deepEqual(seen, [1])
    assert.ok(err instanceof ConnectError)
    assert.equal(err.code, Code.Internal)
    assert.equal(err.rawMessage, 'boom')
  })
})
