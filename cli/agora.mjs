#!/usr/bin/env node
// Agora managed CLI (pkyanam/agora-cli)
// No dependencies. No implicit retries. No credentials in command arguments.
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHmac, timingSafeEqual } from "node:crypto"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const help = `Agora payments CLI

Link this CLI to an Agora deployment with: agora auth login --url https://agora.example
The key is entered in a hidden prompt and stored in your private local config.
Environment variables AGORA_URL and AGORA_API_KEY override that saved profile.

  agora auth login --url https://agora.example
  agora auth status
  agora auth logout
  agora server status --dir /absolute/path/to/agora
  agora server update --dir /absolute/path/to/agora
  agora webhooks verify --secret-file /secure/path/secret --body-file request.json \\
    --timestamp 1790610000 --signature 'v1=…' --event-id evt_… \\
    --delivery-id whd_… --event-type payment.succeeded

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

if (args[0] === "webhooks") {
  try {
    if (args.includes("--help")) {
      console.log(help)
      process.exit(0)
    }
    const action = args[1]
    const flags = {}
    for (let i = 2; i < args.length; i += 2) {
      if (!args[i]?.startsWith("--") || !args[i + 1] || (args[i + 1].startsWith("--") && args[i + 1] !== "-")) {
        throw new Error("Flags require values. Use `agora webhooks verify --help`.")
      }
      flags[args[i].slice(2)] = args[i + 1]
    }
    if (action !== "verify") throw new Error("Use `agora webhooks verify` to validate a signed delivery.")
    if (!flags["secret-file"] || !path.isAbsolute(flags["secret-file"])) throw new Error("Provide an absolute --secret-file path. Keep the file owner-only.")
    if (!flags["body-file"] || !flags.timestamp || !flags.signature || !flags["event-id"] || !flags["delivery-id"] || !flags["event-type"]) {
      throw new Error("Provide --body-file, --timestamp, --signature, --event-id, --delivery-id, and --event-type from the Agora request headers.")
    }
    const secretPath = flags["secret-file"]
    const secretInfo = await lstat(secretPath)
    if (secretInfo.isSymbolicLink() || !secretInfo.isFile() || (secretInfo.mode & 0o077) !== 0 || (process.getuid && secretInfo.uid !== process.getuid())) {
      throw new Error("Webhook secret file must be a regular file owned by this user with no group or other permissions (chmod 600).")
    }
    const secret = (await readFile(secretPath, "utf8")).replace(/\r?\n$/, "")
    if (!secret) throw new Error("Webhook secret file is empty.")
    const rawBody = flags["body-file"] === "-" ? await new Promise((resolve, reject) => {
      const chunks = []
      process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      process.stdin.on("error", reject)
    }) : await readFile(flags["body-file"], "utf8")
    const timestamp = flags.timestamp
    const signature = flags.signature
    if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
      throw new Error("Webhook timestamp is invalid or outside the 5-minute verification window.")
    }
    if (!/^v1=[a-f0-9]{64}$/.test(signature)) throw new Error("Agora webhook signature has an invalid format.")
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest()
    const received = Buffer.from(signature.slice(3), "hex")
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("Webhook signature does not match the exact request body.")
    let event
    try { event = JSON.parse(rawBody) } catch { throw new Error("Signature is valid, but the webhook body is not valid JSON.") }
    if (!event || event.id !== flags["event-id"] || event.type !== flags["event-type"]) throw new Error("Signed event ID/type do not match the Agora request headers.")
    console.log(JSON.stringify({
      verified: true,
      timestamp: Number(timestamp),
      event_id: flags["event-id"],
      delivery_id: flags["delivery-id"],
      event_type: flags["event-type"],
      event,
    }, null, 2))
    process.exit(0)
  } catch (error) {
    console.error(JSON.stringify({ error: { code: "webhook_verification_failed", message: error.message } }, null, 2))
    process.exit(1)
  }
}

if (args[0] === "server") {
  try {
    const [action, ...rest] = args.slice(1)
    const options = {}
    for (let i = 0; i < rest.length; i += 2) {
      if (!rest[i]?.startsWith("--") || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error("Flags require values. Use `agora server update --dir <installation-path>`." )
      options[rest[i].slice(2)] = rest[i + 1]
    }
    if (!options.dir || !path.isAbsolute(options.dir)) throw new Error("Provide an absolute --dir path to the Agora installation.")
    if (!new Set(["update", "status"]).has(action)) throw new Error("Supported host-side commands: `agora server status --dir <path>` and `agora server update --dir <path>`. This command runs locally; it never uses the website URL as a local path.")
    const root = await realpath(options.dir)
    const manifestPath = path.join(root, "install.json")
    let manifest
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) }
    catch { throw new Error(`No valid Agora install manifest at ${manifestPath}. Refusing to guess an app directory.`) }
    if (manifest?.format !== 1 || manifest.deployment_target !== "node" || typeof manifest.current_version !== "string") {
      throw new Error("This command supports a local Node Community install with manifest format 1 only.")
    }
    if (action === "status") {
      console.log(JSON.stringify({ install_dir: root, deployment_target: manifest.deployment_target, current_version: manifest.current_version, updated_at: manifest.updated_at ?? null }, null, 2))
      process.exit(0)
    }
    const updater = path.join(root, "update.sh")
    const child = spawn("bash", [updater, "--dir", root], { stdio: "inherit", env: process.env })
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (code) => resolve(code ?? 1))
    })
    process.exit(typeof status === "number" ? status : 1)
  } catch (error) {
    console.error(JSON.stringify({ error: { code: "server_admin_error", message: error.message } }, null, 2))
    process.exitCode = 1
  }
  process.exit(1)
}

const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agora")
const configFile = path.join(configDir, "config.json")

function validateOrigin(value) {
  const url = new URL(value)
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"))
  if (url.protocol !== "https:" && !localHttp) throw new Error("Agora URL must use HTTPS or local HTTP.")
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Agora URL must be an origin without credentials, path, query, or fragment.")
  return url.origin
}

async function loadConfig() {
  try {
    const config = JSON.parse(await readFile(configFile, "utf8"))
    return config && typeof config === "object" ? config : {}
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw new Error(`Could not read ${configFile}; fix or remove the invalid config file.`)
  }
}

function hiddenPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run `agora auth login` in an interactive terminal so the API key can be entered without echo.")
  }
  return new Promise((resolve, reject) => {
    let value = ""
    const stdin = process.stdin
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup()
          reject(new Error("Login cancelled."))
          return
        }
        if (char === "\r" || char === "\n") {
          cleanup()
          process.stdout.write("\n")
          resolve(value.trim())
          return
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else if (char >= " " && char !== "\u007f") value += char
      }
    }
    const cleanup = () => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    process.stdout.write(label)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}

async function saveConfig(config) {
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await chmod(configDir, 0o700)
  const temp = `${configFile}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  await rename(temp, configFile)
  await chmod(configFile, 0o600)
}

const authCmd = args[0] === "auth" ? args[1] : null
if (authCmd) {
  try {
    const flags = {}
    for (let i = 2; i < args.length; i += 2) {
      if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Flags require values. Use `agora auth login --url https://agora.example`.")
      flags[args[i].slice(2)] = args[i + 1]
    }
    const config = await loadConfig()
    if (authCmd === "login") {
      if (!flags.url) throw new Error("Provide --url https://agora.example")
      const url = validateOrigin(flags.url)
      const key = await hiddenPrompt("Paste the Agora API key (input hidden): ")
      if (!/^ag_[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error("That does not look like an Agora API key (expected ag_…). Nothing was saved.")
      await saveConfig({ ...config, url, apiKey: key })
      console.log(JSON.stringify({ ok: true, url, credential_saved: true, config_file: configFile }, null, 2))
    } else if (authCmd === "status") {
      const url = process.env.AGORA_URL || config.url
      const key = process.env.AGORA_API_KEY || config.apiKey
      console.log(JSON.stringify({ url: url || null, credential_configured: Boolean(key), source: process.env.AGORA_API_KEY ? "environment" : key ? "local_config" : "none" }, null, 2))
    } else if (authCmd === "logout") {
      delete config.apiKey
      delete config.url
      if (Object.keys(config).length) await saveConfig(config)
      else await rm(configFile, { force: true })
      console.log(JSON.stringify({ ok: true, credential_removed: true }, null, 2))
    } else throw new Error("Unknown auth command. Use login, status, or logout.")
    process.exit(0)
  } catch (error) {
    console.error(JSON.stringify({ error: { code: "auth_error", message: error.message } }, null, 2))
    process.exit(1)
  }
}

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

  const config = await loadConfig()
  const key = process.env.AGORA_API_KEY || config.apiKey
  const base = process.env.AGORA_URL || config.url
  if (!key || !base) throw new Error("Link this CLI with `agora auth login --url https://agora.example`, or set AGORA_URL and AGORA_API_KEY.")
  const origin = validateOrigin(base)

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
    response = await fetch(`${origin}/api/v1/${path}`, {
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
    if (result && typeof result === "object" && typeof result.checkout_url === "string" && result.checkout_url.startsWith("/")) {
      result.checkout_url = new URL(result.checkout_url, `${origin}/`).toString()
    }
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || "cli_error", message: error.message } }, null, 2))
  process.exitCode = 1
}
