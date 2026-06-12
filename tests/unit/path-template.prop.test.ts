import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fc from 'fast-check'
import { parsePathTemplate, renderPath } from '../../src/path-template.js'

// Any rendered path must decode back to the original values: single-segment
// variables occupy exactly one segment, double-wildcard variables absorb the
// rest. This pins the encoding rules (slash handling in particular).
describe('path template round-trip properties', () => {
  const template = parsePathTemplate('/v1/{a}/mid/{b=**}')

  it('decodes back to the original values', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (a, b) => {
        const path = renderPath(template, (fp) => (fp[0] === 'a' ? a : b))
        assert.ok(path.startsWith('/v1/'))
        const withoutPrefix = path.slice('/v1/'.length)
        const segments = withoutPrefix.split('/')
        const decodedA = decodeURIComponent(segments[0])
        assert.equal(decodedA, a)
        assert.equal(segments[1], 'mid')
        const decodedB = segments.slice(2).map(decodeURIComponent).join('/')
        assert.equal(decodedB, b)
      }),
      { numRuns: 1000 }
    )
  })

  it('single-segment variables never produce raw reserved characters', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (a) => {
        const path = renderPath(parsePathTemplate('/x/{a}'), () => a)
        const segment = path.slice('/x/'.length)
        assert.ok(!/[/?#&=+ ]/.test(segment), `raw reserved char in ${segment}`)
      }),
      { numRuns: 1000 }
    )
  })
})
