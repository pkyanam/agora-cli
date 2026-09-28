# Agora CLI

Install the command with Node.js 20.9 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/agora-cli/main/install.sh | bash
```

For a source-based install, clone this repository and run `bash install.sh`. During development, an authenticated GitHub CLI install is also available:

```bash
gh api --header 'Accept: application/vnd.github.raw' repos/pkyanam/agora-cli/contents/install.sh | bash
```

The installer places `agora` in `~/.local/bin` or `$AGORA_INSTALL_DIR`, updates only an existing Agora-managed install, and adds one PATH block to the active zsh or bash login file. It saves a permissions-preserving backup before changing an existing shell file. It uses no sudo and stores no API credentials.

## Configure

Set the base URL and a scoped Agora sandbox API key in the environment where you run the command. Keys are not saved by the CLI.

```bash
export AGORA_URL='https://your-agora-host.example'
export AGORA_API_KEY='ag_test_…'
agora --help
agora products list
```

The CLI currently supports sandbox products, payments, refunds and events. It does not take card details or create live charges. Amounts are integer USD cents, so `4900` means `$49.00`. Every write requires a stable `--idempotency-key`; reuse it only when retrying the same request. A refund response of `requires_approval` means no refund has executed yet.

```bash
agora products create --name 'Studio license' --amount 4900 --idempotency-key product-studio-v1
agora payments create --product prod_… --customer 'Alex' --idempotency-key order-001
agora payments get --id pay_…
agora refunds create --payment pay_… --amount 4900 --reason 'Customer request' --idempotency-key refund-001
agora events list --cursor 0
```

The command emits JSON to stdout and errors to stderr. It never retries a payment request implicitly. Keep API keys in a password manager or secret manager, not shell history, source control, or command arguments.

## Development

```bash
bash tests/install.test.sh
```

The CLI is dependency-free. The optional TypeScript client is in `sdk/agora.ts` and also makes requests only with a caller-provided sandbox key.
