import { createHash, randomBytes } from "node:crypto"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"

// RT-RLT-03 and the ping's authorization (REALTIME §1, §5) on the local
// Supabase stack's real Realtime server (P-3 only; staging repeats it with
// RB-03). Three local users: Asha (owner), Ravi (member), Carol (outsider).
// Checks: members join the private channel room:<id> and an outsider is
// refused; a ping sent the way lib/rooms/realtime.ts sends it (secret key as
// `apikey`, REST, ?private=true) is accepted and reaches members only; a ping
// without the key is refused; what a removed member gets.

const SUPABASE_URL = "http://127.0.0.1:54321"
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = process.env.SUPABASE_SECRET_KEY
if (
  !SECRET ||
  !process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1") ||
  !/@(127\.0\.0\.1|localhost):/.test(process.env.DATABASE_URL ?? "")
)
  throw new Error("Export .env.verify (local stack) and pass verify:guard first")

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} })
const checks = []
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok })
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function localUser(email) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 })
  const found = data.users.find((u) => u.email === email)
  if (found) return found.id
  const made = await admin.auth.admin.createUser({ email, email_confirm: true })
  if (made.error) throw made.error
  return made.data.user.id
}

async function accessToken(email) {
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  })
  if (error) throw error
  const client = createServerClient(SUPABASE_URL, PUBLISHABLE, {
    cookies: { getAll: () => [], setAll: () => {} },
  })
  const { data, error: otp } = await client.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  })
  if (otp) throw otp
  return data.session.access_token
}

const as = (user, fn) =>
  db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true)`
    await tx`set local role authenticated`
    return fn(tx)
  })

// As the room page does it: supabase-js with the person's token, loaded
// before the join (components/rooms/room-view.tsx)
async function listen(token, roomId) {
  const client = createClient(SUPABASE_URL, PUBLISHABLE, {
    accessToken: async () => token,
  })
  await client.realtime.setAuth()
  const got = []
  let status = "none"
  client
    .channel(`room:${roomId}`, { config: { private: true } })
    .on("broadcast", { event: "seq" }, (message) => got.push(message.payload))
    .subscribe((s) => (status = s))
  return { got, status: () => status, close: () => client.removeAllChannels() }
}

async function waitStatus(listener, ms = 8000) {
  const end = Date.now() + ms
  while (
    Date.now() < end &&
    !["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(listener.status())
  )
    await sleep(100)
  return listener.status()
}

// Exactly lib/rooms/realtime.ts's request
const ping = (roomId, seq, key = SECRET) =>
  fetch(
    `${SUPABASE_URL}/realtime/v1/api/broadcast/${encodeURIComponent(`room:${roomId}`)}/events/seq?private=true`,
    {
      method: "POST",
      headers: { ...(key ? { apikey: key } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ seq }),
    }
  )

async function run() {
  const asha = await localUser("asha@example.com")
  const ravi = await localUser("ravi.r2check@example.com")
  await localUser("carol.r3check@example.com")

  const [room] = await as(
    asha,
    (tx) =>
      tx`insert into kriya.rooms (created_by, title) values (${asha}, 'R3 realtime check') returning id`
  )
  const token = randomBytes(32).toString("base64url")
  const hash = createHash("sha256").update(token).digest("hex")
  await as(
    asha,
    (
      tx
    ) => tx`insert into kriya.room_invites (room_id, created_by, token_hash, max_uses, expires_at)
               values (${room.id}, ${asha}, ${hash}, 2, now() + interval '1 day')`
  )
  await as(ravi, (tx) => tx`select kriya.join_room(${hash}, 25)`)

  const A = await listen(await accessToken("asha@example.com"), room.id)
  const R = await listen(await accessToken("ravi.r2check@example.com"), room.id)
  const C = await listen(await accessToken("carol.r3check@example.com"), room.id)
  const [sa, sr, sc] = [await waitStatus(A), await waitStatus(R), await waitStatus(C)]
  check("member Asha joins the private channel", sa === "SUBSCRIBED", sa)
  check("member Ravi joins the private channel", sr === "SUBSCRIBED", sr)
  check("outsider Carol is refused", sc !== "SUBSCRIBED", sc)

  const noKey = await ping(room.id, 99, null)
  check(
    "a ping without the secret key is refused",
    noKey.status >= 400,
    `status ${noKey.status}`
  )
  const sent = await ping(room.id, 1)
  check(
    "a ping with the secret key as apikey alone is accepted",
    sent.status === 202,
    `status ${sent.status}`
  )
  await sleep(1500)
  check(
    "members receive { seq } only",
    JSON.stringify(A.got) === '[{"seq":1}]' && JSON.stringify(R.got) === '[{"seq":1}]',
    JSON.stringify([A.got, R.got])
  )
  check("the outsider receives nothing", C.got.length === 0)
  check("the keyless ping reached nobody", !A.got.some((p) => p.seq === 99))

  // Removed: RLS on reads is immediate; the open connection may keep getting
  // pings until it re-authorizes (RF-02); a fresh join is refused
  await as(
    asha,
    (tx) => tx`update kriya.room_members set left_at = now(), removed_by = ${asha}
               where room_id = ${room.id} and user_id = ${ravi}`
  )
  await ping(room.id, 2)
  await sleep(1500)
  const stillGets = R.got.some((p) => p.seq === 2)
  console.log(
    `info  removed member's open connection still got ping 2: ${stillGets} (RF-02: pings carry no content)`
  )
  const R2 = await listen(await accessToken("ravi.r2check@example.com"), room.id)
  const sr2 = await waitStatus(R2)
  check("a removed member's fresh join is refused", sr2 !== "SUBSCRIBED", sr2)

  for (const l of [A, R, C, R2]) await l.close()
  await db.end()
  if (checks.some((c) => !c.ok)) process.exit(1)
}

run()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error)
    await db.end().catch(() => {})
    process.exit(1)
  })
