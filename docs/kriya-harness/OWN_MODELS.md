# Own models: your own API keys and your own orchestration

The owner's request and decisions (2026-11-24, `status.md`):

- anyone may use orchestration with their own models and keys;
- usage **counts** come to Kriya: no prompts, code or keys;
- providers are the **OpenAI-compatible set**;
- pricing and plans come later.

## What the person does

In Kriya Harness, Developer tab → **Your models**:

1. **Add a key.**
   - Providers: OpenRouter, OpenAI, DeepSeek, Groq, Together AI, Mistral, or a
     custom OpenAI-compatible `https` endpoint.
   - The key is typed once and saved only on that computer, in
     `~/.kriya/own-models.json` (mode 600). It's never shown again (last four
     characters only).
2. **Load the provider's models** (`GET <url>/models` with that key), and add
   up to 12. Each keeps its context window, from the provider where it says.
3. **Choose your orchestration.**
   - The **head** plans, reviews and takes over when the worker is stuck. It
     can be any of the plan's Kriya tiers or your own models.
   - The **worker** builds. It can be those, or the S-1 local model.
   - The two must differ.
4. **Restart Kriya Harness.** The picker then lists "Orchestration · <head>
   leads, <worker> builds" first, the Kriya tiers, and each own model.

## How it works

- **The relay routes.** The launcher's relay (`src/gateway-proxy.js`, the S-1
  path generalised) sends a chat request for `own-N` or `local` to that
  model's endpoint, with its real model name and `Authorization: Bearer
  <their key>`. It sends nothing else: no device token, no Kriya header.
  Every other request goes to Kriya as before, and Kriya never sees an
  own-model chat.
- **Orchestration.** The person's own orchestration replaces the owner's
  for that computer. It turns `KRIYA_ORCHESTRA` on unless the person passed
  `--no-orchestra`. The loop's head and worker rules, gates and "done" are
  unchanged.
- **Counts.**
  - The relay reads only the answer's final `usage` figures: tokens, and
    OpenRouter's `cost`.
  - It batches them per provider and model, and sends them every 30 s and
    at exit to `POST /own-usage`.
  - They're stored in `kriya.harness_own_usage` (the person reads their own
    rows, RLS; only the device route writes) and shown on `/harness`
    ("Your own models") and in Owner → Harness (totals, no person named).
  - The cost is the provider's figure, kept apart from Kriya charges
    (invariant 6), and shown only when every call reported one.
- **Providers that refuse `stream_options`.** The request is retried once
  without it. That's safe because a refused request generated nothing.

## Keys never reach a model

DSH's sandbox limits writes, not reads, so a tool could print the key file
(DSH's own `.credentials.yaml` has the same exposure). Two layers protect
the key:

1. **Redaction.** `plugins/keyguard` sits outermost on `tools/post-execute`.
   Any word in a tool's result whose sha256 matches a saved key's is replaced
   with `[redacted: your API key]` before the model sees it. DSH's process
   holds only the hashes (`KRIYA_KEY_HASHES`), never a key.
2. **Guard.** A tool call whose arguments name `own-models.json` is refused.

**Known limit:** a key in a file the person's own account can read is as safe
as that account; the person's own shell can always read it.

## Switches and rules

- **Owner switch.** `harness.ownModels` (off by default) makes `/models`
  advertise `ownModels: 1`. Off: the saved setup is ignored, `/own-usage`
  answers 404, and nothing changes (OM-RUN-02). Today it applies to everyone;
  per-plan limits come with pricing.
- **The relay is needed** (`KRIYA_RELAY=off` means no own models, with a
  one-line note).
- **What the Developer tab may offer** comes from Kriya's advert, never the
  shell (`KRIYA_OWN_MODELS_OFFER`).
- **Keys are never sent anywhere else:** never to Kriya, a log, the Web UI
  (last four characters only), DSH or a model.

## Tests

- **Client:**
  - `tests/own-models.test.js` OM-01…10: the store, custom URLs, model
    lists, launch, `launchEnv`, the relay with keys and counts, usage
    parsing, the reporter, redaction, and the Developer tab routes;
  - `tests/own-models-run.test.js` OM-RUN-01, 02: real DSH with a local HTTPS
    provider (a throwaway certificate, trusted via `NODE_EXTRA_CA_CERTS` in
    the test only).
- **Server:**
  - `tests/harness/own-usage.test.ts` HT-OWN-01, 02;
  - `tests/db/harness-own-usage-rls.test.ts` HT-OWN-DB-01;
  - the migration rollback chains in `tests/db/migrations.test.ts`;
  - HT-REG-01.

## Not verified

- **Real providers.** No real provider was called. Provider-specific
  behaviour (OpenRouter's `cost`, Groq's `x_groq`, which providers refuse
  `stream_options`) follows their documentation and the retry; check it with
  one real key per provider.
- **Native Anthropic and Gemini APIs.** Not built (owner's choice); they're
  reachable through OpenRouter.
