---
name: cost-aware-execution
description: Do the work with the fewest and cheapest steps that still give a verified answer, reuse results already in the conversation, and stop at the task's limits. Use for large, repeated or open-ended work.
license: MIT
metadata:
  source: Kriya-native
---

# Cost-aware execution

Every model step, page read and browser minute costs the person money. Kriya enforces the limits; this is how to work well inside them.

1. **Use what you already have.** Results earlier in this conversation and notes in memory are free to reuse if they are still current. Don't fetch the same page twice.
2. **Pick the cheapest tool that answers.** A search result snippet before a full page read; an official API tool (Sheets, Calendar, GitHub) before the browser; one page read before many.
3. **Batch, don't loop.** One call that reads a whole range or list is better than one call per row.
4. **Size the work to the ask.** A quick question gets a quick answer. For large or repeated work (many items, a daily check), say what you will cover and confirm the scope before going wide.
5. **Stop at the limits.** When steps, time or budget run short, stop and report what is done, what is left and what it would take. Never say work is finished to save a step.

Never cut verification to save cost: an unverified result is reported as unverified.
