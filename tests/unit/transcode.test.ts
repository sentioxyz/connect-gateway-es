import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { ConnectError } from '@connectrpc/connect'
import { encodeQueryString } from '../../src/query-params.js'
import { resolveGatewayRoute } from '../../src/route.js'
import { transcodeRequest } from '../../src/transcode.js'
import type { TranscodeOptions } from '../../src/transcode.js'
import {
  Color,
  EchoService,
  GetNestedRequestSchema,
  GetSimpleRequestSchema,
  GetWildcardRequestSchema,
  KitchenSinkRequestSchema,
  PostBodyRequestSchema,
  PostNamedBodyRequestSchema
} from '../gen/clean/connectgateway/testing/echo_pb.js'

const OPTS: TranscodeOptions = { queryParamCase: 'json' }

function binding(methodName: keyof typeof EchoService.method, index = 0) {
  const route = resolveGatewayRoute(EchoService.method[methodName])
  assert.ok(route, `no route for ${String(methodName)}`)
  return route.bindings[index]
}

describe('transcodeRequest', () => {
  it('renders path variables and sends leftovers as query params', () => {
    const msg = create(GetSimpleRequestSchema, { id: 'a b', note: 'hi' })
    const out = transcodeRequest(binding('getSimple'), GetSimpleRequestSchema, msg, OPTS)
    assert.equal(out.path, '/v1/simple/a%20b')
    assert.deepEqual(out.query, [['note', 'hi']])
    assert.equal(out.body, null)
  })

  it('omits implicit zero-value fields from the query', () => {
    const msg = create(GetSimpleRequestSchema, { id: 'x' })
    const out = transcodeRequest(binding('getSimple'), GetSimpleRequestSchema, msg, OPTS)
    assert.deepEqual(out.query, [])
  })

  it('resolves nested path variables and removes them from the query', () => {
    const msg = create(GetNestedRequestSchema, {
      ownerAndSlug: { ownerName: 'me', slug: 'proj' },
      filter: 'f'
    })
    const out = transcodeRequest(binding('getNested'), GetNestedRequestSchema, msg, OPTS)
    assert.equal(out.path, '/v1/nested/me/proj')
    assert.deepEqual(out.query, [['filter', 'f']])
  })

  it('keeps slashes in double-wildcard path values', () => {
    const msg = create(GetWildcardRequestSchema, { project: 'p', chainId: 'eth/main net', extra: 'e' })
    const out = transcodeRequest(binding('getWildcard'), GetWildcardRequestSchema, msg, OPTS)
    assert.equal(out.path, '/v1/wild/p/eth/main%20net')
    assert.deepEqual(out.query, [['extra', 'e']])
  })

  it('sends all non-path fields in the body for body:"*"', () => {
    const msg = create(PostBodyRequestSchema, {
      id: 'x',
      name: 'n',
      amount: 12345678901234567n,
      inner: { a: 'aa', b: 2n, values: [1.5] }
    })
    const out = transcodeRequest(binding('postBody'), PostBodyRequestSchema, msg, OPTS)
    assert.equal(out.path, '/v1/things/x')
    assert.deepEqual(out.query, [])
    assert.deepEqual(JSON.parse(out.body!), {
      name: 'n',
      amount: '12345678901234567',
      inner: { a: 'aa', b: '2', values: [1.5] }
    })
  })

  it('extracts a named body field and queries the rest', () => {
    const msg = create(PostNamedBodyRequestSchema, {
      id: 'x',
      payload: { a: 'aa', b: 7n },
      extra: 'e'
    })
    const out = transcodeRequest(binding('postNamedBody'), PostNamedBodyRequestSchema, msg, OPTS)
    assert.equal(out.path, '/v1/things/x/payload')
    assert.deepEqual(JSON.parse(out.body!), { a: 'aa', b: '7' })
    assert.deepEqual(out.query, [['extra', 'e']])
  })

  it('sends an empty object body when the named body field is unset', () => {
    const msg = create(PostNamedBodyRequestSchema, { id: 'x' })
    const out = transcodeRequest(binding('postNamedBody'), PostNamedBodyRequestSchema, msg, OPTS)
    assert.equal(out.body, '{}')
  })

  it('uses the selected additional binding', () => {
    const msg = create(PostBodyRequestSchema, { id: 'x', name: 'n' })
    const get = transcodeRequest(binding('multiBind', 1), PostBodyRequestSchema, msg, OPTS)
    assert.equal(get.body, null)
    assert.deepEqual(get.query, [['name', 'n']])
  })

  it('throws on missing path parameters', () => {
    const msg = create(GetSimpleRequestSchema, { note: 'no id' })
    assert.throws(() => transcodeRequest(binding('getSimple'), GetSimpleRequestSchema, msg, OPTS), ConnectError)
  })
})

describe('query param flattening (kitchen sink)', () => {
  const msg = create(KitchenSinkRequestSchema, {
    str: 's s',
    i32: 7,
    i64: 9007199254740993n,
    u64: 18446744073709551615n,
    flag: true,
    dbl: 1.25,
    data: new Uint8Array([1, 2, 254]),
    color: Color.RED,
    tags: ['a', 'b'],
    bigTags: [1n, 2n],
    inner: { a: 'x', b: 3n, values: [0.5, 1] },
    optStr: '',
    optZero: 0,
    createdAt: timestampFromDate(new Date(Date.UTC(2026, 5, 12, 10, 30, 45))),
    ttl: { seconds: 90n, nanos: 0 },
    mask: { paths: ['a.b', 'c'] },
    strValue: 'wrapped',
    i64Value: 5n,
    boolValue: false,
    // protobuf-es v2 types Struct fields as JsonObject directly
    metadata: { k: 'v' },
    choice: { case: 'oneofStr', value: 'picked' }
  })

  it('flattens every supported field type with protojson values', () => {
    const out = transcodeRequest(binding('queryKitchenSink'), KitchenSinkRequestSchema, msg, OPTS)
    assert.equal(out.path, '/v1/query')
    assert.equal(out.body, null)
    const q = new Map<string, string[]>()
    for (const [k, v] of out.query) {
      q.set(k, [...(q.get(k) ?? []), v])
    }
    assert.deepEqual(q.get('str'), ['s s'])
    assert.deepEqual(q.get('i32'), ['7'])
    assert.deepEqual(q.get('i64'), ['9007199254740993'])
    assert.deepEqual(q.get('u64'), ['18446744073709551615'])
    assert.deepEqual(q.get('flag'), ['true'])
    assert.deepEqual(q.get('dbl'), ['1.25'])
    assert.deepEqual(q.get('data'), ['AQL+'])
    assert.deepEqual(q.get('color'), ['COLOR_RED'])
    assert.deepEqual(q.get('tags'), ['a', 'b'])
    assert.deepEqual(q.get('bigTags'), ['1', '2'])
    assert.deepEqual(q.get('inner.a'), ['x'])
    assert.deepEqual(q.get('inner.b'), ['3'])
    assert.deepEqual(q.get('inner.values'), ['0.5', '1'])
    // explicit presence: optional fields set to zero values are sent
    assert.deepEqual(q.get('optStr'), [''])
    assert.deepEqual(q.get('optZero'), ['0'])
    assert.deepEqual(q.get('createdAt'), ['2026-06-12T10:30:45Z'])
    assert.deepEqual(q.get('ttl'), ['90s'])
    assert.deepEqual(q.get('mask'), ['a.b,c'])
    assert.deepEqual(q.get('strValue'), ['wrapped'])
    assert.deepEqual(q.get('i64Value'), ['5'])
    assert.deepEqual(q.get('boolValue'), ['false'])
    assert.deepEqual(q.get('metadata'), ['{"k":"v"}'])
    assert.deepEqual(q.get('oneofStr'), ['picked'])
    assert.equal(q.has('oneofInt'), false)
    assert.equal(q.has('labels'), false)
  })

  it('emits snake_case keys in proto case mode', () => {
    const out = transcodeRequest(binding('queryKitchenSink'), KitchenSinkRequestSchema, msg, {
      queryParamCase: 'proto'
    })
    const keys = new Set(out.query.map(([k]) => k))
    assert.ok(keys.has('big_tags'))
    assert.ok(keys.has('opt_str'))
    assert.ok(keys.has('created_at'))
    assert.ok(keys.has('inner.a'))
    assert.ok(!keys.has('bigTags'))
  })

  it('rejects map fields in query strings', () => {
    const withMap = create(KitchenSinkRequestSchema, { labels: { k: 'v' } })
    assert.throws(
      () => transcodeRequest(binding('queryKitchenSink'), KitchenSinkRequestSchema, withMap, OPTS),
      ConnectError
    )
  })
})

describe('encodeQueryString', () => {
  it('uses URLSearchParams semantics', () => {
    assert.equal(
      encodeQueryString([
        ['a', 'x y'],
        ['a', '2'],
        ['n.b', '中']
      ]),
      'a=x+y&a=2&n.b=%E4%B8%AD'
    )
    assert.equal(encodeQueryString([]), '')
  })
})
