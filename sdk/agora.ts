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
  created_at: string
}

export type CreatedPayment = Payment & {
  checkout_url: string
  provider: Provider
  provider_mode?: "test" | "live"
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
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: MutationOptions,
    idempotencyRequired = method === "POST",
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
      const outcomeUnknown = method === "POST"
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
      const outcomeUnknown = method === "POST"
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
      const outcomeUnknown = method === "POST" && (response.status >= 500 || unknownFromServer)
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

    return result as T
  }

  products = {
    list: (cursor = 0) => this.request<Page<Product>>("GET", `products?cursor=${validCursor(cursor)}`),
    create: (
      data: { name: string; amount: number; description?: string; currency?: "usd" },
      options: MutationOptions,
    ) => this.request<Product>("POST", "products", data, options),
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
    list: (cursor = 0) => this.request<Page<{
      id: string
      type: string
      actor: string
      object_id: string
      data: Record<string, unknown>
      created_at: string
    }>>("GET", `events?cursor=${validCursor(cursor)}`),
  }
}

function validCursor(cursor: number) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer.")
  return cursor
}
