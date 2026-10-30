"use server"

import { revalidatePath } from "next/cache"
import { z, ZodError } from "zod"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import {
  createGatewayModel,
  isGatewayConfigured,
  ModelConfigError,
  modelForTier,
} from "@/lib/models"
import { allowAll, clientIp } from "@/lib/rate-limit"
import {
  approveSkill as approve,
  deleteSkill as remove,
  designSkill as design,
  designsToday,
  restoreSkill as restore,
  retireSkill as retire,
  saveSkill as save,
  studioOn,
  StudioError,
} from "@/lib/skill-studio"
import { editSchema, intentSchema } from "@/lib/skill-studio/design"

// Skill Studio (docs/next-platform/SKILL_STUDIO.md). Identity from the
// session only; every write through withUser. Designing is the only action
// that calls a model: rate limited per address and account, capped per day
// in SQL. Approving is the person's alone; no agent tool reaches these.

type Failed = { error: string }

const skillId = z.string().regex(/^my-[a-z0-9]{10}$/)
const agentIds = z.array(z.string().min(1).max(32)).max(20)

async function expected<T>(work: () => Promise<T>): Promise<T | Failed> {
  try {
    if (!(await studioOn())) return { error: "Skill Studio isn't available yet." }
    return await work()
  } catch (error) {
    if (error instanceof ZodError)
      return { error: error.issues[0]?.message ?? "Check the form and try again." }
    if (error instanceof StudioError) return { error: error.message }
    if (error instanceof ModelConfigError)
      return { error: "Kriya can't reach its models right now. Try again later." }
    throw error
  }
}

const done = <T>(value: T) => {
  revalidatePath("/agents/skills")
  return value
}

export async function designSkill(intent: string) {
  const user = await requireUser()
  return expected(async () => {
    const text = intentSchema.parse(intent)
    if (!isGatewayConfigured())
      throw new StudioError("Kriya can't reach its models right now. Try again later.")
    const daily = Number(await getSetting("next.skillStudioDaily"))
    if ((await designsToday(user.id)) >= daily)
      throw new StudioError(`That's ${daily} designs today. Try again tomorrow.`)
    const ok = await allowAll([
      [`skill-studio:ip:${await clientIp()}`, 20, 3600],
      [`skill-studio:design:${user.id}`, 5, 3600],
    ])
    if (!ok) throw new StudioError("Too many designs. Wait a little and try again.")
    const modelId =
      (await getSetting("next.skillStudioModel")) ?? (await modelForTier("balanced"))
    const row = await design({
      userId: user.id,
      intent: text,
      model: createGatewayModel(modelId),
      unicode: (await getSetting("next.skillsV2")) === "on",
    })
    return done({ id: row.id })
  })
}

export async function saveSkill(id: string, edit: unknown) {
  const user = await requireUser()
  return expected(async () => {
    await save(user.id, skillId.parse(id), editSchema.parse(edit))
    return done({ ok: true as const })
  })
}

export async function approveSkill(id: string, agents: unknown) {
  const user = await requireUser()
  return expected(async () => {
    await approve(user.id, skillId.parse(id), agentIds.parse(agents))
    revalidatePath("/", "layout")
    return done({ ok: true as const })
  })
}

export async function retireSkill(id: string) {
  const user = await requireUser()
  return expected(async () => {
    await retire(user.id, skillId.parse(id))
    revalidatePath("/", "layout")
    return done({ ok: true as const })
  })
}

export async function restoreSkill(id: string) {
  const user = await requireUser()
  return expected(async () => {
    await restore(user.id, skillId.parse(id))
    return done({ ok: true as const })
  })
}

export async function deleteSkill(id: string) {
  const user = await requireUser()
  return expected(async () => {
    await remove(user.id, skillId.parse(id))
    revalidatePath("/", "layout")
    return done({ ok: true as const })
  })
}
