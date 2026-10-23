"use client"

import { BookOpenIcon } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { KriyaMetadata } from "@/lib/agent/tools"

// "Used N skills" under a reply: which skill-library skills the agent was
// given for it and why, from the reply's own metadata (agents.skillLibrary)
export function UsedSkills({ skills }: { skills: NonNullable<KriyaMetadata["skills"]> }) {
  return (
    <Popover>
      <PopoverTrigger className="-my-3 flex min-h-11 items-center gap-1 hover:text-foreground sm:my-0 sm:min-h-0">
        <BookOpenIcon className="size-3" />
        Used {skills.length} {skills.length === 1 ? "skill" : "skills"}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-80 overflow-y-auto">
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li key={skill.id} className="flex flex-col gap-0.5">
              <span className="text-[13px] leading-snug">
                {skill.name} <span className="text-faint">v{skill.version}</span>
              </span>
              <span className="label-mono text-faint">{skill.reason}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-muted-foreground">
          Skills guide how the agent works. They never add tools or permissions.
        </p>
      </PopoverContent>
    </Popover>
  )
}
