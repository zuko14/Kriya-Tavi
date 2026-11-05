import type { Metadata } from "next"
import Link from "next/link"

import { HandAJob } from "@/components/operator/hand-a-job"
import { available, CONNECT, TOOLS } from "@/components/workspace/places"
import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { runnable } from "@/lib/operator/playbooks"
import { getFeatures } from "@/queries/features"
import { playbookChoices, playbookNeeds } from "@/queries/mandates"

export const metadata: Metadata = { title: "How to use Kriya" }

const STEPS = [
  {
    title: "Give an agent a task",
    what: "On Home, pick who does it and say what you need in your own words. It keeps working if you close the app.",
  },
  {
    title: "Approve what matters",
    what: "Before anything leaves Kriya, such as a message or a change on your computer, it waits in your Inbox for your OK.",
  },
  {
    title: "See what was done",
    what: "Every task shows what the agent actually did, with proof from the tools it ran, not just what it says.",
  },
]

const EXAMPLES = [
  "Compare the best phones under ₹30,000 right now, with sources",
  "Plan my week: three priorities a day, with time for breaks",
  "Draft a polite payment reminder for an invoice 30 days late",
  "What changed in Indian income tax rules this year?",
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

// Everything Home used to spell out, in one place to read (owner 2026-11-05):
// the steps, examples, each switched-on feature and the jobs this person can
// hand over (same switches and reads as before)
export default async function Guide() {
  const user = await requireUser()
  const places = available([...TOOLS, ...CONNECT], await getFeatures(user.id))
  const playbooksOn =
    (await getSetting("operator.playbooks")) === "on" &&
    (await getSetting("operator.mandates")) === "on"
  const [jobs, choices] = playbooksOn
    ? await Promise.all([
        playbookNeeds(user.id).then((have) =>
          runnable(have).map(({ id, title, summary, slots }) => ({
            id,
            title,
            summary,
            slots,
          }))
        ),
        playbookChoices(user.id),
      ])
    : [[], null]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-9 px-4 py-6 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-[30px] leading-none font-normal sm:text-[36px]">
            How to use Kriya
          </h1>
          <p className="text-[14px] leading-relaxed text-muted-foreground">
            Kriya is a team of AI agents that do real work for you, and show you what they
            did.
          </p>
        </header>

        <Section title="The basics">
          <ol className="glass flex flex-col divide-y overflow-hidden rounded-[20px]">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex flex-col gap-1 px-4 py-3.5">
                <span className="text-[13.5px] font-medium">
                  {index + 1}. {step.title}
                </span>
                <span className="text-[13px] leading-relaxed text-muted-foreground">
                  {step.what}
                </span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Things you can ask">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed text-muted-foreground">
            {EXAMPLES.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </Section>

        {choices && jobs.length > 0 && (
          <Section title="Hand Kriya a job">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              A job has a clear finish line. Kriya keeps at it, checks in, and is done
              only when the proof says so.
            </p>
            <HandAJob
              playbooks={jobs}
              agents={choices.agents}
              invoices={choices.invoices}
            />
          </Section>
        )}

        {places.length > 0 && (
          <Section title="What Kriya can do">
            <ul className="grid gap-2 sm:grid-cols-2">
              {places.map(({ href, label, icon: Icon, blurb }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="glass flex h-full min-h-16 items-start gap-3 rounded-2xl px-4 py-3 transition-colors hover:border-rigel/30"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-rigel-soft text-rigel">
                      <Icon className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13.5px] leading-tight font-medium">
                        {label}
                      </span>
                      <span className="text-[12.5px] leading-snug text-muted-foreground">
                        {blurb}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  )
}
