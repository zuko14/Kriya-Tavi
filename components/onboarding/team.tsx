"use client"

import * as React from "react"
import { useActionState } from "react"
import { CheckIcon, ChevronLeftIcon } from "lucide-react"

import { completeTeamOnboarding, type FormState } from "@/actions/account"
import { LanguageSelect, UseCasePicker } from "@/components/account/forms"
import { StateNotice, SubmitButton, TextField } from "@/components/auth/auth-kit"
import { Glyph } from "@/components/glyph"
import { packFor } from "@/lib/templates"
import { cn } from "@/lib/utils"

// Onboarding by role (UX_SPEC §2, A2): who you are, then "Meet your team"
// (the pack's agents, each with a toggle, up to the plan's limit), then
// optionally a few things about you. The server checks all of it again.

type Profile = { displayName: string | null; locale: string; useCase: string | null }

export function TeamOnboarding({
  profile,
  maxAgents,
  askAbout,
}: {
  profile: Profile
  maxAgents: number
  // "A few things about you" is saved as shared memory (memory v2)
  askAbout: boolean
}) {
  const [state, action] = useActionState<FormState, FormData>(
    completeTeamOnboarding,
    null
  )
  const [step, setStep] = React.useState<"you" | "team" | "about">("you")
  const [useCase, setUseCase] = React.useState(profile.useCase ?? "")
  const [problem, setProblem] = React.useState<string | null>(null)
  const form = React.useRef<HTMLFormElement>(null)
  const pack = packFor(useCase)
  const firstChoice = React.useCallback(
    (names: string[]) => new Set(names.slice(0, Math.max(maxAgents, 0))),
    [maxAgents]
  )
  const [chosen, setChosen] = React.useState(() =>
    firstChoice(pack.members.map((m) => m.name))
  )

  const pickUseCase = (value: string) => {
    setUseCase(value)
    setChosen(firstChoice(packFor(value).members.map((m) => m.name)))
  }

  const toTeam = () => {
    const name = form.current?.elements.namedItem(
      "displayName"
    ) as HTMLInputElement | null
    if (!name?.value.trim()) return setProblem("Tell us what to call you.")
    if (!useCase) return setProblem("Choose what you'll use Kriya for.")
    setProblem(null)
    setStep("team")
  }

  const toggle = (name: string) =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else if (next.size < maxAgents) next.add(name)
      return next
    })

  return (
    <form ref={form} action={action} className="flex flex-col gap-5">
      <div className={cn("flex flex-col gap-5", step !== "you" && "hidden")}>
        <TextField
          label="What should your agents call you?"
          name="displayName"
          autoComplete="given-name"
          defaultValue={profile.displayName ?? ""}
          maxLength={60}
        />
        <UseCasePicker defaultValue={profile.useCase} onChange={pickUseCase} />
        <LanguageSelect defaultValue={profile.locale} />
        {problem && <p className="text-[13px] text-destructive">{problem}</p>}
        <button
          type="button"
          onClick={toTeam}
          className="btn-liquid h-12 w-full text-[15px]"
        >
          Meet your team
        </button>
      </div>

      <div className={cn("flex flex-col gap-4", step !== "team" && "hidden")}>
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold">Meet your team</h2>
          <p className="text-[13px] text-muted-foreground">
            {pack.teamName}. Keep who you want; you can add or remove agents later.
            {pack.members.length > maxAgents &&
              ` Your plan includes ${maxAgents} agents, so choose up to ${maxAgents}.`}
          </p>
        </div>
        <ul className="flex flex-col gap-2.5">
          {pack.members.map((member) => {
            const on = chosen.has(member.name)
            const full = !on && chosen.size >= maxAgents
            return (
              <li key={member.name}>
                <label
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors",
                    on ? "border-rigel bg-rigel-soft" : "hover:bg-accent/40",
                    full && "cursor-not-allowed opacity-60"
                  )}
                >
                  <input
                    type="checkbox"
                    name="member"
                    value={member.name}
                    checked={on}
                    disabled={full}
                    onChange={() => toggle(member.name)}
                    className="sr-only"
                  />
                  <Glyph seed={member.name} className="size-9 shrink-0 rounded-lg" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-semibold">{member.name}</span>
                      <span
                        aria-hidden
                        className={cn(
                          "grid size-6 shrink-0 place-items-center rounded-full border",
                          on && "border-rigel bg-rigel text-white"
                        )}
                      >
                        {on && <CheckIcon className="size-3.5" />}
                      </span>
                    </span>
                    <span className="text-[12.5px] text-muted-foreground">
                      {member.role}
                    </span>
                    <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4 text-[12.5px]">
                      {member.canDo.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    {member.needs && (
                      <span className="label-mono text-faint">{member.needs}</span>
                    )}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setStep("you")}
            className="flex h-12 items-center gap-1 rounded-xl border px-4 text-[14px]"
          >
            <ChevronLeftIcon className="size-4" />
            Back
          </button>
          {askAbout ? (
            <button
              type="button"
              disabled={chosen.size === 0}
              onClick={() => setStep("about")}
              className="btn-liquid h-12 flex-1 text-[15px]"
            >
              Next
            </button>
          ) : (
            <div className="flex-1">
              <SubmitButton>Start with my team</SubmitButton>
            </div>
          )}
        </div>
      </div>

      {askAbout && (
        <div className={cn("flex flex-col gap-4", step !== "about" && "hidden")}>
          <div className="flex flex-col gap-1">
            <h2 className="text-[17px] font-semibold">A few things about you</h2>
            <p className="text-[13px] text-muted-foreground">
              Optional. Every agent on your team will know these; you can change them in
              Account, About you. Never put passwords, card or Aadhaar numbers here.
            </p>
          </div>
          {pack.slots.map((slot) => (
            <label key={slot.slot} className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">{slot.label}</span>
              <input
                name={`about:${slot.slot}`}
                placeholder={slot.placeholder}
                maxLength={200}
                className="h-12 rounded-xl border border-input bg-background/60 px-4 text-[15px]"
              />
            </label>
          ))}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <div className="sm:flex-1">
              <SubmitButton>Start with my team</SubmitButton>
            </div>
            <button
              type="submit"
              name="skipAbout"
              value="1"
              className="h-12 rounded-xl border px-4 text-[14px] sm:flex-1"
            >
              Tell me later
            </button>
          </div>
        </div>
      )}
      <StateNotice state={state} />
    </form>
  )
}
