import { Code, ConnectError } from '@connectrpc/connect'

/**
 * A value that can be substituted into a path template variable.
 */
export type PathValue = string | number | bigint | boolean

export type TemplateSegment =
  | { kind: 'literal'; value: string }
  | { kind: 'wildcard'; multi: boolean }
  | {
      kind: 'variable'
      /** Field path in proto names, e.g. ['owner_and_slug', 'owner_name']. */
      fieldPath: readonly string[]
      /** Pattern segments after '=', each '*', '**' or a literal. Defaults to ['*']. */
      pattern: readonly string[]
      /** The substituted value may span multiple URL path segments (contains '/'). */
      allowSlashes: boolean
    }

/**
 * A parsed google.api.http path template, following the grammar in
 * https://github.com/googleapis/googleapis/blob/master/google/api/http.proto:
 *
 *   Template = "/" Segments [ Verb ]
 *   Segments = Segment { "/" Segment }
 *   Segment  = "*" | "**" | LITERAL | Variable
 *   Variable = "{" FieldPath [ "=" Segments ] "}"
 *   FieldPath = IDENT { "." IDENT }
 *   Verb     = ":" LITERAL
 */
export interface CompiledPathTemplate {
  readonly raw: string
  readonly segments: readonly TemplateSegment[]
  readonly verb: string | undefined
  /** Field paths consumed by this template, in template order. */
  readonly varFieldPaths: readonly (readonly string[])[]
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseError(template: string, message: string): ConnectError {
  return new ConnectError(`invalid path template "${template}": ${message}`, Code.Internal)
}

export function parsePathTemplate(raw: string): CompiledPathTemplate {
  if (!raw.startsWith('/')) {
    throw parseError(raw, 'must start with "/"')
  }
  let body = raw.slice(1)

  // Extract the trailing ":verb" of the final segment (a ':' outside braces).
  let verb: string | undefined
  let depthScan = 0
  for (let i = body.length - 1; i >= 0; i--) {
    const c = body[i]
    if (c === '}') depthScan++
    else if (c === '{') depthScan--
    else if (c === '/' && depthScan === 0) break
    else if (c === ':' && depthScan === 0) {
      verb = body.slice(i + 1)
      body = body.slice(0, i)
      if (verb === '' || !IDENT_RE.test(verb)) {
        throw parseError(raw, `invalid verb ":${verb}"`)
      }
      break
    }
  }

  // Split into raw segments on '/' outside braces.
  const rawSegments: string[] = []
  let cur = ''
  let depth = 0
  for (const c of body) {
    if (c === '{') {
      depth++
      if (depth > 1) throw parseError(raw, 'nested "{" is not allowed')
      cur += c
    } else if (c === '}') {
      depth--
      if (depth < 0) throw parseError(raw, 'unbalanced "}"')
      cur += c
    } else if (c === '/' && depth === 0) {
      rawSegments.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  if (depth !== 0) throw parseError(raw, 'unbalanced "{"')
  rawSegments.push(cur)

  const segments: TemplateSegment[] = []
  for (const [index, seg] of rawSegments.entries()) {
    if (seg === '') {
      throw parseError(raw, 'empty path segment')
    }
    const prev = segments[segments.length - 1]
    if (
      prev &&
      ((prev.kind === 'wildcard' && prev.multi) || (prev.kind === 'variable' && prev.pattern.includes('**')))
    ) {
      throw parseError(raw, '"**" must be the last segment')
    }
    if (seg === '*' || seg === '**') {
      segments.push({ kind: 'wildcard', multi: seg === '**' })
      continue
    }
    if (seg.startsWith('{')) {
      if (!seg.endsWith('}')) {
        throw parseError(raw, `malformed variable segment "${seg}"`)
      }
      const inside = seg.slice(1, -1)
      const eq = inside.indexOf('=')
      const fieldPathStr = eq < 0 ? inside : inside.slice(0, eq)
      const patternStr = eq < 0 ? undefined : inside.slice(eq + 1)
      const fieldPath = fieldPathStr.split('.')
      for (const ident of fieldPath) {
        if (!IDENT_RE.test(ident)) {
          throw parseError(raw, `invalid field path "${fieldPathStr}"`)
        }
      }
      let pattern: string[]
      if (patternStr === undefined) {
        pattern = ['*']
      } else {
        pattern = patternStr.split('/')
        for (const [pi, p] of pattern.entries()) {
          if (p === '') throw parseError(raw, `empty segment in pattern "${patternStr}"`)
          if (p.includes('{') || p.includes('}')) {
            throw parseError(raw, `variables may not nest in pattern "${patternStr}"`)
          }
          if (p === '**' && pi !== pattern.length - 1) {
            throw parseError(raw, `"**" must be the last segment of pattern "${patternStr}"`)
          }
        }
      }
      segments.push({
        kind: 'variable',
        fieldPath,
        pattern,
        allowSlashes: pattern.length > 1 || pattern.includes('**')
      })
      continue
    }
    if (seg.includes('}') || seg.includes(':')) {
      throw parseError(raw, `malformed segment "${seg}" (index ${index})`)
    }
    segments.push({ kind: 'literal', value: seg })
  }

  const varFieldPaths = segments.flatMap((s) => (s.kind === 'variable' ? [s.fieldPath] : []))
  const seen = new Set<string>()
  for (const fp of varFieldPaths) {
    const key = fp.join('.')
    if (seen.has(key)) throw parseError(raw, `duplicate variable "{${key}}"`)
    seen.add(key)
  }

  return { raw, segments, verb, varFieldPaths }
}

/**
 * Percent-encodes a single path segment value. Everything outside the RFC 3986
 * unreserved set is encoded — unlike encodeURIComponent, which leaves !'()* raw.
 */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Percent-encodes a multi-segment path value, preserving '/' separators.
 */
export function encodeMultiSegment(value: string): string {
  return value.split('/').map(encodeSegment).join('/')
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternRegExp(pattern: readonly string[]): RegExp {
  const parts = pattern.map((p) => (p === '**' ? '.*' : p === '*' ? '[^/]+' : escapeRegExp(p)))
  return new RegExp(`^${parts.join('/')}$`)
}

const isTrivial = (pattern: readonly string[]) => pattern.length === 1 && (pattern[0] === '*' || pattern[0] === '**')

/**
 * Renders the template into a percent-encoded URL path. `lookup` resolves a
 * variable's field path to its protojson scalar value (already stringified for
 * int64 etc.); returning undefined means the field is unset.
 */
export function renderPath(
  template: CompiledPathTemplate,
  lookup: (fieldPath: readonly string[]) => PathValue | undefined
): string {
  const parts: string[] = []
  for (const seg of template.segments) {
    switch (seg.kind) {
      case 'literal':
        parts.push(seg.value)
        break
      case 'wildcard':
        throw new ConnectError(
          `cannot render path template "${template.raw}": bare "${seg.multi ? '**' : '*'}" segments have no request field to substitute`,
          Code.Internal
        )
      case 'variable': {
        const name = seg.fieldPath.join('.')
        const value = lookup(seg.fieldPath)
        if (value === undefined || value === null) {
          throw new ConnectError(`missing required path parameter "${name}" for "${template.raw}"`, Code.Internal)
        }
        if (typeof value === 'object') {
          throw new ConnectError(
            `path parameter "${name}" for "${template.raw}" must be a scalar, got ${typeof value}`,
            Code.Internal
          )
        }
        const str = String(value)
        if (str === '' && !seg.allowSlashes) {
          throw new ConnectError(`path parameter "${name}" for "${template.raw}" must not be empty`, Code.Internal)
        }
        if (!isTrivial(seg.pattern) && !patternRegExp(seg.pattern).test(str)) {
          throw new ConnectError(
            `path parameter "${name}" value ${JSON.stringify(str)} does not match pattern "${seg.pattern.join('/')}" in "${template.raw}"`,
            Code.Internal
          )
        }
        parts.push(seg.allowSlashes ? encodeMultiSegment(str) : encodeSegment(str))
        break
      }
    }
  }
  let path = '/' + parts.join('/')
  if (template.verb !== undefined) {
    path += ':' + template.verb
  }
  return path
}
