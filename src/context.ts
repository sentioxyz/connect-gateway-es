import { createContextKey } from '@connectrpc/connect'
import type { ContextKey } from '@connectrpc/connect'

/**
 * Per-call selection among a method's additional_bindings, by binding index
 * (0 = top-level rule) or HTTP verb.
 *
 *   client.proxy(req, { contextValues: createContextValues().set(gatewayBindingKey, { verb: 'PUT' }) })
 */
export interface GatewayBindingSelector {
  index?: number
  verb?: string
}

export const gatewayBindingKey: ContextKey<GatewayBindingSelector | undefined> = createContextKey<
  GatewayBindingSelector | undefined
>(undefined)

/**
 * Per-call fetch RequestInit overrides (e.g. credentials: 'include' on embed
 * pages). Merged over the transport-level requestInit; method/headers/body/
 * signal are controlled by the transport and cannot be overridden.
 */
export const gatewayRequestInitKey: ContextKey<RequestInit | undefined> = createContextKey<RequestInit | undefined>(
  undefined
)
