# Runbook: key rotation (GA-5)

`KRIYA_TOKEN_KEY` encrypts the tokens of connected accounts and the saved
logins of the agent browser (invariant 4). This runbook rotates it, and the
other service secrets, without losing anyone's connections or logins. Gate
GA-5 needs one rehearsal on **staging**, written in `status.md`. The code is
tested (`tests/agent/key-rotation.test.ts`); the staging drill is not yet
done (2026-10-18).

## How sealing works

- Each sealed value is `v2_<key id>.<iv>.<tag>.<body>`. The key id is the
  first 8 hex characters of a hash of the key: it identifies the key and
  can't recover it. Values written before this change are `v1.…` and don't
  say which key sealed them.
- `KRIYA_TOKEN_KEY` seals everything new. `KRIYA_TOKEN_KEY_PREVIOUS`, set
  only during a rotation, still opens what the old key sealed.
- **Saved logins** are sealed again with the new key when a task uses them,
  and the worker's janitor re-seals the rest (`resealProfiles`, up to 200 per
  run) while a previous key is set. One that opens with neither key is
  expired; the person signs in again.
- **Connection tokens** are sealed in `lib/connectors.ts` (rotation fixes
  approved by the owner 2026-10-19, `tests/connectors/rotation.test.ts`):
  - Google: a refresh during a rotation re-seals **both** the access and the
    refresh token with the new key.
  - Notion, GitHub, Meta: tokens are re-sealed only when the person
    reconnects.
  - Once the old key is removed, a tool using a token still on it fails
    with the reconnect prompt ("… Reconnect GitHub in Account → Connected
    accounts."), not a crash. A missing or malformed `KRIYA_TOKEN_KEY` is
    still reported as a platform error.
  - **Disconnect always works**: when the token won't open, the provider
    revoke is skipped and the row is deleted.
- `npm run readiness` with `DATABASE_URL` counts sealed values per key id
  (`keys.sealed`) by reading prefixes only; nothing is decrypted.

## Planned rotation (every 12 months, or when someone with access leaves)

1. Generate a key on a trusted machine:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Store it in the password manager next to the old one, labelled with the
   date and its key id (`npm run readiness` prints it).
2. On **both** `kriya-web` and `kriya-worker`, in one change: set
   `KRIYA_TOKEN_KEY_PREVIOUS` to the old key and `KRIYA_TOKEN_KEY` to the new
   one. Deploy both. (A service still on the old configuration can't open
   values the other has already re-sealed, so don't leave them mismatched.)
3. Check: `npm run readiness` on each environment shows `keys.rotation`
   (warn: rotation under way) with the old key id, and `keys.token` with the
   new one.
4. Watch `keys.sealed` over the next days. Saved logins should reach zero
   within a few janitor runs.
5. Connections still on the old key (`keys.sealed` lists them; find the
   rows by prefix:
   `select user_id, provider from kriya.connections where access_token not like 'v2_<new id>.%' or refresh_token not like 'v2_<new id>.%'`):
   ask those people to reconnect. Allow up to 90 days.
6. Before removing the old key, tell the people whose connections are still
   on it to reconnect. Rows left behind are safe: their tools ask the person
   to reconnect, and Disconnect removes them (the grant at the provider stays
   until the person removes Kriya there, so say so).
7. Remove `KRIYA_TOKEN_KEY_PREVIOUS` from web and worker; deploy.
   `npm run readiness` should show `keys.sealed` pass and no `keys.rotation`.
8. Destroy the old key in the password manager. Record the rotation in
   `status.md`.

## Emergency rotation (the key may have leaked)

A leaked key exposes everything it sealed **if** the database leaked too.
Don't keep the old key around:

1. Generate a new key and set it as `KRIYA_TOKEN_KEY` on web and worker,
   **without** `KRIYA_TOKEN_KEY_PREVIOUS`. Deploy.
2. Saved logins can't open: they expire on next use or by the janitor, and
   people sign in again. Delete every row in `kriya.connections` (owner,
   audited) and ask people to reconnect: the old tokens may have leaked, so
   don't wait for them to fail.
3. Limit what the old tokens and sessions can still do: ask people to sign
   out other sessions on the sites they saved and to remove Kriya's access
   in their Google, Notion, GitHub and Meta settings.
4. Treat it as an incident (`incident.md`), including whether it's a
   reportable breach.

## Other secrets

| Secret                                              | Where                        | How to rotate                                                                        | Effect while rotating                                                                                 |
| --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `KRIYA_BROWSER_SECRET`                              | web, worker, `kriya-browser` | Set the new value on all three; deploy `kriya-browser` first, then worker and web    | Browser steps, PDFs and live-view tokens fail for a minute or two; live views open at that moment end |
| `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_KEY_*`         | web                          | Rotate in the Razorpay dashboard, then set here                                      | Webhooks in between are refused; check the provider retries them                                      |
| `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY`           | web, worker                  | Create the new key at the provider, set it, deploy, then revoke the old one          | None if done in that order                                                                            |
| OAuth client secrets (Google, Notion, GitHub, Meta) | web, worker                  | Add a second secret at the provider where it allows; set, deploy, remove the old one | New connections fail if done out of order                                                             |
| `SUPABASE_SECRET_KEY`, the `DATABASE_URL` password  | web, worker                  | Rotate in Supabase, set, deploy                                                      | Requests fail until both services have the new value                                                  |

## Drill (staging only)

| Step                                                                                   | Record                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Seed staging: one saved login (a test site), one Google and one Notion test connection | Key ids before                                                                |
| Planned rotation steps 1–3                                                             | Time; readiness output                                                        |
| Run a task that uses the saved login; let the janitor run once                         | `keys.sealed` before and after                                                |
| Run a task that needs a Google refresh                                                 | `keys.sealed` (expect both Google tokens on the new key)                      |
| Steps 5–7, leaving the Notion connection on the old key                                | Login and Google work; a Notion tool asks to reconnect; Disconnect removes it |
| Time from step 2 to step 7                                                             | Minutes                                                                       |

Record the drill in `status.md` under A11.
