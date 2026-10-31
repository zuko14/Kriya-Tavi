# Vision and scenarios (track H, with tracks C and R)

## 1. The idea in one line

**One Kriya agent, every surface, with proof.** The same agent (its role,
skills, memory, approvals, budget) works in three places, and every result
comes back with evidence computed by code:

| Surface | Track | Where the work runs | Who pays for compute |
| --- | --- | --- | --- |
| Kriya web and phone (today) | existing | `kriya-worker` | Kriya (model tokens charged to the plan) |
| A cloud workspace (laptop closed) | C | An isolated provider sandbox | Kriya (compute in plan minutes) |
| The person's own machine (Kriya Harness: a local agent app, like Claude Code's role, with a browser UI on the machine and a command line for scripts) | H | The person's computer | The person's machine; Kriya charges model tokens only |
| A room with friends, co-founders, a family, a class | R | Each agent in its owner's account (any of the above) | Each agent's owner |

The Kriya Harness is the downloadable piece: `npm install -g @kriya-ai/harness`,
then `kriya` opens its UI in the browser on `127.0.0.1` (DSH's Web UI, which is
DSH's interactive surface; DSH ships no terminal UI), `kriya run "…"` runs one
job and exits (scripts, CI), and `kriya acp` serves editors. It is built on
DeepSeek Harness's published packages (MIT), composed as a `kriya` profile
with Kriya plugins (DSH_DISTRIBUTION.md), and it signs in to the person's
existing Kriya account. It is not a second product: no new accounts, billing,
memory or agent identities. While DSH describes itself as an unaudited
developer preview (its `SAFETY.md`), the Kriya Harness ships as a **beta**
with Kriya's own safety notice (HD-02, HG-6).

## 2. What competitors offer (official pages read 2026-10-31, RG-9)

Rules: only facts read on the vendor's own page on that date go in the
"Official" column; anything else is Secondary; **no claim that a competitor
lacks something** goes into product copy until RG-9 is redone right before
publishing (track A rule 12 spirit, `docs/agent-platform/RESEARCH.md` RG-9).

| Product | Fact | Source | Confidence |
| --- | --- | --- | --- |
| ChatGPT group chats | "Since July 9, 2026, you can no longer create or join new group chats"; existing ones viewable, read-only in the UK | help.openai.com/en/articles/12703475 ("Retiring group chats in ChatGPT", updated 3 days before 2026-10-31) | Official |
| ChatGPT dots | An "always-on agent" with "its own cloud computer"; optional access to the person's computer through the desktop app; can create Codex cloud tasks; Slack and personal email connections; scheduled tasks; custom rules (act without asking / if pre-approved / ask / hand off); Pro and Business Premium, not EEA/CH/UK | help.openai.com/en/articles/20001530 ("Getting started with your dot", updated 2026-10-31) | Official |
| ChatGPT dots, texting | "Texting works one-on-one between you and your dot. Your dot can't participate in group texts." Beta, US, iMessage/RCS | same page | Official |
| Claude Cowork projects | "Project sharing is available on Team and Enterprise plans"; "Can view" / "Can edit" for people in the organization | support.claude.com/en/articles/14116274 | Official |
| Claude Cowork sessions | The page doesn't say sessions can be shared or that several people's agents can work in one session | same page | Official (absence on that page only) |
| Claude Code Projects | A project belongs to one user (search summary of code.claude.com) | Search result, page not fetched | Secondary |
| Grok, Gemini (Google Chat spaces), Microsoft Teams Copilot, Slack/Discord bots | Not read on 2026-10-31 | — | Research gap HQ-04 |

What this supports, carefully worded: as of 2026-10-31, OpenAI has retired
group chats and says its dot can't join group texts, and Claude's Cowork
page shares projects within an organization. Kriya Rooms (track R) aim at a
space where **several people each bring their own agent**, the agents act in
their owners' accounts, and results carry proof. Whether anyone else offers
that today is HQ-04; no marketing claim until then.

## 3. Scenarios

Each row: what the person says, what Kriya does, which capabilities, how the
result is proven, and the phase that makes it possible. "Proof" always means
evidence computed by code from verified tool runs (track A rule 7), never
the model's words. Room phases: R4 agents in rooms, R5 proof cards and
independent verification, R7 room goals (`docs/rooms/IMPLEMENTATION_PLAN.md`).

### 3.1 Builders and engineers

| # | Person says | Kriya does | Uses | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| S01 | (phone) "Fix the failing date test in acme/web and open a PR." | Cloud workspace, runs tests, draft PR after approval | C | Test exit code card; PR read back from GitHub | C10 |
| S02 | (laptop) `kriya` "add rate limiting to the API" | Local DSH agent on the laptop, models through Kriya; risky commands need approval | H | Charges per request; local session log (mirrored as a summary from H6) | H4 |
| S03 | (laptop) `kriya handoff` before closing the lid | Uncommitted local changes go up as a checkpoint; a cloud workspace continues the same task | H + C | Workspace restored from that patch (same sha256); cloud test results | H8 |
| S04 | (next morning) `kriya pull` | The cloud workspace's changes come back to the laptop on a new branch | H + C | Patch sha256 matches the cloud checkpoint | H8 |
| S05 | (laptop agent wants `rm -rf build/ && npm publish`) | Approval appears on the person's phone; they decline the publish | H | Approval record with the exact command and answer | H5 |
| S06 | "Use my home server for this, it has the GPU." | The cloud agent runs commands on the person's own machine (when enabled and online) | H + C | Same runner evidence as a cloud workspace | H10 |
| S07 | (in Zed or another ACP editor) | The same Kriya agent in the editor through ACP | H | Same as S02 | H11 |
| S08 | (room with a co-founder) "Ship the pricing page." | Founder A's agent builds in a cloud workspace; founder B's agent independently checks the preview and the PR status | R + C | Two proof cards: A's PR read back; B's independent check | R5 |

### 3.2 Founders, small businesses, teams

| # | Person says | Kriya does | Uses | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| S09 | (room: two founders + their agents) "Compare three payroll vendors for 12 people in Bengaluru." | Each agent researches; agents cross-check each other's numbers; the room goal ticks only with quoted sources | R + existing web tools + K7 citations | Quotes verified against fetched pages; disagreements shown | R7 |
| S10 | (room: owner + accountant) "Draft this month's GST invoices." | Owner's agent drafts in the owner's ledger; the accountant reviews in the room; only the owner confirms entries | R + A7 ledger | Draft entries; confirmation is the owner's action (track A rule 11) | R4 |
| S11 | (room) "Every Monday 9am, tell us what changed on our competitors' pricing pages." | A schedule in the requesting owner's account posts a summary with diffs into the room | R + A3/A13 watchers | Page diffs with fetch times | Later: needs a decision (schedules run in their own threads today; posting their results into a room is not designed in track R v1) |
| S12 | (room) "Did the vendor actually send the contract?" | The owner's agent checks the owner's mail only if the owner allows connectors in that room; the reply is held for the owner's approval before anyone else sees it | R + connectors + disclosure gate | Read-back of the message id; owner's share approval | R4 |
| S13 | (room) "Our launch checklist: done when the PR is merged, the landing page is live, and the price sheet is updated." | A room goal whose items close only with attached proof; a late re-check updates them (track N) | R + N3 re-check | Each item links its verification | R7 |

### 3.3 Everyone else (India-first)

| # | Person says | Kriya does | Uses | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| S14 | (family room, Telugu/Hindi) "Plan Diwali travel Hyderabad → Pune for 5 people, under ₹40,000." | Agents research options; prices quoted with sources; nothing is booked (Kriya never pays, R5) | R + web + skills in Indian languages (N8) | Quoted prices with fetch time | R4 |
| S15 | (student project room: 4 students + mentor) "Build the attendance app; the mentor checks the tests." | Students' agents work in cloud workspaces; the mentor's agent runs the test suite independently | R + C | Test exit codes from two independent runs | R5 |
| S16 | (friends' room) "Who's free Saturday? Book a table for 6." | Each person's agent checks its owner's calendar only with that owner's consent, answers free/busy without details; booking is a hand-off to a person | R + calendar connector + disclosure gate | Free/busy answers approved by each owner | R4 |
| S17 | (job-search room with a mentor) "Review my resume against these 3 openings." | The owner's agent drafts; the mentor comments; edits stay in the owner's files | R + A5 files | File versions | R4 |
| S18 | (phone) "Call me tomorrow at 8 if the PR still has failing checks." | A re-check plus a phone-call reminder (voice rule 10) | N3 + voice | Re-check record; call outcome | existing |

### 3.4 What makes these hard to copy (design properties, not market claims)

1. **Agents act only in their owner's account.** In a room, every agent's
   tools, connections, approvals and spend belong to its owner; others can
   ask, never command (RD-03…RD-06).
2. **Proof travels with the message.** Results in rooms and harness
   mirrors carry code-computed evidence; unproven claims are labelled.
3. **Independent verification by another person's agent.** A second agent,
   owned by someone else, re-checks a claim with its own tools (S08, S15).
4. **Cost belongs to the person who chose to spend.** Each agent's owner
   sets who may invoke it and a ₹ cap per room (RD-04); the harness bills
   only tokens because compute is the person's machine.
5. **One identity across surfaces.** Skills and memory follow the agent
   from phone to cloud workspace to the person's machine to a room.
6. **India-first.** INR everywhere, Indian-language skill matching (N8),
   phone-call reminders, low cost on Render + Supabase.

## 4. Out of scope (for these tracks' first versions)

Public rooms or discovery; payments or bookings by agents (R5, never);
end-to-end encrypted rooms (agents must read messages); a desktop app for
the harness (DSH desktop is unpublished, `private: true`); agents of people
outside Kriya; connector tools inside the local harness; schedules posting
into rooms (S11).

## 5. Research gaps (HQ-…)

| Id | Question | Settle by | Blocks |
| --- | --- | --- | --- |
| HQ-01 | OpenRouter account-level rate limits for one platform key carrying all harness traffic | OpenRouter docs and support, in writing | H9 scale |
| HQ-02 | Does `llm-pi-ai` pass tool calls and streaming through an OpenAI-compatible route unchanged, and send `usage` in the final chunk? | H4 integration test of the client against the H3 gateway (fake upstream) | H4 |
| HQ-03 | npm scope `@kriya-ai` availability and the owner's org account | Owner | H4 publish |
| HQ-04 | Group/multi-agent features of Grok, Gemini in Google Chat, Teams Copilot, Slack/Discord AI, and others (RG-9) | Official pages, dated | Any public copy |
| HQ-05 | Which DSH version to pin first (rc vs the repository's alpha) and its changelog for breaking changes | Upstream upgrade guides | H4 |
