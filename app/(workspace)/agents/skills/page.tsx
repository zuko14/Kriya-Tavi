import type { Metadata } from "next"
import { asc } from "drizzle-orm"
import { notFound } from "next/navigation"

import {
  Designer,
  SkillCard,
  type StudioAgent,
  type StudioSkill,
} from "@/components/skill-studio/studio"
import { withUser } from "@/db"
import { agents } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { skillRisk } from "@/lib/skill-engine"
import { listSkills, studioOn } from "@/lib/skill-studio"
import { storedManifestSchema, toManifest } from "@/lib/skill-studio/design"

export const metadata: Metadata = { title: "Skill Studio" }

// Skill Studio (docs/next-platform/SKILL_STUDIO.md): only with
// next.skillStudio and agents.skillLibrary on. Every action checks again.
export default async function SkillStudioPage() {
  const user = await requireUser()
  if (!(await studioOn())) notFound()

  const [rows, agentRows] = await Promise.all([
    listSkills(user.id),
    withUser(user.id, (tx) =>
      tx
        .select({ id: agents.id, name: agents.name, skills: agents.skills })
        .from(agents)
        .orderBy(asc(agents.createdAt))
    ),
  ])
  const team: StudioAgent[] = agentRows.map((a) => ({
    id: a.id,
    name: a.name,
    skills: a.skills?.on ?? [],
  }))
  const skills: StudioSkill[] = rows.flatMap((row) => {
    const manifest = storedManifestSchema.safeParse(row.manifest)
    if (!manifest.success) return []
    const { risk, approvals } = skillRisk(toManifest(row))
    const t = manifest.data.tools
    return [
      {
        id: row.id,
        status: row.status,
        version: row.version,
        intent: row.intent,
        name: row.name,
        description: row.description,
        body: row.body,
        keywords: manifest.data.keywords,
        tools: [...t.all, ...t.any, ...t.uses],
        risk,
        approvals,
        design: row.design as StudioSkill["design"],
      },
    ]
  })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-1">
          <span className="label-mono">{"// skill studio"}</span>
          <h1 className="text-2xl font-semibold tracking-tight">Skill Studio</h1>
          <p className="text-[13px] text-muted-foreground">
            Describe a skill in a few words. Kriya designs it the way an expert would,
            from several angles, then a strict reviewer improves it. You read it, change
            anything, and choose the agents that use it. A skill teaches an agent how to
            work; it never adds tools or skips your approvals.
          </p>
        </header>

        <Designer />

        <section className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold">Your skills</h2>
          {skills.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              None yet. Your first design shows up here, waiting for your OK.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {skills.map((skill) => (
                <SkillCard
                  key={`${skill.id}:${skill.version}:${skill.status}`}
                  skill={skill}
                  agents={team}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
