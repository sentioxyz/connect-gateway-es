# connect-gateway-es

A [Connect-ES](https://github.com/connectrpc/connect-es) `Transport` that speaks the
[grpc-gateway](https://github.com/grpc-ecosystem/grpc-gateway) REST/JSON dialect.

Point a standard `createClient()` at your existing grpc-gateway endpoints — no server
changes, no extra codegen beyond [protobuf-es](https://github.com/bufbuild/protobuf-es)'s
`protoc-gen-es`. The transport reads the `google.api.http` annotations from the generated
service descriptors at runtime and transcodes each RPC into the exact HTTP request the
gateway expects: path templates, query parameters, request bodies, `google.api.HttpBody`
passthrough, error mapping, and NDJSON server streaming.

```ts
import { createClient } from '@connectrpc/connect'
import { createGatewayTransport } from '@sentio/connect-gateway-es'
import { MyService } from './gen/my_service_pb.js'

const transport = createGatewayTransport({ baseUrl: 'https://api.example.com' })
const client = createClient(MyService, transport)

const resp = await client.getThing({ id: '42' }) // GET https://api.example.com/v1/things/42
```

Migrating off grpc-gateway later? Swap `createGatewayTransport` for
`createConnectTransport` — your generated code and call sites stay identical.

**Status: under construction.** See [CLAUDE.md](CLAUDE.md) for development docs.

## License

[Apache-2.0](LICENSE)
