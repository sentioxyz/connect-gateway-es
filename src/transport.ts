import { create } from '@bufbuild/protobuf'
import type { DescMethod, JsonValue, MessageShape } from '@bufbuild/protobuf'
import { Code, ConnectError, createContextValues } from '@connectrpc/connect'
import type { ContextValues, Transport } from '@connectrpc/connect'
import { runStreamingCall, runUnaryCall } from '@connectrpc/connect/protocol'
import { gatewayBindingKey, gatewayRequestInitKey } from './context.js'
import { decodeJsonMessage, gatewayErrorFromBody, readErrorBody } from './error.js'
import { buildRequestHeaders, splitGatewayMetadata } from './headers.js'
import { httpBodyFromResponse, httpBodyRequestParts, isHttpBody } from './http-body.js'
import type { HttpBodyLike } from './http-body.js'
import { normalizeGatewayOptions } from './options.js'
import type { GatewayTransportOptions, NormalizedGatewayOptions } from './options.js'
import { renderPath } from './path-template.js'
import { encodeQueryString } from './query-params.js'
import { resolveGatewayRoute } from './route.js'
import type { GatewayBinding, GatewayRoute } from './route.js'
import { readNdjsonStream } from './stream.js'
import { transcodeRequest } from './transcode.js'

interface BuiltRequest {
  url: string
  init: RequestInit
}

function buildHttpRequest(
  opt: NormalizedGatewayOptions,
  method: DescMethod,
  binding: GatewayBinding,
  message: unknown,
  callHeader: Headers,
  contextValues: ContextValues
): BuiltRequest {
  let path: string
  let queryString = ''
  let body: BodyInit | null = null
  let contentType: string | null = null

  if (isHttpBody(method.input) && binding.body === '*') {
    // Raw passthrough: HttpBody fields are not addressable by templates or
    // query params; templates with variables fail with a clear error.
    path = renderPath(binding.template, () => undefined)
    const parts = httpBodyRequestParts(method.input, message as HttpBodyLike, opt.httpBodyRequest, opt.jsonWrite)
    body = parts.body
    contentType = parts.contentType
  } else {
    const transcoded = transcodeRequest(binding, method.input, message as MessageShape<typeof method.input>, {
      jsonWriteOptions: opt.jsonWrite,
      queryParamCase: opt.queryParamCase
    })
    path = transcoded.path
    queryString = encodeQueryString(transcoded.query)
    if (transcoded.body !== null) {
      body = transcoded.body
      contentType = 'application/json'
    }
  }

  const url = opt.baseUrl + path + (queryString === '' ? '' : `?${queryString}`)
  const headers = buildRequestHeaders(opt.headers, callHeader, contentType)
  const perCallInit = contextValues.get(gatewayRequestInitKey)
  const init: RequestInit = {
    ...opt.requestInit,
    ...perCallInit,
    method: binding.verb,
    headers,
    body
  }
  return { url, init }
}

/**
 * Creates a connect-es Transport that speaks the grpc-gateway REST/JSON
 * dialect. Routing is derived at runtime from each method's google.api.http
 * annotation; requests are transcoded into the path/query/body mapping the
 * gateway expects, and responses (including errors and NDJSON
 * server-streaming) are mapped back into connect semantics.
 *
 * Use it with a standard client:
 *
 *   const transport = createGatewayTransport({ baseUrl: '' })
 *   const client = createClient(MyService, transport)
 */
export function createGatewayTransport(options: GatewayTransportOptions): Transport {
  const opt = normalizeGatewayOptions(options)
  // The module-level cache only holds annotation-derived routes; fallback
  // routes depend on this transport's fallbackRule, so they are cached here.
  const fallbackRouteCache = new WeakMap<DescMethod, GatewayRoute>()

  function resolveRoute(method: DescMethod): GatewayRoute {
    let route = resolveGatewayRoute(method)
    if (route === undefined && opt.fallbackRule !== undefined) {
      route = fallbackRouteCache.get(method)
      if (route === undefined) {
        route = resolveGatewayRoute(method, opt.fallbackRule)
        if (route !== undefined) {
          fallbackRouteCache.set(method, route)
        }
      }
    }
    if (route === undefined) {
      throw new ConnectError(
        `no google.api.http annotation for ${method.parent.typeName}.${method.name} (set fallbackRule to route unannotated methods)`,
        Code.Unimplemented
      )
    }
    return route
  }

  function pickBinding(route: GatewayRoute, contextValues: ContextValues, message: unknown): GatewayBinding {
    const selector = contextValues.get(gatewayBindingKey)
    if (selector !== undefined) {
      if (selector.index !== undefined) {
        const binding = route.bindings[selector.index]
        if (binding === undefined) {
          throw new ConnectError(
            `binding index ${selector.index} out of range (method has ${route.bindings.length} bindings)`,
            Code.Internal
          )
        }
        return binding
      }
      if (selector.verb !== undefined) {
        const verb = selector.verb.toUpperCase()
        const binding = route.bindings.find((b) => b.verb === verb)
        if (binding === undefined) {
          throw new ConnectError(
            `no ${verb} binding on ${route.method.parent.typeName}.${route.method.name}`,
            Code.Internal
          )
        }
        return binding
      }
    }
    if (opt.selectBinding !== undefined) {
      const index = opt.selectBinding(route.method, route.bindings, message)
      const binding = route.bindings[index]
      if (binding === undefined) {
        throw new ConnectError(`selectBinding returned out-of-range index ${index}`, Code.Internal)
      }
      return binding
    }
    return route.bindings[0]
  }

  async function doFetch(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await opt.fetch(url, { ...init, signal })
    } catch (cause) {
      throw ConnectError.from(cause)
    }
  }

  return {
    unary(method, signal, timeoutMs, header, message, contextValues) {
      const route = resolveRoute(method)
      const ctx = contextValues ?? createContextValues()
      // Pre-selection only feeds the interceptor-visible requestMethod/url;
      // the effective binding is re-picked in next() so interceptors can set
      // gatewayBindingKey or swap the message.
      const previewBinding = pickBinding(route, ctx, message)
      return runUnaryCall({
        interceptors: opt.interceptors,
        signal,
        timeoutMs: timeoutMs ?? opt.defaultTimeoutMs,
        req: {
          stream: false,
          service: method.parent,
          method,
          requestMethod: previewBinding.verb,
          // Interceptors see the un-substituted template: the final URL
          // depends on the message after interceptors run.
          url: opt.baseUrl + previewBinding.template.raw,
          header: new Headers(header),
          contextValues: ctx,
          message
        },
        next: async (req) => {
          // req.message is the normalized full message here (runUnaryCall
          // applies create()), so selectBinding sees a real MessageShape.
          const binding = pickBinding(route, req.contextValues, req.message)
          const { url, init } = buildHttpRequest(opt, method, binding, req.message, req.header, req.contextValues)
          const response = await doFetch(url, init, req.signal)
          const { header: resHeader, trailer } = splitGatewayMetadata(response.headers)
          if (!response.ok) {
            throw gatewayErrorFromBody(await readErrorBody(response), response.status, resHeader, opt.registry)
          }
          let outMessage: MessageShape<typeof method.output>
          if (isHttpBody(method.output)) {
            outMessage = await httpBodyFromResponse(method.output, response)
          } else {
            let json: JsonValue
            try {
              json = (await response.json()) as JsonValue
            } catch (cause) {
              throw new ConnectError('failed to parse response JSON', Code.Internal, resHeader, [], cause)
            }
            outMessage = decodeJsonMessage(method.output, json, opt.jsonRead, resHeader)
          }
          return {
            stream: false,
            service: method.parent,
            method,
            header: resHeader,
            trailer,
            message: outMessage
          }
        }
      })
    },

    stream(method, signal, timeoutMs, header, input, contextValues) {
      if (method.methodKind !== 'server_streaming') {
        throw new ConnectError(
          `${method.methodKind} is not supported: grpc-gateway only transcodes unary and server-streaming RPCs`,
          Code.Unimplemented
        )
      }
      if (isHttpBody(method.output)) {
        throw new ConnectError(
          'server-streaming google.api.HttpBody responses are not supported: the gateway emits raw unframed bytes, not NDJSON',
          Code.Unimplemented
        )
      }
      const route = resolveRoute(method)
      const ctx = contextValues ?? createContextValues()
      return runStreamingCall({
        interceptors: opt.interceptors,
        signal,
        timeoutMs: timeoutMs ?? opt.defaultTimeoutMs,
        req: {
          stream: true,
          service: method.parent,
          method,
          requestMethod: route.bindings[0].verb,
          url: opt.baseUrl + route.bindings[0].template.raw,
          header: new Headers(header),
          contextValues: ctx,
          message: input
        },
        next: async (req) => {
          let single: MessageShape<typeof method.input> | undefined
          for await (const message of req.message) {
            if (single !== undefined) {
              throw new ConnectError('a server-streaming RPC takes exactly one request message', Code.Internal)
            }
            single = message
          }
          single ??= create(method.input)
          const binding = pickBinding(route, req.contextValues, single)
          const { url, init } = buildHttpRequest(opt, method, binding, single, req.header, req.contextValues)
          const response = await doFetch(url, init, req.signal)
          const { header: resHeader, trailer } = splitGatewayMetadata(response.headers)
          if (!response.ok) {
            throw gatewayErrorFromBody(await readErrorBody(response), response.status, resHeader, opt.registry)
          }
          if (response.body === null) {
            throw new ConnectError('streaming response has no body', Code.Internal, resHeader)
          }
          return {
            stream: true,
            service: method.parent,
            method,
            header: resHeader,
            trailer,
            message: readNdjsonStream(response.body, method.output, opt.jsonRead, opt.registry, resHeader)
          }
        }
      })
    }
  }
}
