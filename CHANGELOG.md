# Changelog

All notable changes to Kriya Tavi are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Kriya 0.1.0] — unreleased

### Added

- Accounts with Supabase Auth: sign-up with email confirmation, sign-in, password reset, onboarding, profile, and account deletion. Rate-limited, with answers that don't reveal whether an email is registered.
- Supabase Postgres schema `kriya` with row-level security on every table, tested per table for cross-user access.
- A durable task queue in Postgres and a separate worker: leases, heartbeats, recovery after a crash, cancellation, deadlines, cost and step budgets, provider fallback and escalation retries.
- OpenRouter gateway with routing tiers (Everyday, Balanced, Expert), a model registry and a live model eval script.
- Per-request usage and cost metering, idempotent; per-task charges in rupees with the FX rate and source recorded; reported, estimated and charged amounts kept apart; reconciliation from OpenRouter generation records.
- Plans and entitlements configured in the database; Razorpay subscriptions with verified, deduplicated, order-safe webhooks; a test billing provider.
- The owner console: overview, finance, users (suspend, reactivate), config (models, routing, plans), operations (failed tasks, retries, workers, reconciliation) and an audit log.
- A Kriya interface: brand mark, indigo and saffron themes, landing page, mobile bottom navigation, an Activity panel for every task, plan and usage meters, and a web-app manifest.

### Changed

- Agents choose a model level, not a model id; the plan decides which levels are open.
- Agent instructions treat web content as untrusted and answer in the person's language.

### Removed from the hosted product

- Local Docker workstations (shell, desktop, files), the keychain vault and payment approvals, the Telegram bridge, BYOK provider settings, the update checker and the local installers. They depend on running on the user's own computer; computer use returns through an isolated execution provider.
