"use server"

import { redirect } from "next/navigation"
import { z } from "zod"

import { appUrl, safeNext } from "@/lib/auth"
import { allowAll, clientIp } from "@/lib/rate-limit"
import { createSupabase } from "@/lib/supabase"

// Account flows. Answers never reveal whether an email has an account:
// sign-up, resend and recovery all say the same thing either way.

export type AuthState = { error?: string; message?: string; email?: string } | null

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(254)
const passwordRule = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Keep it under 128 characters.")

const TOO_MANY = "Too many attempts. Wait a few minutes and try again."

function field(form: FormData, name: string) {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = z
    .object({ email, password: z.string().min(1, "Enter your password.").max(128) })
    .safeParse({ email: field(form, "email"), password: field(form, "password") })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const ip = await clientIp()
  const ok = await allowAll([
    [`login:ip:${ip}`, 20, 15 * 60],
    [`login:email:${parsed.data.email}`, 8, 15 * 60],
  ])
  if (!ok) return { error: TOO_MANY, email: parsed.data.email }

  const supabase = await createSupabase()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) {
    if (error.code === "email_not_confirmed") {
      return {
        error: "Confirm your email first. We can send the link again.",
        email: parsed.data.email,
      }
    }
    return { error: "That email and password don't match.", email: parsed.data.email }
  }
  redirect(safeNext(field(form, "next")))
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = z
    .object({
      name: z.string().trim().min(1, "Tell us what to call you.").max(60),
      email,
      password: passwordRule,
      terms: z.literal("on", { error: "Please accept the terms to continue." }),
    })
    .safeParse({
      name: field(form, "name"),
      email: field(form, "email"),
      password: field(form, "password"),
      terms: field(form, "terms"),
    })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const ip = await clientIp()
  if (!(await allowAll([[`signup:ip:${ip}`, 5, 60 * 60]]))) return { error: TOO_MANY }

  const supabase = await createSupabase()
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${appUrl()}/auth/confirm?next=/onboarding`,
      data: { display_name: parsed.data.name },
    },
  })
  // Weak or leaked passwords are the person's to fix; everything else is
  // answered the same way so nobody learns which emails are registered
  if (error?.code === "weak_password") return { error: error.message }
  if (error && error.code !== "user_already_exists") {
    console.error("[kriya] sign-up failed:", error.code)
  }
  // Projects without email confirmation sign the person in at once. Only a
  // new account gets a session, so this reveals nothing about existing emails.
  if (data.session) redirect("/onboarding")
  return {
    message: "Check your inbox for a link to confirm your email.",
    email: parsed.data.email,
  }
}

export async function resendVerification(
  _: AuthState,
  form: FormData
): Promise<AuthState> {
  const parsed = email.safeParse(field(form, "email"))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const ip = await clientIp()
  const ok = await allowAll([
    [`resend:ip:${ip}`, 5, 60 * 60],
    [`resend:email:${parsed.data}`, 3, 60 * 60],
  ])
  if (!ok) return { error: TOO_MANY, email: parsed.data }
  const supabase = await createSupabase()
  await supabase.auth.resend({
    type: "signup",
    email: parsed.data,
    options: { emailRedirectTo: `${appUrl()}/auth/confirm?next=/onboarding` },
  })
  return {
    message: "If that address is waiting for confirmation, a new link is on its way.",
    email: parsed.data,
  }
}

export async function requestPasswordReset(
  _: AuthState,
  form: FormData
): Promise<AuthState> {
  const parsed = email.safeParse(field(form, "email"))
  if (!parsed.success) return { error: parsed.error.issues[0].message }
  const ip = await clientIp()
  const ok = await allowAll([
    [`reset:ip:${ip}`, 5, 60 * 60],
    [`reset:email:${parsed.data}`, 3, 60 * 60],
  ])
  if (!ok) return { error: TOO_MANY }
  const supabase = await createSupabase()
  await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${appUrl()}/auth/confirm?next=/reset-password`,
  })
  return {
    message:
      "If an account uses that address, we've emailed a link to reset the password.",
  }
}

// After a recovery link signed the person in, they choose a new password.
// Also used from Account settings.
export async function updatePassword(_: AuthState, form: FormData): Promise<AuthState> {
  const parsed = z
    .object({ password: passwordRule, confirm: z.string() })
    .refine((value) => value.password === value.confirm, {
      message: "The passwords don't match.",
    })
    .safeParse({ password: field(form, "password"), confirm: field(form, "confirm") })
  if (!parsed.success) return { error: parsed.error.issues[0].message }

  const supabase = await createSupabase()
  const { data } = await supabase.auth.getClaims()
  if (!data?.claims?.sub) {
    return { error: "This reset link has expired. Ask for a new one." }
  }
  if (!(await allowAll([[`password:${data.claims.sub}`, 5, 60 * 60]]))) {
    return { error: TOO_MANY }
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    return {
      error:
        error.code === "same_password"
          ? "Choose a password you haven't used here before."
          : error.code === "weak_password"
            ? error.message
            : "Couldn't update the password. Try the link again.",
    }
  }
  if (field(form, "from") === "account") return { message: "Password updated." }
  redirect("/home?password=updated")
}

export async function signOut() {
  const supabase = await createSupabase()
  await supabase.auth.signOut()
  redirect("/login")
}
