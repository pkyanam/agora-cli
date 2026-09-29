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
