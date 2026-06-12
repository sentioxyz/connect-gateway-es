export { createGatewayTransport } from './transport.js'
export type { GatewayTransportOptions } from './options.js'
export { gatewayBindingKey, gatewayRequestInitKey, type GatewayBindingSelector } from './context.js'
export {
  resolveGatewayRoute,
  routeKey,
  unboundMethodsFallback,
  type GatewayBinding,
  type GatewayRoute,
  type GatewayVerb
} from './route.js'
export {
  parsePathTemplate,
  renderPath,
  type CompiledPathTemplate,
  type PathValue,
  type TemplateSegment
} from './path-template.js'
export {
  codeFromHttpStatus,
  gatewayErrorFromBody,
  gatewayErrorInfo,
  readErrorBody,
  type GatewayErrorInfo
} from './error.js'
export { transcodeRequest, type TranscodedRequest, type TranscodeOptions } from './transcode.js'
export { encodeQueryString, flattenQueryParams, type QueryParamCase } from './query-params.js'
export {
  HTTP_BODY_TYPE_NAME,
  httpBodyFromResponse,
  isHttpBody,
  type HttpBodyLike,
  type HttpBodyRequestMode
} from './http-body.js'
export { readNdjsonStream } from './stream.js'
// Vendored google/api schemas, re-exported for fallbackRule authors and
// HttpBody typing. The full set is also available via the ./google/api subpath.
export { http } from './gen/google/api/annotations_pb.js'
export { HttpRuleSchema, type HttpRule } from './gen/google/api/http_pb.js'
export { HttpBodySchema, type HttpBody } from './gen/google/api/httpbody_pb.js'
