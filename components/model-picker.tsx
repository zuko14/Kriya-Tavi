"use client"

import { LockIcon, SparklesIcon } from "lucide-react"

import { isTier, TIER_LABELS, TIERS, tierName } from "@/lib/tiers"
import { cn } from "@/lib/utils"

// People choose how much power an agent gets, not a model id: the owner maps
// each tier to a tested model, and the plan decides which tiers are open.
export function TierPicker({
  value,
  onChange,
  allowed,
}: {
  value: string
  onChange: (value: string) => void
  allowed: string[]
}) {
  const current = isTier(value) ? value : ""
  return (
    <div role="radiogroup" aria-label="Model level" className="grid gap-2 sm:grid-cols-3">
      {TIERS.map((tier) => {
        const open = allowed.includes(tier)
        const selected = current === tier || (current === "" && tier === "budget")
        return (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!open}
            onClick={() => onChange(tier === "budget" ? "" : tier)}
            className={cn(
              "flex min-h-16 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
              selected
                ? "border-rigel bg-rigel-soft"
                : "hover:border-input hover:bg-accent/40",
              !open &&
                "cursor-not-allowed opacity-55 hover:border-border hover:bg-transparent"
            )}
          >
            <span className="flex w-full items-center gap-1.5 text-[13px] font-medium">
              {TIER_LABELS[tier].name}
              {!open && <LockIcon className="ml-auto size-3 text-muted-foreground" />}
            </span>
            <span className="text-[11.5px] leading-tight text-muted-foreground">
              {open ? TIER_LABELS[tier].blurb : "Available on a higher plan"}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function TierLabel({
  tier,
  className,
}: {
  tier: string | null
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono", className)}>
      <SparklesIcon className="size-3" />
      {tierName(tier).toLowerCase()}
    </span>
  )
}
