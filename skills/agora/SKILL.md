---
name: agora-payments
description: Use Agora's CLI, API, or SDK to create and inspect merchant payments and share the correct hosted checkout link.
---

# Agora commerce

Use the installed `agora` CLI and its JSON output for Agora catalog, quote, order, payment, and fulfillment operations. Keep API keys, customer secrets, and webhook secrets out of prompts, logs, and replies. Use `agora auth status` before writing to inspect provider mode, granted scopes, readiness, and limits; `agora auth status --local` is configuration-only.

## Quote-to-order workflow

- Read the product catalog and customer record before quoting. Use quote line items with positive integer quantities and pass the customer's name/email only when needed for the transaction.
- Use `agora quotes create` with one stable idempotency key. Review the returned immutable product/price snapshots and expiry; do not silently change quantity, discount, or expiry after the customer approved the quote.
- Share the complete `quote_url` returned by Agora exactly as provided, preserving its full fragment. Never build a quote URL from its ID or expose the underlying capability token.
- If Agora does not return a `quote_url`, report that the customer link is unavailable and stop; do not construct one from the quote ID or guess a replacement.
- A quote is not a payment. Share Agora's exact `quote_url` so the customer can review and accept it. Do not call `agora quotes accept` unless the merchant/customer authorized creating the order and payment. Check `agora auth status` first; live mode may create a checkout that can charge the customer.
- Quote acceptance is an idempotent write. If its result is unknown, inspect the quote and order, then retry only with the same idempotency key. Never accept again with a new key to recover a response.

## Checkout links

- For a created payment, use the complete `checkout_url` returned by Agora exactly as provided. Preserve the entire URL, including its fragment. Give that URL to the buyer verbatim.
- After quote acceptance, use `payment.checkout_url` from the response and give that complete value to the buyer verbatim.
- Never construct a checkout path from a `payment.id`, shorten or truncate a checkout URL, or substitute a Stripe/provider URL. Payment IDs identify records; they are not checkout links.
- If the response has no `checkout_url`, or the returned URL is unavailable or rejected, say so and stop. Do not guess a replacement. A payment get/list response may not include a share link.
- If a create request's outcome is unknown, inspect the payment state and retry only with the same idempotency key. Do not create another payment to recover the URL.

## Mode and financial effects

Check the merchant's configured provider mode before accepting a quote or creating a payment. Clearly identify test mode versus live mode. Do not create a live payment unless the user explicitly authorized the order; completing a live checkout can charge a customer. A pending record or checkout session is not proof of payment. Use Agora's reported status and verified provider events as the source of truth.

## Fulfillment

- A payment, return page, or unverified webhook is not proof an order is paid. Read the order/fulfillment state from Agora; only claim work whose server-reported fulfillment state is `ready`.
- Use `agora fulfillments claim` before doing the work and `agora fulfillments complete` only after it is actually done. These commands record workflow state; they do not run integrations. Do not invent fulfillment actions or mark an order complete to make a customer appear served.
- Check `agora orders status`, `agora orders get`, and `agora fulfillments get` to report status. Request `agora orders receipt` only after Agora reports the order paid. Keep customer data limited to the transaction and fulfillment task.

Use `agora --help` for available commands. Payment creation requires a unique, stable `--idempotency-key`; reuse that key only when retrying the same order.
