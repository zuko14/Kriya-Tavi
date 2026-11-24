# S-1 Local models (hybrid, signed in)

The owner's decision is SI-01 (2026-11-24, `status.md`). The source is
`STRATEGIC_INTENTS_SOVEREIGN_COMPUTE_AND_ONBOARDING.md` milestone S-1, which
is internal and not a source of fact.

## What it does

A person starts `kriya --local-model`. Kriya Harness then finds a model
server on their computer: Ollama on port 11434, then LM Studio on 1234. They
can also name any OpenAI-compatible server on their own network
(`--local-model http://192.168.1.9:8000/v1`) and a model
(`--local-model-name qwen2.5-coder:32b`).

That model builds the orchestra's **worker** steps. Kriya's head still:

- leads the session;
- plans and writes the contracts;
- advises and runs the critic;
- takes over after `escalateAfter` failed attempts, or when the worker is stuck.

Gates, checks and "done" are unchanged: code decides them.

## Rules

1. **Off by default, twice.** The owner's `harness.localModels` makes
   `GET /models` say `localModels: 1`, and only while the orchestra is
   offered. The person must also ask with `--local-model`. Without both,
   nothing changes; the launcher prints one line saying why.
2. **Signed in.** There's no signed-out mode. The head's requests are metered
   and capped as before (track H rule 4). Local requests cost Kriya nothing
   and never reach it.
3. **Own computer or network only.** The server must be on a loopback or
   private address (127/8, 10/8, 172.16/12, 192.168/16, `::1`, `fc00::/7`, or
   `*.local`). The probe and the relay refuse redirects.
4. **No token leaves for the local server.** The local relay
   (`src/gateway-proxy.js`) sends only chat requests for the `local` model
   there, with the model's real name. It sends the body and its type, never
   the device token or Kriya's headers. Every other request goes to Kriya as
   before. Kriya never sees the model id `local`.
5. **No DSH edits.** `local` is one more model of the existing `kriya`
   route. It exists only when the launcher found the server. It has a context
   window (`KRIYA_LOCAL_CONTEXT`, default 32,768, clamped to 16k–1M) and a
   compaction headroom of a quarter of that window.

## Known limits (unknowns, with how to check)

- **Ollama's context.** Its OpenAI endpoint serves 4,096 tokens unless
  started with `OLLAMA_CONTEXT_LENGTH`; the launcher says so.
  **Check:** a real run on a 14B model.
- **Tool calling.** Tool calling depends on the local model. A model that
  can't call tools fails its attempts, and the head takes over within the
  existing 4 attempts. Unmeasured on a real local model.
- **Picker entry.** The `local` model also shows in the model picker as
  "Local · <model>". A person may choose it for a whole session; they stay
  signed in.

## Tests

- **Client:** `tests/local-model.test.js` LM-01…10 and
  `tests/local-model-run.test.js` LM-RUN-01, 02 (real DSH, a fake Kriya and
  a fake local server).
- **Server:** `tests/harness/local-models.test.ts` HT-LM-01, and HT-REG-01.
