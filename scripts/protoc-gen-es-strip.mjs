#!/usr/bin/env node
// A protoc plugin wrapper that removes google/api option-only imports from the
// FileDescriptorProto dependency lists of the CodeGeneratorRequest, then delegates
// to the stock protoc-gen-es plugin. This emulates codegen setups that strip
// options-only imports (the option bytes remain in the descriptor as unknown
// fields), so tests can prove route resolution works on such descriptors.
import { spawnSync } from 'node:child_process'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { CodeGeneratorRequestSchema } from '@bufbuild/protobuf/wkt'

const STRIP = new Set(['google/api/annotations.proto', 'google/api/http.proto'])

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const request = fromBinary(CodeGeneratorRequestSchema, Buffer.concat(chunks))

for (const file of [...request.protoFile, ...request.sourceFileDescriptors]) {
  file.dependency = file.dependency.filter((dep) => !STRIP.has(dep))
}
// Drop the stripped files themselves from the request so nothing references them.
request.protoFile = request.protoFile.filter((file) => !STRIP.has(file.name))
request.fileToGenerate = request.fileToGenerate.filter((name) => !STRIP.has(name))

const result = spawnSync('protoc-gen-es', [], {
  input: toBinary(CodeGeneratorRequestSchema, request),
  maxBuffer: 64 * 1024 * 1024
})
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '')
  process.exit(result.status ?? 1)
}
process.stdout.write(result.stdout)
