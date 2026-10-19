# Vision and scope

## 1. Intent

Kriya Tavi is an India-first personal AI agent that **does the work, remembers
what matters, keeps going in the background, and shows exactly what it
accomplished**. It doesn't just answer.

A student, developer, founder, freelancer, creator or small business gets a
small **team** of agents shaped to their work. The team:

1. **Carries out tasks** through official APIs, a real browser with the
   person's own login profiles, and documents it produces (PDF reports,
   invoices, resumes).
2. **Remembers ongoing goals**: a profile of the person, standing
   preferences, decisions, and the history of what was done, kept accurate
   over months.
3. **Works in the background**: scheduled runs, watchers, goal check-ins
   that pause only when the person must decide.
4. **Proves what it did**: every action that changed something is listed
   with evidence (a read-back from the API, a before/after screenshot, the
   document itself). Nothing is shown as done that wasn't verified (AD-02).

## 2. What "production-grade, accurate, reliable, secure" means here

No system can promise 100 % accuracy. Promising it would break AGENTS.md
voice rule 6 ("never fabricate"). This plan makes four guarantees that **can**
be enforced and measured.

| Guarantee                                                                   | How it's enforced                                                              | Measured by                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Nothing external happens without the person's approval of that exact action | Deterministic policy engine (AD-03), approval per R2–R4 call, R5 doesn't exist | AT-POL-_, AS-SEC-_ (target: 0 unapproved commits, no tolerance) |
| Nothing is reported as done unless it was verified                          | Accomplishments derived from evidence (AD-02)                                  | AT-VER-*, metric V1 = 100 %                                     |
| Numbers about money are exact                                               | Code computes every total and tax in integer paise (AD-16)                     | AT-LED-* (exact equality)                                       |
| Failures are visible, never silent                                          | Durable tasks, bounded retries, explicit `needs_review` states                 | AT-WRK-_, AS-REL-_                                              |

Model-dependent quality (how good a draft is, whether the right memory is
recalled, whether a page was understood) gets **measured thresholds** in
TEST_AND_EVALUATION.md, recorded with sample size and date, never rounded up.

## 3. Principles

1. **Do the task, within the rules of the site.** API first; browser only
   in the site's mode (AD-06, AD-07). Losing the person's account is the
   worst outcome.
2. **The person's identity is theirs.** No passwords, OTPs, CAPTCHAs or
   payments by agents. The person takes over for those steps (AD-04).
3. **Memory is a product, not a log.** Typed, scoped, dated, sourced,
   editable, with history (MEMORY_AND_CONTEXT.md).
4. **Tokens are money.** Every prompt block has a budget, observations are
   compressed, repeated work becomes skills, and summaries run off the
   critical path on the cheapest tier (AD-12, AD-13, AD-21).
5. **One engine, many roles.** Roles are data (AD-14). A feature built for
   founders works for freelancers when it fits.
6. **Additive and reversible.** Every phase ships behind its own switch,
   with a rollback, without changing existing behaviour for people who don't
   use it (CHANGE_IMPACT_AND_SAFETY.md).
7. **India first.** Rupees with Indian grouping, GST, IST, Indian languages in
   the person's own script, Indian portals and exams. Facts about rules
   (GST, exams, scholarships) always come from an official source the agent
   read, with the date it was read.

## 4. In scope (this plan, phases A1–A12)

- Memory v2 and context economy (A1).
- Role packs and teams for each use case (A2).
- Goals, schedules, background runs, approval inbox, "What I did" (A3).
- Browser runtime with the policy engine, on fixture sites (A4).
- Files: uploads, extraction, generated PDFs (A5).
- Login profiles, live view and take-over (A6).
- Accounts: bills, ledger, GST maths, invoices, reports (A7).
- Official-API connectors: GitHub, Sheets write, YouTube, Instagram (A8).
- Skills (save, approve, replay), plus embeddings if needed (A9).
- Controlled pilot on real sites with test accounts (A10).
- Security, compliance and readiness (A11).
- Governed improvement loop (A12).
- Watchers, Radar and the public facts commons (A13).
- **Signature features K1–K10** (`SIGNATURE_FEATURES.md`), Kriya's own way of
  working:
  - receipts with ₹ costs;
  - quotes and hard ₹ caps;
  - undo;
  - deadline radar from official sources;
  - zero-token watchers;
  - shared verified public facts;
  - citation cross-checks;
  - expiring read-only shares for a CA or parent;
  - ready-to-apply kits;
  - lite mode for slow networks.

## 5. Out of scope (and why)

| Not built                                                                         | Why                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Agent-typed passwords, OTP relay, CAPTCHA solving                                 | AD-04; account security and site rules                                |
| Payments, UPI, net banking, card entry                                            | R5. Needs RBI-regulated flows and a separate design                   |
| Filing GST/ITR returns, government submissions                                    | R5. Legal consequence; Kriya prepares, the person or their CA files   |
| Bulk outreach: mass connect, apply or message; scraping other people's profiles   | AD-06. Against site terms and against the people on the receiving end |
| Bot-detection evasion (stealth, fingerprint spoofing, proxies to hide automation) | Dishonest automation; against site terms                              |
| Running the person's code                                                         | AD-24; needs a microVM provider                                       |
| Push, SMS, WhatsApp or email notifications or reminders                           | AD-20, voice rule 10                                                  |
| Native mobile apps                                                                | The web app is mobile-first; revisit after A11                        |
| A marketplace of third-party skills                                               | Trust and review model not designed                                   |

## 6. Glossary

| Term                | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Team                | The squad created from a role pack                                                       |
| Role pack           | Templates, loadout, profile slots and starter goals for one use case (AD-14)             |
| Goal                | A long-running objective with success criteria, its own thread, check-ins and a budget   |
| Schedule            | A rule that enqueues a task: once, recurring, or a watcher (check X, act if Y)           |
| Login profile       | Sealed browser session state for one site (AD-05)                                        |
| Take-over / handoff | The person controls the live browser for a step the agent may not do                     |
| Site mode           | `api` / `supervised` / `assisted` / `blocked` (AD-06)                                    |
| Risk class          | R0–R5 (AD-03)                                                                            |
| Evidence            | API read-back, before/after screenshot, generated file, or provider id proving an action |
| Episode             | The derived record of one finished task: what was done, with evidence                    |
| Skill               | A saved, approved, replayable procedure (AD-21)                                          |
| Fixture site        | A local test site used instead of a real one (AD-23)                                     |
