# Vision and scenarios (track R: Rooms)

## 1. The idea

A **room** is a conversation where people and **their own agents** work on
something together: two founders and their agents shipping a launch, a
family planning a trip, students and a mentor building a project, a shop
owner and an accountant closing the month. Agents don't just chat: they do
real work in their owners' accounts (research, code in cloud workspaces,
drafts, checks), and every result arrives in the room with **proof computed
by code**, which another member's agent can independently re-check.

Four rules make this safe:

1. **An agent acts only for its owner.** Its tools, connections, memory,
   approvals and spend are its owner's. Others can ask it; only its owner
   can approve anything it does outside Kriya.
2. **Nothing private leaves without the owner.** If the agent touched its
   owner's private data (mail, files, calendar…), its reply waits for the
   owner's "Share in room".
3. **Proof, not claims.** Agent messages carry proof cards from verified
   tool runs; unproven claims say so.
4. **The owner decides who may spend.** By default only the owner can
   invoke their agent; they can let members invoke it with a daily ₹ cap.

## 2. Market facts (2026-10-31)

See `docs/kriya-harness/VISION_AND_SCENARIOS.md` §2 for the dated, sourced
facts (ChatGPT group chats retired since 2026-07-09; ChatGPT dots: texting
"one-on-one … can't participate in group texts"; Claude Cowork project
sharing on Team/Enterprise) and research gap HQ-04 (Grok, Gemini in Google
Chat, Teams Copilot, Slack/Discord AI). No comparison or "first" claim goes
into product copy until RG-9 is redone right before publishing. (Say
"India-first", never "India's first".)

## 3. Scenarios

| # | Room | What happens | Phase |
| --- | --- | --- | --- |
| RS01 | Two founders + their agents | "@Arjun build the pricing page" → Arjun's agent works in a cloud workspace (track C), posts a proof card (draft PR read back); "@Meera verify the PR" → Meera's agent reads the PR with Meera's GitHub connection and posts "Independently verified: PR #42 open, checks passing" | R5 (C10 for the workspace) |
| RS02 | Founders + agents | "Compare 3 payroll vendors for 12 people in Bengaluru" → both agents research; numbers quoted with sources; K7 checks marked on each card | R4 |
| RS03 | Launch room | A goal "Launch ready when: PR merged, landing page live, price sheet updated"; each item closes only with an attached verified proof card; late re-checks post updates | R7 |
| RS04 | Shop owner + accountant | Owner's agent drafts GST invoices in the owner's ledger (A7); the accountant comments; confirmation stays the owner's action | R4 |
| RS05 | Family (Telugu/Hindi/Hinglish) | Trip options with quoted prices; nothing booked (Kriya never pays) | R4 |
| RS06 | Friends | "Who's free Saturday?" → each agent answers only free/busy from its owner's calendar, and only after its owner shares (disclosure gate) | R4 |
| RS07 | Students + mentor | Students' agents work in workspaces; the mentor's agent re-runs the tests independently | R5 |
| RS08 | Any room | Agents hand questions to each other ("@Meera can you check the price?") within a turn budget; any member can press Stop | R6 |
| RS09 | Any room | Shared room notes ("our budget is ₹40k"): agents add notes as unconfirmed; a person confirms | R8 |
| RS10 | Any room | Weekly check-in: a person's schedule posts a summary with page diffs into the room | Later: needs a decision (A3 schedules run in their own threads; relaying their results into a room is not in v1) |

## 4. Out of scope for v1

Public or discoverable rooms; agents from outside Kriya; voice calls in
rooms; file uploads into rooms (proof cards and links only); end-to-end
encryption (agents must read messages; stated plainly in the room info);
agents posting on their own initiative without a person's message, schedule
or mention.
