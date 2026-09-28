# Agora CLI

Install the command with Node.js 20.9 or newer:

```bash
curl -fsSL https://agora-payments.vercel.app/install.sh | bash
```

For a source-based install, clone this repository and run `bash install.sh`:

```bash
gh repo clone pkyanam/agora-cli
cd agora-cli
bash install.sh
```

The installer places `agora` in `~/.local/bin` or `$AGORA_INSTALL_DIR`, verifies the pinned SHA-256 of the standalone client, updates only an existing Agora-managed install, and adds one PATH block to the active zsh or bash login file. It saves a permissions-preserving backup before changing an existing shell file. It uses no sudo and stores no API credentials.

## Configure

Link the CLI once to a deployment. Create a scoped, mode-bound key in the Agora Developers page, then run the origin-specific command it provides. The key is pasted into a hidden prompt and saved in `~/.config/agora/config.json` with owner-only permissions. The CLI never prints or accepts the key as a command-line argument. Environment variables override the saved profile for scripts and agents. The server selects the provider and test/live mode; the CLI cannot change modes.

```bash
agora auth login --url 'https://your-agora-host.example'
# Paste the generated API key when prompted; terminal input is hidden.
agora auth status
agora --help
agora products list
```

Use `agora auth logout` to remove the locally saved URL and key. For temporary scripting, set `AGORA_URL` and `AGORA_API_KEY` in the process environment; these values take precedence and are never written to the config file.

The CLI supports products, payments (including hosted-checkout reconciliation), refunds, events, and local signature verification for Agora outgoing webhooks. Provider and mode are selected by the server-side API key: sandbox operations are simulated, and Stripe test-mode checkout uses Stripe-hosted card entry and official test cards. The CLI never takes card details and cannot enable live charges. Amounts are integer USD cents, so `4900` means `$49.00`. Create and refund writes require a stable `--idempotency-key`; reuse it only when retrying the same request. Payment reconciliation is safe to repeat and does not create another payment. A refund response of `pending` means provider confirmation is still outstanding; `requires_approval` means no refund has executed yet. After a network timeout or server error, inspect payment/refund state and never retry a write under a new idempotency key.

```bash
agora products create --name 'Studio license' --amount 4900 --idempotency-key product-studio-v1
agora payments create --product prod_… --customer 'Alex' --idempotency-key order-001
agora payments get --id pay_…
agora payments reconcile --id pay_…
agora refunds create --payment pay_… --amount 4900 --reason 'Customer request' --idempotency-key refund-001
agora events list --cursor 0
```

Webhook deliveries include `Agora-Timestamp`, `Agora-Signature`, `Agora-Event-Id`, `Agora-Delivery-Id`, and `Agora-Event-Type`. Verify the exact raw UTF-8 request body before parsing it; the signature is HMAC-SHA256 over `<timestamp>.<raw body>` and expires after five minutes. Store the endpoint signing secret in an owner-only file (mode `0600`), then pass the raw request body as a file or stdin:

```bash
agora webhooks verify --secret-file "$HOME/.config/agora/webhook-secret" \
  --body-file request-body.json --timestamp "$AGORA_TIMESTAMP" \
  --signature "$AGORA_SIGNATURE" --event-id "$AGORA_EVENT_ID" \
  --delivery-id "$AGORA_DELIVERY_ID" --event-type "$AGORA_EVENT_TYPE"
```

The verifier checks the timestamp window, constant-time signature, and event ID/type headers, then returns structured JSON with the event and delivery IDs. The TypeScript server SDK exports the same `verifyOutgoingWebhook(secret, timestamp, rawBody, signature, nowSeconds?)` helper. Webhook delivery is at-least-once: retries reuse the event and delivery IDs while receiving a fresh timestamp/signature.

The command emits JSON to stdout and errors to stderr. A relative `checkout_url` is expanded to the absolute deployment URL, so a tool can open the result directly. It never retries a payment request implicitly. Keep API keys in a password manager or secret manager; the CLI's owner-only config is convenient for local use but is not an agent secret manager.

## Development

```bash
bash tests/install.test.sh
node --test tests/cli.test.mjs
bun test tests/sdk.test.ts
```

The CLI is dependency-free. The optional TypeScript client is in `sdk/agora.ts` and makes requests only with a caller-provided mode-bound API key.
