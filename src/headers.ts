/**
 * Merges transport-default headers with per-call headers (per-call wins) and
 * applies gateway content negotiation defaults.
 */
export function buildRequestHeaders(
  defaults: HeadersInit | undefined,
  callHeader: Headers,
  contentType: string | null
): Headers {
  const headers = new Headers(defaults)
  callHeader.forEach((value, key) => headers.set(key, value))
  if (contentType !== null && !headers.has('content-type')) {
    headers.set('content-type', contentType)
  }
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json')
  }
  return headers
}

const GRPC_METADATA_PREFIX = 'grpc-metadata-'

/**
 * Demangles grpc-gateway's Grpc-Metadata-* response headers back into plain
 * metadata keys. Browsers cannot read HTTP trailers, so the trailer Headers is
 * always synthesized empty.
 */
export function splitGatewayMetadata(responseHeaders: Headers): { header: Headers; trailer: Headers } {
  const header = new Headers()
  const trailer = new Headers()
  responseHeaders.forEach((value, key) => {
    if (key.startsWith(GRPC_METADATA_PREFIX)) {
      header.append(key.slice(GRPC_METADATA_PREFIX.length), value)
    } else {
      header.append(key, value)
    }
  })
  return { header, trailer }
}
