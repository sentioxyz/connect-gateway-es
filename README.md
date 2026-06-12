# connect-gateway-es

A [Connect-ES](https://github.com/connectrpc/connect-es) `Transport` that speaks the
[grpc-gateway](https://github.com/grpc-ecosystem/grpc-gateway) REST/JSON dialect.

Point a standard `createClient()` at your existing grpc-gateway endpoints — no server
changes, no extra codegen beyond [protobuf-es](https://github.com/bufbuild/protobuf-es)'s
`protoc-gen-es`. The transport reads each method's `google.api.http` annotation from the
generated service descriptor at runtime and transcodes the RPC into exactly the HTTP
request the gateway expects.

```ts
import { createClient } from '@connectrpc/connect'
import { createGatewayTransport } from '@sentio/connect-gateway-es'
import { MyService } from './gen/my_service_pb.js'

const transport = createGatewayTransport({ baseUrl: 'https://api.example.com' })
const client = createClient(MyService, transport)

const thing = await client.getThing({ id: '42', view: 'FULL' })
// → GET https://api.example.com/v1/things/42?view=FULL
```

Migrating off grpc-gateway later (connect-go, [vanguard](https://github.com/connectrpc/vanguard-go))?
Swap `createGatewayTransport` for `createConnectTransport` — generated code and call
sites stay identical. That symmetry is the point: this library un-sticks browser clients
from unmaintained gateway codegen without forcing a server migration first.

## Features

- **Full HttpRule support**: GET/POST/PUT/PATCH/DELETE, `body: "*"` and named body
  fields, query parameter flattening (nested messages as dotted keys, repeated fields,
  protojson well-known-type encodings, `Struct`/`Value` as JSON text), path templates
  with nested field paths (`{a.b}`), wildcards (`{v=**}`, `{v=items/*}`) and
  `additional_bindings`.
- **First-class connect-es citizenship**: built on the public
  `runUnaryCall`/`runStreamingCall` helpers, so interceptors, per-call headers,
  `AbortSignal`, and `timeoutMs` behave exactly like the official transports.
- **Errors done right**: gateway error bodies (`google.rpc.Status` JSON) map onto
  `ConnectError` with the grpc code verbatim and `details` decoded through your
  registry; the original HTTP status and raw body stay available via
  `gatewayErrorInfo(err)` for legacy error-shape adapters.
- **`google.api.HttpBody` passthrough** in both directions (raw bytes + content type).
- **Server streaming** over the gateway's newline-delimited JSON chunk format,
  including mid-stream error chunks.
- **Stripped descriptors welcome**: option bytes survive as unknown fields when your
  codegen drops options-only imports (Bazel `strip_imports`-style setups); the
  transport reads them with its own vendored `google/api` schemas. Your generated
  `*_pb.ts` files need no `google/api` imports at all.
- **Conformance-tested**: CI runs the test matrix against a real grpc-gateway +
  gRPC echo server (production-style `JSONPb` marshaler configuration) and asserts the
  server decoded exactly the message the client meant — see [conformance/](conformance/).

## Install

```bash
pnpm add @sentio/connect-gateway-es @connectrpc/connect @bufbuild/protobuf
```

`@connectrpc/connect` (^2) and `@bufbuild/protobuf` (^2.12) are peer dependencies — your
app controls the single runtime copy.

## Options

```ts
createGatewayTransport({
  // Required. '' produces relative URLs (e.g. behind Next.js rewrites or any
  // same-origin reverse proxy); absolute origins work too.
  baseUrl: '',

  fetch,                      // inject for tests/instrumentation (default: globalThis.fetch)
  interceptors: [authInterceptor],
  defaultTimeoutMs: 30_000,
  registry,                   // decodes google.protobuf.Any (error details etc.)
  jsonOptions: {},            // extra protojson knobs; ignoreUnknownFields defaults to true
  queryParamCase: 'json',     // 'json' (camelCase, default) | 'proto' (snake_case)
  fallbackRule: unboundMethodsFallback, // route unannotated methods like generate_unbound_methods
  selectBinding,              // static additional_bindings chooser
  httpBodyRequest: 'raw',     // HttpBody request encoding: 'raw' | 'json'
  headers: { 'x-client': 'web' }, // defaults merged under per-call headers
  requestInit: { credentials: 'include' } // default fetch options
})
```

### Per-call overrides

```ts
import { createContextValues } from '@connectrpc/connect'
import { gatewayBindingKey, gatewayRequestInitKey } from '@sentio/connect-gateway-es'

// Pick an additional_bindings variant for this call:
await client.proxy(req, {
  contextValues: createContextValues().set(gatewayBindingKey, { verb: 'PUT' })
})

// Override fetch options for this call (e.g. embed pages):
await client.getDashboard(req, {
  contextValues: createContextValues().set(gatewayRequestInitKey, { credentials: 'include' })
})
```

### Errors

```ts
import { ConnectError } from '@connectrpc/connect'
import { gatewayErrorInfo } from '@sentio/connect-gateway-es'

try {
  await client.getThing({ id: 'nope' })
} catch (err) {
  if (err instanceof ConnectError) {
    err.code                      // grpc code from the response body (5 = NotFound)
    err.rawMessage                // status message
    err.findDetails(SomeSchema)   // decoded google.rpc details (needs `registry`)
    gatewayErrorInfo(err)         // { httpStatus: 404, rawBody: {...} } — wire-level facts
  }
}
```

### Cache keys / introspection

`routeKey(method)` returns a stable human-readable key like `"GET /v1/things/{id}"` —
handy for SWR/React Query cache keys. `resolveGatewayRoute(method)` exposes the full
compiled routing plan.

## Runtime support

Evergreen browsers (2023+) and Node 20+. ESM only; `nodenext`/`bundler` module
resolution recommended.

## Limitations

- **Client/bidi streaming**: not expressible through grpc-gateway from browsers —
  calls reject with `Unimplemented`.
- **Slashes in single-segment path variables**: default-config gateways (legacy
  unescaping mode) decode `%2F` before routing, so such values 404. Use a `{var=**}`
  template, or configure the gateway with `UnescapingModeAllExceptReserved`.
  (Pinned by a conformance test.)
- `response_body` and custom HTTP verbs: unsupported (compile-time error).
- Map-valued fields cannot be query parameters (the gateway rejects them too).
- HTTP trailers are not observable in browsers; `trailer` is always empty.

## Development

```bash
pnpm install
pnpm build              # tsc
pnpm test               # unit + property tests (node:test via tsx)
pnpm test:conformance   # real grpc-gateway echo server (requires go)
pnpm gen                # regenerate src/gen, tests/gen, conformance/gen (buf)
pnpm lint && pnpm format
```

See [CLAUDE.md](CLAUDE.md) for architecture notes and invariants.

## License

[Apache-2.0](LICENSE)
