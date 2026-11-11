import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { GET } from "@/app/api/harness/v1/editing/features/route"
import { SETTINGS } from "@/lib/config"
import { EditingFeaturesResponse, ROUTES } from "@/lib/harness/contract"

import { call, deviceFor, harnessDb, harnessEnv } from "../harness/setup"

// ET-VS-REG-01's server half (VISUAL_SCENES.md): the switch ships off, off says no, and a
// computer can't ask without a device.

let token: string
const ask = (withToken: string | undefined = token) =>
  GET(call("GET", "/editing/features", { token: withToken }))

beforeAll(async () => {
  const db = await harnessDb()
  ;({ token } = await deviceFor(db.pg, await db.createUser()))
})

describe("/editing/features", () => {
  it("editing.motion ships off, and on it is reported with custom motion apart", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.motion"].fallback).toBe("off")
    expect(defs["editing.customMotion"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_MOTION: "on" })
    expect(await (await ask()).json()).toMatchObject({
      motion: true,
      customMotion: false,
    })
    harnessEnv({ KRIYA_EDITING_MOTION: undefined, KRIYA_EDITING_CUSTOM_MOTION: "on" })
    expect(await (await ask()).json()).toMatchObject({
      motion: false,
      customMotion: true,
    })
    harnessEnv({ KRIYA_EDITING_CUSTOM_MOTION: undefined })
  })

  // ET-ASM-REG-01's server half (ASSEMBLY_AND_INTENT.md §10)
  it("editing.assembly ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.assembly"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_ASSEMBLY: undefined })
    expect(await (await ask()).json()).toMatchObject({ assembly: false })
    harnessEnv({ KRIYA_EDITING_ASSEMBLY: "on" })
    const res = await ask()
    expect(EditingFeaturesResponse.parse(await res.json())).toMatchObject({
      assembly: true,
      motion: false,
    })
    harnessEnv({ KRIYA_EDITING_ASSEMBLY: undefined })
  })

  it("says nothing while editing.studio is off, even with assembly on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_ASSEMBLY: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_ASSEMBLY: undefined })
  })

  // ET-PV-REG-01's server half (CRAFT_UPGRADE.md §2)
  it("editing.livePreview ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.livePreview"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_LIVE_PREVIEW: undefined })
    expect(await (await ask()).json()).toMatchObject({ livePreview: false })
    harnessEnv({ KRIYA_EDITING_LIVE_PREVIEW: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      livePreview: true,
      assembly: false,
    })
    harnessEnv({ KRIYA_EDITING_LIVE_PREVIEW: undefined })
  })

  it("says nothing while editing.studio is off, even with livePreview on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_LIVE_PREVIEW: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_LIVE_PREVIEW: undefined })
  })

  it("is in the contract, and editing.visuals ships off", () => {
    expect(ROUTES.some((r) => r.path === "/editing/features" && r.auth)).toBe(true)
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.visuals"].fallback).toBe("off")
  })

  it("says nothing while editing.studio is off, even with visuals on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_VISUALS: "on" })
    expect((await ask()).status).toBe(404)
  })

  it("answers false with the studio on and visuals off", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_VISUALS: undefined })
    const res = await ask()
    expect(res.status).toBe(200)
    expect(EditingFeaturesResponse.parse(await res.json())).toEqual({
      visuals: false,
      playbooks: false,
      mediaSearch: false,
      motion: false,
      customMotion: false,
      assembly: false,
      livePreview: false,
    })
  })

  it("answers true only when both are on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_VISUALS: "on" })
    expect(await (await ask()).json()).toEqual({
      visuals: true,
      playbooks: false,
      mediaSearch: false,
      motion: false,
      customMotion: false,
      assembly: false,
      livePreview: false,
    })
    harnessEnv({ KRIYA_EDITING_VISUALS: undefined, KRIYA_EDITING_PLAYBOOKS: "on" })
    expect(await (await ask()).json()).toEqual({
      visuals: false,
      playbooks: true,
      mediaSearch: false,
      motion: false,
      customMotion: false,
      assembly: false,
      livePreview: false,
    })
  })

  it("refuses without a device", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_VISUALS: "on" })
    expect((await ask("not-a-token")).status).toBe(401)
  })
})
