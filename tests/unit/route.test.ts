import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConnectError } from '@connectrpc/connect'
import { resolveGatewayRoute, routeKey, unboundMethodsFallback } from '../../src/route.js'
import { EchoService as CleanEchoService } from '../gen/clean/connectgateway/testing/echo_pb.js'
import { EchoService as StrippedEchoService } from '../gen/stripped/connectgateway/testing/echo_pb.js'

// Route resolution must behave identically whether the descriptor kept its
// google/api imports (clean) or had them stripped at codegen time with the
// option bytes left behind as unknown fields (stripped).
for (const [flavor, EchoService] of [
  ['clean', CleanEchoService],
  ['stripped', StrippedEchoService]
] as const) {
  describe(`resolveGatewayRoute (${flavor} descriptors)`, () => {
    it('resolves a simple GET binding', () => {
      const route = resolveGatewayRoute(EchoService.method.getSimple)
      assert.ok(route)
      assert.equal(route.bindings.length, 1)
      assert.equal(route.bindings[0].verb, 'GET')
      assert.equal(route.bindings[0].template.raw, '/v1/simple/{id}')
      assert.equal(route.bindings[0].body, undefined)
    })

    it('resolves nested-field and wildcard templates', () => {
      const nested = resolveGatewayRoute(EchoService.method.getNested)
      assert.deepEqual(nested?.bindings[0].template.varFieldPaths, [
        ['owner_and_slug', 'owner_name'],
        ['owner_and_slug', 'slug']
      ])
      const wild = resolveGatewayRoute(EchoService.method.getWildcard)
      assert.equal(wild?.bindings[0].template.raw, '/v1/wild/{project}/{chain_id=**}')
    })

    it('resolves bodies for POST/PUT/PATCH and none for DELETE', () => {
      assert.equal(resolveGatewayRoute(EchoService.method.postBody)?.bindings[0].body, '*')
      assert.equal(resolveGatewayRoute(EchoService.method.putBody)?.bindings[0].body, '*')
      assert.equal(resolveGatewayRoute(EchoService.method.patchBody)?.bindings[0].body, '*')
      assert.equal(resolveGatewayRoute(EchoService.method.deleteSimple)?.bindings[0].body, undefined)
      assert.equal(resolveGatewayRoute(EchoService.method.deleteSimple)?.bindings[0].verb, 'DELETE')
    })

    it('resolves a named body field as a field path', () => {
      const route = resolveGatewayRoute(EchoService.method.postNamedBody)
      assert.deepEqual(route?.bindings[0].body, ['payload'])
    })

    it('resolves additional_bindings in declaration order', () => {
      const route = resolveGatewayRoute(EchoService.method.multiBind)
      assert.ok(route)
      assert.deepEqual(
        route.bindings.map((b) => [b.verb, b.body ?? null]),
        [
          ['POST', '*'],
          ['GET', null],
          ['PUT', '*'],
          ['DELETE', null]
        ]
      )
      assert.equal(new Set(route.bindings.map((b) => b.template.raw)).size, 1)
    })

    it('returns undefined for unannotated methods', () => {
      assert.equal(resolveGatewayRoute(EchoService.method.noAnnotation), undefined)
    })

    it('applies the unbound-methods fallback for unannotated methods', () => {
      const route = resolveGatewayRoute(EchoService.method.noAnnotation, unboundMethodsFallback)
      assert.ok(route)
      assert.equal(route.bindings[0].verb, 'POST')
      assert.equal(route.bindings[0].template.raw, '/connectgateway.testing.EchoService/NoAnnotation')
      assert.equal(route.bindings[0].body, '*')
    })

    it('caches annotated routes by descriptor identity', () => {
      assert.equal(resolveGatewayRoute(EchoService.method.getSimple), resolveGatewayRoute(EchoService.method.getSimple))
    })

    it('does not let one caller’s fallback leak into another', () => {
      const withFallback = resolveGatewayRoute(EchoService.method.noAnnotation, unboundMethodsFallback)
      assert.ok(withFallback)
      assert.equal(resolveGatewayRoute(EchoService.method.noAnnotation), undefined)
    })

    it('identifies HttpBody passthrough methods by output type', () => {
      assert.equal(EchoService.method.getRaw.output.typeName, 'google.api.HttpBody')
      assert.equal(EchoService.method.postRaw.input.typeName, 'google.api.HttpBody')
    })

    it('builds stable route keys', () => {
      assert.equal(routeKey(EchoService.method.getSimple), 'GET /v1/simple/{id}')
      assert.equal(routeKey(EchoService.method.multiBind), 'POST /v1/multi/{id}')
      assert.equal(routeKey(EchoService.method.noAnnotation), 'connectgateway.testing.EchoService/NoAnnotation')
    })

    it('rejects fallback rules with unsupported features', () => {
      assert.throws(
        () =>
          resolveGatewayRoute(EchoService.method.noAnnotation, () => ({
            ...unboundMethodsFallback(EchoService.method.noAnnotation),
            responseBody: 'x'
          })),
        ConnectError
      )
    })
  })
}
