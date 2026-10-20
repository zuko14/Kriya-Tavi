"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PhoneIcon } from "lucide-react"

import {
  ownerPhoneVerificationStatus,
  updateVoicePreferences,
  verifyOwnerPhone,
} from "@/actions/voice"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { PhoneSettings as Settings } from "@/queries/voice"

// "Phone & calls" in /account (UX_AND_INTERACTION_SPEC §7): the owner's
// number, verified by a call where they key in the code shown here, and the
// preferences for report calls. Everything shown comes from the server.

const tap = "min-h-11"
const field = "min-h-11 w-full rounded-md border bg-background px-3 text-[14px] sm:w-auto"

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  ) : null

type Verifying = { id: string; code: string; status: string }

const STATUS: Record<string, string> = {
  calling: "Calling you now. Answer and type this code on your keypad.",
  verified: "Your number is verified.",
  failed: "That code didn't match three times. Start again.",
  expired: "The code expired. Start again.",
}

function OwnerNumber({ phone }: { phone: string | null }) {
  const router = useRouter()
  const [number, setNumber] = React.useState("")
  const [verifying, setVerifying] = React.useState<Verifying | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, start] = React.useTransition()

  // Poll while the call is on; stop at any final status
  React.useEffect(() => {
    if (!verifying || verifying.status !== "calling") return
    const timer = setInterval(async () => {
      const result = await ownerPhoneVerificationStatus(verifying.id).catch(() => null)
      if (!result?.ok || result.status === "calling") return
      setVerifying((v) => v && { ...v, status: result.status })
      if (result.status === "verified") router.refresh()
    }, 3000)
    return () => clearInterval(timer)
  }, [verifying, router])

  const call = () =>
    start(async () => {
      setError(null)
      try {
        const result = await verifyOwnerPhone(number)
        if (!result.ok) return setError(result.message)
        setVerifying({ id: result.verificationId, code: result.code, status: "calling" })
      } catch {
        setError("That didn't go through. Try again.")
      }
    })

  const calling = verifying?.status === "calling"
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px]">
        {phone ? (
          <>
            Your number: <span className="font-mono tabular-nums">{phone}</span>{" "}
            <span className="text-[12.5px] text-muted-foreground">· verified</span>
          </>
        ) : (
          "Add your number so Tavi can call you with results."
        )}
      </p>
      {calling && (
        <div className="flex flex-col gap-2 rounded-xl border p-4">
          <span className="label-mono">your code</span>
          <span className="font-mono text-4xl tracking-[0.3em] tabular-nums">
            {verifying.code}
          </span>
        </div>
      )}
      {verifying && (
        <p role="status" aria-live="polite" className="text-[13px]">
          {STATUS[verifying.status] ?? STATUS.calling}
        </p>
      )}
      {!calling && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault()
            call()
          }}
        >
          <label htmlFor="owner-phone" className="sr-only">
            Mobile number
          </label>
          <Input
            id="owner-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="10-digit mobile number"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className={`${tap} sm:max-w-56`}
          />
          <Button type="submit" disabled={pending || !number.trim()} className={tap}>
            <PhoneIcon data-icon="inline-start" />
            {phone ? "Change number" : "Call me to verify"}
          </Button>
        </form>
      )}
      <Problem error={error} />
    </div>
  )
}

// The choices shown, plus the stored value when it's another one
const withCurrent = (choices: number[], current: number) =>
  choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)

function Preferences({ settings }: { settings: Settings }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [pending, start] = React.useTransition()
  const zones = React.useMemo(() => {
    const all = Intl.supportedValuesOf("timeZone")
    return all.includes(settings.timezone) ? all : [settings.timezone, ...all]
  }, [settings.timezone])

  const save = (form: FormData) =>
    start(async () => {
      setError(null)
      setSaved(false)
      try {
        const result = await updateVoicePreferences({
          timezone: form.get("timezone"),
          quietStart: form.get("quietStart"),
          quietEnd: form.get("quietEnd"),
          reportMode: form.get("reportMode"),
          reportMaxAttempts: Number(form.get("reportMaxAttempts")),
          reportRetryMinutes: Number(form.get("reportRetryMinutes")),
          transcriptRetentionDays: Number(form.get("transcriptRetentionDays")),
        })
        if (!result.ok) return setError(result.message)
        setSaved(true)
        router.refresh()
      } catch {
        setError("That didn't go through. Try again.")
      }
    })

  const row = "flex flex-col gap-1.5 text-[13px]"
  return (
    <form action={save} className="flex max-w-md flex-col gap-4">
      <label className={row}>
        Timezone
        <select name="timezone" defaultValue={settings.timezone} className={field}>
          {zones.map((zone) => (
            <option key={zone}>{zone}</option>
          ))}
        </select>
      </label>
      <fieldset className={row}>
        <legend className="mb-1.5">Quiet hours (no calls to you)</legend>
        <div className="flex items-center gap-2">
          <input
            type="time"
            name="quietStart"
            aria-label="Quiet hours start"
            defaultValue={settings.quietStart}
            className={field}
          />
          <span className="text-muted-foreground">to</span>
          <input
            type="time"
            name="quietEnd"
            aria-label="Quiet hours end"
            defaultValue={settings.quietEnd}
            className={field}
          />
        </div>
      </fieldset>
      <fieldset className={row}>
        <legend className="mb-1.5">Tell me the result</legend>
        {(
          [
            ["scheduled", "At the time I choose"],
            ["on_completion", "As soon as the call is done"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={`flex ${tap} items-center gap-2`}>
            <input
              type="radio"
              name="reportMode"
              value={value}
              defaultChecked={settings.reportMode === value}
              className="size-4 accent-rigel"
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <label className={row}>
          If I miss the call, try
          <select
            name="reportMaxAttempts"
            defaultValue={settings.reportMaxAttempts}
            className={field}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "once" : `${n} times`}
              </option>
            ))}
          </select>
        </label>
        <label className={row}>
          Wait between tries
          <select
            name="reportRetryMinutes"
            defaultValue={settings.reportRetryMinutes}
            className={field}
          >
            {withCurrent([5, 10, 15, 30, 60], settings.reportRetryMinutes).map((n) => (
              <option key={n} value={n}>
                {n} minutes
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={row}>
        Keep call transcripts
        <select
          name="transcriptRetentionDays"
          defaultValue={settings.transcriptRetentionDays}
          className={field}
        >
          {withCurrent([0, 7, 30, 90], settings.transcriptRetentionDays).map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "Don't keep (only the result)" : `${n} days`}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className={tap}>
          Save
        </Button>
        {saved && (
          <span role="status" className="text-[12.5px] text-muted-foreground">
            Saved.
          </span>
        )}
      </div>
      <Problem error={error} />
    </form>
  )
}

export function PhoneSettings({ settings }: { settings: Settings }) {
  return (
    <div className="flex flex-col gap-6">
      <OwnerNumber phone={settings.phone} />
      <Preferences settings={settings} />
    </div>
  )
}
