"use client"

import * as React from "react"
import { useActionState } from "react"
import { CheckIcon } from "lucide-react"

import {
  cancelPlan,
  choosePlan,
  completeOnboarding,
  deleteAccount,
  finishTestCheckout,
  saveProfile,
  type FormState,
} from "@/actions/account"
import { StateNotice, SubmitButton, TextField } from "@/components/auth/auth-kit"
import { cn } from "@/lib/utils"

export const LANGUAGES = [
  { value: "en-IN", label: "English" },
  { value: "hi-IN", label: "हिन्दी · Hindi" },
  { value: "te-IN", label: "తెలుగు · Telugu" },
  { value: "ta-IN", label: "தமிழ் · Tamil" },
  { value: "bn-IN", label: "বাংলা · Bengali" },
  { value: "mr-IN", label: "मराठी · Marathi" },
  { value: "kn-IN", label: "ಕನ್ನಡ · Kannada" },
]

export const USE_CASE_OPTIONS = [
  { value: "student", label: "Student", hint: "Study plans, research, assignments" },
  { value: "developer", label: "Developer", hint: "Code reviews, debugging, docs" },
  { value: "founder", label: "Founder", hint: "Research, planning, ops" },
  { value: "freelancer", label: "Freelancer", hint: "Proposals, clients, invoices" },
  { value: "creator", label: "Creator", hint: "Posts, scripts, newsletters" },
  { value: "business", label: "Small business", hint: "Customers, content, admin" },
  { value: "other", label: "Something else", hint: "A general assistant" },
]

type Profile = { displayName: string | null; locale: string; useCase: string | null }

function LanguageSelect({ defaultValue }: { defaultValue: string }) {
  const id = React.useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        Language your agents reply in by default
      </label>
      <select
        id={id}
        name="locale"
        defaultValue={defaultValue}
        className="h-11 rounded-md border border-input bg-transparent px-3 text-[15px] sm:h-10 sm:text-sm"
      >
        {LANGUAGES.map((language) => (
          <option key={language.value} value={language.value}>
            {language.label}
          </option>
        ))}
      </select>
      <p className="text-[12px] text-muted-foreground">
        Agents always answer in the language you write in; this is the fallback.
      </p>
    </div>
  )
}

function UseCasePicker({ defaultValue }: { defaultValue: string | null }) {
  const [value, setValue] = React.useState(defaultValue ?? "")
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] font-medium">
        What will you use Kriya for?
      </legend>
      <input type="hidden" name="useCase" value={value} />
      <div className="grid grid-cols-2 gap-2">
        {USE_CASE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => setValue(option.value)}
            className={cn(
              "flex min-h-14 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
              value === option.value
                ? "border-rigel bg-rigel-soft"
                : "hover:border-input hover:bg-accent/40"
            )}
          >
            <span className="flex w-full items-center justify-between text-[13.5px] font-medium">
              {option.label}
              {value === option.value && <CheckIcon className="size-3.5 text-rigel" />}
            </span>
            <span className="text-[11.5px] leading-tight text-muted-foreground">
              {option.hint}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export function OnboardingForm({ profile }: { profile: Profile }) {
  const [state, action] = useActionState<FormState, FormData>(completeOnboarding, null)
  return (
    <form action={action} className="flex flex-col gap-5">
      <TextField
        label="What should your agents call you?"
        name="displayName"
        autoComplete="given-name"
        defaultValue={profile.displayName ?? ""}
        maxLength={60}
      />
      <UseCasePicker defaultValue={profile.useCase} />
      <LanguageSelect defaultValue={profile.locale} />
      <StateNotice state={state} />
      <SubmitButton>Create my first agent</SubmitButton>
    </form>
  )
}

export function ProfileForm({ profile }: { profile: Profile }) {
  const [state, action] = useActionState<FormState, FormData>(saveProfile, null)
  return (
    <form action={action} className="flex flex-col gap-5">
      <TextField
        label="Name"
        name="displayName"
        autoComplete="name"
        defaultValue={profile.displayName ?? ""}
        maxLength={60}
      />
      <UseCasePicker defaultValue={profile.useCase} />
      <LanguageSelect defaultValue={profile.locale} />
      <StateNotice state={state} />
      <div className="sm:w-40">
        <SubmitButton>Save</SubmitButton>
      </div>
    </form>
  )
}

export function ChoosePlanButton({ planId, label }: { planId: string; label: string }) {
  const [state, action] = useActionState<FormState, FormData>(choosePlan, null)
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="plan" value={planId} />
      <SubmitButton>{label}</SubmitButton>
      <StateNotice state={state} />
    </form>
  )
}

export function CancelPlanForm() {
  const [state, action] = useActionState<FormState, FormData>(cancelPlan, null)
  return (
    <form action={action} className="flex flex-col gap-2">
      <StateNotice state={state} />
      {!state?.message && (
        <button
          type="submit"
          className="self-start text-[13px] text-destructive hover:underline"
        >
          Cancel my plan
        </button>
      )}
    </form>
  )
}

export function TestCheckoutForm({ sub }: { sub: string }) {
  const [state, action] = useActionState<FormState, FormData>(finishTestCheckout, null)
  return (
    <div className="flex flex-col gap-3">
      <form action={action}>
        <input type="hidden" name="sub" value={sub} />
        <input type="hidden" name="outcome" value="paid" />
        <SubmitButton>Simulate a successful payment</SubmitButton>
      </form>
      <form action={action}>
        <input type="hidden" name="sub" value={sub} />
        <input type="hidden" name="outcome" value="failed" />
        <button
          type="submit"
          className="h-10 w-full rounded-md border text-[13px] text-muted-foreground hover:bg-accent/50"
        >
          Simulate a failed payment
        </button>
      </form>
      <StateNotice state={state} />
    </div>
  )
}

export function DeleteAccountForm() {
  const [state, action] = useActionState<FormState, FormData>(deleteAccount, null)
  return (
    <form action={action} className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        This deletes your account, agents, conversations and memories for good, and
        cancels any paid plan immediately. Payment and usage records are kept without your
        name, for accounting.
      </p>
      <TextField label='Type "DELETE" to confirm' name="confirm" autoComplete="off" />
      <StateNotice state={state} />
      <div className="sm:w-56">
        <SubmitButton>Delete my account</SubmitButton>
      </div>
    </form>
  )
}
