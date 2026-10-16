"use client"

import { useActionState } from "react"
import Link from "next/link"

import {
  requestPasswordReset,
  resendVerification,
  signIn,
  signUp,
  updatePassword,
  type AuthState,
} from "@/actions/auth"
import { StateNotice, SubmitButton, TextField } from "@/components/auth/auth-kit"

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [state, action] = useActionState<AuthState, FormData>(signIn, null)
  const unconfirmed = state?.error?.startsWith("Confirm your email")
  return (
    <div className="flex flex-col gap-4">
      {notice && !state && <StateNotice state={{ error: notice }} />}
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next ?? ""} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={state?.email}
          autoFocus
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <div className="-mt-1 flex justify-end">
          <Link
            href="/forgot-password"
            className="text-[12.5px] text-rigel hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <StateNotice state={state} />
        <SubmitButton>Sign in</SubmitButton>
      </form>
      {unconfirmed && <ResendForm email={state?.email} />}
    </div>
  )
}

export function SignupForm() {
  const [state, action] = useActionState<AuthState, FormData>(signUp, null)
  if (state?.message) {
    return (
      <div className="flex flex-col gap-4">
        <StateNotice state={state} />
        <p className="text-[13px] text-muted-foreground">
          The link opens Kriya and finishes setting up your account. Nothing in your
          inbox? Check spam, or send it again.
        </p>
        <ResendForm email={state.email} />
      </div>
    )
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <TextField
        label="Your name"
        name="name"
        autoComplete="name"
        maxLength={60}
        autoFocus
      />
      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={state?.email}
      />
      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        hint="At least 10 characters. A short phrase is easier to remember."
      />
      <label className="flex items-start gap-2.5 text-[13px] leading-snug text-muted-foreground">
        <input
          type="checkbox"
          name="terms"
          required
          className="mt-0.5 size-4 shrink-0 accent-[var(--rigel)]"
        />
        <span>
          I agree to the{" "}
          <Link href="/legal/terms" className="text-rigel hover:underline">
            terms
          </Link>{" "}
          and{" "}
          <Link href="/legal/privacy" className="text-rigel hover:underline">
            privacy policy
          </Link>
          .
        </span>
      </label>
      <StateNotice state={state} />
      <SubmitButton>Create account</SubmitButton>
    </form>
  )
}

export function ResendForm({ email }: { email?: string }) {
  const [state, action] = useActionState<AuthState, FormData>(resendVerification, null)
  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-dashed p-3"
    >
      <TextField
        label="Email to confirm"
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={state?.email ?? email}
      />
      <StateNotice state={state} />
      <SubmitButton>Send the confirmation link again</SubmitButton>
    </form>
  )
}

export function ForgotForm() {
  const [state, action] = useActionState<AuthState, FormData>(requestPasswordReset, null)
  return (
    <form action={action} className="flex flex-col gap-4">
      <TextField label="Email" name="email" type="email" autoComplete="email" autoFocus />
      <StateNotice state={state} />
      <SubmitButton>Email me a reset link</SubmitButton>
    </form>
  )
}

export function ResetForm({ from }: { from?: "account" }) {
  const [state, action] = useActionState<AuthState, FormData>(updatePassword, null)
  return (
    <form action={action} className="flex flex-col gap-4">
      {from && <input type="hidden" name="from" value={from} />}
      <TextField
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        hint="At least 10 characters."
        autoFocus={!from}
      />
      <TextField
        label="Repeat it"
        name="confirm"
        type="password"
        autoComplete="new-password"
      />
      <StateNotice state={state} />
      <SubmitButton>Save password</SubmitButton>
    </form>
  )
}
