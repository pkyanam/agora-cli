import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { Agora, AgoraError, verifyOutgoingWebhook } from "../sdk/agora"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Agora TypeScript client", () => {
  test("verifies signatures against exact raw bytes and rejects stale or malformed headers", () => {
    const secret = "whsec_test_fixture"
    const timestamp = "1790610000"
    const rawBody = '{"id":"evt_fixture","type":"payment.succeeded"}'
    const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`
    const now = Number(timestamp) + 300
    expect(verifyOutgoingWebhook(secret, timestamp, rawBody, signature, now)).toBe(true)
    expect(verifyOutgoingWebhook(secret, timestamp, `${rawBody} `, signature, now)).toBe(false)
    expect(verifyOutgoingWebhook(secret, timestamp, rawBody, signature, now + 1)).toBe(false)
    expect(verifyOutgoingWebhook(secret, timestamp, rawBody, "v1=not-hex", now)).toBe(false)
  })

  test("requires idempotency before any create request", async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return Response.json({})
    }) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    await expect(api.products.create({ name: "Studio", amount: 4900 }, undefined as never))
      .rejects.toThrow("idempotencyKey is required")
    expect(called).toBe(false)
  })

  test("creates a payment with the stable idempotency key and absolute checkout URL", async () => {
    let request: RequestInit | undefined
    let requestUrl = ""
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      request = init
      return Response.json({
        id: "pay_fixture",
        product_id: "prod_fixture",
        product_name: "Studio",
        customer: "Alex",
        amount: 4900,
        refunded: 0,
        currency: "usd",
        status: "pending",
        provider: "stripe",
        provider_mode: "test",
        checkout_url: "/checkout/start#opaque",
        provider_checkout_url: "https://checkout.stripe.com/c/pay_provider_only",
        created_at: "2026-09-28T00:00:00Z",
      }, { status: 201 })
    }) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    const payment = await api.payments.create(
      { product_id: "prod_fixture", customer: "Alex" },
      { idempotencyKey: "order-fixture-1" },
    )

    expect(requestUrl).toBe("https://agora.example/api/v1/payments")
    expect((request?.headers as Record<string, string>)["Idempotency-Key"]).toBe("order-fixture-1")
    expect(payment.provider_mode).toBe("test")
    expect(payment.checkout_url).toBe("https://agora.example/checkout/start#opaque")
    expect("provider_checkout_url" in payment).toBe(false)
  })

  test("payment get and list preserve Agora checkout URLs and omit processor URLs", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input)
      const row = {
        id: "pay_fixture",
        checkout_url: "https://agora.example/checkout/start#long-opaque-fragment",
        provider_checkout_url: "https://checkout.stripe.com/c/pay_provider_only",
      }
      return Response.json(url.endsWith("?cursor=0") ? { data: [row], next_cursor: null } : row)
    }) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    const payment = await api.payments.get("pay_fixture")
    const page = await api.payments.list()
    expect(payment.checkout_url).toBe("https://agora.example/checkout/start#long-opaque-fragment")
    expect("provider_checkout_url" in payment).toBe(false)
    expect(page.data[0].checkout_url).toBe("https://agora.example/checkout/start#long-opaque-fragment")
    expect("provider_checkout_url" in page.data[0]).toBe(false)
  })

  test("sales workflow SDK covers versioned products, customers, quotes, orders, and fulfillment safely", async () => {
    const requests: Array<{ url: string; method: string; key?: string; body?: unknown }> = []
    globalThis.fetch = (async (input, init) => {
      const headers = init?.headers as Record<string, string> | undefined
      requests.push({
        url: String(input), method: init?.method || "GET", key: headers?.["Idempotency-Key"],
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (String(input).endsWith("/quotes/quote_fixture/accept")) {
        return Response.json({
          quote_id: "quote_fixture", order_id: "order_fixture",
          payment: { id: "pay_fixture", status: "pending", checkout_url: "/checkout/start#complete-capability-fragment", provider_checkout_url: "https://processor.example/private" },
        })
      }
      if (String(input).endsWith("/api/v1/quotes")) {
        return Response.json({ id: "quote_fixture", quote_url: "/quote#full-public-capability", quote_token: "must-not-leak" })
      }
      if (String(input).endsWith("/api/v1/orders/order%2F1/receipt")) {
        return Response.json({ order_id: "order_fixture", merchant: "Fixture", status: "paid", fulfillment_status: "ready", currency: "usd", total_amount: 4900, paid_at: "2026-09-28T00:00:00.000Z", items: [] })
      }
      return Response.json({ id: "fixture", data: [], next_cursor: null, mode: "sandbox", provider_mode: "sandbox", provider_status: "ready", checkout_enabled: true, scopes: ["quotes:write"], limits: { max_amount: 50000, refund_budget: 10000, spent: 0 } })
    }) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    const customer = await api.customers.create({ name: "Ada", email: "ada@example.test" }, { idempotencyKey: "customer-1" })
    const product = await api.products.update("prod/1", { name: "Edited", expected_version: 3 }, { idempotencyKey: "edit-1" })
    const quote = await api.quotes.create({
      customer: { name: "Ada" }, items: [{ product_id: "prod_1", quantity: 2 }], expires_at: "2026-10-01T00:00:00.000Z",
    }, { idempotencyKey: "quote-1" })
    const accepted = await api.quotes.accept("quote_fixture", { idempotencyKey: "accept-1" })
    const customers = await api.customers.list(4, 20)
    const orders = await api.orders.get("order/1")
    const receipt = await api.orders.receipt("order/1")
    const fulfillment = await api.fulfillments.claim("ful_1", { idempotencyKey: "claim-1" })
    await api.fulfillments.complete("ful_1", { note: "Delivered" }, { idempotencyKey: "complete-1" })
    const account = await api.account.status()

    expect(customer.id).toBe("fixture")
    expect(product.id).toBe("fixture")
    expect(quote.id).toBe("quote_fixture")
    expect(quote.quote_url).toBe("https://agora.example/quote#full-public-capability")
    expect("quote_token" in quote).toBe(false)
    expect(accepted.quote_id).toBe("quote_fixture")
    expect(accepted.payment.checkout_url).toBe("https://agora.example/checkout/start#complete-capability-fragment")
    expect("provider_checkout_url" in accepted.payment).toBe(false)
    expect(customers.data).toEqual([])
    expect(orders.id).toBe("fixture")
    expect(receipt.order_id).toBe("order_fixture")
    expect(receipt.status).toBe("paid")
    expect(fulfillment.id).toBe("fixture")
    expect(account.provider_mode).toBe("sandbox")
    expect(requests.map((request) => [request.method, request.url, request.key])).toEqual([
      ["POST", "https://agora.example/api/v1/customers", "customer-1"],
      ["PATCH", "https://agora.example/api/v1/products/prod%2F1", "edit-1"],
      ["POST", "https://agora.example/api/v1/quotes", "quote-1"],
      ["POST", "https://agora.example/api/v1/quotes/quote_fixture/accept", "accept-1"],
      ["GET", "https://agora.example/api/v1/customers?cursor=4&limit=20", undefined],
      ["GET", "https://agora.example/api/v1/orders/order%2F1", undefined],
      ["GET", "https://agora.example/api/v1/orders/order%2F1/receipt", undefined],
      ["POST", "https://agora.example/api/v1/fulfillments/ful_1/claim", "claim-1"],
      ["POST", "https://agora.example/api/v1/fulfillments/ful_1/complete", "complete-1"],
      ["GET", "https://agora.example/api/v1/account", undefined],
    ])
    expect(requests[2].body).toEqual({ customer: { name: "Ada" }, items: [{ product_id: "prod_1", quantity: 2 }], expires_at: "2026-10-01T00:00:00.000Z" })
    expect(requests[1].body).toEqual({ name: "Edited", expected_version: 3 })
    expect(requests[8].body).toEqual({ note: "Delivered" })
  })

  test("reconciles through the documented endpoint without pretending it needs a write key", async () => {
    let requestUrl = ""
    let request: RequestInit | undefined
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input)
      request = init
      return Response.json({ id: "pay/a", status: "succeeded", reconciled: true })
    }) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    const result = await api.payments.reconcile("pay/a")

    expect(requestUrl).toBe("https://agora.example/api/v1/payments/pay%2Fa/reconcile")
    expect(request?.method).toBe("POST")
    expect((request?.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined()
    expect(result).toEqual({ id: "pay/a", status: "succeeded", reconciled: true })
  })

  test("preserves API request ids and marks an unconfirmed provider write as unknown", async () => {
    globalThis.fetch = (async () => Response.json({
      error: {
        code: "provider_outcome_unknown",
        message: "Stripe timed out.",
        request_id: "req_fixture",
      },
    }, { status: 503 })) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    try {
      await api.refunds.create(
        { payment_id: "pay_fixture", amount: 100, reason: "QA fixture" },
        { idempotencyKey: "refund-fixture-1" },
      )
      throw new Error("expected refund request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(AgoraError)
      const apiError = error as AgoraError
      expect(apiError.code).toBe("provider_outcome_unknown")
      expect(apiError.status).toBe(503)
      expect(apiError.requestId).toBe("req_fixture")
      expect(apiError.outcomeUnknown).toBe(true)
      expect(apiError.message).toContain("same idempotency key")
    }
  })

  test("keeps a pending Stripe refund pending until the server reports a terminal state", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "ref_fixture",
      payment_id: "pay_fixture",
      amount: 100,
      reason: "QA fixture",
      status: "pending",
      provider: "stripe",
      provider_mode: "test",
    }, { status: 201 })) as typeof fetch

    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    const refund = await api.refunds.create(
      { payment_id: "pay_fixture", amount: 100, reason: "QA fixture" },
      { idempotencyKey: "refund-fixture-pending" },
    )
    expect(refund.status).toBe("pending")
    expect(refund.provider_mode).toBe("test")
  })

  test("treats malformed non-2xx write responses as unknown without leaking the API key", async () => {
    globalThis.fetch = (async () => new Response("<html>upstream error</html>", {
      status: 502,
      headers: { "content-type": "text/html", "x-request-id": "req_fixture_bad_json" },
    })) as typeof fetch

    const apiKey = "fixture_secret_must_not_appear"
    const api = new Agora({ apiKey, baseUrl: "https://agora.example" })
    try {
      await api.payments.create(
        { product_id: "prod_fixture" },
        { idempotencyKey: "order-fixture-malformed" },
      )
      throw new Error("expected payment request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(AgoraError)
      const apiError = error as AgoraError
      expect(apiError.code).toBe("outcome_unknown")
      expect(apiError.status).toBe(502)
      expect(apiError.requestId).toBe("req_fixture_bad_json")
      expect(apiError.outcomeUnknown).toBe(true)
      expect(apiError.message).not.toContain(apiKey)
      expect(apiError.message).not.toContain("<html>")
    }
  })

  test("marks network failures on POST as unknown and refuses insecure remote URLs", async () => {
    globalThis.fetch = (async () => { throw new Error("socket closed") }) as typeof fetch
    const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
    await expect(api.products.create(
      { name: "Studio", amount: 4900 },
      { idempotencyKey: "product-fixture-1" },
    )).rejects.toMatchObject({ code: "outcome_unknown", status: 0, outcomeUnknown: true })

    expect(() => new Agora({ apiKey: "fixture", baseUrl: "http://agora.example" }))
      .toThrow("Use HTTPS")
    expect(() => new Agora({ apiKey: "fixture", baseUrl: "http://agora.localhost" })).not.toThrow()
  })
})
