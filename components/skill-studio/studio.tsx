"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import {
  approveSkill,
  deleteSkill,
  designSkill,
  restoreSkill,
  retireSkill,
  saveSkill,
} from "@/actions/skill-studio"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

// Skill Studio (docs/next-platform/SKILL_STUDIO.md): describe a skill, read
// how Kriya designed it, change anything, then approve it for the agents
// that should use it. Every check happens again on the server.

// 44 px touch targets on phones (AGENTS.md)
const tap = "min-h-11 sm:min-h-8"

export type StudioSkill = {
  id: string
  status: "draft" | "active" | "retired"
  version: number
  intent: string
  name: string
  description: string
  body: string
  keywords: string[]
  tools: string[]
  risk: string
  approvals: string[]
  design: {
    domain?: string
    expert?: string
    perspectives?: { lens: string; insight: string }[]
    scenarios?: string[]
    outOfScope?: string[]
    assumptions?: string[]
    scores?: Record<string, number> | null
    issues?: string[]
    removed?: string[]
    checks?: { ask: string; expect: string; got: string; ok: boolean }[]
  }
}
export type StudioAgent = { id: string; name: string; skills: string[] }

const EXAMPLES = [
  "Keep my LinkedIn profile and posts strong as a final-year student",
  "Prepare me for product manager interviews",
  "Plan a week of vegetarian meals for a family of four",
]

function useRun() {
  const router = useRouter()
  const [pending, start] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  const run = (work: () => Promise<{ error?: string } | unknown>, after?: () => void) =>
    start(async () => {
      setError(null)
      try {
        const result = (await work()) as { error?: string } | undefined
        if (result?.error) setError(result.error)
        else {
          after?.()
          router.refresh()
        }
      } catch {
        setError("That didn't go through. Try again.")
      }
    })
  return { pending, error, run }
}

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  ) : null

export function Designer() {
  const [intent, setIntent] = React.useState("")
  const { pending, error, run } = useRun()
  return (
    <form
      className="glass flex flex-col gap-3 rounded-[20px] p-4"
      onSubmit={(event) => {
        event.preventDefault()
        run(
          () => designSkill(intent),
          () => setIntent("")
        )
      }}
    >
      <label htmlFor="intent" className="text-[14px] font-semibold">
        What should your agent get really good at?
      </label>
      <Textarea
        id="intent"
        value={intent}
        maxLength={500}
        rows={3}
        placeholder="A few words are enough"
        onChange={(event) => setIntent(event.target.value)}
        disabled={pending}
      />
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            disabled={pending}
            onClick={() => setIntent(example)}
            className={`${tap} rounded-full border border-hairline px-3 text-left text-[12px] text-muted-foreground hover:border-input`}
          >
            {example}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          className={tap}
          disabled={pending || intent.trim().length < 3}
        >
          {pending && <Spinner />}
          {pending ? "Designing…" : "Design skill"}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {pending
            ? "An expert plan, a draft and a strict review: about a minute."
            : "You read and approve it before any agent uses it."}
        </span>
      </div>
      <Problem error={error} />
    </form>
  )
}

const STATUS = {
  draft: "border-betelgeuse/40 text-betelgeuse",
  active: "border-rigel/40 text-rigel",
  retired: "border-hairline text-faint",
} as const

function List({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="label-mono">{title}</span>
      <ul className="list-disc pl-5 text-[12.5px] text-muted-foreground">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export function SkillCard({
  skill,
  agents,
}: {
  skill: StudioSkill
  agents: StudioAgent[]
}) {
  const { pending, error, run } = useRun()
  const [name, setName] = React.useState(skill.name)
  const [description, setDescription] = React.useState(skill.description)
  const [keywords, setKeywords] = React.useState(skill.keywords.join(", "))
  const [body, setBody] = React.useState(skill.body)
  const [chosen, setChosen] = React.useState(
    () => new Set(agents.filter((a) => a.skills.includes(skill.id)).map((a) => a.id))
  )
  const edited =
    name !== skill.name ||
    description !== skill.description ||
    keywords !== skill.keywords.join(", ") ||
    body !== skill.body
  const edit = () => ({
    name,
    description,
    keywords: keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    instructions: body,
  })
  const d = skill.design
  const retired = skill.status === "retired"

  return (
    <li className="glass flex flex-col gap-3 rounded-[20px] px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[15px] font-semibold">{skill.name}</span>
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[10.5px] ${STATUS[skill.status]}`}
        >
          {skill.status === "draft" ? "waiting for your OK" : skill.status} · v
          {skill.version}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">{skill.description}</p>
      <p className="font-mono text-[10.5px] text-faint">
        You asked: &ldquo;{skill.intent}&rdquo;
      </p>

      <details className="flex flex-col gap-3">
        <summary className={`${tap} flex cursor-pointer items-center text-[13px]`}>
          How Kriya designed it
        </summary>
        <div className="flex flex-col gap-3 pt-2">
          {d.expert && (
            <p className="text-[12.5px]">
              <span className="label-mono">Expert </span>
              {d.expert}
            </p>
          )}
          {d.perspectives?.length ? (
            <div className="flex flex-col gap-1">
              <span className="label-mono">Perspectives</span>
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {d.perspectives.map((p, i) => (
                  <li key={i}>
                    <span className="font-semibold">{p.lens}: </span>
                    <span className="text-muted-foreground">{p.insight}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <List title="Situations it handles" items={d.scenarios} />
          <List title="What Kriya won't do here" items={d.outOfScope} />
          <List title="Assumptions" items={d.assumptions} />
          {d.scores && (
            <p className="font-mono text-[11px] text-muted-foreground">
              Review:{" "}
              {Object.entries(d.scores)
                .map(([k, v]) => `${k} ${v}/5`)
                .join(" · ")}
            </p>
          )}
          <List title="Fixed in review" items={d.issues} />
          <List title="Taken out by Kriya's rules" items={d.removed} />
          {d.checks?.length ? (
            <div className="flex flex-col gap-1">
              <span className="label-mono">Sample requests</span>
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {d.checks.map((c, i) => (
                  <li key={i} className={c.ok ? "" : "text-betelgeuse"}>
                    {c.got === "activate" ? "Uses it" : "Doesn't use it"}: &ldquo;
                    {c.ask}&rdquo;{c.ok ? "" : " (not as intended; adjust the keywords)"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="font-mono text-[11px] text-muted-foreground">
            Tools it mentions: {skill.tools.length ? skill.tools.join(", ") : "none"} ·
            highest risk {skill.risk}
            {skill.approvals.length > 0 &&
              ` · waits for your approval: ${skill.approvals.join(", ")}`}
          </p>
        </div>
      </details>

      <details>
        <summary className={`${tap} flex cursor-pointer items-center text-[13px]`}>
          Read or change the skill
        </summary>
        <div className="flex flex-col gap-2 pt-2">
          <label className="text-[12px]" htmlFor={`${skill.id}-name`}>
            Name
          </label>
          <Input
            className={tap}
            id={`${skill.id}-name`}
            value={name}
            maxLength={60}
            disabled={retired || pending}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="text-[12px]" htmlFor={`${skill.id}-description`}>
            Description
          </label>
          <Input
            className={tap}
            id={`${skill.id}-description`}
            value={description}
            maxLength={240}
            disabled={retired || pending}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="text-[12px]" htmlFor={`${skill.id}-keywords`}>
            Words that bring it in (comma-separated)
          </label>
          <Input
            className={tap}
            id={`${skill.id}-keywords`}
            value={keywords}
            disabled={retired || pending}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <label className="text-[12px]" htmlFor={`${skill.id}-body`}>
            Instructions
          </label>
          <Textarea
            id={`${skill.id}-body`}
            value={body}
            rows={14}
            maxLength={6000}
            className="font-mono text-[12px]"
            disabled={retired || pending}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="font-mono text-[10.5px] text-faint">
            {body.length.toLocaleString("en-IN")} / 6,000
          </span>
          {!retired && (
            <Button
              variant="outline"
              className={`${tap} self-start`}
              disabled={pending || !edited}
              onClick={() => run(() => saveSkill(skill.id, edit()))}
            >
              Save changes
            </Button>
          )}
        </div>
      </details>

      {!retired && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px]">Agents that use it</legend>
          {agents.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground">Create an agent first.</p>
          )}
          {agents.map((agent) => (
            <label
              key={agent.id}
              className={`${tap} flex items-center gap-3 text-[13px]`}
            >
              <Checkbox
                checked={chosen.has(agent.id)}
                disabled={pending}
                aria-label={`Use with ${agent.name}`}
                onCheckedChange={(on) =>
                  setChosen((prev) => {
                    const next = new Set(prev)
                    if (on) next.add(agent.id)
                    else next.delete(agent.id)
                    return next
                  })
                }
              />
              {agent.name}
            </label>
          ))}
          <p className="text-[11.5px] text-muted-foreground">
            To take it off an agent later, untick it in that agent&rsquo;s Skills.
          </p>
        </fieldset>
      )}

      <div className="flex flex-wrap gap-2">
        {!retired && (
          <Button
            className={tap}
            disabled={pending || edited}
            onClick={() => run(() => approveSkill(skill.id, [...chosen]))}
          >
            {skill.status === "draft" ? "Approve and use it" : "Update agents"}
          </Button>
        )}
        {skill.status === "active" && (
          <Button
            variant="outline"
            className={tap}
            disabled={pending}
            onClick={() => run(() => retireSkill(skill.id))}
          >
            Stop using it
          </Button>
        )}
        {retired && (
          <Button
            variant="outline"
            className={tap}
            disabled={pending}
            onClick={() => run(() => restoreSkill(skill.id))}
          >
            Restore as draft
          </Button>
        )}
        <Confirm
          trigger={
            <Button variant="ghost" className={tap} disabled={pending}>
              Delete
            </Button>
          }
          title={`Delete ${skill.name}?`}
          description="It's removed from every agent that uses it. This can't be undone."
          action="Delete"
          onConfirm={() => run(() => deleteSkill(skill.id))}
        />
      </div>
      {edited && !retired && (
        <p className="text-[12px] text-muted-foreground">Save your changes first.</p>
      )}
      <Problem error={error} />
    </li>
  )
}
