import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { LogoMark, Wordmark } from "@/components/brand"
import { LEGAL_DOCS, LEGAL_STATUS, type LegalDocName } from "@/lib/legal"

// Privacy notice, terms and AI disclosure (A11). Drafts until counsel signs
// them off (GA-7); the label says so on every page.

const isDoc = (doc: string): doc is LegalDocName => doc in LEGAL_DOCS

const LINKS: [LegalDocName, string][] = [
  ["privacy", "Privacy"],
  ["terms", "Terms"],
  ["ai", "AI disclosure"],
]

export async function generateMetadata({
  params,
}: {
  params: Promise<{ doc: string }>
}): Promise<Metadata> {
  const { doc } = await params
  return isDoc(doc)
    ? { title: `${LEGAL_DOCS[doc].title} (draft)`, description: LEGAL_DOCS[doc].summary }
    : { title: "Not found" }
}

export default async function LegalPage({
  params,
}: {
  params: Promise<{ doc: string }>
}) {
  const { doc } = await params
  if (!isDoc(doc)) notFound()
  const { title, summary, sections } = LEGAL_DOCS[doc]
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12">
      <Link href="/" className="flex min-h-11 items-center gap-2 self-start">
        <LogoMark className="size-6" />
        <Wordmark />
      </Link>
      <header className="flex flex-col gap-2">
        {LEGAL_STATUS.draft && (
          <p
            role="note"
            className="self-start rounded-full border border-betelgeuse/40 bg-betelgeuse/10 px-3 py-1 text-[12px] font-medium"
          >
            {LEGAL_STATUS.label}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-[14px] leading-relaxed text-muted-foreground">{summary}</p>
        <p className="label-mono">updated {LEGAL_STATUS.updated}</p>
      </header>
      {sections.map((section) => (
        <section key={section.heading} className="flex flex-col gap-2">
          <h2 className="text-[15px] font-semibold">{section.heading}</h2>
          {section.paragraphs?.map((paragraph) => (
            <p
              key={paragraph}
              className="text-[14px] leading-relaxed text-muted-foreground"
            >
              {paragraph}
            </p>
          ))}
          {section.items && (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-relaxed text-muted-foreground">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <nav
        aria-label="Legal"
        className="flex flex-wrap gap-x-4 border-t pt-4 text-[13px]"
      >
        {LINKS.filter(([name]) => name !== doc).map(([name, label]) => (
          <Link
            key={name}
            href={`/legal/${name}`}
            className="flex min-h-11 items-center text-rigel hover:underline"
          >
            {label}
          </Link>
        ))}
      </nav>
    </main>
  )
}
