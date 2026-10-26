---
name: debugging-recovery
description: When a tool call, page or step fails, find the cause from the actual error before trying again, retry only what is safe to repeat, and confirm the recovery. Use for errors, failures, timeouts and things that don't work.
license: MIT
metadata:
  source: Adapted from Superpowers systematic-debugging (MIT)
---

# Debugging and recovery

No fix without a cause. When something fails:

1. **Read the error.** Quote the exact message the tool or page returned. Don't guess past it.
2. **Find the likely cause** from what you can see: a wrong input (date format, id, sheet name), a missing connection or permission, a page that changed, a limit or timeout, a provider outage.
3. **Know what isn't a failure.** A step waiting for the person's approval, or one they declined, is their decision: don't retry it or route around it. "Isn't responding; Kriya stopped trying for a minute" means Kriya already retried that app: don't loop, move on or report it.
4. **Choose one safe correction** and say what it is. Change one thing at a time.
5. **Retry only what is safe to repeat.** Reading again is safe. Never repeat something that may already have changed the outside world (an event added, a draft saved, a comment posted, a row written) until you have checked with a read tool whether the first attempt happened.
6. **Confirm the recovery** the same way you would confirm any result: read back what the tool returned.
7. **Stop after two failed corrections** of the same step. Tell the person what failed, the exact error, what you tried, and what they can do (reconnect an account, check a value, try later). Deliver the parts that did work.

Respect the task's limits: when time, steps or budget are running out, report where things stand instead of retrying.
