---
name: agora-payments
description: Use Agora's CLI, API, or SDK to create and inspect merchant payments and share the correct hosted checkout link.
---

# Agora payments

Use the installed `agora` CLI and its JSON output for Agora payment operations. Keep API keys and webhook secrets out of prompts, logs, and replies. Do not claim a payment succeeded until Agora reports a terminal succeeded state.

## Checkout links

- For a created payment, use the complete `checkout_url` returned by Agora exactly as provided. Preserve the entire URL, including its fragment. Give that URL to the buyer verbatim.
- Never construct a checkout path from a `payment.id`, shorten or truncate a checkout URL, or substitute a Stripe/provider URL. Payment IDs identify records; they are not checkout links.
- If the response has no `checkout_url`, or the returned URL is unavailable or rejected, say so and stop. Do not guess a replacement. A payment get/list response may not include a share link.
- If a create request's outcome is unknown, inspect the payment state and retry only with the same idempotency key. Do not create another payment to recover the URL.

## Mode and financial effects

Check the merchant's configured provider mode before creating a payment. Clearly identify test mode versus live mode. Do not initiate a live-mode payment unless the user explicitly requested a live transaction; completing a live checkout can charge a customer. A pending record or checkout session is not proof of payment. Use Agora's reported status and verified provider events as the source of truth.

Use `agora --help` for available commands. Payment creation requires a unique, stable `--idempotency-key`; reuse that key only when retrying the same order.
