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

  // ET-NL-REG-01's server half (ASSEMBLY_AND_INTENT.md §10)
  it("editing.intent ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.intent"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_INTENT: undefined })
    expect(await (await ask()).json()).toMatchObject({ intent: false })
    harnessEnv({ KRIYA_EDITING_INTENT: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      intent: true,
      livePreview: false,
    })
    harnessEnv({ KRIYA_EDITING_INTENT: undefined })
  })

  it("says nothing while editing.studio is off, even with intent on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_INTENT: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_INTENT: undefined })
  })

  // ET-FX-REG-01's server half (CRAFT_UPGRADE.md §3)
  it("editing.craft ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.craft"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_CRAFT: undefined })
    expect(await (await ask()).json()).toMatchObject({ craft: false })
    harnessEnv({ KRIYA_EDITING_CRAFT: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      craft: true,
      intent: false,
    })
    harnessEnv({ KRIYA_EDITING_CRAFT: undefined })
  })

  it("says nothing while editing.studio is off, even with craft on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_CRAFT: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_CRAFT: undefined })
  })

  // ET-TY-REG-01's server half (CRAFT_UPGRADE.md §5)
  it("editing.typeKit ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.typeKit"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_TYPE_KIT: undefined })
    expect(await (await ask()).json()).toMatchObject({ typeKit: false })
    harnessEnv({ KRIYA_EDITING_TYPE_KIT: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      typeKit: true,
      craft: false,
    })
    harnessEnv({ KRIYA_EDITING_TYPE_KIT: undefined })
  })

  it("says nothing while editing.studio is off, even with typeKit on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_TYPE_KIT: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_TYPE_KIT: undefined })
  })

  // ET-RF2-REG-01's server half (CRAFT_UPGRADE.md §4)
  it("editing.referenceIntent ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.referenceIntent"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_REFERENCE_INTENT: undefined })
    expect(await (await ask()).json()).toMatchObject({ referenceIntent: false })
    harnessEnv({ KRIYA_EDITING_REFERENCE_INTENT: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      referenceIntent: true,
      typeKit: false,
    })
    harnessEnv({ KRIYA_EDITING_REFERENCE_INTENT: undefined })
  })

  it("says nothing while editing.studio is off, even with referenceIntent on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_REFERENCE_INTENT: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_REFERENCE_INTENT: undefined })
  })

  // ET-DL-REG-01's server half (CRAFT_UPGRADE.md §6)
  it("editing.directorLoop ships off, and on it is reported", async () => {
    const defs = SETTINGS as unknown as Record<string, { fallback?: string }>
    expect(defs["editing.directorLoop"].fallback).toBe("off")
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_DIRECTOR_LOOP: undefined })
    expect(await (await ask()).json()).toMatchObject({ directorLoop: false })
    harnessEnv({ KRIYA_EDITING_DIRECTOR_LOOP: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      directorLoop: true,
      referenceIntent: false,
    })
    harnessEnv({ KRIYA_EDITING_DIRECTOR_LOOP: undefined })
  })

  // TP11 (rule 17): an order across clips only with both editing.tavi and editing.assembly on
  it("taviOrder is true only with editing.tavi and editing.assembly both on", async () => {
    harnessEnv({
      KRIYA_EDITING_STUDIO: "on",
      KRIYA_EDITING_TAVI: undefined,
      KRIYA_EDITING_ASSEMBLY: undefined,
    })
    expect(await (await ask()).json()).toMatchObject({ taviOrder: false })
    harnessEnv({ KRIYA_EDITING_TAVI: "on" })
    expect(await (await ask()).json()).toMatchObject({ taviOrder: false })
    harnessEnv({ KRIYA_EDITING_TAVI: undefined, KRIYA_EDITING_ASSEMBLY: "on" })
    expect(await (await ask()).json()).toMatchObject({ taviOrder: false, assembly: true })
    harnessEnv({ KRIYA_EDITING_TAVI: "on" })
    expect(EditingFeaturesResponse.parse(await (await ask()).json())).toMatchObject({
      taviOrder: true,
      assembly: true,
    })
    harnessEnv({ KRIYA_EDITING_TAVI: undefined, KRIYA_EDITING_ASSEMBLY: undefined })
  })

  it("says nothing while editing.studio is off, even with directorLoop on", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: undefined, KRIYA_EDITING_DIRECTOR_LOOP: "on" })
    expect((await ask()).status).toBe(404)
    harnessEnv({ KRIYA_EDITING_DIRECTOR_LOOP: undefined })
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
      intent: false,
      craft: false,
      typeKit: false,
      referenceIntent: false,
      directorLoop: false,
      taviOrder: false,
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
      intent: false,
      craft: false,
      typeKit: false,
      referenceIntent: false,
      directorLoop: false,
      taviOrder: false,
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
      intent: false,
      craft: false,
      typeKit: false,
      referenceIntent: false,
      directorLoop: false,
      taviOrder: false,
    })
  })

  it("refuses without a device", async () => {
    harnessEnv({ KRIYA_EDITING_STUDIO: "on", KRIYA_EDITING_VISUALS: "on" })
    expect((await ask("not-a-token")).status).toBe(401)
  })
})
