"use server"

import { count, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { privileged, withUser } from "@/db"
import {
  agents,
  auditEvents,
  plans,
  profileInputSchema,
  profiles,
  tasks,
  threads,
} from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { cancelSubscription, simulateTestPayment, startCheckout } from "@/lib/billing"
import { getSetting } from "@/lib/config"
import { getPlan } from "@/lib/entitlements"
import { log } from "@/lib/log"
import { PERSON_NOTE_MAX } from "@/lib/memory/person"
import { allow } from "@/lib/rate-limit"
import { createSupabase, createSupabaseAdmin } from "@/lib/supabase"
import { createTeam, TeamError } from "@/lib/teams"
import { templatesFor } from "@/lib/templates"

export type FormState = { error?: string; message?: string } | null

function field(form: FormData, name: string) {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

function parseProfile(form: FormData) {
  return profileInputSchema.safeParse({
    displayName: field(form, "displayName"),
    locale: field(form, "locale") || "en-IN",
    useCase: field(form, "useCase") || undefined,
  })
}

export async function saveProfile(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser()
  const parsed = parseProfile(form)
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  await withUser(user.id, (tx) =>
    tx
      .update(profiles)
      .set({
        displayName: parsed.data.displayName,
        locale: parsed.data.locale,
        useCase: parsed.data.useCase ?? null,
      })
      .where(eq(profiles.id, user.id))
  )
  revalidatePath("/", "layout")
  return { message: "Saved." }
}

// First run: who you are, then a first agent that fits, then straight into it
export async function completeOnboarding(
  _: FormState,
  form: FormData
): Promise<FormState> {
  const user = await requireUser()
  const parsed = parseProfile(form)
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const destination = await withUser(user.id, async (tx) => {
    await tx
      .update(profiles)
      .set({
        displayName: parsed.data.displayName,
        locale: parsed.data.locale,
        useCase: parsed.data.useCase ?? null,
        onboardedAt: new Date(),
      })
      .where(eq(profiles.id, user.id))
    const [existing] = await tx.select({ n: count() }).from(agents)
    if ((existing?.n ?? 0) > 0) return "/home"
    const template = templatesFor(parsed.data.useCase)[0]
    const [agent] = await tx
      .insert(agents)
      .values({
        id: nanoid(12),
        userId: user.id,
        name: template.name,
        role: template.role,
        instructions: template.instructions,
      })
      .returning({ id: agents.id })
    const [thread] = await tx
      .insert(threads)
      .values({ id: nanoid(12), userId: user.id, agentId: agent.id })
      .returning({ id: threads.id })
    return `/a/${agent.id}/${thread.id}`
  })
  revalidatePath("/", "layout")
  redirect(destination)
}

// "Meet your team" (A2, behind agents.rolePacks): who you are, the role
// pack's agents you chose, and optionally a few things about you. The pack,
// the plan's agent limit and the switch are all checked here, not in the form.
export async function completeTeamOnboarding(
  _: FormState,
  form: FormData
): Promise<FormState> {
  const user = await requireUser()
  if ((await getSetting("agents.rolePacks")) !== "on") {
    return { error: "Teams aren't available yet. Reload the page." }
  }
  const parsed = parseProfile(form)
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const members = z.array(z.string().max(40)).max(10).safeParse(form.getAll("member"))
  if (!members.success) return { error: "Choose your team again." }
  // Shared notes are read only by memory v2, so they're asked for only then
  const askAbout =
    (await getSetting("agents.memoryV2")) === "on" && field(form, "skipAbout") !== "1"
  const about = askAbout
    ? [...form.entries()]
        .filter(([key, value]) => key.startsWith("about:") && typeof value === "string")
        .slice(0, 8)
        .map(([key, value]) => ({
          slot: key.slice("about:".length, "about:".length + 64),
          content: String(value).slice(0, PERSON_NOTE_MAX),
        }))
    : []
  const plan = await getPlan(user.id)

  let destination: string
  try {
    destination = await withUser(user.id, async (tx) => {
      await tx
        .update(profiles)
        .set({
          displayName: parsed.data.displayName,
          locale: parsed.data.locale,
          useCase: parsed.data.useCase ?? null,
          onboardedAt: new Date(),
        })
        .where(eq(profiles.id, user.id))
      return createTeam(tx, user.id, {
        useCase: parsed.data.useCase,
        members: members.data,
        about,
        maxAgents: plan.maxAgents,
      })
    })
  } catch (error) {
    if (error instanceof TeamError) return { error: error.message }
    log.error("team onboarding failed", { error })
    return { error: "Couldn't set up your team. Try again." }
  }
  revalidatePath("/", "layout")
  redirect(destination)
}

/* ───────────────────────────── billing ──────────────────────────── */

// Lite mode (K10): the person's explicit choice, or null if they haven't
// made one (the browser's save-data hint decides meanwhile)
export async function getLiteMode(): Promise<boolean | null> {
  const user = await requireUser()
  return user.profile.liteMode
}

// Lite mode (K10): the person's own setting, saved on their profile
export async function setLiteMode(enabled: boolean): Promise<FormState> {
  const user = await requireUser()
  const parsed = z.boolean().safeParse(enabled)
  if (!parsed.success) return { error: "That request wasn't valid." }
  await withUser(user.id, (tx) =>
    tx.update(profiles).set({ liteMode: parsed.data }).where(eq(profiles.id, user.id))
  )
  revalidatePath("/", "layout")
  return { message: parsed.data ? "Lite mode is on." : "Lite mode is off." }
}

export async function choosePlan(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser()
  const planId = z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .safeParse(field(form, "plan"))
  if (!planId.success) return { error: "Choose a plan." }
  if (!(await allow(`checkout:${user.id}`, 10, 60 * 60))) {
    return { error: "Too many attempts. Try again in a while." }
  }
  const [plan] = await privileged.select().from(plans).where(eq(plans.id, planId.data))
  if (!plan) return { error: "That plan isn't available." }
  let url: string
  try {
    ;({ url } = await startCheckout(user.id, plan))
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Couldn't start the payment.",
    }
  }
  redirect(url)
}

export async function finishTestCheckout(
  _: FormState,
  form: FormData
): Promise<FormState> {
  const user = await requireUser()
  const sub = z
    .string()
    .regex(/^test_sub_[\w-]+$/)
    .safeParse(field(form, "sub"))
  const outcome = field(form, "outcome") === "failed" ? "failed" : "paid"
  if (!sub.success) return { error: "Checkout not found." }
  try {
    await simulateTestPayment(user.id, sub.data, outcome)
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Couldn't complete the test.",
    }
  }
  revalidatePath("/", "layout")
  redirect(outcome === "paid" ? "/account?billing=active" : "/account?billing=failed")
}

export async function cancelPlan(): Promise<FormState> {
  const user = await requireUser()
  try {
    const sub = await cancelSubscription(user.id, true)
    if (!sub) return { error: "You don't have a paid plan to cancel." }
  } catch (error) {
    log.error("cancel failed", { error })
    return { error: "Couldn't cancel right now. Try again, or contact support." }
  }
  revalidatePath("/", "layout")
  return { message: "Your plan stays active until the end of this billing period." }
}

/* ───────────────────────────── deletion ─────────────────────────── */

// Deletes the account and everything in it. Payment and usage records are
// kept without the person's identity, as accounting requires.
export async function deleteAccount(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser()
  if (field(form, "confirm").trim() !== "DELETE") {
    return { error: "Type DELETE in capitals to confirm." }
  }
  if (!(await allow(`delete:${user.id}`, 3, 60 * 60))) {
    return { error: "Too many attempts. Try again in a while." }
  }

  try {
    await cancelSubscription(user.id, false)
  } catch (error) {
    log.error("delete: subscription cancel failed", { error })
    return {
      error:
        "We couldn't cancel your paid plan, so nothing was deleted. Try again, or contact support.",
    }
  }

  // Stop anything still running; the cascade then removes the tasks
  await privileged
    .update(tasks)
    .set({ cancelRequestedAt: new Date() })
    .where(eq(tasks.userId, user.id))
  await privileged.insert(auditEvents).values({
    actorId: user.id,
    action: "account.delete",
    targetType: "user",
    targetId: user.id,
  })

  try {
    const admin = createSupabaseAdmin()
    const { error } = await admin.auth.admin.deleteUser(user.id)
    if (error) throw error
  } catch (error) {
    log.error("delete: auth deletion failed", { error })
    return {
      error:
        "We couldn't delete your account right now. Contact support and we'll do it.",
    }
  }

  const supabase = await createSupabase()
  await supabase.auth.signOut().catch(() => {})
  redirect("/?deleted=1")
}
