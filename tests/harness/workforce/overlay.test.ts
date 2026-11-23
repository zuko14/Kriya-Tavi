import { randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Harness 2.0 W11 (docs/kriya-harness/upgrade_2.0/SELF_EVOLUTION.md §6;
// WD-09, WD-15): approved versions, the overlay with canary buckets, one-click
// rollback, outcome counts from the mirror and the guard. WT-OV-01…07.

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

import * as sessions from "@/app/api/harness/v1/sessions/route"
import * as turns from "@/app/api/harness/v1/sessions/[id]/turns/route"
import * as models from "@/app/api/harness/v1/models/route"
import { privileged } from "@/db"
import { harnessCartridgeCandidates } from "@/db/schema"
import { TurnRequest } from "@/lib/harness/contract"
import { buildCandidate, loadIncumbent } from "@/lib/harness/scout/draft"
import { benchCandidate, decideCandidate } from "@/lib/harness/scout/proposal"
import {
  canaryBucket,
  canaryVersion,
  guardCanaries,
  guardVerdict,
  promoteVersion,
  rollbackVersion,
  wilson,
} from "@/lib/harness/scout/versions"
import { deviceSkills, etagOf } from "@/lib/harness/skills"

import type { TestDb } from "../../db/harness"
import { call, deviceFor, harnessDb, harnessEnv } from "../setup"

let pg: TestDb
let newUser: () => Promise<string>
let owner: string

const ID = "kriya-role-frontend"
const LINE = "- Use `:focus-visible` for focus styles, so only the keyboard draws a ring."
const body = (tag = "") =>
  loadIncumbent(ID).body.replace(
    "- Every image has `alt`",
    `${LINE}${tag}\n- Every image has \`alt\``
  )

const TASKS = Array.from({ length: 12 }, (_, i) => `fe-task-${i}`)
const report = (passes: number, run: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    seedVersion: "99da9e832cf6",
    agent: "kriya run --mode auto",
    results: TASKS.map((id, i) => ({
      id,
      kind: "fix",
      level: "multi",
      status: i < passes ? "passed" : "failed",
      escaped: false,
      leaked: false,
      tampered: false,
      constraintBroken: false,
      agentTimedOut: false,
      durationMs: 1000,
      costMicroInr: "1000",
    })),
    finishedAt: `2026-11-23T0${run}:00:00.000Z`,
    ...extra,
  })

/** A candidate taken through bench and approval: a stored version */
async function approvedVersion(tag = "", keywords: string[] = []) {
  const { values } = buildCandidate(
    loadIncumbent(ID),
    { body: body(tag), addedKeywords: keywords },
    []
  )
  const [c] = await privileged
    .insert(harnessCartridgeCandidates)
    .values({ ...values, findingIds: ["00000000-0000-4000-8000-000000000001"] })
    .returning()
  const ran = { cartridgeCandidate: { id: c.id, cartridgeId: ID, sha256: c.bodySha256 } }
  await benchCandidate(
    c.id,
    [0, 1, 2].map((r) => report(4, r)),
    [0, 1, 2].map((r) => report(12, r, ran)),
    owner
  )
  await decideCandidate(c.id, "approve", owner)
  const { rows } = await pg.query<{ id: string; version: string }>(
    "select id, version from kriya.harness_cartridge_versions where candidate_id = $1",
    [c.id]
  )
  return rows[0]
}

const ON = {
  KRIYA_HARNESS_DEFAULT_SKILLS: "on",
  KRIYA_HARNESS_WORKFORCE: "on",
  KRIYA_HARNESS_CARTRIDGE_OVERLAY: "on",
  KRIYA_HARNESS_MIRROR: "on",
}
const device = (deviceId = randomUUID()) => ({ id: owner, deviceId, agentId: null })
const served = async (d = device()) => {
  const { skills, load } = await deviceSkills(d)
  const item = skills.find((s) => s.id === ID)!
  return { item, etag: etagOf(skills), text: load(ID, item.version) }
}

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(async () => {
  harnessEnv(ON)
  await pg.exec(
    "delete from kriya.harness_cartridge_outcomes; delete from kriya.harness_cartridge_versions; delete from kriya.harness_cartridge_candidates"
  )
  owner = await newUser()
})

describe("WT-OV: versions, overlay, rollback, outcomes, guard", () => {
  it("WT-OV-01: overlay off serves the repository's cartridges, with the same list and ETag, whatever is stored", async () => {
    harnessEnv({ ...ON, KRIYA_HARNESS_CARTRIDGE_OVERLAY: "off" })
    const before = await served()
    const v = await approvedVersion("", ["focus ring"])
    await promoteVersion(v.id, owner)
    const after = await served()
    expect(after.etag).toBe(before.etag)
    expect(after.item.version).toBe("1.0.0")
    expect(after.text).not.toContain(LINE)
    // On: the active version, its body and its added keyword; the ETag changes
    harnessEnv(ON)
    const on = await served()
    expect(on.item.version).toBe(v.version)
    expect(on.item.version).toBe("1.0.1")
    expect(on.text).toContain(LINE)
    expect(on.item.activation.keywords).toContain("focus ring")
    expect((on.item as { cartridge?: { role: string } }).cartridge?.role).toBe("frontend")
    expect(on.etag).not.toBe(before.etag)
  })

  it("WT-OV-02: canary buckets are stable per device and serve about their share", async () => {
    const v = await approvedVersion()
    const d = randomUUID()
    expect(canaryBucket(d, v.id)).toBe(canaryBucket(d, v.id))
    await canaryVersion(v.id, 10, owner)
    const devices = Array.from({ length: 1000 }, () => randomUUID())
    let got = 0
    for (const id of devices) if (canaryBucket(id, v.id) < 10) got++
    expect(got).toBeGreaterThan(70)
    expect(got).toBeLessThan(130)
    const inside = devices.find((id) => canaryBucket(id, v.id) < 10)!
    const outside = devices.find((id) => canaryBucket(id, v.id) >= 10)!
    expect((await served(device(inside))).item.version).toBe(v.version)
    expect((await served(device(outside))).item.version).toBe("1.0.0")
    // Widening keeps every device already in: its bucket is under the larger share too
    await canaryVersion(v.id, 50, owner)
    expect((await served(device(inside))).item.version).toBe(v.version)
    await expect(canaryVersion(v.id, 10, owner)).rejects.toThrow(/only grows/)
    await expect(canaryVersion(v.id, 33, owner)).rejects.toThrow(/10, 50 or 100/)
  })

  it("WT-OV-03: outcome counts are written once per turn, by stored version, only with the switches on", async () => {
    const v = await approvedVersion()
    await promoteVersion(v.id, owner)
    const { token, deviceId } = await deviceFor(pg, owner)
    const agentId = `ag-${deviceId.slice(0, 8)}`
    await pg.query(
      "insert into kriya.agents (id, user_id, name, role, glyph) values ($1, $2, 'Arjun', 'engineer', 'g')",
      [agentId, owner]
    )
    await pg.query(
      "update kriya.harness_devices set mirror = 'summary', agent_id = $1 where id = $2",
      [agentId, deviceId]
    )
    const opened = await (
      await sessions.POST(
        call("POST", "/sessions", {
          token,
          body: { deviceSessionId: "s-ov", project: "p", title: "t" },
        })
      )
    ).json()
    const counts = [
      {
        cartridgeId: ID,
        version: v.version,
        verified: 3,
        blocked: 1,
        notChecked: 0,
        undone: 0,
      },
      // A version Kriya never stored is dropped
      {
        cartridgeId: ID,
        version: "9.9.9",
        verified: 5,
        blocked: 0,
        notChecked: 0,
        undone: 0,
      },
    ]
    const send = (seq: number, outcomes = counts) =>
      turns.POST(
        call("POST", `/sessions/${opened.sessionId}/turns`, {
          token,
          body: { seq, text: "done", tools: [], cartridgeOutcomes: outcomes },
        })
      )
    expect((await send(0)).status).toBe(204)
    // The same seq again adds nothing
    expect((await send(0)).status).toBe(204)
    expect((await send(1)).status).toBe(204)
    const { rows } = await pg.query(
      "select version_id, verified, blocked from kriya.harness_cartridge_outcomes"
    )
    expect(rows).toEqual([{ version_id: v.id, verified: 6, blocked: 2 }])
    // Workforce off: the field is taken (contract) but nothing is written
    harnessEnv({ ...ON, KRIYA_HARNESS_WORKFORCE: "off" })
    expect((await send(2)).status).toBe(204)
    expect(
      (
        await pg.query(
          "select sum(verified)::int as n from kriya.harness_cartridge_outcomes"
        )
      ).rows
    ).toEqual([{ n: 6 }])
    // Counts only: no other field, no text
    expect(
      TurnRequest.safeParse({
        seq: 3,
        text: "",
        tools: [],
        cartridgeOutcomes: [{ ...counts[0], note: "x" }],
      }).success
    ).toBe(false)
    expect(
      TurnRequest.safeParse({
        seq: 3,
        text: "",
        tools: [],
        cartridgeOutcomes: Array(21).fill(counts[0]),
      }).success
    ).toBe(false)
    // The advert: only with harness.workforce on
    const advert = async () =>
      (await (await models.GET(call("GET", "/models", { token }))).json()).workforce
    expect(await advert()).toBeUndefined()
    harnessEnv(ON)
    expect(await advert()).toBe(1)
  })

  it("WT-OV-04: one active and one canary per cartridge; promoting supersedes", async () => {
    const a = await approvedVersion("a")
    const b = await approvedVersion("b")
    expect([a.version, b.version]).toEqual(["1.0.1", "1.0.2"])
    await canaryVersion(a.id, 10, owner)
    await expect(canaryVersion(b.id, 10, owner)).rejects.toThrow(/already a canary/)
    await expect(
      pg.query(
        "update kriya.harness_cartridge_versions set status = 'canary', canary_pct = 10 where id = $1",
        [b.id]
      )
    ).rejects.toThrow(/harness_cartridge_one_canary/)
    await promoteVersion(a.id, owner)
    await promoteVersion(b.id, owner)
    const { rows } = await pg.query(
      "select version, status from kriya.harness_cartridge_versions order by version"
    )
    expect(rows).toEqual([
      { version: "1.0.1", status: "superseded" },
      { version: "1.0.2", status: "active" },
    ])
  })

  it("WT-OV-05: rollback serves the previous version on the next fetch and changes the ETag; nothing is deleted", async () => {
    const a = await approvedVersion("a")
    const b = await approvedVersion("b")
    await promoteVersion(a.id, owner)
    await promoteVersion(b.id, owner)
    const before = await served()
    expect(before.item.version).toBe("1.0.2")
    await rollbackVersion(b.id, owner)
    const after = await served()
    expect(after.item.version).toBe("1.0.1")
    expect(after.etag).not.toBe(before.etag)
    // Rolling back the last one serves the repository's cartridge
    await rollbackVersion(a.id, owner)
    expect((await served()).item.version).toBe("1.0.0")
    expect(
      (await pg.query("select count(*)::int as n from kriya.harness_cartridge_versions"))
        .rows
    ).toEqual([{ n: 2 }])
    await expect(rollbackVersion(a.id, owner)).rejects.toThrow(/isn't served/)
    const { rows } = await pg.query<{ action: string }>(
      "select action from kriya.audit_events where target_id = any($1) order by id",
      [[a.id, b.id]]
    )
    expect(rows.map((r) => r.action)).toEqual([
      "harness.version.promote",
      "harness.version.promote",
      "harness.version.rollback",
      "harness.version.rollback",
    ])
  })

  it("WT-OV-06: the guard waits below 100 steps and rolls back only a canary that is shown worse", async () => {
    expect(wilson(90, 100, "lower")).toBeLessThan(0.9)
    expect(wilson(90, 100, "upper")).toBeGreaterThan(0.9)
    expect(guardVerdict({ verified: 10, steps: 99 }, { verified: 99, steps: 100 })).toBe(
      "wait"
    )
    expect(guardVerdict({ verified: 10, steps: 200 }, undefined)).toBe("wait")
    expect(guardVerdict({ verified: 10, steps: 200 }, { verified: 50, steps: 99 })).toBe(
      "wait"
    )
    expect(guardVerdict({ verified: 85, steps: 100 }, { verified: 90, steps: 100 })).toBe(
      "keep"
    )
    expect(guardVerdict({ verified: 50, steps: 100 }, { verified: 90, steps: 100 })).toBe(
      "rollback"
    )
    const active = await approvedVersion("a")
    const canary = await approvedVersion("b")
    await promoteVersion(active.id, owner)
    await canaryVersion(canary.id, 10, owner)
    const { deviceId } = await deviceFor(pg, owner)
    const counts = (version: string, verified: number, blocked: number) =>
      pg.query(
        "insert into kriya.harness_cartridge_outcomes (user_id, device_id, version_id, day, verified, blocked) values ($1, $2, $3, '2026-11-23', $4, $5)",
        [owner, deviceId, version, verified, blocked]
      )
    await counts(active.id, 90, 10)
    await counts(canary.id, 40, 50)
    // 90 steps on the canary: wait
    expect(await guardCanaries()).toEqual([])
    await pg.query(
      "update kriya.harness_cartridge_outcomes set blocked = 60 where version_id = $1",
      [canary.id]
    )
    expect(await guardCanaries()).toEqual([canary.id])
    const { rows } = await pg.query(
      "select status from kriya.harness_cartridge_versions where id = $1",
      [canary.id]
    )
    expect(rows).toEqual([{ status: "rolled_back" }])
    const audit = await pg.query(
      "select actor_id, action from kriya.audit_events where target_id = $1 order by id desc limit 1",
      [canary.id]
    )
    expect(audit.rows).toEqual([
      { actor_id: null, action: "harness.version.auto_rollback" },
    ])
  })

  it("WT-OV-07: a version never changes, follows its edges, and only the person's outcomes are theirs", async () => {
    const v = await approvedVersion()
    await expect(
      pg.query("update kriya.harness_cartridge_versions set body = 'x' where id = $1", [
        v.id,
      ])
    ).rejects.toThrow(/never changes/)
    await expect(
      pg.query(
        "update kriya.harness_cartridge_versions set manifest = '{}' where id = $1",
        [v.id]
      )
    ).rejects.toThrow(/never changes/)
    await rollbackVersion(v.id, owner)
    await expect(
      pg.query(
        "update kriya.harness_cartridge_versions set status = 'active' where id = $1",
        [v.id]
      )
    ).rejects.toThrow(/can't go from rolled_back to active/)
    // Client roles: versions are server only; outcomes are per person
    const other = await newUser()
    const { deviceId } = await deviceFor(pg, owner)
    await pg.query(
      "insert into kriya.harness_cartridge_outcomes (user_id, device_id, version_id, day, verified) values ($1, $2, $3, '2026-11-23', 1)",
      [owner, deviceId, v.id]
    )
    const { asUser } = await import("../../db/harness")
    const seen = (user: string, q: string) =>
      asUser(pg, user, (tx) => tx.query(q)).then(
        (r) => r.rows,
        (e) => String(e)
      )
    expect(
      await seen(other, "select version_id from kriya.harness_cartridge_outcomes")
    ).toEqual([])
    expect(
      await seen(owner, "select verified from kriya.harness_cartridge_outcomes")
    ).toEqual([{ verified: 1 }])
    const versions = await seen(owner, "select id from kriya.harness_cartridge_versions")
    expect(Array.isArray(versions) ? versions : []).toEqual([])
  })
})
