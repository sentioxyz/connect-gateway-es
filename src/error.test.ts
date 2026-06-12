import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRegistry } from '@bufbuild/protobuf'
import { DurationSchema } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError } from '@connectrpc/connect'
import { codeFromHttpStatus, gatewayErrorFromBody, gatewayErrorInfo, readErrorBody } from './error.js'

describe('gatewayErrorFromBody', () => {
  it('maps a google.rpc.Status body to the grpc code verbatim', () => {
    const err = gatewayErrorFromBody({ code: 3, message: 'bad field', details: [] }, 400)
    assert.equal(err.code, Code.InvalidArgument)
    assert.equal(err.rawMessage, 'bad field')
    assert.deepEqual(gatewayErrorInfo(err), {
      httpStatus: 400,
      rawBody: { code: 3, message: 'bad field', details: [] }
    })
  })

  it('prefers the body code over the HTTP status', () => {
    const err = gatewayErrorFromBody({ code: 16, message: 'token expired' }, 503)
    assert.equal(err.code, Code.Unauthenticated)
  })

  it('falls back to HTTP status mapping for non-Status bodies', () => {
    assert.equal(gatewayErrorFromBody('<html>bad gateway</html>', 502).code, Code.Unavailable)
    assert.equal(gatewayErrorFromBody(undefined, 404).code, Code.NotFound)
    assert.equal(gatewayErrorFromBody(undefined, 429).code, Code.ResourceExhausted)
    assert.equal(gatewayErrorFromBody(undefined, 500).code, Code.Internal)
    assert.equal(gatewayErrorFromBody(undefined, 418).code, Code.Unknown)
  })

  it('uses the body text as the message for non-JSON errors', () => {
    const err = gatewayErrorFromBody('upstream connect error', 503)
    assert.equal(err.rawMessage, 'upstream connect error')
  })

  it('decodes Any details when the registry knows the type', () => {
    const detail = { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '3s' }
    const err = gatewayErrorFromBody(
      { code: 9, message: 'precondition', details: [detail] },
      400,
      undefined,
      createRegistry(DurationSchema)
    )
    assert.equal(err.code, Code.FailedPrecondition)
    assert.equal(err.details.length, 1)
    const found = err.findDetails(DurationSchema)
    assert.equal(found.length, 1)
    assert.equal(found[0].seconds, 3n)
  })

  it('keeps unknown detail types in the raw body only', () => {
    const detail = { '@type': 'type.googleapis.com/x.Unknown', foo: 1 }
    const err = gatewayErrorFromBody({ code: 13, message: 'x', details: [detail] }, 500, undefined, createRegistry())
    assert.equal(err.details.length, 0)
    const info = gatewayErrorInfo(err)
    assert.deepEqual((info?.rawBody as { details: unknown[] }).details, [detail])
  })

  it('attaches response headers as error metadata', () => {
    const err = gatewayErrorFromBody({ code: 16, message: 'no' }, 401, new Headers({ 'www-authenticate': 'Bearer' }))
    assert.equal(err.metadata.get('www-authenticate'), 'Bearer')
  })

  it('returns undefined info for foreign errors', () => {
    assert.equal(gatewayErrorInfo(new ConnectError('x', Code.Internal)), undefined)
    assert.equal(gatewayErrorInfo(new Error('x')), undefined)
  })
})

describe('codeFromHttpStatus', () => {
  it('covers the documented table', () => {
    const table: Array<[number, Code]> = [
      [400, Code.InvalidArgument],
      [401, Code.Unauthenticated],
      [403, Code.PermissionDenied],
      [404, Code.NotFound],
      [408, Code.DeadlineExceeded],
      [409, Code.Aborted],
      [412, Code.FailedPrecondition],
      [413, Code.ResourceExhausted],
      [429, Code.ResourceExhausted],
      [499, Code.Canceled],
      [501, Code.Unimplemented],
      [502, Code.Unavailable],
      [503, Code.Unavailable],
      [504, Code.DeadlineExceeded]
    ]
    for (const [status, code] of table) {
      assert.equal(codeFromHttpStatus(status), code, `status ${status}`)
    }
  })
})

describe('readErrorBody', () => {
  it('parses JSON bodies', async () => {
    assert.deepEqual(await readErrorBody(new Response('{"code":5}')), { code: 5 })
  })
  it('returns text for non-JSON bodies', async () => {
    assert.equal(await readErrorBody(new Response('plain')), 'plain')
  })
  it('returns undefined for empty bodies', async () => {
    assert.equal(await readErrorBody(new Response('')), undefined)
  })
})
