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

Set the base URL and a scoped, mode-bound Agora API key in the environment where you run the command. The server selects the provider and test/live mode; the CLI cannot change modes. Keys are not saved by the CLI.

```bash
export AGORA_URL='https://your-agora-host.example'
export AGORA_API_KEY='ag_…'
agora --help
agora products list
```

The CLI supports products, payments (including hosted-checkout reconciliation), refunds and events. Provider and mode are selected by the server-side API key: sandbox operations are simulated, and Stripe test-mode checkout uses Stripe-hosted card entry and official test cards. The CLI never takes card details and cannot enable live charges. Amounts are integer USD cents, so `4900` means `$49.00`. Create and refund writes require a stable `--idempotency-key`; reuse it only when retrying the same request. Payment reconciliation is safe to repeat and does not create another payment. A refund response of `pending` means provider confirmation is still outstanding; `requires_approval` means no refund has executed yet. After a network timeout or server error, inspect payment/refund state and never retry a write under a new idempotency key.

```bash
agora products create --name 'Studio license' --amount 4900 --idempotency-key product-studio-v1
agora payments create --product prod_… --customer 'Alex' --idempotency-key order-001
agora payments get --id pay_…
agora payments reconcile --id pay_…
agora refunds create --payment pay_… --amount 4900 --reason 'Customer request' --idempotency-key refund-001
agora events list --cursor 0
```

The command emits JSON to stdout and errors to stderr. It never retries a payment request implicitly. Keep API keys in a password manager or secret manager, not shell history, source control, or command arguments.

## Development

```bash
bash tests/install.test.sh
node --test tests/cli.test.mjs
bun test tests/sdk.test.ts
```

The CLI is dependency-free. The optional TypeScript client is in `sdk/agora.ts` and makes requests only with a caller-provided mode-bound API key.
