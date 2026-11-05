# Product intent (track S: Flows)

Source: the owner's brief,
`docs/kriya_visual_studio/KRYA_STUDIO_VISUAL_AGENT_ENGENEERING_PRODUCT_BRIEF.md`
(2026-11-05). This page keeps the intent; the brief keeps the detail.

**One sentence.** Describe an outcome, get or draw how it should be done, run it
with trustworthy controls, see every step, and improve it with evidence.

## Who it is for

| Person | Wants | Gets |
| --- | --- | --- |
| Small-business owner | "Every Monday, chase overdue invoices and let me check before anything goes" | Describes it, reviews a small graph, presses Run, approves on the phone |
| Operator or analyst | A repeatable process with approvals and connected accounts | Agents, checks, gates, versions |
| Developer | Parallel research with a merge; retries; state | The graph, run inspector, re-run from a node |
| AI engineer | Their own harness: loops, verification, budgets | Loop regions, worst-case bound, Compare and the gate |
| Harness user | To design what the agent does on their machine | Device flows, the Graph tab |

## Jobs

1. Turn a recurring piece of work into something that runs the same way twice.
2. Know before running what the worst case is.
3. When it goes wrong, find the node and fix only that.
4. Tell whether a change made it better.

## Principles

1. **The simplest graph that works.** One agent is a fine answer. The copilot
   and Improve both suggest removing things.
2. **Same rules as chat.** A flow gets no power an agent doesn't have.
3. **Code decides.** Pass, fail, done and better come from records, never from
   model text.
4. **Nothing silently changes.** Proposals are previews; the person applies.
5. **No dead controls.** What isn't built isn't shown.
6. **Calm, exact, native.** It should look like Kriya drew it with a ruler.

## Not doing (release 1)

Triggers other than Run, code nodes, direct tool nodes, sub-flows, public
template sharing, import and export, team editing. Each needs its own design;
`IMPLEMENTATION_PLAN.md` lists them.
