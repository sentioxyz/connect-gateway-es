import { create, getOption, hasOption } from '@bufbuild/protobuf'
import type { DescMethod } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { http } from './gen/google/api/annotations_pb.js'
import { HttpRuleSchema } from './gen/google/api/http_pb.js'
import type { HttpRule } from './gen/google/api/http_pb.js'
import { parsePathTemplate } from './path-template.js'
import type { CompiledPathTemplate } from './path-template.js'

export type GatewayVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * One HTTP binding of an RPC: the top-level google.api.http rule or one of its
 * additional_bindings.
 */
export interface GatewayBinding {
  readonly verb: GatewayVerb
  readonly template: CompiledPathTemplate
  /**
   * Request body mapping: '*' sends all non-path fields as the JSON body, a
   * field path sends just that field, undefined sends no body (GET/DELETE).
   */
  readonly body: '*' | readonly string[] | undefined
}

/**
 * The compiled routing plan for an RPC: binding [0] is the top-level rule,
 * followed by additional_bindings in declaration order.
 */
export interface GatewayRoute {
  readonly method: DescMethod
  readonly bindings: readonly GatewayBinding[]
}

/**
 * A fallback used for methods without a google.api.http annotation. Mirrors
 * grpc-gateway's generate_unbound_methods registration:
 * POST /<package>.<Service>/<Method> with body "*".
 */
export function unboundMethodsFallback(method: DescMethod): HttpRule {
  return create(HttpRuleSchema, {
    pattern: { case: 'post', value: `/${method.parent.typeName}/${method.name}` },
    body: '*'
  })
}

function compileBinding(method: DescMethod, rule: HttpRule, top: boolean): GatewayBinding {
  const where = `rpc ${method.parent.typeName}.${method.name}`
  const { case: patternCase, value } = rule.pattern
  if (patternCase === undefined) {
    throw new ConnectError(`${where}: google.api.http rule has no pattern`, Code.Internal)
  }
  if (patternCase === 'custom') {
    throw new ConnectError(`${where}: custom HTTP verbs are not supported`, Code.Unimplemented)
  }
  if (rule.responseBody !== '') {
    throw new ConnectError(`${where}: response_body is not supported`, Code.Unimplemented)
  }
  if (!top && rule.additionalBindings.length > 0) {
    throw new ConnectError(`${where}: additional_bindings may not be nested`, Code.Internal)
  }
  const verb = patternCase.toUpperCase() as GatewayVerb
  const template = parsePathTemplate(value as string)

  let body: GatewayBinding['body']
  if (rule.body === '') {
    body = undefined
  } else if (rule.body === '*') {
    body = '*'
  } else {
    const fieldPath = rule.body.split('.')
    if (fieldPath.length !== 1) {
      throw new ConnectError(`${where}: body must be "*" or a top-level field name, got "${rule.body}"`, Code.Internal)
    }
    const field = method.input.fields.find((f) => f.name === fieldPath[0])
    if (field === undefined) {
      throw new ConnectError(
        `${where}: body field "${rule.body}" does not exist on ${method.input.typeName}`,
        Code.Internal
      )
    }
    body = fieldPath
  }
  if (body !== undefined && (verb === 'GET' || verb === 'DELETE')) {
    throw new ConnectError(`${where}: ${verb} bindings must not declare a body`, Code.Internal)
  }
  return { verb, template, body }
}

function compileRoute(method: DescMethod, rule: HttpRule): GatewayRoute {
  const bindings = [compileBinding(method, rule, true)]
  for (const extra of rule.additionalBindings) {
    bindings.push(compileBinding(method, extra, false))
  }
  return { method, bindings }
}

// Annotation-derived routes are intrinsic to the descriptor, so a module-level
// cache keyed by descriptor identity is safe. null marks "no annotation".
const annotatedRouteCache = new WeakMap<DescMethod, GatewayRoute | null>()

function resolveAnnotatedRoute(method: DescMethod): GatewayRoute | undefined {
  const cached = annotatedRouteCache.get(method)
  if (cached !== undefined) {
    return cached ?? undefined
  }
  let route: GatewayRoute | null = null
  if (hasOption(method, http)) {
    route = compileRoute(method, getOption(method, http))
  }
  annotatedRouteCache.set(method, route)
  return route ?? undefined
}

/**
 * Resolves the gateway routing plan for an RPC from its google.api.http
 * annotation. Works on descriptors generated with options-only imports
 * stripped (the option bytes survive as unknown fields). Returns undefined if
 * the method has no annotation and no fallback produces a rule.
 *
 * Fallback-derived routes are not cached here — callers owning a fallback
 * (e.g. a transport instance) should memoize per instance.
 */
export function resolveGatewayRoute(
  method: DescMethod,
  fallbackRule?: (method: DescMethod) => HttpRule | undefined
): GatewayRoute | undefined {
  const annotated = resolveAnnotatedRoute(method)
  if (annotated !== undefined) {
    return annotated
  }
  const fallback = fallbackRule?.(method)
  return fallback === undefined ? undefined : compileRoute(method, fallback)
}

/**
 * A stable, human-readable key for an RPC's primary binding, e.g.
 * "GET /v1/simple/{id}". Useful for client-side cache keys (SWR etc.).
 */
export function routeKey(method: DescMethod, fallbackRule?: (method: DescMethod) => HttpRule | undefined): string {
  const route = resolveGatewayRoute(method, fallbackRule)
  if (route === undefined) {
    return `${method.parent.typeName}/${method.name}`
  }
  const binding = route.bindings[0]
  return `${binding.verb} ${binding.template.raw}`
}
