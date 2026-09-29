import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { once } from "node:events"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const cliPath = fileURLToPath(new URL("../cli/agora.mjs", import.meta.url))

test("command-specific help is offline and describes each existing command", () => {
  const cases = [
    [["auth", "login", "--help"], /hidden prompt/],
    [["auth", "status", "--help"], /provider mode, granted scopes,\nand account limits/],
    [["products", "create", "--help"], /positive integer USD cents/],
    [["products", "update", "--help"], /expected-version/],
    [["quotes", "create", "--help"], /cannot exceed 30 days/],
    [["quotes", "accept", "--help"], /canonical Agora checkout_url/],
    [["orders", "status", "--help"], /checkout return page is not proof/],
    [["orders", "receipt", "--help"], /unavailable until Agora confirms payment/],
    [["fulfillments", "claim", "--help"], /server-confirmed paid orders/],
    [["payments", "create", "--help"], /complete checkout_url exactly as returned/],
    [["payments", "reconcile", "--help"], /Safe to repeat/],
    [["refunds", "create", "--help"], /may require merchant approval/],
    [["webhooks", "verify", "--help"], /exact raw body/],
    [["server", "update", "--help"], /Node Community installs/],
  ]
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/path/that/does/not/exist", XDG_CONFIG_HOME: "/no/config" },
    })
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`)
    assert.match(result.stdout, expected)
    assert.equal(result.stderr, "")
  }
})

test("agora --skill prints the exact bundled skill without auth, config, or network", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agora-skill-cli-"))
  const configDir = path.join(temp, ".config")
  await mkdir(path.join(configDir, "agora"), { recursive: true })
  await writeFile(path.join(configDir, "agora", "config.json"), "not valid json")
  try {
    const expected = await readFile(new URL("../skills/agora/SKILL.md", import.meta.url), "utf8")
    const result = spawnSync(process.execPath, [cliPath, "--skill"], {
      encoding: "utf8",
      env: { HOME: temp, XDG_CONFIG_HOME: configDir, PATH: process.env.PATH },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.equal(result.stdout, expected)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("webhook verifier returns rich event and delivery metadata without exposing secret", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agora-webhook-cli-"))
  const secret = "whsec_cli_test_fixture"
  const timestamp = String(Math.floor(Date.now() / 1000))
  const event = { id: "evt_cli_fixture", type: "payment.succeeded", api_version: "2026-09-28", data: { object: { id: "pay_cli_fixture" } } }
  const rawBody = JSON.stringify(event)
  const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`
  const secretPath = path.join(temp, "secret")
  const bodyPath = path.join(temp, "body.json")
  try {
    await writeFile(secretPath, `${secret}\n`, { mode: 0o600 })
    await chmod(secretPath, 0o600)
    await writeFile(bodyPath, rawBody)
    const args = [cliPath, "webhooks", "verify", "--secret-file", secretPath, "--body-file", bodyPath,
      "--timestamp", timestamp, "--signature", signature, "--event-id", event.id,
      "--delivery-id", "whd_cli_fixture", "--event-type", event.type]
    const valid = spawnSync(process.execPath, args, { encoding: "utf8" })
    assert.equal(valid.status, 0, valid.stderr)
    const result = JSON.parse(valid.stdout)
    assert.equal(result.verified, true)
    assert.equal(result.event_id, event.id)
    assert.equal(result.delivery_id, "whd_cli_fixture")
    assert.equal(result.event.data.object.id, "pay_cli_fixture")
    assert.ok(!valid.stdout.includes(secret))

    await writeFile(bodyPath, `${rawBody} `)
    const tampered = spawnSync(process.execPath, args, { encoding: "utf8" })
    assert.notEqual(tampered.status, 0)
    assert.match(tampered.stderr, /exact request body/)
    assert.ok(!tampered.stderr.includes(secret))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

async function withServer(handler, run) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
  }
}

function runCli(args, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, AGORA_URL: baseUrl, AGORA_API_KEY: "ag_test_fixture_only" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

test("payments reconcile calls the documented POST endpoint without a mutation key", async () => {
  let request
  const result = await withServer((req, res) => {
    request = { method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers["idempotency-key"] }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "pay_fixture", status: "pending", reconciled: false }))
  }, (baseUrl) => runCli(["payments", "reconcile", "--id", "pay_fixture"], baseUrl))

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(request, {
    method: "POST",
    url: "/api/v1/payments/pay_fixture/reconcile",
    auth: "Bearer ag_test_fixture_only",
    key: undefined,
  })
  assert.deepEqual(JSON.parse(result.stdout), { id: "pay_fixture", status: "pending", reconciled: false })
})

test("sales workflow commands use the contracted routes, scopes-by-server, and stable idempotency keys", async () => {
  const seen = []
  const outputs = []
  const result = await withServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined })
    res.writeHead(200, { "content-type": "application/json" })
    const response = req.url === "/api/v1/quotes"
      ? { id: "quote_fixture", quote_url: "/quote#opaque-quote-capability", quote_token: "must-not-leak" }
      : req.url === "/api/v1/quotes/quote_fixture/accept"
        ? { quote_id: "quote_fixture", order_id: "order_fixture", payment: { id: "pay_fixture", checkout_url: "/checkout/start#opaque-fragment", checkout_token: "must-not-leak" } }
        : { ok: true, checkout_url: "https://agora.example/checkout/start#opaque-fragment" }
    res.end(JSON.stringify(response))
  }, async (baseUrl) => {
    const commands = [
      ["customers", "create", "--name", "Ada", "--email", "ada@example.test", "--idempotency-key", "customer-1"],
      ["quotes", "create", "--customer", "Ada", "--email", "ada@example.test", "--item", "prod_one:2", "--item", "prod_two:1", "--discount", "100", "--expires-at", "2026-10-01T12:00:00.000Z", "--idempotency-key", "quote-1"],
      ["quotes", "accept", "--id", "quote_fixture", "--idempotency-key", "accept-1"],
      ["products", "update", "--id", "prod_fixture", "--expected-version", "2", "--name", "New", "--idempotency-key", "product-edit-1"],
      ["fulfillments", "claim", "--id", "ful_1", "--idempotency-key", "claim-1"],
      ["fulfillments", "complete", "--id", "ful_1", "--note", "Delivered", "--idempotency-key", "complete-1"],
      ["fulfillments", "fail", "--id", "ful_1", "--note", "Carrier issue", "--idempotency-key", "fail-1"],
      ["fulfillments", "retry", "--id", "ful_1", "--note", "Resolved", "--idempotency-key", "retry-1"],
      ["fulfillments", "list", "--status", "ready", "--limit", "10"],
      ["customers", "get", "--id", "cus/a"],
      ["orders", "list", "--cursor", "5", "--limit", "25"],
      ["orders", "status", "--id", "order_fixture"],
      ["orders", "receipt", "--id", "order_fixture"],
      ["fulfillments", "get", "--id", "ful_1"],
    ]
    for (const command of commands) {
      const response = await runCli(command, baseUrl)
      assert.equal(response.status, 0, `${command.join(" ")} failed: ${response.stderr}`)
      outputs.push(JSON.parse(response.stdout))
      assert.ok(outputs.at(-1))
    }
  })
  assert.equal(result, undefined)
  assert.deepEqual(seen.map(({ method, url, key }) => [method, url, key]), [
    ["POST", "/api/v1/customers", "customer-1"],
    ["POST", "/api/v1/quotes", "quote-1"],
    ["POST", "/api/v1/quotes/quote_fixture/accept", "accept-1"],
    ["PATCH", "/api/v1/products/prod_fixture", "product-edit-1"],
    ["POST", "/api/v1/fulfillments/ful_1/claim", "claim-1"],
    ["POST", "/api/v1/fulfillments/ful_1/complete", "complete-1"],
    ["POST", "/api/v1/fulfillments/ful_1/fail", "fail-1"],
    ["POST", "/api/v1/fulfillments/ful_1/retry", "retry-1"],
    ["GET", "/api/v1/fulfillments?cursor=0&limit=10&status=ready", undefined],
    ["GET", "/api/v1/customers/cus%2Fa", undefined],
    ["GET", "/api/v1/orders?cursor=5&limit=25", undefined],
    ["GET", "/api/v1/orders/order_fixture", undefined],
    ["GET", "/api/v1/orders/order_fixture/receipt", undefined],
    ["GET", "/api/v1/fulfillments/ful_1", undefined],
  ])
  assert.deepEqual(seen[1].body, {
    customer: { name: "Ada", email: "ada@example.test" },
    items: [{ product_id: "prod_one", quantity: 2 }, { product_id: "prod_two", quantity: 1 }],
    discount_amount: 100,
    expires_at: "2026-10-01T12:00:00.000Z",
  })
  assert.deepEqual(seen[3].body, { expected_version: 2, name: "New" })
  assert.equal(seen[5].body.note, "Delivered")
  assert.equal(seen[6].body.note, "Carrier issue")
  assert.equal(seen[7].body.note, "Resolved")
  assert.equal(new URL(outputs[1].quote_url).pathname, "/quote")
  assert.equal(new URL(outputs[1].quote_url).hash, "#opaque-quote-capability")
  assert.ok(!("quote_token" in outputs[1]))
  assert.equal(new URL(outputs[2].payment.checkout_url).pathname, "/checkout/start")
  assert.equal(new URL(outputs[2].payment.checkout_url).hash, "#opaque-fragment")
  assert.ok(!("checkout_token" in outputs[2].payment))
})

test("auth status checks remote account mode and limits by default and stays offline with --local", async () => {
  let requests = 0
  const remote = await withServer((req, res) => {
    requests++
    assert.equal(req.url, "/api/v1/account")
    assert.equal(req.headers.authorization, "Bearer ag_test_fixture_only")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ mode: "sandbox", provider_mode: "sandbox", provider_status: "ready", checkout_enabled: true, scopes: ["quotes:read", "quotes:write"], limits: { max_amount: 50000, refund_budget: 10000, spent: 0 } }))
  }, async (baseUrl) => {
    const remoteResult = await runCli(["auth", "status"], baseUrl)
    assert.equal(remoteResult.status, 0, remoteResult.stderr)
    const parsed = JSON.parse(remoteResult.stdout)
    assert.equal(parsed.account.provider_mode, "sandbox")
    assert.deepEqual(parsed.account.scopes, ["quotes:read", "quotes:write"])
    assert.ok(!remoteResult.stdout.includes("ag_test_fixture_only"))
    const localResult = await runCli(["auth", "status", "--local"], baseUrl)
    assert.equal(localResult.status, 0, localResult.stderr)
    assert.equal(JSON.parse(localResult.stdout).account, undefined)
  })
  assert.equal(remote, undefined)
  assert.equal(requests, 1)
})

test("payment create, replay, get, and list preserve Agora checkout URLs and suppress provider URLs", async () => {
  const canonical = "https://agora.example/checkout/start#opaque-capability-that-must-not-be-truncated"
  const provider = "https://checkout.stripe.com/c/pay_provider_only"
  const result = await withServer((req, res) => {
    const body = req.url === "/api/v1/payments"
      ? { id: "pay_fixture", checkout_url: canonical, provider_checkout_url: provider }
      : req.url === "/api/v1/payments?cursor=0"
        ? { data: [{ id: "pay_fixture", checkout_url: "/checkout/start#opaque-capability-that-must-not-be-truncated", provider_checkout_url: provider }], next_cursor: null }
        : { id: "pay_fixture", checkout_url: "/checkout/start#opaque-capability-that-must-not-be-truncated", provider_checkout_url: provider }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }, async (baseUrl) => {
    const create = await runCli(["payments", "create", "--product", "prod_fixture", "--idempotency-key", "stable-order-1"], baseUrl)
    const replay = await runCli(["payments", "create", "--product", "prod_fixture", "--idempotency-key", "stable-order-1"], baseUrl)
    const get = await runCli(["payments", "get", "--id", "pay_fixture"], baseUrl)
    const list = await runCli(["payments", "list"], baseUrl)
    return { create, replay, get, list, baseUrl }
  })

  for (const output of [result.create, result.replay, result.get, result.list]) {
    assert.equal(output.status, 0, output.stderr)
    assert.doesNotMatch(output.stdout, /checkout\.stripe\.com|provider_checkout_url/)
  }
  assert.deepEqual(JSON.parse(result.create.stdout), JSON.parse(result.replay.stdout))
  assert.equal(JSON.parse(result.create.stdout).checkout_url, canonical)
  const relativeCanonical = new URL("/checkout/start#opaque-capability-that-must-not-be-truncated", result.baseUrl).href
  assert.equal(JSON.parse(result.get.stdout).checkout_url, relativeCanonical)
  assert.equal(JSON.parse(result.list.stdout).data[0].checkout_url, relativeCanonical)
  for (const output of [result.create, result.replay, result.get, result.list]) assert.doesNotMatch(output.stdout, /\/checkout\/pay_fixture/)
})

test("a create command requires an idempotency key before making a request", async () => {
  let requestCount = 0
  const result = await withServer((_req, res) => {
    requestCount += 1
    res.writeHead(500).end()
  }, (baseUrl) => runCli(["products", "create", "--name", "Studio", "--amount", "4900"], baseUrl))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Missing --idempotency-key/)
  assert.equal(requestCount, 0)
})

test("a provider 5xx reports unknown outcome and does not retry automatically", async () => {
  let requestCount = 0
  let idempotencyKey
  const result = await withServer((req, res) => {
    requestCount += 1
    idempotencyKey = req.headers["idempotency-key"]
    res.writeHead(503, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { code: "provider_outcome_unknown", message: "Provider timed out." } }))
  }, (baseUrl) => runCli([
    "payments", "create", "--product", "prod_fixture", "--idempotency-key", "stable-order-1",
  ], baseUrl))

  assert.notEqual(result.status, 0)
  assert.equal(requestCount, 1)
  assert.equal(idempotencyKey, "stable-order-1")
  assert.match(result.stderr, /"outcome": "unknown"/)
  assert.match(result.stderr, /reuse the same --idempotency-key/)
  assert.doesNotMatch(result.stderr, /ag_test_fixture_only/)
})

test("a malformed provider error response reports unknown outcome without credential output", async () => {
  const result = await withServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/html" })
    res.end("<html>upstream error</html>")
  }, (baseUrl) => runCli([
    "refunds", "create", "--payment", "pay_fixture", "--amount", "100",
    "--reason", "QA fixture", "--idempotency-key", "refund-fixture-2",
  ], baseUrl))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /"code": "outcome_unknown"/)
  assert.match(result.stderr, /Check payment state before retrying/)
  assert.doesNotMatch(result.stderr, /ag_test_fixture_only|<html>/)
})

test("remote HTTP origins are rejected before a request", async () => {
  const result = await runCli(["products", "list"], "http://example.com")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must use HTTPS or local HTTP/)
})
