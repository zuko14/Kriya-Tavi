"use client"

import { ChevronDownIcon, LockIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { FieldDescription, FieldLabel } from "@/components/ui/field"
import { recommendedFor, SKILL_LIMITS, type SkillPrefs } from "@/lib/skill-library"
import type { SkillOption } from "@/queries/skills"

// The Creator's Skills section (agents.skillLibrary). An agent without saved
// choices shows its role's recommended skills, following the role as it is
// typed; the first change makes the choice explicit.
export function SkillPicker({
  options,
  role,
  value,
  onChange,
}: {
  options: SkillOption[]
  role: string
  value: SkillPrefs | null | undefined
  onChange: (value: SkillPrefs) => void
}) {
  const recommended = new Set(recommendedFor(role))
  const prefs = value ?? { auto: true, on: [...recommended] }
  const required = options.filter((o) => o.required)
  const optional = options.filter((o) => !o.required)
  const toggle = (id: string, checked: boolean) =>
    onChange({
      ...prefs,
      on: checked ? [...prefs.on, id] : prefs.on.filter((x) => x !== id),
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <FieldLabel>Skills</FieldLabel>
        <span className="font-mono text-[10.5px] text-faint tabular-nums">
          {required.length + optional.filter((o) => prefs.on.includes(o.id)).length} on
        </span>
      </div>
      <FieldDescription>
        How this agent approaches its work. Skills never add tools, accounts or
        permissions, and Kriya&apos;s safeguards stay on whatever you choose.
      </FieldDescription>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2">
        <Checkbox
          checked={prefs.auto}
          onCheckedChange={(auto) => onChange({ ...prefs, auto: Boolean(auto) })}
        />
        <span className="flex flex-col">
          <span className="text-[13px] font-medium">Pick for each task</span>
          <span className="text-[12px] text-muted-foreground">
            {prefs.auto
              ? "Uses only the checked skills that fit each message."
              : `Uses every checked skill on every task, up to ${SKILL_LIMITS.skills} (longer prompts cost more).`}
          </span>
        </span>
      </label>

      <span className="label-mono">Always on</span>
      <ul className="flex flex-col gap-1.5">
        {required.map((option) => (
          <SkillRow
            key={option.id}
            option={option}
            control={<LockIcon className="size-4 text-faint" aria-label="Always on" />}
          />
        ))}
      </ul>

      <span className="label-mono">Optional</span>
      <ul className="flex flex-col gap-1.5">
        {optional.map((option) => (
          <SkillRow
            key={option.id}
            option={option}
            recommended={recommended.has(option.id)}
            control={
              <Checkbox
                checked={prefs.on.includes(option.id)}
                onCheckedChange={(checked) => toggle(option.id, Boolean(checked))}
                aria-label={`Use ${option.name}`}
              />
            }
          />
        ))}
      </ul>
    </div>
  )
}

function SkillRow({
  option,
  control,
  recommended,
}: {
  option: SkillOption
  control: React.ReactNode
  recommended?: boolean
}) {
  const unavailable = option.offByKriya || option.missing.length > 0
  return (
    <li className="rounded-md border bg-background/40 px-3 py-2">
      <div className="flex items-start gap-3">
        <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 pt-0.5">
          <span className="flex size-4 shrink-0 items-center justify-center pt-1">
            {control}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 text-[13px] font-medium">
              {option.name}
              {recommended && (
                <span className="rounded-sm bg-rigel/10 px-1.5 font-mono text-[10px] text-rigel">
                  recommended
                </span>
              )}
            </span>
            <span className="text-[12px] leading-snug text-muted-foreground">
              {option.description}
            </span>
            {unavailable && (
              <span className="text-[12px] leading-snug text-betelgeuse">
                {option.offByKriya
                  ? "Switched off by Kriya for now."
                  : `Not available yet: ${option.prerequisites.join("; ") || `needs ${option.missing.join(", ")}`}.`}
              </span>
            )}
          </span>
        </label>
      </div>
      <Collapsible className="group/skill">
        <CollapsibleTrigger className="ml-7 flex min-h-11 items-center gap-1 font-mono text-[10.5px] text-muted-foreground hover:text-foreground sm:min-h-8">
          details
          <ChevronDownIcon className="size-3 transition-transform group-data-[open]/skill:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="ml-7 pb-1">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-faint">Version</dt>
            <dd>{option.version}</dd>
            <dt className="text-faint">Source</dt>
            <dd>{option.source}</dd>
            <dt className="text-faint">Tools</dt>
            <dd className="font-mono text-[11px] break-words">
              {option.tools.length ? option.tools.join(", ") : "none: guidance only"}
            </dd>
            <dt className="text-faint">Risk</dt>
            <dd>
              {option.risk}
              {option.approvals.length > 0 &&
                ` · waits for your approval: ${option.approvals.join(", ")}`}
            </dd>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
