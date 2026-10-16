<p align="center">
  <img src="public/logo.svg" width="72" height="72" alt="Kriya Tavi">
</p>

<h1 align="center">Kriya Tavi</h1>

<p align="center"><strong>Verified action. AI that acts, and proves it acted right.</strong></p>

<p align="center">
An India-first AI agent platform by Kriya AI. Hand real work to AI agents from
your phone or browser, follow every step they take, and see what each task
cost, in rupees.
</p>

---

## What it does

- **Agents with roles and memory.** Create agents for research, study, code,
  client work or content. They remember what matters about you and your work,
  and you can read, edit or delete every memory.
- **Tasks that outlive the tab.** Work runs in a background worker. Close
  Chrome, reopen the thread, and the task is still going or already done.
- **An activity record for every task.** Each search, page read and memory
  change, which model level ran it, how long it took and what it cost.
- **Squads.** Several agents in one thread hand work to whoever fits.
- **Indian languages.** Agents answer in the language and script you write:
  English, Hindi, Telugu, Tamil, Hinglish and more. Voice typing in the composer.
- **Plans in rupees.** Server-enforced limits, warnings before you hit them,
  and Razorpay subscriptions (with a test mode).
- **An owner console** for users, costs, revenue, models, plans and operations.

What agents can't do yet: use a computer or browser for you. That arrives with
an isolated execution provider (see the [roadmap](docs/kriya/status.md#roadmap)).

## How it's built

A Next.js 16 web app and a Node worker on Render, around Supabase (Auth and
Postgres with row-level security). Models through OpenRouter, web research
through Firecrawl, payments through Razorpay.

| Read | For |
| --- | --- |
| [docs/kriya/architecture.md](docs/kriya/architecture.md) | System design, task lifecycle, tenancy, metering |
| [docs/kriya/deployment.md](docs/kriya/deployment.md) | Supabase, Render, Razorpay setup; environment; verification; rollback |
| [docs/kriya/security.md](docs/kriya/security.md) | Threat model and known gaps |
| [docs/kriya/status.md](docs/kriya/status.md) | What's done, what's verified, what's left |

## Local development

You need Node.js 22, a Supabase project (a separate development project, never
production), and an OpenRouter key.

```bash
npm ci
# create .env with the variables in docs/kriya/deployment.md
MIGRATION_DATABASE_URL=… npm run db:migrate
npm run dev                   # web on http://localhost:6796
npm run dev:worker            # the worker, in a second terminal
```

Add `http://localhost:6796/auth/confirm` to the development project's
redirect URLs. Then sign up, confirm the email and grant yourself the owner
role:

```bash
DATABASE_URL=… npm run owner:grant -- you@example.com
```

### Checks

```bash
npm test              # database (PGlite), pipeline, billing and money tests
npm run check         # typecheck, lint, format, tests
npm run build
```

The tests run a real Postgres in-process (PGlite) with Supabase's auth schema
shimmed, so RLS, the queue functions and the full task pipeline are tested
without a network or Docker.

## Attribution

Kriya Tavi includes MIT-licensed code by Sourav Bera. The copyright and
permission notice are kept in [LICENSE](LICENSE).
