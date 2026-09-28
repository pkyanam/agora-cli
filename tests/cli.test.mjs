import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import test from "node:test"

const cliPath = fileURLToPath(new URL("../cli/agora.mjs", import.meta.url))

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
