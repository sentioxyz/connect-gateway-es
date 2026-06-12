import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConnectError } from '@connectrpc/connect'
import { encodeMultiSegment, encodeSegment, parsePathTemplate, renderPath } from './path-template.js'
import type { PathValue } from './path-template.js'

function render(template: string, values: Record<string, PathValue | undefined>): string {
  return renderPath(parsePathTemplate(template), (fieldPath) => values[fieldPath.join('.')])
}

describe('parsePathTemplate', () => {
  it('parses a simple variable', () => {
    const t = parsePathTemplate('/v1/simple/{id}')
    assert.deepEqual(t.varFieldPaths, [['id']])
    assert.equal(t.verb, undefined)
    assert.deepEqual(t.segments, [
      { kind: 'literal', value: 'v1' },
      { kind: 'literal', value: 'simple' },
      { kind: 'variable', fieldPath: ['id'], pattern: ['*'], allowSlashes: false }
    ])
  })

  it('parses nested field paths', () => {
    const t = parsePathTemplate('/v1/nested/{owner_and_slug.owner_name}/{owner_and_slug.slug}')
    assert.deepEqual(t.varFieldPaths, [
      ['owner_and_slug', 'owner_name'],
      ['owner_and_slug', 'slug']
    ])
  })

  it('parses wildcard patterns', () => {
    const t = parsePathTemplate('/v1/wild/{project}/{chain_id=**}')
    const last = t.segments[t.segments.length - 1]
    assert.deepEqual(last, { kind: 'variable', fieldPath: ['chain_id'], pattern: ['**'], allowSlashes: true })
  })

  it('parses mixed literal patterns', () => {
    const t = parsePathTemplate('/v1/pat/{name=items/*}')
    const last = t.segments[t.segments.length - 1]
    assert.deepEqual(last, { kind: 'variable', fieldPath: ['name'], pattern: ['items', '*'], allowSlashes: true })
  })

  it('parses a trailing verb', () => {
    const t = parsePathTemplate('/v1/things/{id}:cancel')
    assert.equal(t.verb, 'cancel')
    assert.deepEqual(t.varFieldPaths, [['id']])
  })

  it('parses bare wildcards', () => {
    const t = parsePathTemplate('/v1/*/tail/{id}')
    assert.deepEqual(t.segments[1], { kind: 'wildcard', multi: false })
  })

  it('rejects malformed templates', () => {
    const bad = [
      'v1/simple', // no leading slash
      '/v1/{id', // unbalanced brace
      '/v1/id}', // unbalanced brace
      '/v1/{a{b}}', // nested braces
      '/v1//x', // empty segment
      '/v1/x/', // trailing empty segment
      '/v1/{id=**}/more', // ** not last
      '/**/{id}', // bare ** not last
      '/v1/{a.b=x/**/y}', // ** not last inside pattern
      '/v1/{9bad}', // invalid ident
      '/v1/{a..b}', // empty ident in field path
      '/v1/{id}/{id}', // duplicate variable
      '/v1/{id}:', // empty verb
      '/v1/x:verb/y' // colon outside final segment
    ]
    for (const raw of bad) {
      assert.throws(() => parsePathTemplate(raw), ConnectError, `expected parse failure for ${raw}`)
    }
  })
})

describe('renderPath', () => {
  it('substitutes simple variables and keeps literals', () => {
    assert.equal(render('/v1/simple/{id}', { id: 'abc' }), '/v1/simple/abc')
    assert.equal(render('/v1/simple/{id}', { id: 42 }), '/v1/simple/42')
    assert.equal(render('/v1/simple/{id}', { id: 9007199254740993n }), '/v1/simple/9007199254740993')
  })

  it('substitutes nested field paths', () => {
    assert.equal(
      render('/v1/nested/{owner_and_slug.owner_name}/{owner_and_slug.slug}', {
        'owner_and_slug.owner_name': 'me',
        'owner_and_slug.slug': 'proj'
      }),
      '/v1/nested/me/proj'
    )
  })

  it('percent-encodes single-segment values, including slashes', () => {
    assert.equal(render('/v1/simple/{id}', { id: 'a b/c%' }), '/v1/simple/a%20b%2Fc%25')
    assert.equal(render('/v1/simple/{id}', { id: "weird!'()*" }), '/v1/simple/weird%21%27%28%29%2A')
    assert.equal(render('/v1/simple/{id}', { id: '中文' }), '/v1/simple/%E4%B8%AD%E6%96%87')
  })

  it('preserves slashes in multi-segment values', () => {
    assert.equal(
      render('/v1/wild/{project}/{chain_id=**}', { project: 'p', chain_id: 'eth/main net' }),
      '/v1/wild/p/eth/main%20net'
    )
  })

  it('allows empty values only for ** variables', () => {
    assert.equal(render('/v1/wild/{project}/{chain_id=**}', { project: 'p', chain_id: '' }), '/v1/wild/p/')
    assert.throws(() => render('/v1/simple/{id}', { id: '' }), ConnectError)
  })

  it('validates non-trivial patterns', () => {
    assert.equal(render('/v1/pat/{name=items/*}', { name: 'items/abc' }), '/v1/pat/items/abc')
    assert.throws(() => render('/v1/pat/{name=items/*}', { name: 'other/abc' }), ConnectError)
    assert.throws(() => render('/v1/pat/{name=items/*}', { name: 'items/a/b' }), ConnectError)
  })

  it('appends the verb after the final segment', () => {
    assert.equal(render('/v1/things/{id}:cancel', { id: 'x' }), '/v1/things/x:cancel')
  })

  it('throws on missing values and non-scalars', () => {
    assert.throws(() => render('/v1/simple/{id}', {}), ConnectError)
    assert.throws(() => render('/v1/simple/{id}', { id: { nope: true } as unknown as PathValue }), ConnectError)
  })

  it('cannot render bare wildcards', () => {
    assert.throws(() => render('/v1/*/tail/{id}', { id: 'x' }), ConnectError)
  })
})

describe('encoding helpers', () => {
  it('encodeSegment encodes the full reserved set', () => {
    assert.equal(encodeSegment('a-b_c.d~e'), 'a-b_c.d~e')
    assert.equal(encodeSegment('a/b?c#d&e=f'), 'a%2Fb%3Fc%23d%26e%3Df')
  })
  it('encodeMultiSegment keeps slashes only', () => {
    assert.equal(encodeMultiSegment('a/b c/d'), 'a/b%20c/d')
  })
})
