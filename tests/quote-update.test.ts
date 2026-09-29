import { afterEach, expect, test } from "bun:test"
import { Agora } from "../sdk/agora"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test("quote edits use the versioned PUT endpoint and require idempotency", async () => {
  let request: { url: string; method?: string; key?: string; body?: unknown } | undefined
  globalThis.fetch = (async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    request = {
      url: String(input), method: init?.method, key: headers?.["Idempotency-Key"],
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    return Response.json({ id: "quo_1", version: 2, quote_url: "/quote#rotated" })
  }) as typeof fetch

  const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
  const updated = await api.quotes.update("quo/1", {
    expected_version: 1,
    customer: { name: "Austin Hedges", email: "friend@example.test" },
    items: [{ product_id: "prod_1", quantity: 2 }],
    discount_amount: 250,
  }, { idempotencyKey: "edit-quote-1" })

  expect(request).toEqual({
    url: "https://agora.example/api/v1/quotes/quo%2F1", method: "PUT", key: "edit-quote-1",
    body: {
      expected_version: 1,
      customer: { name: "Austin Hedges", email: "friend@example.test" },
      items: [{ product_id: "prod_1", quantity: 2 }], discount_amount: 250,
    },
  })
  expect(updated.version).toBe(2)
  expect(updated.quote_url).toBe("https://agora.example/quote#rotated")
})

test("quote edits reject a missing idempotency key before sending", async () => {
  let called = false
  globalThis.fetch = (async () => { called = true; return Response.json({}) }) as typeof fetch
  const api = new Agora({ apiKey: "fixture", baseUrl: "https://agora.example" })
  await expect(api.quotes.update("quo_1", {
    expected_version: 1, customer: { name: "Austin Hedges" }, items: [{ product_id: "prod_1", quantity: 1 }],
  }, undefined as never)).rejects.toThrow("idempotencyKey is required")
  expect(called).toBe(false)
})
