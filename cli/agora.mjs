#!/usr/bin/env node
// Agora managed CLI (pkyanam/agora-cli)
// No dependencies. No implicit retries. No credentials in command arguments.
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHmac, timingSafeEqual } from "node:crypto"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const bundledSkill = "---\nname: agora-payments\ndescription: Use Agora's CLI, API, or SDK to create and inspect merchant payments and share the correct hosted checkout link.\n---\n\n# Agora commerce\n\nUse the installed `agora` CLI and its JSON output for Agora catalog, quote, order, payment, and fulfillment operations. Keep API keys, customer secrets, and webhook secrets out of prompts, logs, and replies. Use `agora auth status` before writing to inspect provider mode, granted scopes, readiness, and limits; `agora auth status --local` is configuration-only.\n\n## Quote-to-order workflow\n\n- Read the product catalog and customer record before quoting. Use quote line items with positive integer quantities and pass the customer's name/email only when needed for the transaction.\n- Use `agora quotes create` with one stable idempotency key. Review the returned immutable product/price snapshots and expiry; do not silently change quantity, discount, or expiry after the customer approved the quote.\n- Share the complete `quote_url` returned by Agora exactly as provided, preserving its full fragment. Never build a quote URL from its ID or expose the underlying capability token.\n- If Agora does not return a `quote_url`, report that the customer link is unavailable and stop; do not construct one from the quote ID or guess a replacement.\n- A quote is not a payment. Share Agora's exact `quote_url` so the customer can review and accept it themselves on the hosted quote page.\n- `agora quotes accept` is an authenticated merchant API action that creates an order and payment. Use it only when the merchant explicitly authorized that action; it does not establish that the customer accepted the quote. Check `agora auth status` first; live mode may create a checkout that can charge the customer.\n- API quote acceptance is an idempotent write. If its result is unknown, inspect the quote and order, then retry only with the same idempotency key. Never accept again with a new key to recover a response.\n\n## Checkout links\n\n- For a created payment, use the complete `checkout_url` returned by Agora exactly as provided. Preserve the entire URL, including its fragment. Give that URL to the buyer verbatim.\n- After authorized API quote acceptance, use `payment.checkout_url` from the response and give that complete value to the buyer verbatim.\n- Never construct a checkout path from a `payment.id`, shorten or truncate a checkout URL, or substitute a Stripe/provider URL. Payment IDs identify records; they are not checkout links.\n- If the response has no `checkout_url`, or the returned URL is unavailable or rejected, say so and stop. Do not guess a replacement. A payment get/list response may not include a share link.\n- If a create request's outcome is unknown, inspect the payment state and retry only with the same idempotency key. Do not create another payment to recover the URL.\n\n## Mode and financial effects\n\nCheck the merchant's configured provider mode before accepting a quote or creating a payment. Clearly identify test mode versus live mode. Do not create a live payment unless the user explicitly authorized the order; completing a live checkout can charge a customer. A pending record or checkout session is not proof of payment. Use Agora's reported status and verified provider events as the source of truth.\n\n## Fulfillment\n\n- A payment, return page, or unverified webhook is not proof an order is paid. Read the order/fulfillment state from Agora; only claim work whose server-reported fulfillment state is `ready`.\n- Use `agora fulfillments claim` before doing the work and `agora fulfillments complete` only after it is actually done. These commands record workflow state; they do not run integrations. Do not invent fulfillment actions or mark an order complete to make a customer appear served.\n- Check `agora orders status`, `agora orders get`, and `agora fulfillments get` to report status. Request `agora orders receipt` only after Agora reports the order paid. Keep customer data limited to the transaction and fulfillment task.\n\nUse `agora --help` for available commands. Payment creation requires a unique, stable `--idempotency-key`; reuse that key only when retrying the same order.\n"

const commandHelp = {
  auth: `Agora authentication\n\nUsage:\n  agora auth login --url <origin>\n  agora auth status [--local]\n  agora auth logout\n\nLogin prompts for an API key without echo and stores it in the private local config.\nStatus reports the saved URL and credential state. Use --local to avoid a remote check.\nLogout removes the saved URL/key. AGORA_URL and AGORA_API_KEY override saved values.`,
  "auth login": `Link this CLI to an Agora deployment.\n\nUsage:\n  agora auth login --url https://agora.example\n\nThe URL must be an HTTPS origin (localhost HTTP is allowed for development). Enter\nthe API key at the hidden prompt; do not put it in shell history or command arguments.`,
  "auth status": `Show the configured Agora origin, credential source, provider mode, granted scopes,\nand account limits when a remote status check is available.\n\nUsage:\n  agora auth status [--local]\n\n--local reads configuration only and makes no network request. Never prints the key.`,
  "auth logout": `Remove the saved Agora origin and API key.\n\nUsage:\n  agora auth logout\n\nEnvironment variable overrides are not changed.`,
  products: `Manage the merchant catalog.\n\nUsage:\n  agora products list [--cursor <integer>]\n  agora products create --name <name> --amount <cents> [--description <text>] --idempotency-key <key>\n\nAmounts are positive integer USD cents. Writes require a stable idempotency key.`,
  "products list": `List catalog products.\n\nUsage:\n  agora products list [--cursor <integer>]\n\nReturns JSON with data and next_cursor.`,
  "products create": `Create a catalog product.\n\nUsage:\n  agora products create --name <name> --amount <cents> [--description <text>] --idempotency-key <key>\n\nAmount is positive integer USD cents. The idempotency key identifies this exact create operation.`,
  "products update": `Edit the current catalog version without changing existing quote or payment snapshots.\n\nUsage:\n  agora products update --id <product-id> --expected-version <n> [--name <name>] [--description <text>] [--amount <cents>] --idempotency-key <key>\n\nUse the version from the latest product response. A stale version returns a conflict;\nread the current product and review before submitting a new edit.`,
  customers: `Manage merchant customer records.\n\nUsage:\n  agora customers list [--cursor <n>] [--limit <n>]\n  agora customers get --id <customer-id>\n  agora customers create --name <name> [--email <email>] --idempotency-key <key>`,
  "customers list": `List customers.\n\nUsage:\n  agora customers list [--cursor <n>] [--limit <n>]`,
  "customers get": `Get one customer record.\n\nUsage:\n  agora customers get --id <customer-id>`,
  "customers create": `Create a customer record.\n\nUsage:\n  agora customers create --name <name> [--email <email>] --idempotency-key <key>`,
  quotes: `Create, inspect, and share quotes; an authenticated API acceptance creates an order and payment.\n\nUsage:\n  agora quotes list [--cursor <n>] [--limit <n>]\n  agora quotes get --id <quote-id>\n  agora quotes create --customer <name> [--email <email>] --item <product-id>:<quantity> [--item <product-id>:<quantity>] [--discount <cents>] [--expires-at <ISO-time>] --idempotency-key <key>\n  agora quotes accept --id <quote-id> --idempotency-key <key>  # merchant-authorized API action\n\nCreate returns immutable item and price snapshots plus the customer-facing quote_url. Share that\ncomplete URL for customer review. \`quotes accept\` is a separate merchant-authorized API action;\nit creates one order and payment but does not mean the customer accepted the quote.`,
  "quotes list": `List quotes.\n\nUsage:\n  agora quotes list [--cursor <n>] [--limit <n>]`,
  "quotes get": `Get a quote and its immutable catalog snapshots.\n\nUsage:\n  agora quotes get --id <quote-id>`,
  "quotes create": `Create a quote from catalog items.\n\nUsage:\n  agora quotes create --customer <name> [--email <email>] --item <product-id>:<quantity> [--item <product-id>:<quantity>] [--discount <cents>] [--expires-at <ISO-time>] --idempotency-key <key>\n\nExpiry defaults to seven days and cannot exceed 30 days. Discount and amounts are USD cents.\nReview returned snapshots, then share the complete quote_url exactly as returned.`,
  "quotes accept": `Accept a quote through the authenticated merchant API and create its order/payment.\n\nUsage:\n  agora quotes accept --id <quote-id> --idempotency-key <key>\n\nThe response includes the canonical Agora checkout_url. This creates an order and payment; it is not\nevidence of customer consent. Use only when the merchant explicitly authorized this action. For\ncustomer review/acceptance, share the exact quote_url from \`agora quotes get --id <quote-id>\`.\nA live checkout may charge the customer.`,
  orders: `Inspect orders created from accepted quotes.\n\nUsage:\n  agora orders list [--cursor <n>] [--limit <n>]\n  agora orders get --id <order-id>\n  agora orders status --id <order-id>\n  agora orders receipt --id <order-id>`,
  "orders list": `List orders and their payment/fulfillment status.\n\nUsage:\n  agora orders list [--cursor <n>] [--limit <n>]`,
  "orders get": `Get an order, immutable line items, and linked workflow state.\n\nUsage:\n  agora orders get --id <order-id>`,
  "orders status": `Get an order's payment and fulfillment status.\n\nUsage:\n  agora orders status --id <order-id>\n\nAgora's verified payment state is authoritative; a checkout return page is not proof of payment.`,
  "orders receipt": `Get a paid order's merchant receipt.\n\nUsage:\n  agora orders receipt --id <order-id>\n\nReceipts are unavailable until Agora confirms payment; no checkout capability is needed.`,
  fulfillments: `Inspect and advance fulfillment records for paid orders.\n\nUsage:\n  agora fulfillments list [--cursor <n>] [--limit <n>] [--status <state>]\n  agora fulfillments get --id <fulfillment-id>\n  agora fulfillments claim --id <fulfillment-id> --idempotency-key <key>\n  agora fulfillments complete --id <fulfillment-id> [--note <text>] --idempotency-key <key>\n  agora fulfillments fail --id <fulfillment-id> [--note <text>] --idempotency-key <key>\n  agora fulfillments retry --id <fulfillment-id> [--note <text>] --idempotency-key <key>\n\nOnly a verified payment success makes fulfillment ready. These actions record workflow state;\nthey do not execute arbitrary external integrations.`,
  "fulfillments list": `List fulfillment records.\n\nUsage:\n  agora fulfillments list [--cursor <n>] [--limit <n>] [--status <awaiting_payment|ready|claimed|completed|failed>]`,
  "fulfillments get": `Get fulfillment state and claimant.\n\nUsage:\n  agora fulfillments get --id <fulfillment-id>`,
  "fulfillments claim": `Claim a ready fulfillment for this actor. Only server-confirmed paid orders become ready.\n\nUsage:\n  agora fulfillments claim --id <fulfillment-id> --idempotency-key <key>`,
  "fulfillments complete": `Mark the current actor's claimed fulfillment complete.\n\nUsage:\n  agora fulfillments complete --id <fulfillment-id> [--note <text>] --idempotency-key <key>`,
  "fulfillments fail": `Mark the current actor's claimed fulfillment failed.\n\nUsage:\n  agora fulfillments fail --id <fulfillment-id> [--note <text>] --idempotency-key <key>`,
  "fulfillments retry": `Return a failed fulfillment for a paid order to ready.\n\nUsage:\n  agora fulfillments retry --id <fulfillment-id> [--note <text>] --idempotency-key <key>`,
  payments: `Manage one-time payments.\n\nUsage:\n  agora payments list [--cursor <integer>]\n  agora payments get --id <payment-id>\n  agora payments reconcile --id <payment-id>\n  agora payments create --product <product-id> [--customer <name>] --idempotency-key <key>\n\nShare only Agora's complete checkout_url, preserving fragments. A pending payment is not paid.`,
  "payments list": `List payment records.\n\nUsage:\n  agora payments list [--cursor <integer>]`,
  "payments get": `Get payment state and details.\n\nUsage:\n  agora payments get --id <payment-id>\n\nUse Agora's reported status as the source of truth. Do not infer success from a browser redirect.`,
  "payments reconcile": `Ask Agora to refresh payment state from its provider.\n\nUsage:\n  agora payments reconcile --id <payment-id>\n\nSafe to repeat; no idempotency key is needed.`,
  "payments create": `Create one payment for a catalog product.\n\nUsage:\n  agora payments create --product <product-id> [--customer <name>] --idempotency-key <key>\n\nCheck mode first with agora auth status. Live checkout may charge a customer. Give the buyer\nthe complete checkout_url exactly as returned, including any fragment. Never construct one.\nIf the result is unknown, inspect payment state and retry only with the same key.`,
  refunds: `Request a refund.\n\nUsage:\n  agora refunds create --payment <payment-id> --amount <cents> --reason <text> --idempotency-key <key>\n\nA requires_approval result means the refund has not executed.`,
  "refunds create": `Request a refund for a payment.\n\nUsage:\n  agora refunds create --payment <payment-id> --amount <cents> --reason <text> --idempotency-key <key>\n\nAmount is positive integer USD cents. The result may require merchant approval.`,
  events: `Inspect merchant event history.\n\nUsage:\n  agora events list [--cursor <integer>]`,
  "events list": `List merchant events.\n\nUsage:\n  agora events list [--cursor <integer>]`,
  webhooks: `Webhook utilities.\n\nUsage:\n  agora webhooks verify --secret-file <absolute-path> --body-file <path|-> \\\n    --timestamp <unix-seconds> --signature <v1-hex> --event-id <id> \\\n    --delivery-id <id> --event-type <type>\n\nVerification checks the exact raw request body and a five-minute timestamp window.`,
  "webhooks verify": `Verify an Agora outgoing webhook.\n\nUsage:\n  agora webhooks verify --secret-file <absolute-path> --body-file <path|-> \\\n    --timestamp <unix-seconds> --signature <v1-hex> --event-id <id> \\\n    --delivery-id <id> --event-type <type>\n\nSecret files must be owner-only. Use --body-file - to read the exact raw body from stdin.`,
  server: `Manage a local Agora Community installation.\n\nUsage:\n  agora server status --dir <absolute-install-path>\n  agora server update --dir <absolute-install-path>`,
  "server status": `Show the version and target for a managed local installation.\n\nUsage:\n  agora server status --dir <absolute-install-path>`,
  "server update": `Update a managed local installation.\n\nUsage:\n  agora server update --dir <absolute-install-path>\n\nOnly supported for manifest format 1 Node Community installs.`,
}
if (args.length === 1 && args[0] === "--skill") {
  process.stdout.write(bundledSkill)
  process.exit(0)
}

const help = `Agora payments CLI

Link this CLI to an Agora deployment with: agora auth login --url https://agora.example
The key is entered in a hidden prompt and stored in your private local config.
Environment variables AGORA_URL and AGORA_API_KEY override that saved profile.
Print the bundled agent instructions with: agora --skill

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
  agora products update --id prod_... --expected-version 1 --name "Studio Plus" --idempotency-key edit-1
  agora customers list
  agora customers get --id cus_...
  agora payments list
  agora payments get --id pay_...
  agora payments reconcile --id pay_...
  agora payments create --product prod_... --customer "Alex" --idempotency-key order-1
  agora customers create --name "Alex" --idempotency-key customer-1
  agora quotes create --customer "Alex" --item prod_...:1 --idempotency-key quote-1
  agora quotes accept --id quote_... --idempotency-key quote-accept-1 # merchant-authorized API action
  agora orders list
  agora orders get --id order_...
  agora orders status --id order_...
  agora orders receipt --id order_... # paid orders only
  agora fulfillments list
  agora fulfillments get --id ful_...
  agora fulfillments claim --id ful_... --idempotency-key claim-1
  agora fulfillments complete --id ful_... --idempotency-key complete-1
  agora refunds create --payment pay_... --amount 4900 --reason "Customer request" --idempotency-key refund-1
  agora events list --cursor 0

All amounts are integer USD cents. The connected merchant and provider mode are selected by the server.
For a created payment, use and share the returned Agora checkout_url exactly as returned. Never
construct a checkout URL from a payment id or share a processor URL; the checkout URL may be long.
Mutations require a stable --idempotency-key. Reuse it for retries.
A payment reconciliation is safe to repeat and does not require an idempotency key.
A refund can return requires_approval; it has NOT executed in that state. A pending refund still awaits provider confirmation.
Output is JSON; errors go to stderr with a nonzero exit status. Test-mode transactions do not move money.
`

if (args.includes("--help") || args.includes("-h")) {
  const topic = args.slice(0, args.findIndex((arg) => arg === "--help" || arg === "-h")).join(" ")
  const text = commandHelp[topic] || (topic ? commandHelp[topic.split(" ")[0]] : null)
  if (text) console.log(text)
  else console.log(help)
  process.exit(0)
}

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

function withoutProviderCheckoutUrls(value) {
  if (Array.isArray(value)) return value.map(withoutProviderCheckoutUrls)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["provider_checkout_url", "checkout_token", "quote_token"].includes(key))
    .map(([key, item]) => [key, withoutProviderCheckoutUrls(item)]))
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
    for (let i = 2; i < args.length;) {
      if (args[i] === "--local") { flags.local = true; i++; continue }
      if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Flags require values. Use `agora auth login --url https://agora.example`.")
      flags[args[i].slice(2)] = args[i + 1]
      i += 2
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
      const status = { url: url || null, credential_configured: Boolean(key), source: process.env.AGORA_API_KEY ? "environment" : key ? "local_config" : "none" }
      if (!flags.local && key && url) {
        const origin = validateOrigin(url)
        let response
        try {
          response = await fetch(`${origin}/api/v1/account`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          })
        } catch (error) {
          throw new Error(`Could not reach the Agora account status endpoint. Use --local to inspect local configuration only. (${error.message})`)
        }
        let account
        try { account = await response.json() } catch { throw new Error("Agora returned an invalid account status response.") }
        if (!response.ok) throw new Error(account?.error?.message || `Account status failed with HTTP ${response.status}.`)
        status.account = account
      }
      console.log(JSON.stringify(status, null, 2))
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

if (!args.length) {
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
    const flag = rest[i].slice(2)
    if (flags[flag] === undefined) flags[flag] = rest[i + 1]
    else if (Array.isArray(flags[flag])) flags[flag].push(rest[i + 1])
    else flags[flag] = [flags[flag], rest[i + 1]]
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
  const positiveInteger = (value, label) => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`)
    return parsed
  }
  const pagePath = (name) => {
    const cursor = flags.cursor === undefined ? 0 : Number(flags.cursor)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("--cursor must be a non-negative integer.")
    const params = new URLSearchParams({ cursor: String(cursor) })
    if (flags.limit !== undefined) params.set("limit", String(positiveInteger(flags.limit, "--limit")))
    if (name === "fulfillments" && flags.status !== undefined) {
      if (!["awaiting_payment", "ready", "claimed", "completed", "failed"].includes(flags.status)) throw new Error("--status must be awaiting_payment, ready, claimed, completed, or failed.")
      params.set("status", flags.status)
    }
    return `${name}?${params.toString()}`
  }
  const idempotency = () => { requiresIdempotencyKey = true; return need("idempotency-key") }
  const checkState = () => resource === "payments"
    ? `Check payment state before retrying with \"agora payments get --id ${flags.id || "<payment-id>"}\"`
    : resource === "refunds"
      ? "Check payment state before retrying"
    : `Check ${resource} state before retrying`

  const config = await loadConfig()
  const key = process.env.AGORA_API_KEY || config.apiKey
  const base = process.env.AGORA_URL || config.url
  if (!key || !base) throw new Error("Link this CLI with `agora auth login --url https://agora.example`, or set AGORA_URL and AGORA_API_KEY.")
  const origin = validateOrigin(base)

  let method = "GET"
  let path = resource
  let body
  let requiresIdempotencyKey = false
  if (verb === "list" && ["products", "payments", "events", "customers", "quotes", "orders", "fulfillments"].includes(resource)) {
    path = pagePath(resource)
  } else if (verb === "get" && resource === "payments") {
    path += `/${encodeURIComponent(need("id"))}`
  } else if ((verb === "get" && ["customers", "quotes", "orders", "fulfillments"].includes(resource)) || (verb === "status" && resource === "orders")) {
    path += `/${encodeURIComponent(need("id"))}`
  } else if (resource === "orders" && verb === "receipt") {
    path += `/${encodeURIComponent(need("id"))}/receipt`
  } else if (verb === "reconcile" && resource === "payments") {
    method = "POST"
    path += `/${encodeURIComponent(need("id"))}/reconcile`
  } else if (verb === "create") {
    method = "POST"
    idempotency()
    if (resource === "payments") body = { product_id: need("product"), customer: flags.customer }
    else if (resource === "products") body = { name: need("name"), amount: amount(), description: flags.description || "" }
    else if (resource === "customers") body = { name: need("name"), email: flags.email }
    else if (resource === "refunds") body = { payment_id: need("payment"), amount: amount(), reason: need("reason") }
    else if (resource === "quotes") {
      const customer = { name: need("customer") }
      if (flags.email) customer.email = flags.email
      const itemFlags = flags.item === undefined ? [] : Array.isArray(flags.item) ? flags.item : [flags.item]
      if (!itemFlags.length) throw new Error("Provide at least one --item <product-id>:<quantity>.")
      const items = itemFlags.map((item) => {
        const separator = item.lastIndexOf(":")
        if (separator < 1) throw new Error(`Invalid --item ${item}; expected <product-id>:<quantity>.`)
        return { product_id: item.slice(0, separator), quantity: positiveInteger(item.slice(separator + 1), "Item quantity") }
      })
      body = { customer, items }
      if (flags.discount !== undefined) body.discount_amount = Number(flags.discount)
      if (flags["expires-at"] !== undefined) {
        if (!Number.isFinite(Date.parse(flags["expires-at"]))) throw new Error("--expires-at must be a valid ISO timestamp.")
        body.expires_at = flags["expires-at"]
      }
    }
    else throw new Error("Unknown resource. Use --help.")
  } else if (resource === "products" && verb === "update") {
    method = "PATCH"
    const id = need("id")
    const expectedVersion = positiveInteger(need("expected-version"), "--expected-version")
    body = { expected_version: expectedVersion }
    for (const field of ["name", "description"]) if (flags[field] !== undefined) body[field] = flags[field]
    if (flags.amount !== undefined) body.amount = amount()
    if (Object.keys(body).length === 1) throw new Error("Provide at least one of --name, --description, or --amount to update.")
    path = `products/${encodeURIComponent(id)}`
    idempotency()
  } else if (resource === "quotes" && verb === "accept") {
    method = "POST"
    path = `quotes/${encodeURIComponent(need("id"))}/accept`
    body = {}
    idempotency()
  } else if (resource === "fulfillments" && ["claim", "complete", "fail", "retry"].includes(verb)) {
    method = "POST"
    path = `fulfillments/${encodeURIComponent(need("id"))}/${verb}`
    body = ["complete", "fail", "retry"].includes(verb) && flags.note !== undefined ? { note: flags.note } : {}
    idempotency()
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
    const message = method !== "GET"
      ? requiresIdempotencyKey
        ? `The request outcome is unknown. ${checkState()}, and use only the same --idempotency-key. (${error.message})`
        : `The reconciliation response is unknown. Check payment state with "agora payments get --id ${flags.id}"; reconciliation is safe to repeat. (${error.message})`
      : error.message
    throw Object.assign(new Error(message), { code: method === "POST" ? "outcome_unknown" : "request_failed" })
  }

  let result
  try {
    result = await response.json()
  } catch {
    const message = method !== "GET"
      ? requiresIdempotencyKey
        ? `The response was not valid JSON, so the request outcome is unknown. ${checkState()} and reuse the same --idempotency-key.`
        : `The reconciliation response was not valid JSON. Check payment state with "agora payments get --id ${flags.id}"; reconciliation is safe to repeat.`
      : "The server returned an invalid JSON response."
    throw Object.assign(new Error(message), { code: method === "POST" ? "outcome_unknown" : "invalid_response" })
  }

  if (!response.ok) {
    if (method !== "GET" && response.status >= 500 && result && typeof result === "object") {
      result = {
        ...result,
        error: {
          ...result.error,
          code: result.error?.code || "outcome_unknown",
          message: requiresIdempotencyKey
            ? `${result.error?.message || "The server could not confirm the request."} ${checkState()} and reuse the same --idempotency-key.`
            : `${result.error?.message || "The server could not confirm the request."} Check payment state with "agora payments get --id ${flags.id}"; reconciliation is safe to repeat.`,
          outcome: "unknown",
        },
      }
    }
    console.error(JSON.stringify(result, null, 2))
    process.exitCode = 1
  } else {
    result = withoutProviderCheckoutUrls(result)
    const normalizeCheckoutUrls = (value) => {
      if (Array.isArray(value)) return value.forEach(normalizeCheckoutUrls)
      if (!value || typeof value !== "object") return
    for (const [key, item] of Object.entries(value)) {
        if (["checkout_url", "quote_url"].includes(key) && typeof item === "string" && item.startsWith("/")) value[key] = new URL(item, `${origin}/`).toString()
        else normalizeCheckoutUrls(item)
      }
    }
    normalizeCheckoutUrls(result)
    console.log(JSON.stringify(result, null, 2))
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || "cli_error", message: error.message } }, null, 2))
  process.exitCode = 1
}
