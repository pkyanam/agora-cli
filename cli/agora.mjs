#!/usr/bin/env node
// Agora managed CLI (pkyanam/agora-cli)
// No dependencies. No implicit retries. No credentials in command arguments.
const args = process.argv.slice(2)
const help = `Agora payments CLI

Set AGORA_URL and AGORA_API_KEY in your environment. Agora never saves your API key.

  agora products list
  agora products create --name "Studio" --amount 4900 --idempotency-key product-1
  agora payments list
  agora payments get --id pay_...
  agora payments reconcile --id pay_...
  agora payments create --product prod_... --customer "Alex" --idempotency-key order-1
  agora refunds create --payment pay_... --amount 4900 --reason "Customer request" --idempotency-key refund-1
  agora events list --cursor 0

All amounts are integer USD cents. The connected merchant and provider mode are selected by the server.
Mutations require a stable --idempotency-key. Reuse it for retries.
A payment reconciliation is safe to repeat and does not require an idempotency key.
A refund can return requires_approval; it has NOT executed in that state. A pending refund still awaits provider confirmation.
Output is JSON; errors go to stderr with a nonzero exit status. Test-mode transactions do not move money.
`

if (!args.length || args.includes("--help")) {
  console.log(help)
  process.exit(0)
}

try {
  const [resource, verb, ...rest] = args
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || !rest[i + 1] || rest[i + 1].startsWith("--")) {
      throw new Error("Flags require values. Use --help.")
    }
    flags[rest[i].slice(2)] = rest[i + 1]
  }
  const need = (name) => {
    if (!flags[name]) throw new Error(`Missing --${name}`)
    return flags[name]
  }
  const amount = () => {
    const value = Number(need("amount"))
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("--amount must be positive integer cents")
    }
    return value
  }

  const key = process.env.AGORA_API_KEY
  const base = process.env.AGORA_URL
  if (!key || !base) throw new Error("Set AGORA_URL and AGORA_API_KEY.")
  const url = new URL(base)
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"))
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("AGORA_URL must use HTTPS or local HTTP.")
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AGORA_URL must be an origin without credentials, path, query, or fragment.")
  }

  let method = "GET"
  let path = resource
  let body
  let requiresIdempotencyKey = false
  if (verb === "list" && ["products", "payments", "events"].includes(resource)) {
    const cursor = Number(flags.cursor || 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid cursor")
    path += `?cursor=${cursor}`
  } else if (verb === "get" && resource === "payments") {
    path += `/${encodeURIComponent(need("id"))}`
  } else if (verb === "reconcile" && resource === "payments") {
    method = "POST"
    path += `/${encodeURIComponent(need("id"))}/reconcile`
  } else if (verb === "create") {
    method = "POST"
    requiresIdempotencyKey = true
    if (resource === "payments") body = { product_id: need("product"), customer: flags.customer }
    else if (resource === "products") body = { name: need("name"), amount: amount(), description: flags.description || "" }
    else if (resource === "refunds") body = { payment_id: need("payment"), amount: amount(), reason: need("reason") }
    else throw new Error("Unknown resource. Use --help.")
  } else {
    throw new Error("Unknown command. Use --help.")
  }

  const headers = { Authorization: `Bearer ${key}` }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    headers["Idempotency-Key"] = need("idempotency-key")
  } else if (requiresIdempotencyKey) {
    headers["Idempotency-Key"] = need("idempotency-key")
  }

  let response
  try {
    response = await fetch(`${url.origin}/api/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    const message = method === "POST"
      ? requiresIdempotencyKey
        ? `The request outcome is unknown. Check payment state with "agora payments get --id ${flags.id || "<payment-id>"}". Retry only with the same --idempotency-key. (${error.message})`
        : `The reconciliation response is unknown. Check payment state with "agora payments get --id ${flags.id}"; reconciliation is safe to repeat. (${error.message})`
      : error.message
    throw Object.assign(new Error(message), { code: method === "POST" ? "outcome_unknown" : "request_failed" })
  }

  let result
  try {
    result = await response.json()
  } catch {
    const message = method === "POST"
      ? requiresIdempotencyKey
        ? "The response was not valid JSON, so the request outcome is unknown. Check payment state before retrying and reuse the same --idempotency-key."
        : `The reconciliation response was not valid JSON. Check payment state with "agora payments get --id ${flags.id}"; reconciliation is safe to repeat.`
      : "The server returned an invalid JSON response."
    throw Object.assign(new Error(message), { code: method === "POST" ? "outcome_unknown" : "invalid_response" })
  }

  if (!response.ok) {
    if (method === "POST" && response.status >= 500 && result && typeof result === "object") {
      result = {
        ...result,
        error: {
          ...result.error,
          code: result.error?.code || "outcome_unknown",
          message: requiresIdempotencyKey
            ? `${result.error?.message || "The server could not confirm the request."} Check state before retrying and reuse the same --idempotency-key.`
            : `${result.error?.message || "The server could not confirm the request."} Check payment state with "agora payments get --id ${flags.id}"; reconciliation is safe to repeat.`,
          outcome: "unknown",
        },
      }
    }
    console.error(JSON.stringify(result, null, 2))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || "cli_error", message: error.message } }, null, 2))
  process.exitCode = 1
}
