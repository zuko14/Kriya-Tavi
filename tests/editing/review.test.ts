import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: () => {},
}))

const session = vi.hoisted(() => ({ user: { id: "" } }))
vi.mock("@/lib/auth", async (actual) => ({
  ...(await actual<typeof import("@/lib/auth")>()),
  requireUser: async () => session.user,
  authenticate: async () => session.user,
}))

import {
  acceptEdit,
  addEditNote,
  answerEditQuestion,
  cancelEdit,
  deleteEditPreview,
  dismissFound,
  removeEditNote,
  sendEditNotes,
  startFromFound,
} from "@/actions/editing"
import { POST as helloRoute } from "@/app/api/harness/v1/daemon/hello/route"
import { POST as reportRoute } from "@/app/api/harness/v1/dispatch/[id]/route"
import { GET as nextRoute } from "@/app/api/harness/v1/dispatch/next/route"
import { POST as foundRoute } from "@/app/api/harness/v1/editing/found/route"
import { GET as notesRoute } from "@/app/api/harness/v1/editing/jobs/[id]/notes/route"
import { POST as finishRoute } from "@/app/api/harness/v1/editing/jobs/[id]/previews/[pid]/route"
import { POST as reserveRoute } from "@/app/api/harness/v1/editing/jobs/[id]/previews/route"
import { POST as askRoute } from "@/app/api/harness/v1/editing/jobs/[id]/questions/route"
import * as answerRoute from "@/app/api/harness/v1/editing/questions/[id]/route"
import { PERSON_ONLY_WRITES, TOOL_WRITES } from "@/lib/agent/policy"
import type { Agent } from "@/db/schema"
import { cardText, reviewEdits } from "@/lib/editing/jobs"
import { setPreviewStoreForTests, type PreviewStore } from "@/lib/editing/previews"
import { createEditTools } from "@/lib/editing/tools"
import { editCards, editRoom } from "@/queries/editing"
import { getInbox } from "@/queries/inbox"

import type { TestDb } from "../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "../harness/setup"

// ET-RV-01…05, on the real routes, actions and queries over PGlite: a decision card
// reaches the person and the answer reaches the job; only a session answers; a note goes
// through one revision; a recording is only a name and a duration until it's tapped.

const PROJECT = "0123456789abcdef"
const OPTIONS = { toolCallId: "c1", messages: [] } as never
type Out = Record<string, unknown>

let pg: TestDb
let alice: string
let bob: string
let mine: { token: string; deviceId: string }
let other: { token: string; deviceId: string }

const say = (token: string) =>
  helloRoute(
    call("POST", "/daemon/hello", {
      token,
      body: {
        daemonVersion: "0.3.0",
        capabilities: { fullAccess: false, serve: false, handoff: true, edit: true },
        projects: [
          { id: PROJECT, name: "Raw footage", path: "~/Raw footage", git: false },
        ],
        rules: [],
      },
    })
  )
const poll = async () =>
  (
    await nextRoute(call("GET", "/dispatch/next?wait=0", { token: mine.token }))
  ).json() as Promise<{
    dispatch: { id: string; kind: string; payload: Out } | null
    cancel: string[]
  }>
const report = (id: string, body: unknown) =>
  reportRoute(call("POST", `/dispatch/${id}`, { token: mine.token, body }))

const count = async (table: string) =>
  (await pg.query<{ n: number }>(`select count(*)::int as n from kriya.${table}`)).rows[0]
    .n

// A job as video_edit_start makes it, claimed and running
async function runningJob() {
  const started = (await createEditTools({
    current: () => ({ id: "a1" }) as Agent,
    userId: alice,
    threadId: "t1",
  }).video_edit_start.execute!(
    {
      device: mine.deviceId,
      project: PROJECT,
      computer: "laptop",
      folder: "Raw footage",
      brief: "Cut a reel",
      effort: "best",
    } as never,
    OPTIONS
  )) as { job: string }
  const { dispatch } = await poll()
  await report(dispatch!.id, { status: "running" })
  await reviewEdits()
  return { job: started.job, dispatch: dispatch!.id }
}
async function finishedJob() {
  const made = await runningJob()
  await report(made.dispatch, {
    status: "done",
    result: { outcome: "delivered", gates: [], notes: 0 },
  })
  await reviewEdits()
  return made
}

const askCard = (job: string, token = mine.token, over: Out = {}) =>
  askRoute(
    call("POST", `/editing/jobs/${job}/questions`, {
      token,
      body: {
        kind: "file",
        prompt: "Which recording did you mean?",
        options: [{ label: "a.mp4" }, { label: "b.mp4" }],
        defaultOption: 0,
        timeoutSeconds: 600,
        ...over,
      },
    })
  )
const answerOf = (id: string, token = mine.token) =>
  answerRoute.GET(call("GET", `/editing/questions/${id}?wait=0`, { token }))

const found = (over: Out = {}, token = mine.token) =>
  foundRoute(
    call("POST", "/editing/found", {
      token,
      body: { project: PROJECT, name: "Sunday talk.mov", seconds: 2040, ...over },
    })
  )

function fakeStore() {
  const removed: string[] = []
  const store: PreviewStore & { removed: string[] } = {
    removed,
    uploadUrl: async (p) => `https://storage.example/upload/${p}`,
    read: async () => null,
    signedUrl: async (p) => `https://storage.example/sign/${p}`,
    remove: async (paths) => void removed.push(...paths),
  }
  return store
}
let store: ReturnType<typeof fakeStore>

beforeAll(async () => {
  const db = await harnessDb()
  pg = db.pg
  alice = await db.createUser()
  bob = await db.createUser()
  mine = await deviceFor(pg, alice)
  other = await deviceFor(pg, bob)
  await pg.query(
    "insert into kriya.agents (id, user_id, name, role, glyph) values ('a1', $1, 'Editor', 'r', 'g')",
    [alice]
  )
  await pg.query(
    "insert into kriya.threads (id, user_id, agent_id) values ('t1', $1, 'a1')",
    [alice]
  )
  await pg.exec(
    "create schema if not exists storage; create table if not exists storage.objects (bucket_id text not null, name text not null)"
  )
  await pg.query("update kriya.plans set editing_preview_bytes = 1000000")
})

beforeEach(async () => {
  harnessEnv({
    KRIYA_HARNESS_CONTROL_CENTER: "on",
    KRIYA_HARNESS_RPM: "6000",
    KRIYA_EDITING_TAVI: "on",
    KRIYA_EDITING_PREVIEWS: "on",
    KRIYA_EDITING_REVIEW: "on",
    KRIYA_EDITING_WATCH_FOLDERS: "on",
  })
  store = fakeStore()
  setPreviewStoreForTests(store)
  session.user = { id: alice }
  await pg.exec(`
    delete from kriya.edit_questions;
    delete from kriya.edit_jobs;
    delete from kriya.harness_dispatches;
    delete from kriya.harness_device_state;
    delete from kriya.messages;
  `)
  await say(mine.token)
  await say(other.token)
})
afterEach(() => setPreviewStoreForTests(undefined))

describe("ET-RV-01: a decision card", () => {
  it("reaches the person, and their answer reaches the job", async () => {
    const { job } = await runningJob()
    const res = await askCard(job)
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    expect(await (await answerOf(id)).json()).toEqual({ status: "open" })

    const inbox = await getInbox(alice)
    expect(inbox.editCards.map((c) => [c.id, c.kind, c.deviceName])).toEqual([
      [id, "file", "laptop"],
    ])
    expect((await getInbox(bob)).editCards).toEqual([])

    expect(await answerEditQuestion(id, 1)).toEqual({ ok: true })
    expect(await (await answerOf(id)).json()).toEqual({ status: "answered", option: 1 })
    expect((await getInbox(alice)).editCards).toEqual([])
  })

  it("a timeout takes the default, whether the computer or the worker sees it first", async () => {
    const { job } = await runningJob()
    const first = (await (await askCard(job)).json()) as { id: string }
    const second = (await (
      await askCard(job, mine.token, { defaultOption: 1 })
    ).json()) as {
      id: string
    }
    await pg.query(
      "update kriya.edit_questions set expires_at = now() - interval '1 second'"
    )
    expect(await (await answerOf(first.id)).json()).toEqual({
      status: "defaulted",
      option: 0,
    })
    await reviewEdits()
    expect(await (await answerOf(second.id)).json()).toEqual({
      status: "defaulted",
      option: 1,
    })
    // Too late for the person
    expect(await answerEditQuestion(second.id, 0)).toEqual({
      error: expect.stringMatching(/closed/),
    })
  })

  it("the card notes what a default did, by code", async () => {
    const { job, dispatch } = await runningJob()
    await report(dispatch, {
      status: "done",
      result: {
        outcome: "delivered",
        gates: [],
        notes: 0,
        defaulted: 1,
        applied: 2,
        skipped: 1,
      },
    })
    await reviewEdits()
    const { rows } = await pg.query<{ parts: { text: string }[] }>(
      "select parts from kriya.messages where id = $1",
      [`edit-${job}`]
    )
    const text = rows[0].parts[0].text
    expect(text).toContain("1 choice went to the default")
    expect(text).toContain("Took 2 notes")
    expect(text).toContain("Couldn't do 1 note")
    expect(text).toContain("No preview was stored")
  })

  it("the default must be a choice; a closed job asks nothing; another computer's gets 404", async () => {
    const { job, dispatch } = await runningJob()
    expect((await askCard(job, mine.token, { defaultOption: 5 })).status).toBe(400)
    expect((await askCard(job, other.token)).status).toBe(404)
    await report(dispatch, {
      status: "done",
      result: { outcome: "delivered", gates: [], notes: 0 },
    })
    await reviewEdits()
    expect((await askCard(job)).status).toBe(404)
  })
})

describe("ET-RV-02: only a session answers", () => {
  it("no device route can, and no tool", async () => {
    expect(Object.keys(answerRoute).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["GET"])
    const { job } = await runningJob()
    const { id } = (await (await askCard(job)).json()) as { id: string }
    expect((await answerOf(id, other.token)).status).toBe(404)

    const tools = createEditTools({
      current: () => ({ id: "a1" }) as Agent,
      userId: alice,
      threadId: "t1",
    })
    for (const name of Object.keys(tools))
      for (const write of TOOL_WRITES[name]) {
        expect(PERSON_ONLY_WRITES).not.toContain(write)
        expect(write).not.toMatch(/edit_questions|edit_notes|accepted_at/)
      }
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/editing/review.ts"),
      "utf8"
    )
    expect(source).not.toMatch(/status: "answered"/)
  })

  it("another person can't answer, and only one of the choices counts", async () => {
    const { job } = await runningJob()
    const { id } = (await (await askCard(job)).json()) as { id: string }
    session.user = { id: bob }
    expect(await answerEditQuestion(id, 0)).toEqual({ error: "That edit isn't there." })
    session.user = { id: alice }
    expect(await answerEditQuestion(id, 2)).toEqual({
      error: expect.stringMatching(/isn't one of/),
    })
    expect(await answerEditQuestion("not-a-uuid", 0)).toHaveProperty("error")
  })
})

describe("ET-RV-03: notes", () => {
  it("pin to a moment, come and go with the person, and reach only this computer", async () => {
    const { job } = await finishedJob()
    expect(
      await addEditNote({ jobId: job, atFlicks: 705_600_000, body: "Bigger here" })
    ).toEqual({
      ok: true,
    })
    expect(await addEditNote({ jobId: job, atFlicks: -1, body: "x" })).toHaveProperty(
      "error"
    )
    expect(await addEditNote({ jobId: job, atFlicks: 0, body: "   " })).toEqual({
      error: "Write the note first.",
    })
    session.user = { id: bob }
    expect(await addEditNote({ jobId: job, atFlicks: 0, body: "Mine" })).toEqual({
      error: "That edit isn't there.",
    })
    session.user = { id: alice }

    const room = await editRoom(alice, job)
    expect(room?.notes.map((n) => [n.atFlicks, n.body, n.status])).toEqual([
      [705_600_000, "Bigger here", "open"],
    ])
    expect(await editRoom(bob, job)).toBeNull()

    await addEditNote({ jobId: job, atFlicks: 0, body: "Gone soon" })
    const gone = (await editRoom(alice, job))!.notes.find((n) => n.body === "Gone soon")!
    expect(await removeEditNote(gone.id)).toEqual({ ok: true })

    const sent = (await sendEditNotes(job)) as { id: string }
    const asks = (id: string, token = mine.token) =>
      notesRoute(call("GET", `/editing/jobs/${id}/notes`, { token }))
    expect(await (await asks(sent.id)).json()).toEqual({
      notes: [{ id: expect.any(String), atFlicks: 705_600_000, body: "Bigger here" }],
    })
    expect((await asks(sent.id, other.token)).status).toBe(404)
    // Gone to the computer: no taking it back
    const kept = (await editRoom(alice, job))!.notes[0]
    expect(await removeEditNote(kept.id)).toHaveProperty("error")
  })

  it("the parent's notes aren't a revision's until they're sent", async () => {
    const { job } = await finishedJob()
    await addEditNote({ jobId: job, atFlicks: 0, body: "Not sent" })
    const res = await notesRoute(
      call("GET", `/editing/jobs/${job}/notes`, { token: mine.token })
    )
    expect(await res.json()).toEqual({ notes: [] })
  })
})

describe("ET-RV-04: Send notes", () => {
  it("starts one revision; a double tap starts one", async () => {
    const { job } = await finishedJob()
    await addEditNote({ jobId: job, atFlicks: 0, body: "Tighter" })
    const before = await count("edit_jobs")
    const results = await Promise.all([sendEditNotes(job), sendEditNotes(job)])
    expect(results.filter((r) => "ok" in r)).toHaveLength(1)
    expect(results.filter((r) => "error" in r)).toEqual([
      { error: "There are no notes to send." },
    ])
    expect(await count("edit_jobs")).toBe(before + 1)
    const { dispatch } = await poll()
    expect(dispatch?.payload).toMatchObject({ revisionOf: job, project: PROJECT })
    expect((await poll()).dispatch).toBeNull()
  })

  it("no notes, or a cut still being made, starts nothing, and leaves no row", async () => {
    const { job } = await finishedJob()
    const before = await count("edit_jobs")
    expect(await sendEditNotes(job)).toEqual({ error: "There are no notes to send." })
    expect(await count("edit_jobs")).toBe(before)
    expect((await poll()).dispatch).toBeNull()

    const { job: running } = await runningJob()
    await pg.query(
      "insert into kriya.edit_notes (user_id, job_id, at_flicks, body) values ($1, $2, 0, 'x')",
      [alice, running]
    )
    expect(await sendEditNotes(running)).toEqual({
      error: expect.stringMatching(/still being made/),
    })
  })

  it("a cut that comes back settles its notes; one that doesn't gives them back", async () => {
    const { job } = await finishedJob()
    await addEditNote({ jobId: job, atFlicks: 0, body: "One" })
    await sendEditNotes(job)
    const first = await poll()
    await report(first.dispatch!.id, { status: "failed", result: { code: "disk_low" } })
    await reviewEdits()
    let notes = (await editRoom(alice, job))!.notes
    expect(notes.map((n) => n.status)).toEqual(["open"])

    await sendEditNotes(job)
    const second = await poll()
    await report(second.dispatch!.id, { status: "running" })
    await report(second.dispatch!.id, {
      status: "done",
      result: { outcome: "delivered", gates: [], notes: 0, applied: 1 },
    })
    await reviewEdits()
    notes = (await editRoom(alice, job))!.notes
    expect(notes.map((n) => n.status)).toEqual(["done"])
  })

  it("Looks good closes the job, once, and only for its owner", async () => {
    const { job } = await finishedJob()
    session.user = { id: bob }
    expect(await acceptEdit(job)).toEqual({ error: "That edit isn't there." })
    session.user = { id: alice }
    expect(await acceptEdit(job)).toEqual({ ok: true })
    expect((await editRoom(alice, job))?.job.acceptedAt).toBeInstanceOf(Date)
    expect(await acceptEdit(job)).toEqual({ error: "That edit isn't there." })
  })

  it("the room keeps a line's cuts together, and stops one through the existing cancel", async () => {
    const { job } = await finishedJob()
    await addEditNote({ jobId: job, atFlicks: 0, body: "Tighter" })
    const { id } = (await sendEditNotes(job)) as { id: string }
    await finishedJobOnOtherLine()
    const room = await editRoom(alice, id)
    expect(room?.cuts.map((c) => [c.id, c.label])).toEqual([
      [job, "Cut A"],
      [id, "Cut B"],
    ])
    const { dispatch } = await poll()
    await report(dispatch!.id, { status: "running" })
    expect(await cancelEdit(id)).toEqual({ ok: true })
    expect((await poll()).cancel).toEqual([dispatch!.id])
    session.user = { id: bob }
    expect(await cancelEdit(id)).toEqual({ error: "That edit isn't there." })
  })

  async function finishedJobOnOtherLine() {
    await pg.query(
      `insert into kriya.edit_jobs (user_id, device_id, project, brief, status)
       values ($1, $2, $3, 'another', 'queued')`,
      [alice, mine.deviceId, PROJECT]
    )
  }
})

describe("ET-RV-05: watch folders", () => {
  it("off by default; only a name and a duration; nothing runs until it's tapped", async () => {
    harnessEnv({ KRIYA_EDITING_WATCH_FOLDERS: undefined })
    expect((await found()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_WATCH_FOLDERS: "on" })

    expect((await found({ path: "/Users/x" })).status).toBe(400)
    expect((await found({ sha256: "a" })).status).toBe(400)
    const res = await found()
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    expect(await count("harness_dispatches")).toBe(0)
    expect(await count("edit_jobs")).toBe(0)

    const [card] = (await getInbox(alice)).editCards
    expect(card).toMatchObject({ id, kind: "found", jobId: null })
    expect(card.options).toEqual({
      project: PROJECT,
      name: "Sunday talk.mov",
      seconds: 2040,
    })

    const results = await Promise.all([startFromFound(id), startFromFound(id)])
    expect(results.filter((r) => "ok" in r)).toHaveLength(1)
    expect(await count("edit_jobs")).toBe(1)
    const { dispatch } = await poll()
    expect(dispatch?.kind).toBe("edit")
    expect(dispatch?.payload.brief).toContain("Sunday talk.mov")
    expect((await getInbox(alice)).editCards).toEqual([])
  })

  it("the computer must offer the folder and allow editing; Not this one starts nothing", async () => {
    expect((await found({ project: "fedcba9876543210" })).status).toBe(409)
    const { id } = (await (await found()).json()) as { id: string }
    expect(await dismissFound(id)).toEqual({ ok: true })
    expect(await startFromFound(id)).toEqual({
      error: expect.stringMatching(/already been answered/),
    })
    expect(await count("harness_dispatches")).toBe(0)

    const next = (await (await found({ name: "b.mov" })).json()) as { id: string }
    await helloRoute(
      call("POST", "/daemon/hello", {
        token: mine.token,
        body: {
          daemonVersion: "0.3.0",
          capabilities: { fullAccess: false, serve: false, handoff: true },
          projects: [
            { id: PROJECT, name: "Raw footage", path: "~/Raw footage", git: false },
          ],
          rules: [],
        },
      })
    )
    expect(await startFromFound(next.id)).toEqual({
      error: expect.stringMatching(/off on that computer/),
    })
    // Refused, so the card is still there to answer later
    expect((await getInbox(alice)).editCards.map((c) => c.id)).toEqual([next.id])
  })

  it("a noisy folder can't fill the Inbox; old cards leave; another person's can't be tapped", async () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++)
      ids.push(((await (await found({ name: `${i}.mov` })).json()) as { id: string }).id)
    expect((await found({ name: "one more.mov" })).status).toBe(429)
    session.user = { id: bob }
    expect(await startFromFound(ids[0])).toEqual({ error: "That edit isn't there." })
    session.user = { id: alice }
    await pg.query(
      "update kriya.edit_questions set expires_at = now() - interval '1 second'"
    )
    await reviewEdits()
    expect(await editCards(alice, "all")).toEqual([])
    const { rows } = await pg.query<{ status: string }>(
      "select distinct status from kriya.edit_questions"
    )
    expect(rows).toEqual([{ status: "expired" }])
    expect((await found({ name: "after.mov" })).status).toBe(200)
  })

  it("a found card can't be answered as a choice", async () => {
    const { id } = (await (await found()).json()) as { id: string }
    expect(await answerEditQuestion(id, 0)).toEqual({ error: "That edit isn't there." })
  })
})

describe("clips and previews", () => {
  it("a job offers several clips, each still inside the plan's room; one preview", async () => {
    const { job } = await runningJob()
    const reserve = (kind: string, tag: string) =>
      reserveRoute(
        call("POST", `/editing/jobs/${job}/previews`, {
          token: mine.token,
          body: {
            kind,
            bytes: 100,
            sha256: createHash("sha256").update(tag).digest("hex"),
          },
        })
      )
    expect((await reserve("clip", "a")).status).toBe(200)
    expect((await reserve("clip", "b")).status).toBe(200)
    expect((await reserve("preview", "c")).status).toBe(200)
    expect((await reserve("preview", "d")).status).toBe(409)
    await pg.query("update kriya.plans set editing_preview_bytes = 350")
    expect((await reserve("clip", "e")).status).toBe(403)
    await pg.query("update kriya.plans set editing_preview_bytes = 1000000")
  })

  it("the person can remove a preview from Kriya; another person can't", async () => {
    const { job } = await runningJob()
    const res = await reserveRoute(
      call("POST", `/editing/jobs/${job}/previews`, {
        token: mine.token,
        body: { kind: "preview", bytes: 10, sha256: "a".repeat(64) },
      })
    )
    const { id } = (await res.json()) as { id: string }
    expect(
      (
        await finishRoute(
          call("POST", `/editing/jobs/${job}/previews/${id}`, { token: mine.token })
        )
      ).status
    ).toBe(204)
    session.user = { id: bob }
    expect(await deleteEditPreview(id)).toEqual({ error: "That edit isn't there." })
    expect(store.removed).toEqual([])
    session.user = { id: alice }
    expect(await deleteEditPreview(id)).toEqual({ ok: true })
    expect(store.removed).toHaveLength(1)
  })
})

describe("ET-REG-01, ED15's half", () => {
  it("with the switches off nothing new answers, and the Inbox has no card", async () => {
    const { job } = await finishedJob()
    harnessEnv({
      KRIYA_EDITING_REVIEW: undefined,
      KRIYA_EDITING_WATCH_FOLDERS: undefined,
    })
    expect((await askCard(job)).status).toBe(404)
    expect((await answerOf(crypto.randomUUID())).status).toBe(404)
    expect(
      (await notesRoute(call("GET", `/editing/jobs/${job}/notes`, { token: mine.token })))
        .status
    ).toBe(404)
    expect((await found()).status).toBe(404)
    expect((await getInbox(alice)).editCards).toEqual([])
    expect(await addEditNote({ jobId: job, atFlicks: 0, body: "x" })).toHaveProperty(
      "error"
    )
    expect(await sendEditNotes(job)).toHaveProperty("error")
    expect(await acceptEdit(job)).toHaveProperty("error")
    expect(await startFromFound(crypto.randomUUID())).toHaveProperty("error")
  })

  it("a card links to the Review Room only with it on", () => {
    const job = { id: "j1", status: "delivered", verdict: {} } as never
    expect(cardText(job, "p1", true)).toContain("/edits/j1")
    expect(cardText(job, "p1", false)).toContain("/api/editing/preview/p1")
  })
})

// TP11 (CRAFT_UPGRADE §9, rule 17): the clips a computer advertises, and the order card
describe("TP11: advertised clips and the order card", () => {
  const helloWith = (projects: Out[]) =>
    helloRoute(
      call("POST", "/daemon/hello", {
        token: mine.token,
        body: {
          daemonVersion: "0.3.0",
          capabilities: { fullAccess: false, serve: false, handoff: true, edit: true },
          projects,
          rules: [],
        },
      })
    )
  const folder = { id: PROJECT, name: "Raw footage", path: "~/Raw footage", git: false }
  const places = async () =>
    (await createEditTools({
      current: () => ({ id: "a1" }) as Agent,
      userId: alice,
      threadId: "t1",
    }).video_edit_places.execute!({} as never, OPTIONS)) as {
      notice?: string
      computers: { folders: Out[] }[]
    }

  it("a hello with clips, without them, and with a field no clip has", async () => {
    expect((await helloWith([folder])).status).toBe(200)
    const clips = [{ n: 1, label: "Intro" }, { n: 2 }, { n: 3, label: "Demo take" }]
    expect((await helloWith([{ ...folder, clips }])).status).toBe(200)
    // Strict: a path, a transcript or a file name is never part of a clip
    expect(
      (await helloWith([{ ...folder, clips: [{ n: 1, path: "/Users/a/x.mov" }] }])).status
    ).toBe(400)
    expect((await helloWith([{ ...folder, clips: [{ n: 0 }] }])).status).toBe(400)
    expect(
      (await helloWith([{ ...folder, clips: [{ n: 1, label: "a\nb" }] }])).status
    ).toBe(400)
    expect(
      (
        await helloWith([
          { ...folder, clips: Array.from({ length: 51 }, (_, i) => ({ n: i + 1 })) },
        ])
      ).status
    ).toBe(400)
  })

  it("video_edit_places lists a folder's clips as the computer's data, only with editing.assembly on", async () => {
    await helloWith([{ ...folder, clips: [{ n: 1, label: "Intro" }, { n: 2 }] }])
    harnessEnv({ KRIYA_EDITING_ASSEMBLY: undefined })
    expect((await places()).computers[0].folders).toEqual([
      { project: PROJECT, name: "Raw footage" },
    ])
    harnessEnv({ KRIYA_EDITING_ASSEMBLY: "on" })
    const on = await places()
    expect(on.notice).toBeTruthy()
    expect(on.computers[0].folders).toEqual([
      {
        project: PROJECT,
        name: "Raw footage",
        clips: [{ n: 1, label: "Intro" }, { n: 2 }],
      },
    ])
    harnessEnv({ KRIYA_EDITING_ASSEMBLY: undefined })
    const tools = createEditTools({
      current: () => ({ id: "a1" }) as Agent,
      userId: alice,
      threadId: "t1",
    })
    expect(tools.video_edit_start.description).toMatch(
      /order of them by those numbers or labels/
    )
  })

  it("an order card is asked, reaches the person, and is answered or defaults like the others", async () => {
    const { job } = await runningJob()
    const order = {
      kind: "order",
      prompt: "Which order did you mean?",
      options: [
        { label: "Clip 2, then clip 1, then clip 3" },
        { label: "Clip 3, then clip 1, then clip 2" },
      ],
      defaultOption: 0,
      timeoutSeconds: 300,
    }
    const res = await askCard(job, mine.token, order)
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    expect((await getInbox(alice)).editCards.map((c) => [c.id, c.kind])).toEqual([
      [id, "order"],
    ])
    expect(await answerEditQuestion(id, 1)).toEqual({ ok: true })
    expect(await (await answerOf(id)).json()).toEqual({ status: "answered", option: 1 })
    const second = (await (await askCard(job, mine.token, order)).json()) as {
      id: string
    }
    await pg.query(
      "update kriya.edit_questions set expires_at = now() - interval '1 second'"
    )
    expect(await (await answerOf(second.id)).json()).toEqual({
      status: "defaulted",
      option: 0,
    })
    // Another person's computer can't ask on this job
    expect((await askCard(job, other.token, order)).status).toBe(404)
  })
})
