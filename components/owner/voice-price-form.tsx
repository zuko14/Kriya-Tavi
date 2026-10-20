"use client"

import { useActionState } from "react"
import { useFormStatus } from "react-dom"

import type { OwnerState } from "@/actions/owner"
import { saveVoicePrice } from "@/actions/voice-prices"
import { StateNotice } from "@/components/auth/auth-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// One row of the voice price sheet; the same id again replaces it
const UNITS = [
  ["second", "per second"],
  ["minute_pulse_60", "per minute (60 s pulses)"],
  ["minute_pulse_30", "per 30 s pulse"],
  ["attempt", "per attempt"],
  ["character", "per character"],
  ["audio_second", "per audio second"],
] as const

function Save() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant="secondary" disabled={pending}>
      Save price
    </Button>
  )
}

const select = "h-9 rounded-md border bg-background px-2 text-[12.5px]"

export function VoicePriceForm() {
  const [state, action] = useActionState<OwnerState, FormData>(saveVoicePrice, null)
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      <Input
        name="id"
        placeholder="exotel:outbound"
        className="h-9 font-mono text-[12.5px]"
      />
      <div className="flex gap-2">
        <Input
          name="provider"
          placeholder="provider (exotel)"
          className="h-9 text-[12.5px]"
        />
        <Input
          name="product"
          placeholder="product (outbound)"
          className="h-9 text-[12.5px]"
        />
      </div>
      <div className="flex gap-2">
        <Input
          name="price"
          placeholder="0.45"
          inputMode="decimal"
          className="h-9 w-28 font-mono text-[12.5px]"
        />
        <select name="currency" aria-label="Currency" className={select}>
          <option>INR</option>
          <option>USD</option>
        </select>
        <select name="unit" aria-label="Unit" className={select}>
          {UNITS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <Input
        name="effectiveFrom"
        type="date"
        aria-label="Effective from"
        className="h-9 text-[12.5px]"
      />
      <Input
        name="source"
        placeholder="Source, e.g. Exotel quote 2026-10-20, email"
        className="h-9 text-[12.5px] sm:col-span-2"
      />
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Save />
        <StateNotice state={state} />
      </div>
    </form>
  )
}
