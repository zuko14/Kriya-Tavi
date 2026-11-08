import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }))

import { POST as reserveRoute } from "@/app/api/harness/v1/editing/jobs/[id]/previews/route"
import { POST as finishRoute } from "@/app/api/harness/v1/editing/jobs/[id]/previews/[pid]/route"
import { SETTINGS } from "@/lib/config"
import { reviewEdits } from "@/lib/editing/jobs"
import { queue } from "@/lib/harness/control"

import { call, deviceFor, harnessDb, harnessEnv } from "../harness/setup"

// ET-REG-01, the server's half: with every editing.* setting off, no new route
// answers, nothing can queue an edit, the belt and pages take no new branch.

const ROOT = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")
const defs = SETTINGS as unknown as Record<
  string,
  { fallback?: string; pattern?: RegExp }
>

let token: string
let user: string
let deviceId: string

beforeAll(async () => {
  const db = await harnessDb()
  user = await db.createUser()
  ;({ token, deviceId } = await deviceFor(db.pg, user))
})
beforeEach(() => harnessEnv())

describe("ET-REG-01", () => {
  it("every on/off key ships off, and the numbers are the agreed ones", () => {
    for (const key of ["editing.tavi", "editing.previews"])
      expect(defs[key].fallback, key).toBe("off")
    expect(defs["editing.previewMaxBytes"].fallback).toBe("47185920")
    expect(defs["editing.previewDays"].fallback).toBe("14")
    expect(defs["editing.dailyJobs"].fallback).toBe("20")
    expect(defs["editing.jobLostMinutes"].fallback).toBe("30")
  })

  it("the device routes answer 404", async () => {
    const job = crypto.randomUUID()
    expect(
      (
        await reserveRoute(
          call("POST", `/editing/jobs/${job}/previews`, {
            token,
            body: { kind: "preview", bytes: 1, sha256: "a".repeat(64) },
          })
        )
      ).status
    ).toBe(404)
    expect(
      (
        await finishRoute(
          call("POST", `/editing/jobs/${job}/previews/${crypto.randomUUID()}`, { token })
        )
      ).status
    ).toBe(404)
  })

  it("nothing a person queues can be an edit", async () => {
    await expect(queue(user, deviceId, "edit", {})).rejects.toMatchObject({
      code: "not_allowed",
    })
  })

  it("the belt, the page and the worker each take the switch", () => {
    expect(read("lib/agent/run-task.ts")).toMatch(
      /\(await getSetting\("editing\.tavi"\)\) === "on" \? createEditTools\(env\) : \{\}/
    )
    expect(read("app/(workspace)/harness/page.tsx")).toMatch(
      /\(await on\("editing\.tavi"\)\) \? await listEdits/
    )
    expect(read("worker/index.ts")).toMatch(
      /\(await getSetting\("editing\.tavi"\)\) === "on"\) await reviewEdits\(\)/
    )
    expect(read("components/dialogs/agent-dialog.tsx")).toMatch(
      /features\.editing\s+\? \[\.\.\.agentTemplates, VIDEO_EDITOR\]\s+: agentTemplates/
    )
    // lib/templates.ts and the prompt stay as they are (EH-11, EH-38)
    expect(read("lib/templates.ts")).not.toMatch(/Video editor/)
    expect(read("lib/agent/instructions.ts")).not.toMatch(/video_edit/)
  })

  it("the pass with no jobs does nothing", async () => {
    await expect(reviewEdits()).resolves.toBeUndefined()
  })
})
