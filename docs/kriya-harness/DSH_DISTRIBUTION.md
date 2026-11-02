# How the Kriya Harness is built on DeepSeek Harness (track H)

The Kriya Harness reuses DeepSeek Harness (DSH) as a dependency and adds
Kriya through DSH's documented extension points. Nothing in DSH is edited.
Upstream facts are from the pinned commit `ce7073d` and npm on 2026-10-31
(REPOSITORY_AUDIT §2); everything marked **verify** is checked in H4 against
the version actually pinned.

## 1. Package layout (repository `kriya-harness`, HD-03)

```
kriya-harness/
  package.json            # "@kriya-ai/harness", bin "kriya", engines node >=24.9
                          # dependencies: @deepseek-ai/dsh@<exact>, dsh bundles@<exact>
                          # "dsh": { "profile": { "bundles": [ ... ] } } per profile
  profiles/kriya/         # web UI profile: dsh-base + dsh-web-app + kriya bundle
  profiles/kriya-run/     # one-shot profile: dsh-base + dsh-headless + kriya bundle
  profiles/kriya-acp/     # editor profile: dsh-base + dsh-acp-app + kriya bundle
  bundle/                 # the "kriya" bundle: cordis.patch.yml mounting the plugins below
  plugins/
    auth/                 # P-AUTH   Kriya device sign-in (authorization method)
    gateway/              # P-GW     config rows for dsh-llm-pi-ai → Kriya gateway
    approvals/            # P-APR    user-approval answerer → Kriya phone approvals
    sync/                 # P-SYNC   session-persistence wrapper → Kriya mirror
    skills/               # P-SKL    skill source from Kriya's catalogue
    tools/                # P-TOOL   kriya_memory_search, kriya_memory_save, kriya_handoff
    world/                # P-WORLD  runner protocol for cloud agents (H10)
  bin/kriya.ts            # resolves the pinned dsh and runs `dsh --profile <kriya|kriya-run|kriya-acp>`
                          # with DSH_HOME=~/.kriya
  THIRD_PARTY_NOTICES.md  # DSH MIT notice + generated dependency notices
  SAFETY.md               # Kriya's beta safety notice (HF-05)
```

`bin/kriya.ts` only selects a profile and the home directory; booting stays
DSH's launcher, as upstream requires ("Only dsh profiles launch supported
Node apps").

## 2. Commands

| Command | Profile | What the person gets |
| --- | --- | --- |
| `kriya login` | `kriya` (auth only) | Device sign-in (HD-05); shows the user code and opens `/connect/device` |
| `kriya [--mode ask\|auto\|read\|full]` | `kriya` | DSH's Web UI on `127.0.0.1` with Kriya models, skills, memory tools, phone approvals and the mirror (HD-20 modes) |
| `kriya run [--mode ask\|auto\|read\|plan\|full] "<job>" [--json]` | `kriya-run` | One job, final answer printed, exit code 0/1 (DSH headless) |
| `kriya acp` | `kriya-acp` | ACP server over stdio for editors (HD-13) |
| `kriya handoff [note]` | helper (no agent) | HD-11 upload, then prints the Kriya thread link |
| `kriya pull [workspace]` | helper (no agent) | HD-11 download and apply on a new branch |
| `kriya logout` | helper | Deletes the local device token and revokes it on the server |
| `kriya doctor` | helper | Node version, DSH version, sign-in state, gateway reachability, profile integrity |

## 3. The seven plugins, mapped to DSH seams

| Plugin | DSH seam (upstream package) | What it does | Server endpoint (API_AND_CONTRACTS) |
| --- | --- | --- | --- |
| P-AUTH | `credentials` + `authorization` (a provider-specific method; the package "provides no provider-specific methods itself") | Runs the device flow, stores the device token under the credential name `kriya.device` in `credentials-local` (private on-machine storage readable by the same OS user) | `/device/code`, `/device/token` |
| P-GW | `llm-pi-ai` custom route ("OpenAI-compatible gateways … custom routes can declare those values without code changes") | Config only: base URL `<KRIYA_URL>/api/harness/v1`, credential `kriya.device`, models `budget`, `balanced`, `escalation`; DSH's `llm-retry` stays on | `/chat/completions`, `/models` |
| P-APR | `user-approval` answerer ("sends each request to the deployment's human or machine answerers") | Posts each approval request to Kriya and long-polls the answer; local terminal/UI answers still work; first answer wins; timeout → `unavailable` (fails closed) | `/approvals`, `/approvals/{id}` |
| P-SYNC | `session-persistence` backend (wraps `session-persistence-jsonl`) | Writes locally first (durability barrier = local flush), then queues a redacted turn summary to Kriya; offline → retried later; never blocks the agent | `/sessions`, `/sessions/{id}/turns` |
| P-SKL | `skill` catalogue source ("combine catalogs and expose one instruction set per name") | Fetches the person's skill catalogue (curated + approved Studio skills) with an ETag cache; skills are instructions only, never tools | `/skills`, `/skills/{id}/{version}` |
| P-TOOL | `ctx.tools` registrations | `kriya_memory_search` (read), `kriya_memory_save` (saved unconfirmed), `kriya_handoff` (HD-11) | `/memory/search`, `/memory`, `/handoff` |
| P-WORLD | none in DSH (Kriya's runner protocol) | Serves track C's runner protocol over an outbound connection for one chosen folder (H10) | relay (HD-12) |

Disabled by the `kriya` bundle (patch rows set `disabled`): DeepSeek-account
credential and model plugins (`credentials/deepseek-account*`,
`llm/llm-deepseek-account`), telemetry exporters, liveshare and other
experimental bundles, plugin-market recommendations. **Verify** each row id
against `dsh --profile kriya --dump-config` in H4 and record the dump.

## 4. What the person gets from DSH unchanged

The agent loop, prompt assembly, tool pipeline, file tools (`read`, `write`,
`edit`, `apply_patch`, `glob`, `grep`), bash/PowerShell, background jobs,
persistent terminals, LSP, MCP client, subagents, compaction, plan mode,
todo list, goals, schedules (local), attachments, deliverables (changed-file
summaries), permission presets and approvals, hooks compatibility, the Web
UI and session history. Their maturity is DSH's; experimental packages stay
off unless a later decision turns one on.

## 5. Versions and upgrades

| Item | Rule |
| --- | --- |
| Pin | Exact versions of `@deepseek-ai/dsh` and every DSH package the profiles name; lockfile committed |
| First pin | Chosen in H4 after reading the upgrade guides between the latest npm release candidate and the pinned commit (HQ-05) |
| Bump | A branch that changes only versions, runs the HT suite and the gateway contract tests, records results; then a release |
| Patches | Package-manager patch files only, each linked to an upstream issue; removed when upstream fixes it |
| Session format | DSH migrates session logs forward by version-named successors; the mirror (P-SYNC) reads only its own summaries, so DSH format changes don't break Kriya |
| Node | `engines.node >= 24.9`; `kriya doctor` explains how to upgrade |

## 6. License, notices, brand

- DSH is MIT (Copyright (c) 2026 DeepSeek). Its notice ships in
  `THIRD_PARTY_NOTICES.md` with every transitive dependency's notice,
  generated at release from the lockfile; releases fail if any dependency's
  license is unknown or not on the allow-list (MIT, ISC, BSD-2/3, Apache-2.0,
  0BSD, BlueOak, CC0, Python-2.0 for tooling) without a recorded exception.
- Brand: "Kriya Harness, built on DeepSeek Harness" (allowed by DSH's brand
  guidelines); no DeepSeek logo, no "DeepSeek Harness" in the product name.
- This repository's `LICENSE` is untouched; track C's `NOTICE.md` covers
  code ported into this repository, not the client.
