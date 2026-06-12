#!/usr/bin/env bash
# Regenerates all checked-in protobuf-es code:
#   src/gen/google/api   - vendored descriptors the transport needs at runtime
#   tests/gen/clean      - test schemas, stock protoc-gen-es output
#   tests/gen/stripped   - test schemas with google/api imports stripped from the
#                          descriptor dependency list (emulates strip-imports codegen)
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf src/gen/google tests/gen

pnpm exec buf generate --template buf.gen.vendor.yaml
pnpm exec buf generate --template buf.gen.tests-clean.yaml --include-imports
pnpm exec buf generate --template buf.gen.tests-stripped.yaml --include-imports

echo "Generated:"
find src/gen tests/gen -name '*_pb.ts' | sort
