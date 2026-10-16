import { CheckIcon } from "lucide-react"

import { ChoosePlanButton } from "@/components/account/forms"
import type { Plan } from "@/db/schema"
import { TIER_LABELS } from "@/lib/tiers"
import { formatInr, formatPaise } from "@/lib/money"
import { cn } from "@/lib/utils"

// The plans as the owner configured them: nothing here is hardcoded pricing
export function PlanCards({
  plans,
  currentPlanId,
  canBuy,
  signedIn,
}: {
  plans: Plan[]
  currentPlanId?: string
  canBuy: boolean
  signedIn: boolean
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {plans.map((plan) => {
        const current = plan.id === currentPlanId
        const priced = plan.isDefault || plan.priceMonthlyPaise != null
        const features = [
          `${plan.maxTasksPerDay.toLocaleString("en-IN")} tasks a day`,
          `Up to ${plan.maxAgents} agents`,
          plan.maxConcurrentTasks > 1
            ? `${plan.maxConcurrentTasks} tasks at once`
            : "One task at a time",
          `Models: ${plan.allowedTiers.map((tier) => TIER_LABELS[tier]?.name ?? tier).join(", ")}`,
          plan.includedUsageMicroInr > 0 &&
            `${formatInr(plan.includedUsageMicroInr)} of AI usage included`,
          `Tasks up to ${Math.round(plan.maxTaskSeconds / 60)} minutes`,
        ].filter((value): value is string => !!value)
        return (
          <article
            key={plan.id}
            className={cn(
              "flex flex-col gap-4 rounded-xl border bg-surface p-5",
              current && "border-rigel ring-1 ring-rigel/40"
            )}
          >
            <header className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">{plan.name}</h3>
                {current && (
                  <span className="rounded-full bg-rigel-soft px-2 py-0.5 font-mono text-[10px] text-rigel uppercase">
                    Current
                  </span>
                )}
              </div>
              <p className="text-2xl font-semibold tracking-tight">
                {plan.isDefault
                  ? "Free"
                  : priced
                    ? formatPaise(plan.priceMonthlyPaise)
                    : "Coming soon"}
                {!plan.isDefault && priced && (
                  <span className="text-[13px] font-normal text-muted-foreground">
                    {" "}
                    / month
                  </span>
                )}
              </p>
              {plan.description && (
                <p className="text-[13px] text-muted-foreground">{plan.description}</p>
              )}
            </header>
            <ul className="flex flex-1 flex-col gap-2 text-[13px]">
              {features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-betelgeuse" />
                  {feature}
                </li>
              ))}
            </ul>
            {signedIn && !current && !plan.isDefault && priced && canBuy && (
              <ChoosePlanButton planId={plan.id} label={`Choose ${plan.name}`} />
            )}
          </article>
        )
      })}
    </div>
  )
}
