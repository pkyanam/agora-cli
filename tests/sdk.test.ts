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
