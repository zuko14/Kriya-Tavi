import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { Transcript } from "@/components/thread/transcript"
import { WhatIDidCard, type WhatIDidRecord } from "@/components/thread/what-i-did"
import type { KriyaMessage } from "@/lib/agent/tools"

// What the thread shows (A3): a schedule's run is labelled "Scheduled run",
// never as the person; "What I did" shows ✓ only for checked actions, and
// greys out or warns about the rest. Server actions are stubbed: rendering
// on the server runs no effects, so none would be called anyway.

vi.mock("@/actions/inbox", () => ({
  whatIDid: async () => ({ receipts: false, records: [] }),
  verifyMyRecords: async () => null,
  deleteRecord: async () => ({ ok: true }),
}))
vi.mock("@/actions/memory", () => ({
  usedMemories: async () => [],
  confirmMemory: async () => null,
  forgetForGood: async () => null,
}))
vi.mock("@/actions/goals", () => ({ changeGoal: async () => ({ ok: true }) }))
vi.mock("@/actions/schedules", () => ({ changeSchedule: async () => ({ ok: true }) }))
vi.mock("@/actions/quotes", () => ({ setCap: async () => ({ ok: true }) }))
vi.mock("@/actions/skills", () => ({
  approveSkill: async () => ({ ok: true }),
  retireSkill: async () => ({ ok: true }),
  resetSkill: async () => ({ ok: true }),
}))
vi.mock("@/actions/share", () => ({
  receiptPdf: async () => ({ error: "off" }),
  createShare: async () => ({ error: "off" }),
}))
vi.mock("@/actions/undo", () => ({
  undoExecution: async () => ({ ok: true }),
  undoStatus: async () => null,
}))

const text = (id: string, body: string, metadata?: KriyaMessage["metadata"]) =>
  ({ id, role: "user", parts: [{ type: "text", text: body }], metadata }) as KriyaMessage

describe("thread rendering", () => {
  it('labels a schedule\'s message "Scheduled run", and only that one', () => {
    const html = renderToStaticMarkup(
      createElement(Transcript, {
        messages: [
          text("m1", "Plan my week", { channel: "schedule", scheduleId: "s1" }),
          text("m2", "Thanks"),
        ],
        members: [{ id: "a1", name: "Disha", role: "Study", glyph: "g", model: null }],
        status: "ready",
        isSquad: false,
        empty: null,
      })
    )
    expect(html.match(/Scheduled run/g)).toHaveLength(1)
    expect(html.indexOf("Scheduled run")).toBeLessThan(html.indexOf("Plan my week"))
    expect(html.indexOf("Plan my week")).toBeLessThan(html.indexOf("Thanks"))
  })

  it("shows checked actions, not-confirmed claims and unsupported quotes apart", () => {
    const record = {
      id: "00000000-0000-0000-0000-000000000001",
      taskId: "00000000-0000-0000-0000-000000000002",
      threadId: "t1",
      seq: 3,
      hash: null,
      done: [
        {
          executionId: "e1",
          tool: "schedule_create",
          title: "Started a schedule: Every Monday at 9:00 am",
          risk: "R2",
          verification: {
            status: "verified",
            method: "api_readback",
            evidence: [{ kind: "provider_id", value: "abcdefghijkl" }],
          },
        },
      ],
      unconfirmed: [
        { claim: "I emailed Ravi.", reason: "Kriya can't send email or post." },
      ],
      checks: [
        { sentence: "Fee is ₹1,500.", status: "unsupported", reason: "No citation." },
        { sentence: "Closes 7 Oct [1].", status: "supported" },
      ],
      titles: null,
      createdAt: new Date("2026-10-18T08:30:00Z"),
      deletedAt: null,
      chargeMicroInr: null,
      chargeStatus: null,
    } as WhatIDidRecord
    const html = renderToStaticMarkup(
      createElement(WhatIDidCard, { record, receipts: false })
    )
    expect(html).toContain("Started a schedule: Every Monday at 9:00 am")
    expect(html).toContain('aria-label="checked"')
    expect(html).toContain("not confirmed: Kriya can&#x27;t send email or post.")
    expect(html).toContain("Unsupported: “Fee is ₹1,500.”")
    expect(html).not.toContain("Closes 7 Oct")
    expect(html).not.toContain("record #3")
  })
})
