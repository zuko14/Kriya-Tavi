---
name: kriya-security
description: Use when code handles input from users or the network, authentication, secrets, files, shell commands or database queries: check the trust boundaries, injection, secrets and permissions before calling the work done.
license: MIT
metadata:
  source: Written for Kriya Harness, based on ECC security-review (MIT)
  default: Kriya default skill
---

# Security check

Find where untrusted data enters and follow it.

**Check:**
- **Input** from users, files, the network or other services is validated at the boundary (type, size, format) before use.
- **Injection:** database queries are parameterised; shell commands get arguments, not strings built from input; HTML output is escaped; paths can't climb out of their folder.
- **Secrets** come from the environment or a secret store, never source, logs, error messages, URLs or responses. Don't print one to check it.
- **Auth:** every route that needs a user checks one, on the server; ownership is checked for each record, not assumed from an id the client sent.
- **Dependencies:** no new package for a few lines; an added one is pinned and from a known source.
- **Errors** say what went wrong without internals, stack traces or other people's data.

**When you find a problem:** fix it if it's in scope; otherwise tell the person exactly where and why, ranked by impact. Never test against systems you don't own, and never disable a safety check to make something work.
