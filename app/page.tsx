import type { Metadata } from "next"
import Link from "next/link"
import { asc, eq } from "drizzle-orm"
import {
  ArrowRightIcon,
  BrainIcon,
  CheckIcon,
  GlobeIcon,
  IndianRupeeIcon,
  LanguagesIcon,
  ListChecksIcon,
  PenLineIcon,
  SearchIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SparklesIcon,
  UsersIcon,
  WandSparklesIcon,
} from "lucide-react"

import { PlanCards } from "@/components/account/plan-cards"
import { LogoMark, Mascot, Wordmark } from "@/components/brand"
import { Intro } from "@/components/intro/intro"
import { privileged } from "@/db"
import { plans, type Plan } from "@/db/schema"
import { getSessionUser } from "@/lib/auth"

export const metadata: Metadata = {
  title: { absolute: "Kriya Tavi — your personal AI, by Kriya AI" },
}

async function activePlans(): Promise<Plan[]> {
  try {
    return await privileged
      .select()
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(asc(plans.sort))
  } catch {
    // The landing page stays up even if the database is unreachable
    return []
  }
}

const FEATURES = [
  {
    icon: WandSparklesIcon,
    title: "Agents you design",
    body: "Give each agent a name, a role, instructions and a model level. A tutor, a researcher, a copywriter: yours, and only yours.",
  },
  {
    icon: UsersIcon,
    title: "A lead with sub-agents",
    body: "Put agents in a squad. The lead splits your request, its sub-agents work on their parts at the same time, and you get one combined answer.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Every step on the record",
    body: "Searches, pages read, memory changes and hand-offs, with timings. Check the work instead of trusting it.",
  },
  {
    icon: IndianRupeeIcon,
    title: "Costs in rupees, per task",
    body: "See what each task cost as it finishes. Limits warn you before you hit them, never after.",
  },
  {
    icon: BrainIcon,
    title: "Memory you control",
    body: "Agents remember your projects and preferences. Read, edit or delete any memory, any time.",
  },
  {
    icon: LanguagesIcon,
    title: "Talks the way you talk",
    body: "English, Hindi, Telugu, Tamil, Hinglish and more. Agents answer in your language and script.",
  },
]

const STEPS = [
  {
    n: "01",
    title: "Talk to Tavi",
    body: "Start a conversation, like any assistant. Ask, plan, draft, research.",
  },
  {
    n: "02",
    title: "Build your team",
    body: "Create agents from templates or from scratch, then group them into a squad with a lead.",
  },
  {
    n: "03",
    title: "Hand off real work",
    body: "Close the tab. Tasks keep running, and you get the result with every step shown.",
  },
]

const USE_CASES = [
  {
    who: "Students",
    examples: [
      "A 6-week JEE revision plan",
      "Explain this concept with an example",
      "Find sources for my project",
    ],
  },
  {
    who: "Developers",
    examples: [
      "Review this function for bugs",
      "Compare two libraries with sources",
      "Write tests for my API",
    ],
  },
  {
    who: "Freelancers",
    examples: [
      "Draft a proposal with GST",
      "Follow up on an unpaid invoice",
      "Research a new client's market",
    ],
  },
  {
    who: "Small businesses",
    examples: [
      "Instagram posts for the week",
      "Supplier comparison under ₹50,000",
      "Reply to customer questions",
    ],
  },
]

const FAQ = [
  {
    q: "What can an agent actually do today?",
    a: "Search and read the web with sources, remember what matters about you and your work, and hand tasks to each other in a squad. It plans, researches and drafts. Agents can't use a computer or browser for you yet. That's coming, inside an isolated sandbox, with your approval before anything consequential.",
  },
  {
    q: "How do squads and sub-agents work?",
    a: "A squad is a group of your agents. The lead picks up your message; when part of it clearly belongs to another member's role, it hands that over with a short brief, and the sub-agent takes it from there. You see every hand-off in the thread.",
  },
  {
    q: "Does it understand Hindi, Telugu or Hinglish?",
    a: "Write the way you talk. Agents reply in the language and script you use: English, Hindi, Telugu, Tamil, Hinglish, Telugu-English and more.",
  },
  {
    q: "How do I know what it did?",
    a: "Every task has an activity record: each search, page read and memory change, how long it took, which model level ran it, and what it cost in rupees.",
  },
  {
    q: "Is my data private?",
    a: "Your agents, conversations and memories are isolated to your account at the database level. You can read, edit and delete what your agents remember, or delete your account at any time.",
  },
]

const HERO_CHIPS = [
  {
    position: "top-[8%] -left-2 sm:-left-8",
    dot: "bg-[#1f6362]",
    who: "Lead",
    what: "Planning your request",
  },
  {
    position: "top-[46%] -right-2 sm:-right-8",
    dot: "bg-[#b4622f]",
    who: "Researcher",
    what: "Reading 3 sources",
  },
  {
    position: "bottom-[8%] left-2 sm:-left-4",
    dot: "bg-[#2c8a5f]",
    who: "Writer",
    what: "Draft ready",
  },
]

export default async function LandingPage() {
  const [user, planRows] = await Promise.all([getSessionUser(), activePlans()])
  const cta = user
    ? { href: "/home", label: "Open Kriya Tavi" }
    : { href: "/signup", label: "Start free" }

  return (
    <div className="aura relative min-h-svh overflow-x-hidden">
      <Intro enterHref={user ? "/home" : "/login"} />

      <header className="sticky top-0 z-40 px-3 pt-3 sm:px-6">
        <div className="glass mx-auto flex h-14 max-w-6xl items-center gap-2 rounded-full pr-2 pl-3 sm:pl-4">
          <Link
            href="/"
            className="flex min-h-11 items-center gap-2"
            aria-label="Kriya Tavi"
          >
            <LogoMark className="size-8" />
            <Wordmark className="text-[16px] max-[380px]:hidden" />
          </Link>
          <nav className="ml-auto flex items-center gap-0.5 text-[13.5px]">
            {[
              ["#features", "Features"],
              ["#pricing", "Pricing"],
              ["#faq", "FAQ"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="rounded-full px-3 py-2 text-muted-foreground transition-colors hover:text-foreground max-md:hidden"
              >
                {label}
              </a>
            ))}
            {!user && (
              <Link
                href="/login"
                className="flex min-h-11 items-center rounded-full px-3 text-muted-foreground transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
            )}
            <Link href={cta.href} className="btn-liquid h-11 px-4 text-[13.5px]">
              {cta.label}
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-12 pb-20 sm:px-6 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:gap-6">
          <div className="rise flex flex-col items-start gap-6">
            <span className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] text-muted-foreground">
              <SparklesIcon className="size-3.5 text-betelgeuse" />
              Personal AI, made in India by Kriya AI
            </span>
            <h1 className="font-display text-[44px] leading-[1.02] font-normal text-balance sm:text-[64px] lg:text-[72px]">
              Your personal AI, <em className="text-rigel">with a team</em> behind it.
            </h1>
            <p className="max-w-xl text-[16px] leading-relaxed text-muted-foreground sm:text-[17.5px]">
              Talk to Tavi like any assistant. When the work gets bigger, bring in your
              squad: a lead agent that hands research, writing and code to the right
              sub-agent. Every step shown, every rupee counted.
            </p>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
              <Link href={cta.href} className="btn-liquid h-12 px-7 text-[15px]">
                {cta.label}
                <ArrowRightIcon className="size-4" />
              </Link>
              {!user && (
                <Link href="/login" className="btn-glass h-12 px-7 text-[15px]">
                  Sign in
                </Link>
              )}
            </div>
            {!user && (
              <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <CheckIcon className="size-3.5 text-ok" /> No card. Nothing to install.
              </p>
            )}
          </div>

          <div className="relative mx-auto w-full max-w-[520px]">
            <div className="relative aspect-square overflow-hidden rounded-[36px] bg-[radial-gradient(70%_60%_at_50%_42%,#fbf5ee,#f2e8df_60%,#e6d7c7)] shadow-[0_40px_100px_-40px_rgb(19_41_43/0.55)] ring-1 ring-black/5">
              <Mascot
                priority
                sizes="(min-width: 1024px) 520px, 90vw"
                className="absolute inset-[6%] w-[88%]"
              />
            </div>
            {HERO_CHIPS.map((chip, i) => (
              <div
                key={chip.who}
                style={{ animationDelay: `${400 + i * 160}ms` }}
                className={`rise absolute ${chip.position} flex items-center gap-2.5 rounded-2xl border border-white/70 bg-white/70 px-3.5 py-2.5 text-[#13292b] shadow-[0_12px_40px_-12px_rgb(19_41_43/0.35)] backdrop-blur-xl`}
              >
                <span className={`size-2 rounded-full ${chip.dot}`} />
                <span className="flex flex-col leading-tight">
                  <span className="text-[12.5px] font-semibold">{chip.who}</span>
                  <span className="text-[11.5px] text-[#13292b]/60">{chip.what}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Product preview */}
        <section aria-labelledby="proof" className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <h2
              id="proof"
              className="font-display text-[34px] leading-tight font-normal text-balance sm:text-[44px]"
            >
              One conversation. <em className="text-rigel">A whole team.</em>
            </h2>
            <p className="max-w-xl text-[15px] text-muted-foreground">
              What a finished task looks like, from the hand-off to the bill.
            </p>
          </div>
          <div className="glass grid overflow-hidden rounded-[28px] md:grid-cols-[1.45fr_1fr]">
            <div className="flex min-w-0 flex-col gap-4 p-5 sm:p-7">
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="flex -space-x-1.5">
                  {["bg-[#1f6362]", "bg-[#b4622f]", "bg-[#2c8a5f]"].map((color) => (
                    <span
                      key={color}
                      className={`size-5 rounded-full ring-2 ring-background ${color}`}
                    />
                  ))}
                </span>
                Launch squad · Lead, Researcher, Writer
              </div>
              <p className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[14px] text-primary-foreground">
                Which 3 UPI apps have the lowest failure rates this year? Then a short
                post about it.
              </p>
              <div className="flex flex-col gap-1 rounded-2xl border bg-background/50 p-2 font-mono text-[12px]">
                {[
                  { icon: UsersIcon, text: "Lead → Researcher · find failure-rate data" },
                  { icon: SearchIcon, text: "search · UPI app failure rates 2026 NPCI" },
                  {
                    icon: GlobeIcon,
                    text: "read · npci.org.in · UPI ecosystem statistics",
                  },
                  { icon: UsersIcon, text: "Researcher → Writer · post from findings" },
                  { icon: PenLineIcon, text: "draft · 120-word post with sources" },
                ].map(({ icon: Icon, text }) => (
                  <span
                    key={text}
                    className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground"
                  >
                    <CheckIcon className="size-3.5 shrink-0 text-ok" />
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{text}</span>
                  </span>
                ))}
              </div>
              <p className="text-[14.5px] leading-relaxed">
                Here are the three, with the source for each number, one caveat about how
                the reports measure failures, and a post you can publish today…
              </p>
            </div>
            <div className="flex flex-col gap-4 border-t bg-background/30 p-5 sm:p-7 md:border-t-0 md:border-l">
              <span className="label-mono flex items-center gap-1.5">
                <ListChecksIcon className="size-3.5" />
                Activity record
              </span>
              <dl className="grid grid-cols-2 gap-y-3 text-[13px]">
                <dt className="text-muted-foreground">status</dt>
                <dd className="text-ok">done</dd>
                <dt className="text-muted-foreground">agents</dt>
                <dd>3, two hand-offs</dd>
                <dt className="text-muted-foreground">tools</dt>
                <dd>5 calls, all checked</dd>
                <dt className="text-muted-foreground">time</dt>
                <dd className="tabular-nums">52s</dd>
                <dt className="text-muted-foreground">cost</dt>
                <dd className="font-display text-[18px] leading-none tabular-nums">
                  ₹0.1120
                </dd>
              </dl>
              <p className="mt-auto text-[12px] leading-relaxed text-muted-foreground">
                Illustration. Real records show the exact searches, pages, hand-offs and
                costs of your own tasks.
              </p>
            </div>
          </div>
        </section>

        {/* Features */}
        <section
          id="features"
          aria-labelledby="features-title"
          className="mx-auto max-w-6xl scroll-mt-24 px-4 pb-24 sm:px-6"
        >
          <h2
            id="features-title"
            className="mb-8 max-w-2xl font-display text-[34px] leading-tight font-normal text-balance sm:text-[44px]"
          >
            Built like a premium assistant.{" "}
            <em className="text-rigel">Honest like a ledger.</em>
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <article
                key={title}
                className="glass flex flex-col gap-3 rounded-[22px] p-6 transition-transform duration-300 hover:-translate-y-1"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-rigel-soft text-rigel">
                  <Icon className="size-5" />
                </span>
                <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h3>
                <p className="text-[14px] leading-relaxed text-muted-foreground">
                  {body}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="grid gap-8 md:grid-cols-3 md:gap-6">
            {STEPS.map((step) => (
              <div key={step.n} className="flex flex-col gap-3 border-t pt-6">
                <span className="font-display text-[40px] leading-none text-betelgeuse italic">
                  {step.n}
                </span>
                <h3 className="text-[17px] font-semibold">{step.title}</h3>
                <p className="text-[14px] leading-relaxed text-muted-foreground">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Use cases */}
        <section aria-labelledby="who" className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <h2
            id="who"
            className="mb-8 font-display text-[34px] leading-tight font-normal text-balance sm:text-[44px]"
          >
            Hand off the work that <em className="text-rigel">eats your day</em>
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {USE_CASES.map(({ who, examples }) => (
              <div key={who} className="glass flex flex-col gap-4 rounded-[22px] p-5">
                <h3 className="label-mono">{who}</h3>
                <ul className="flex flex-col gap-2.5 text-[14px]">
                  {examples.map((example) => (
                    <li key={example} className="leading-snug">
                      “{example}”
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {planRows.length > 0 && (
          <section
            id="pricing"
            aria-labelledby="pricing-title"
            className="mx-auto max-w-6xl scroll-mt-24 px-4 pb-24 sm:px-6"
          >
            <h2
              id="pricing-title"
              className="mb-2 font-display text-[34px] leading-tight font-normal sm:text-[44px]"
            >
              Simple plans, <em className="text-rigel">in rupees</em>
            </h2>
            <p className="mb-8 text-[15px] text-muted-foreground">
              Start free. Upgrade when your agents are doing real work for you.
            </p>
            <PlanCards plans={planRows} canBuy={false} signedIn={false} />
          </section>
        )}

        <section
          id="faq"
          aria-labelledby="faq-title"
          className="mx-auto max-w-3xl scroll-mt-24 px-4 pb-24 sm:px-6"
        >
          <h2
            id="faq-title"
            className="mb-8 text-center font-display text-[34px] leading-tight font-normal sm:text-[44px]"
          >
            Questions
          </h2>
          <div className="glass divide-y overflow-hidden rounded-[22px]">
            {FAQ.map(({ q, a }) => (
              <details key={q} className="group px-5 sm:px-6">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 text-[15px] font-medium">
                  {q}
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="pb-5 text-[14px] leading-relaxed text-muted-foreground">
                  {a}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Closing call */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="relative grid items-center overflow-hidden rounded-[32px] bg-[radial-gradient(80%_80%_at_80%_50%,#fbf5ee,#f2e8df_55%,#e6d7c7)] text-[#13292b] ring-1 ring-black/5 md:grid-cols-[1.3fr_1fr]">
            <div className="flex flex-col items-start gap-5 p-8 sm:p-12">
              <h2 className="font-display text-[34px] leading-[1.05] font-normal text-balance sm:text-[48px]">
                Meet Tavi. <em className="text-[#b4622f]">Then meet your team.</em>
              </h2>
              <p className="max-w-md text-[15px] leading-relaxed text-[#13292b]/70">
                Free to start, in your browser or on your phone.
              </p>
              <Link href={cta.href} className="btn-liquid btn-ink h-12 px-7 text-[15px]">
                {cta.label}
                <ArrowRightIcon className="size-4" />
              </Link>
            </div>
            <div className="relative mx-auto -mb-6 w-[70%] max-w-[340px] md:mb-0 md:w-full">
              <Mascot sizes="340px" className="w-full" />
            </div>
          </div>
        </section>
      </main>

      <footer className="relative border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-[12.5px] text-muted-foreground sm:flex-row sm:items-center sm:px-6">
          <span className="flex items-center gap-2">
            <LogoMark className="size-6" />
            Kriya Tavi by Kriya AI
          </span>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:ml-auto">
            <Link href="/legal/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link href="/legal/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <span className="inline-flex items-center gap-1">
              <SmartphoneIcon className="size-3.5" /> Works on phones
            </span>
          </nav>
        </div>
      </footer>
    </div>
  )
}
