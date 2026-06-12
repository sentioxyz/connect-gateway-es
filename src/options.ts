import type { DescMethod, JsonReadOptions, JsonWriteOptions, Registry } from '@bufbuild/protobuf'
import type { Interceptor } from '@connectrpc/connect'
import type { HttpRule } from './gen/google/api/http_pb.js'
import type { HttpBodyRequestMode } from './http-body.js'
import type { QueryParamCase } from './query-params.js'
import type { GatewayBinding } from './route.js'

export interface GatewayTransportOptions {
  /**
   * Base URL prepended to every rendered path. '' produces relative URLs
   * (e.g. behind Next.js rewrites); absolute origins work for cross-origin
   * or server-side calls. A trailing slash is stripped.
   */
  baseUrl: string
  /** Defaults to globalThis.fetch. Inject for tests or instrumentation. */
  fetch?: typeof globalThis.fetch
  interceptors?: Interceptor[]
  /** Applied when a call passes no timeoutMs of its own. */
  defaultTimeoutMs?: number
  /**
   * Registry for google.protobuf.Any payloads: error details and Any-bearing
   * messages.
   */
  registry?: Registry
  /**
   * Extra protojson options for request serialization and response parsing.
   * The transport defaults to ignoreUnknownFields: true so old clients
   * tolerate new server fields.
   */
  jsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>
  /**
   * Naming of query parameter keys: 'json' (lowerCamelCase, default) or
   * 'proto' (snake_case). grpc-gateway accepts both.
   */
  queryParamCase?: QueryParamCase
  /**
   * Routes methods that have no google.api.http annotation. Pair with
   * unboundMethodsFallback for gateways registered with
   * generate_unbound_methods. Default: such calls reject with Unimplemented.
   */
  fallbackRule?: (method: DescMethod) => HttpRule | undefined
  /**
   * Picks among additional_bindings (return an index into bindings).
   * Default: the top-level rule. Per-call override: gatewayBindingKey.
   */
  selectBinding?: (method: DescMethod, bindings: readonly GatewayBinding[], message: unknown) => number
  /**
   * How to send requests whose input is google.api.HttpBody: 'raw' (default;
   * data as body, content_type as Content-Type — HTTPBodyMarshaler gateways)
   * or 'json' (protojson of the HttpBody message).
   */
  httpBodyRequest?: HttpBodyRequestMode
  /** Default headers merged under per-call headers. */
  headers?: HeadersInit
  /**
   * Default fetch options (credentials, cache, ...). Per-call override:
   * gatewayRequestInitKey. method/headers/body/signal are transport-owned.
   */
  requestInit?: RequestInit
}

export interface NormalizedGatewayOptions {
  baseUrl: string
  fetch: typeof globalThis.fetch
  interceptors: Interceptor[]
  defaultTimeoutMs: number | undefined
  registry: Registry | undefined
  jsonRead: Partial<JsonReadOptions>
  jsonWrite: Partial<JsonWriteOptions>
  queryParamCase: QueryParamCase
  fallbackRule: ((method: DescMethod) => HttpRule | undefined) | undefined
  selectBinding: GatewayTransportOptions['selectBinding']
  httpBodyRequest: HttpBodyRequestMode
  headers: HeadersInit | undefined
  requestInit: RequestInit | undefined
}

export function normalizeGatewayOptions(options: GatewayTransportOptions): NormalizedGatewayOptions {
  const jsonRead: Partial<JsonReadOptions> = { ignoreUnknownFields: true, ...options.jsonOptions }
  const jsonWrite: Partial<JsonWriteOptions> = { ...options.jsonOptions }
  if (options.registry !== undefined) {
    jsonRead.registry = options.registry
    jsonWrite.registry = options.registry
  }
  return {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    fetch: options.fetch ?? globalThis.fetch?.bind(globalThis),
    interceptors: options.interceptors ?? [],
    defaultTimeoutMs: options.defaultTimeoutMs,
    registry: options.registry,
    jsonRead,
    jsonWrite,
    queryParamCase: options.queryParamCase ?? 'json',
    fallbackRule: options.fallbackRule,
    selectBinding: options.selectBinding,
    httpBodyRequest: options.httpBodyRequest ?? 'raw',
    headers: options.headers,
    requestInit: options.requestInit
  }
}
