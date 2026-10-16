import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { LogoMark, Wordmark } from "@/components/brand"

// shortcut: plain-language drafts so sign-up can link somewhere real; they
// must be replaced by counsel-reviewed terms before commercial launch
const DOCS = {
  terms: {
    title: "Terms of service (draft)",
    body: [
      "Kriya Tavi is operated by Kriya AI. These draft terms describe how the service works today and will be replaced by reviewed terms before paid plans launch.",
      "You are responsible for what you ask your agents to do and for checking their work before relying on it. Agents can make mistakes; Kriya shows what each agent did so you can verify it.",
      "Don't use Kriya to break the law, harm others, attack systems, or generate content that is illegal in India.",
      "Free plans have daily limits. Paid plans, when available, are billed monthly in rupees and can be cancelled at any time; they stay active until the end of the period you paid for.",
      "We may pause accounts that abuse the service. You can delete your account from Account settings at any time.",
    ],
  },
  privacy: {
    title: "Privacy policy (draft)",
    body: [
      "We store your account details, your agents, conversations and memories so the service can work. They are stored in a managed Postgres database (Supabase) and isolated per account.",
      "To answer you, your messages are sent to AI model providers through OpenRouter, and web searches go through Firecrawl. We don't sell your data or use it for advertising.",
      "We record usage (model, tokens, cost) per task to bill fairly and show you what you spent. Payment details are handled by our payment provider; Kriya never sees your card or UPI PIN.",
      "You can see, edit and delete your agents' memories at any time, and delete your whole account from Account settings. Billing records are kept without your name for accounting.",
      "Questions about your data: contact Kriya support from the email address on your account.",
    ],
  },
} as const

type Doc = keyof typeof DOCS

export async function generateMetadata({
  params,
}: {
  params: Promise<{ doc: string }>
}): Promise<Metadata> {
  const { doc } = await params
  return { title: doc in DOCS ? DOCS[doc as Doc].title : "Not found" }
}

export default async function LegalPage({
  params,
}: {
  params: Promise<{ doc: string }>
}) {
  const { doc } = await params
  if (!(doc in DOCS)) notFound()
  const { title, body } = DOCS[doc as Doc]
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
      <Link href="/" className="flex items-center gap-2">
        <LogoMark className="size-6" />
        <Wordmark />
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {body.map((paragraph) => (
        <p key={paragraph} className="text-[14px] leading-relaxed text-muted-foreground">
          {paragraph}
        </p>
      ))}
    </main>
  )
}
