import { createHmac, timingSafeEqual } from "node:crypto"

/** Agora's first-party, dependency-free server-side client. */
export type Provider = "sandbox" | "stripe"
export type ProviderMode = "sandbox" | "test" | "live"

export type Product = {
  id: string
  name: string
  description: string
  amount: number
  currency: "usd"
  created_at: string
  version?: number
  archived_at?: string | null
}

export type Customer = { id: string; name: string; email: string | null; created_at: string; updated_at?: string }
export type QuoteItem = { id?: string; quote_id?: string; product_id: string; product_name: string; catalog_version: number; quantity: number; unit_amount: number; line_total: number }
export type Quote = {
  id: string
  version?: number
  customer_id: string
  customer_name: string
  customer_email: string | null
  items: QuoteItem[]
  subtotal_amount: number
  discount_amount: number
  total_amount: number
  currency: "usd"
  status: "open" | "accepted" | "expired" | "cancelled"
  expires_at: string
  quote_url?: string
  accepted_at: string | null
  order_id: string | null
  created_at: string
}
export type Order = {
  id: string
  quote_id: string | null
  customer_id: string
  customer_name: string
  customer_email: string | null
  status: "awaiting_payment" | "paid" | "cancelled"
  total_amount: number
  currency: "usd"
  payment_id: string | null
  fulfillment_status?: Fulfillment["status"]
  created_at: string
  paid_at: string | null
  items?: OrderItem[]
}
export type OrderItem = { id: string; order_id: string; product_id: string; product_name: string; catalog_version: number; quantity: number; unit_amount: number; line_total: number }
export type OrderReceipt = {
  order_id: string
  merchant: string
  status: "paid"
  fulfillment_status: Fulfillment["status"] | null
  currency: "usd"
  total_amount: number
  paid_at: string
  items: Array<Pick<OrderItem, "product_name" | "quantity" | "unit_amount" | "line_total"> & { discount_amount: number; net_total: number }>
}
export type Fulfillment = {
  id: string
  order_id: string
  payment_id: string
  status: "awaiting_payment" | "ready" | "claimed" | "completed" | "failed"
  claimed_by: string | null
  claimed_at: string | null
  completed_at: string | null
  note: string | null
  created_at: string
  updated_at: string
}
export type AccountStatus = {
  mode: Provider
  provider_mode: ProviderMode
  provider_status: string
  checkout_enabled: boolean
  scopes: string[]
  limits: { max_amount: number; refund_budget: number; spent: number } | null
}
export type AcceptedQuote = {
  quote_id: string
  order_id: string
  payment: CreatedPayment
}

export type Payment = {
  id: string
  product_id: string
  product_name: string
  customer: string
  amount: number
  refunded: number
  currency: "usd"
  status: "pending" | "succeeded" | "failed"
  provider?: Provider
  provider_mode?: "test" | "live" | null
  /** Agora's payer-facing hosted checkout URL. Use this exact value; never build it from the payment ID. */
  checkout_url?: string
  created_at: string
}

export type CreatedPayment = Payment & {
  checkout_url: string
  provider: Provider
  provider_mode?: "test" | "live" | null
}

export type Refund = {
  id: string
  payment_id: string
  amount: number
  reason: string
  status: "pending" | "succeeded" | "failed" | "requires_approval"
  provider?: Provider
  provider_mode?: "test" | "live" | null
  created_at?: string
}

export type PaymentReconciliation = {
  id: string
  status: Payment["status"]
  reconciled: boolean
}

export type Page<T> = { data: T[]; next_cursor: number | null }
export type MutationOptions = { idempotencyKey: string }

/**
 * Verify Agora's outgoing webhook signature over the exact UTF-8 request body.
 * Parse JSON only after this returns true. Timestamps older/newer than 5 minutes
 * are rejected to limit replay; the server may retry the same event later with
 * a fresh timestamp and signature.
 */
export function verifyOutgoingWebhook(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) return false
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return false
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest()
  const received = Buffer.from(signature.slice(3), "hex")
  return expected.length === received.length && timingSafeEqual(expected, received)
}

type ApiErrorBody = {
  error?: { message?: string; code?: string; request_id?: string }
}

export class AgoraError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId?: string
  /** True when the server may have applied a write but the client lacks its result. */
  readonly outcomeUnknown: boolean

  constructor(
    message: string,
    code: string,
    status: number,
    requestId?: string,
    outcomeUnknown = false,
  ) {
    super(message)
    this.name = "AgoraError"
    this.code = code
    this.status = status
    this.requestId = requestId
    this.outcomeUnknown = outcomeUnknown
  }
}

export class Agora {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(options: { apiKey: string; baseUrl: string }) {
    const url = new URL(options.baseUrl)
    const localHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"))
    if (url.protocol !== "https:" && !localHttp) {
      throw new Error("Use HTTPS, except for localhost development.")
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Use a base URL origin without credentials, path, query, or fragment.")
    }
    this.baseUrl = url.origin
    this.apiKey = options.apiKey
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
    options?: MutationOptions,
    idempotencyRequired = method !== "GET",
  ): Promise<T> {
    if (idempotencyRequired && !options?.idempotencyKey) {
      throw new Error("An idempotencyKey is required for writes. Reuse it when retrying the same operation.")
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      const outcomeUnknown = method !== "GET"
      throw new AgoraError(
        outcomeUnknown
          ? idempotencyRequired
            ? "The request outcome is unknown. Check the affected payment or refund, then retry only with the same idempotency key."
            : "The reconciliation outcome is unknown. Check payment state, then safely retry reconciliation if needed."
          : error instanceof Error ? error.message : "Network request failed.",
        outcomeUnknown ? "outcome_unknown" : "request_failed",
        0,
        undefined,
        outcomeUnknown,
      )
    }

    let result: unknown
    try {
      result = await response.json()
    } catch {
      const outcomeUnknown = method !== "GET"
      throw new AgoraError(
        outcomeUnknown
          ? idempotencyRequired
            ? "The server response could not be read, so the request outcome is unknown. Check state before retrying and reuse the same idempotency key."
            : "The reconciliation response could not be read. Check payment state, then safely retry reconciliation if needed."
          : "The server returned an invalid JSON response.",
        outcomeUnknown ? "outcome_unknown" : "invalid_response",
        response.status,
        response.headers.get("x-request-id") ?? undefined,
        outcomeUnknown,
      )
    }

    if (!response.ok) {
      const error = result as ApiErrorBody
      const unknownFromServer = error.error?.code === "provider_outcome_unknown"
      const outcomeUnknown = method !== "GET" && (response.status >= 500 || unknownFromServer)
      throw new AgoraError(
        outcomeUnknown
          ? idempotencyRequired
            ? `${error.error?.message || "The server could not confirm the request."} Check state before retrying and reuse the same idempotency key.`
            : `${error.error?.message || "The server could not confirm reconciliation."} Check payment state; reconciliation is safe to repeat.`
          : error.error?.message || "Request failed.",
        error.error?.code || (outcomeUnknown ? "outcome_unknown" : "request_failed"),
        response.status,
        error.error?.request_id || response.headers.get("x-request-id") || undefined,
        outcomeUnknown,
      )
    }

    return withoutProviderCheckoutUrls(result, this.baseUrl) as T
  }

  products = {
    list: (cursor = 0, limit?: number) => this.request<Page<Product>>("GET", pageQuery("products", cursor, limit)),
    create: (
      data: { name: string; amount: number; description?: string; currency?: "usd" },
      options: MutationOptions,
    ) => this.request<Product>("POST", "products", data, options),
    update: (
      id: string,
      data: { name?: string; description?: string; amount?: number; expected_version: number },
      options: MutationOptions,
    ) => this.request<Product>("PATCH", `products/${encodeURIComponent(id)}`, data, options),
  }

  quotes = {
    list: (cursor = 0, limit?: number) => this.request<Page<Quote>>("GET", pageQuery("quotes", cursor, limit)),
    get: (id: string) => this.request<Quote>("GET", `quotes/${encodeURIComponent(id)}`),
    create: (
      data: { customer: { name: string; email?: string }; items: Array<{ product_id: string; quantity: number }>; discount_amount?: number; expires_at?: string },
      options: MutationOptions,
    ) => this.request<Quote>("POST", "quotes", data, options),
    update: (
      id: string,
      data: { expected_version: number; customer: { name: string; email?: string }; items: Array<{ product_id: string; quantity: number }>; discount_amount?: number; expires_at?: string },
      options: MutationOptions,
    ) => this.request<Quote>("PUT", `quotes/${encodeURIComponent(id)}`, data, options),
    accept: (id: string, options: MutationOptions) => this.request<AcceptedQuote>(
      "POST", `quotes/${encodeURIComponent(id)}/accept`, {}, options,
    ),
  }

  customers = {
    list: (cursor = 0, limit?: number) => this.request<Page<Customer>>("GET", pageQuery("customers", cursor, limit)),
    get: (id: string) => this.request<Customer>("GET", `customers/${encodeURIComponent(id)}`),
    create: (data: { name: string; email?: string }, options: MutationOptions) =>
      this.request<Customer>("POST", "customers", data, options),
  }

  orders = {
    list: (cursor = 0, limit?: number) => this.request<Page<Order>>("GET", pageQuery("orders", cursor, limit)),
    get: (id: string) => this.request<Order>("GET", `orders/${encodeURIComponent(id)}`),
    status: (id: string) => this.request<Order>("GET", `orders/${encodeURIComponent(id)}`),
    receipt: (id: string) => this.request<OrderReceipt>("GET", `orders/${encodeURIComponent(id)}/receipt`),
  }

  fulfillments = {
    list: (cursor = 0, limit?: number, status?: Fulfillment["status"]) =>
      this.request<Page<Fulfillment>>("GET", pageQuery("fulfillments", cursor, limit, status ? { status } : undefined)),
    get: (id: string) => this.request<Fulfillment>("GET", `fulfillments/${encodeURIComponent(id)}`),
    claim: (id: string, options: MutationOptions) => this.request<Fulfillment>(
      "POST", `fulfillments/${encodeURIComponent(id)}/claim`, {}, options,
    ),
    complete: (id: string, data: { note?: string }, options: MutationOptions) => this.request<Fulfillment>(
      "POST", `fulfillments/${encodeURIComponent(id)}/complete`, data, options,
    ),
    fail: (id: string, data: { note?: string }, options: MutationOptions) => this.request<Fulfillment>(
      "POST", `fulfillments/${encodeURIComponent(id)}/fail`, data, options,
    ),
    retry: (id: string, data: { note?: string }, options: MutationOptions) => this.request<Fulfillment>(
      "POST", `fulfillments/${encodeURIComponent(id)}/retry`, data, options,
    ),
  }

  account = {
    status: () => this.request<AccountStatus>("GET", "account"),
  }

  payments = {
    list: (cursor = 0) => this.request<Page<Payment>>("GET", `payments?cursor=${validCursor(cursor)}`),
    get: (id: string) => this.request<Payment>("GET", `payments/${encodeURIComponent(id)}`),
    create: async (
      data: { product_id: string; customer?: string },
      options: MutationOptions,
    ): Promise<CreatedPayment> => {
      const payment = await this.request<CreatedPayment>("POST", "payments", data, options)
      return { ...payment, checkout_url: new URL(payment.checkout_url, this.baseUrl).href }
    },
    reconcile: (id: string) => this.request<PaymentReconciliation>(
      "POST",
      `payments/${encodeURIComponent(id)}/reconcile`,
      undefined,
      undefined,
      false,
    ),
  }

  refunds = {
    create: (
      data: { payment_id: string; amount: number; reason: string },
      options: MutationOptions,
    ) => this.request<Refund>("POST", "refunds", data, options),
  }

  events = {
    list: (cursor = 0, limit?: number) => this.request<Page<{
      id: string
      type: string
      actor: string
      object_id: string
      data: Record<string, unknown>
      created_at: string
    }>>("GET", pageQuery("events", cursor, limit)),
  }
}

/** Strip processor-only checkout links before exposing API responses to callers. */
function withoutProviderCheckoutUrls(value: unknown, baseUrl: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutProviderCheckoutUrls(item, baseUrl))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["provider_checkout_url", "checkout_token", "quote_token"].includes(key))
    .map(([key, item]) => [key, (key === "checkout_url" || key === "quote_url") && typeof item === "string" && item.startsWith("/")
      ? new URL(item, `${baseUrl}/`).href
      : withoutProviderCheckoutUrls(item, baseUrl)]))
}

function validCursor(cursor: number) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer.")
  return cursor
}

function pageQuery(resource: string, cursor: number, limit?: number, filters?: Record<string, string>) {
  const params = new URLSearchParams({ cursor: String(validCursor(cursor)) })
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer.")
    params.set("limit", String(limit))
  }
  for (const [key, value] of Object.entries(filters || {})) params.set(key, value)
  return `${resource}?${params}`
}
