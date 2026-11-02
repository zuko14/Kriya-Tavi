import { describe, expect, it } from "vitest"

import { SETTINGS } from "@/lib/config"

// RT-REG-01 (track R), settings part (R1): every rooms.* switch that turns
// something on ships off, and every default passes its own check. The route,
// prompt and belt parts come with the phases that add them (R2, R4).

const defs = SETTINGS as unknown as Record<
  string,
  { env: string | null; fallback?: string; pattern?: RegExp }
>
const ROOM_KEYS = Object.keys(defs).filter((key) => key.startsWith("rooms."))

describe("RT-REG-01: the rooms.* settings", () => {
  it("are the RD-19 block", () => {
    expect(ROOM_KEYS.sort()).toEqual([
      "rooms.agentTurnBudget",
      "rooms.agents",
      "rooms.contextMessages",
      "rooms.enabled",
      "rooms.inviteDays",
      "rooms.maxAgents",
      "rooms.maxHumans",
      "rooms.maxPerPerson",
      "rooms.realtime",
    ])
  })

  it("ship off, with RD-19's defaults", () => {
    expect(defs["rooms.enabled"].fallback).toBe("off")
    expect(defs["rooms.agents"].fallback).toBe("off")
    // Polling until the owner sets Realtime up (RB-03); every switch ships off
    expect(defs["rooms.realtime"].fallback).toBe("off")
    expect(defs["rooms.maxHumans"].fallback).toBe("25")
    expect(defs["rooms.maxAgents"].fallback).toBe("10")
    expect(defs["rooms.maxPerPerson"].fallback).toBe("20")
    expect(defs["rooms.inviteDays"].fallback).toBe("7")
    expect(defs["rooms.agentTurnBudget"].fallback).toBe("4")
    expect(defs["rooms.contextMessages"].fallback).toBe("30")
  })

  it("every default passes its own check, and each reads its own variable", () => {
    for (const key of ROOM_KEYS) {
      const def = defs[key]
      expect(def.env, key).toMatch(/^KRIYA_ROOMS_[A-Z_]+$/)
      if (def.fallback !== undefined && def.pattern)
        expect(def.pattern.test(def.fallback), key).toBe(true)
    }
    // Invites last at most 7 days (the room_invites check)
    expect(defs["rooms.inviteDays"].pattern?.test("8")).toBe(false)
    expect(defs["rooms.maxHumans"].pattern?.test("26")).toBe(false)
  })
})

// RT-REG-01, R4 part: with rooms.* off nothing about agents in rooms runs.
// The prompt and belt of ordinary tasks are pinned by AT-REG-01's snapshot
// and tests/rooms/runner.test.ts (RT-AGT-02); this pins the shared tables.
describe("RT-REG-01: agents in rooms change no shared table", () => {
  it("room_history is R0, writes nothing and never waits for an approval", async () => {
    const { TOOL_CLASSES, TOOL_WRITES, PERSON_ONLY_WRITES } =
      await import("@/lib/agent/policy")
    const { CAPABILITIES, GRANTABLE } = await import("@/lib/agent/capabilities")
    const { TOOL_APPROVALS } = await import("@/lib/agent/run-task")
    const { SIDE_EFFECT_TOOLS } = await import("@/lib/agent/tools")
    expect(TOOL_CLASSES.room_history).toBe("R0")
    expect(TOOL_WRITES.room_history).toEqual([])
    expect(CAPABILITIES.room_history.system).toBe("kriya")
    expect(GRANTABLE.has("room_history")).toBe(false)
    expect(SIDE_EFFECT_TOOLS.has("room_history")).toBe(false)
    expect("room_history" in TOOL_APPROVALS).toBe(false)
    expect(PERSON_ONLY_WRITES).toEqual(
      expect.arrayContaining([
        "rooms",
        "room_members",
        "room_invites",
        "room_agents",
        "room_disclosures",
      ])
    )
    // No tool writes a room table, except R8's room_note_add adding a note
    // (unconfirmed; CHANGE_IMPACT R8 row)
    for (const [tool, writes] of Object.entries(TOOL_WRITES))
      expect(
        writes.filter(
          (w) =>
            w.startsWith("room") && !(tool === "room_note_add" && w === "room_notes+")
        ),
        tool
      ).toEqual([])
  })

  it("untrustedSeen marks only a room request, by its marker", async () => {
    const { untrustedSeen } = await import("@/lib/agent/tools")
    const { ROOM_CONTEXT } = await import("@/lib/rooms/context")
    const user = (text: string) => [
      { role: "user" as const, content: [{ type: "text" as const, text }] },
    ]
    expect(untrustedSeen(user("Recent room messages, said the person"))).toBe(false)
    expect(untrustedSeen(user(`[Room: x]\n\n${ROOM_CONTEXT}\n(none)`))).toBe(true)
  })
})

describe("room_history in the thread and the activity panel", () => {
  it("has its card and its labels (owner, 2026-11-01)", async () => {
    const fs = await import("node:fs")
    expect(fs.readFileSync("components/thread/tool-call.tsx", "utf8")).toMatch(
      /room_history: \{\s*icon: MessagesSquareIcon,\s*label: "read the room"/
    )
    const activity = fs.readFileSync("components/workbench/activity.tsx", "utf8")
    expect(activity).toContain('room_history: "Read earlier messages in the room"')
    expect(activity).toContain('room_history: "read earlier messages in the room"')
  })
})
