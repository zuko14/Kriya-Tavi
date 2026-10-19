"use server"

import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { withUser } from "@/db"
import { loginProfiles } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { finishSignIn, ProfileError, startSignIn } from "@/lib/browser/profiles"
import { browserProvider } from "@/lib/browser/session"
import { siteFor } from "@/lib/browser/sites"
import { getSetting } from "@/lib/config"
import { allow } from "@/lib/rate-limit"
import { isSecretsConfigured } from "@/lib/secrets"

// Account → Logins (A6, AD-05): the person signs in to a site themselves in
// Kriya's browser (take-over), then saves or discards it. Only the person
// does these; no agent tool can (AT-POL-07). Behind agents.loginProfiles.

const OFF = { error: "Saved logins aren't available yet." }

async function person() {
  const user = await requireUser()
  return (await getSetting("agents.loginProfiles")) === "on" ? user : null
}

const failed = (error: unknown) => {
  if (error instanceof ProfileError) return { error: error.message }
  throw error
}

// Kriya's browser and the sealing key, or why not
function ready() {
  const provider = browserProvider()
  if (!provider) return { error: "Kriya's browser isn't set up on this server yet." }
  if (!isSecretsConfigured()) {
    return { error: "Saved logins aren't set up on this server yet." }
  }
  return { provider }
}

const startInput = z.object({
  url: z.string().trim().min(3).max(2000),
  label: z.string().trim().max(60).optional(),
})

// Starts a take-over on the site's sign-in page; the page then opens the
// live view for the session it returns
export async function startLogin(url: string, label?: string) {
  const user = await person()
  const input = startInput.safeParse({ url, label })
  if (!user) return OFF
  if (!input.success) return { error: "Enter the site's address, like linkedin.com." }
  if (!(await allow(`login:${user.id}`, 10, 3600))) {
    return { error: "Too many sign-ins this hour. Try again later." }
  }
  const setup = ready()
  if ("error" in setup) return setup
  try {
    const started = await startSignIn(setup.provider, user.id, input.data)
    revalidatePath("/account")
    return started
  } catch (error) {
    return failed(error)
  }
}

// Signs in again to a profile that expired or is due for re-confirmation
export async function signInAgain(profileId: string) {
  const user = await person()
  const id = z.uuid().safeParse(profileId)
  if (!user || !id.success) return OFF
  if (!(await allow(`login:${user.id}`, 10, 3600))) {
    return { error: "Too many sign-ins this hour. Try again later." }
  }
  const [row] = await withUser(user.id, (tx) =>
    tx
      .select({ domain: loginProfiles.domain })
      .from(loginProfiles)
      .where(eq(loginProfiles.id, id.data))
  )
  if (!row) return { error: "That login no longer exists." }
  const setup = ready()
  if ("error" in setup) return setup
  try {
    return await startSignIn(setup.provider, user.id, {
      url: `https://${row.domain}/`,
      profileId: id.data,
    })
  } catch (error) {
    return failed(error)
  }
}

// "Save login": the person's consent, with background use off unless
// they turned it on in the same dialog
export async function saveLogin(profileId: string, backgroundAllowed: boolean) {
  const user = await person()
  const id = z.uuid().safeParse(profileId)
  if (!user || !id.success) return OFF
  const setup = ready()
  if ("error" in setup) return setup
  try {
    const result = await finishSignIn(setup.provider, user.id, id.data, {
      save: true,
      backgroundAllowed: backgroundAllowed === true,
    })
    revalidatePath("/account")
    return result === "saved"
      ? { saved: true }
      : {
          error:
            "No sign-in was found on that site, so nothing was saved. Start again and sign in before saving.",
        }
  } catch (error) {
    return failed(error)
  }
}

export async function cancelLogin(profileId: string) {
  const user = await person()
  const id = z.uuid().safeParse(profileId)
  if (!user || !id.success) return OFF
  const provider = browserProvider()
  if (!provider) return { ok: true }
  try {
    await finishSignIn(provider, user.id, id.data, { save: false })
    revalidatePath("/account")
    return { ok: true }
  } catch (error) {
    return failed(error)
  }
}

export async function setLoginBackground(profileId: string, allowed: boolean) {
  const user = await person()
  const id = z.uuid().safeParse(profileId)
  if (!user || !id.success) return OFF
  const rows = await withUser(user.id, (tx) =>
    tx
      .update(loginProfiles)
      .set({ backgroundAllowed: allowed === true })
      .where(and(eq(loginProfiles.id, id.data), eq(loginProfiles.userId, user.id)))
      .returning({ id: loginProfiles.id })
  )
  revalidatePath("/account")
  return rows.length ? { ok: true } : { error: "That login no longer exists." }
}

// Deletes the profile and its sealed state. The site may still have the
// session open elsewhere, so the answer carries its security page.
export async function removeLogin(profileId: string) {
  const user = await person()
  const id = z.uuid().safeParse(profileId)
  if (!user || !id.success) return OFF
  const provider = browserProvider()
  if (provider) {
    // Ends a sign-in still open in Kriya's browser, without saving
    await finishSignIn(provider, user.id, id.data, { save: false }).catch(() => {})
  }
  const rows = await withUser(user.id, (tx) =>
    tx
      .delete(loginProfiles)
      .where(and(eq(loginProfiles.id, id.data), eq(loginProfiles.userId, user.id)))
      .returning({ domain: loginProfiles.domain })
  )
  revalidatePath("/account")
  if (!rows.length) return { removed: true, securityPage: null }
  return {
    removed: true,
    securityPage: siteFor(rows[0].domain)?.securityPage ?? null,
  }
}
