<div align="center">
  <h1>Agora CLI</h1>
  <p>Sell with versioned products, expiring quotes, orders, and fulfillment.</p>
  <p>
    <a href="https://github.com/pkyanam/agora-cli"><img alt="GitHub stars" src="https://img.shields.io/github/stars/pkyanam/agora-cli"></a>
    <a href="https://github.com/pkyanam/agora-cli/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/pkyanam/agora-cli"></a>
  </p>
</div>

![Agora Community payments dashboard](assets/agora-overview.png)

## Install

You need Node.js 20.9 or newer. Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/agora-cli/main/install.sh | bash
```

## Connect

Run `agora auth login --url https://your-agora-address` and paste your API key when asked. Get an API key from the Agora Developers page. The key's scopes are fixed by the merchant; `agora auth status` reports mode, readiness, scopes, and limits without revealing the key. Use `--local` for an offline configuration check.

```bash
agora products list
```

Run `agora --help` for the command list or `agora <resource> <action> --help` for exact fields and examples. [Open an issue](https://github.com/pkyanam/agora-cli/issues) if you need help.

## Sell with a quote

Create a customer record when you need to retain customer details, then create a quote from one or more current catalog products:

```bash
agora customers create --name "Ada Lovelace" --email ada@example.com --idempotency-key customer-ada-1
agora products list
agora quotes create --customer "Ada Lovelace" --email ada@example.com \
  --item prod_...:2 --item prod_...:1 --discount 500 \
  --idempotency-key quote-ada-1
```

Quotes snapshot product names and prices and return a `quote_url`; share that exact complete URL with the customer. They expire after seven days by default; an explicit `--expires-at` may be no more than 30 days ahead. Edit an open quote with `agora quotes update --id quo_... --expected-version 1 ... --idempotency-key edit-1`; provide all `--item` flags when changing its lines. Successful edits advance the version and replace the share URL, so share the returned `quote_url`. The hosted quote page lets the customer review and accept the quote. `agora quotes accept` is a separate authenticated merchant API action that creates an order and payment; it is not evidence that the customer accepted:

```bash
agora quotes accept --id quote_... --idempotency-key accept-ada-1
agora orders get --id order_...
agora orders status --id order_...
agora orders receipt --id order_... # only after Agora confirms payment
```

API acceptance can create a live checkout. Check `agora auth status` first, and use this command only when the merchant explicitly authorized creating the order and payment. If the merchant wants customer acceptance, share the complete `quote_url` instead. An unknown result is not a reason to use a new key: inspect the quote/order and retry only with the same key.

## Payment links

`agora payments create` and `agora quotes accept` print the server response as JSON. Share the complete
`checkout_url` field with the buyer exactly as returned. Do not construct a URL
from the payment `id`, shorten the URL, or use a processor checkout URL. The
Agora URL is the payer-facing link and can contain a capability in its fragment.
The CLI preserves the full URL and omits processor-only checkout URLs.

## Fulfill an order

A verified provider success moves an order to `paid` and its fulfillment to `ready`. Pending checkout, a return-page visit, or an unverified webhook does not unlock fulfillment. Claim work before performing it, then mark it complete afterward:

```bash
agora orders get --id order_...
agora fulfillments get --id ful_...
agora fulfillments claim --id ful_... --idempotency-key claim-ful-1
agora fulfillments complete --id ful_... --note "Shipped tracking …" --idempotency-key complete-ful-1
```

If work cannot be completed, use `agora fulfillments fail --id ful_... --note "Reason" --idempotency-key fail-ful-1`; after resolving the issue, `agora fulfillments retry --id ful_... --note "Resolution" --idempotency-key retry-ful-1` returns a paid order's failed task to `ready`. These commands update Agora's workflow state; they do not run external shipping or delivery integrations. Reads and writes require the corresponding API-key scopes. Existing API keys do not gain new scopes automatically.

Agent instructions for Agora integrations: [`skills/agora/SKILL.md`](skills/agora/SKILL.md).
To install it for a supported coding agent, run `npx skills add https://github.com/pkyanam/agora-cli --skill agora` (see the [Skills CLI](https://www.skills.sh/docs/cli)).
After installing the Agora CLI, `agora --skill` prints the same instructions to standard output without reading credentials or configuration.

## TypeScript SDK

The dependency-free TypeScript client in [`sdk/agora.ts`](sdk/agora.ts) exposes the same scoped sales workflow. Copy that file into your app; this repository does not publish it as an npm package. Mutations require an explicit stable idempotency key; the SDK does not retry writes automatically.

```ts
import { Agora } from "./lib/agora.ts" // copy sdk/agora.ts here

const agora = new Agora({ baseUrl: process.env.AGORA_URL!, apiKey: process.env.AGORA_API_KEY! })
const account = await agora.account.status()
const quote = await agora.quotes.create({
  customer: { name: "Ada Lovelace", email: "ada@example.com" },
  items: [{ product_id: "prod_...", quantity: 1 }],
}, { idempotencyKey: "quote-ada-1" })
// Share quote.quote_url verbatim. The call below is merchant-authorized API acceptance,
// creating an order and payment without recording customer consent.
const accepted = await agora.quotes.accept(quote.id, { idempotencyKey: "accept-ada-1" })
// Share accepted.payment.checkout_url verbatim; never construct it from an ID.
```

Check the account mode, readiness, scopes, and limits before writes. Use `orders.receipt(id)` only after the order is paid; the server returns `order_not_paid` otherwise.
