// The public legal pages (/legal/<doc>), as data so the readiness checks
// can read them (tests/readiness). DRAFTS: counsel hasn't answered AQ-1…AQ-6
// (SECURITY_AND_COMPLIANCE §4) and the DPDP Rules gazette text hasn't been
// read (RESEARCH §5), so open points say they're open; nothing here claims
// a legal position that hasn't been reviewed. GA-7 stays open until counsel
// signs these off.

export type LegalSection = { heading: string; paragraphs?: string[]; items?: string[] }
export type LegalDoc = { title: string; summary: string; sections: LegalSection[] }

export const LEGAL_STATUS = {
  draft: true,
  label: "Draft, pending legal review",
  updated: "2026-10-18",
}

// Every outside service that may process a person's data, with what for.
// The readiness check fails if the code uses a service missing from here.
export const PROCESSORS = [
  {
    name: "Supabase",
    purpose: "Database, sign-in and file storage for your account",
    when: "Always",
  },
  {
    name: "Render",
    purpose:
      "Runs Kriya's web app, background worker and agent browser (Singapore region)",
    when: "Always",
  },
  {
    name: "OpenRouter and the AI model providers it routes to",
    purpose:
      "Generates your agents' replies from your messages and the context Kriya sends with them",
    when: "Each time an agent works",
  },
  {
    name: "Firecrawl",
    purpose: "Web search and reading public web pages for your agents",
    when: "When an agent searches or reads the web, or a watcher checks a page",
  },
  {
    name: "Razorpay",
    purpose: "Payments for paid plans; Kriya never sees your card or UPI PIN",
    when: "When you pay",
  },
  {
    name: "Google, Notion, GitHub and Meta (Instagram)",
    purpose: "Only the accounts you connect, for the actions you ask for",
    when: "Only after you connect an account",
  },
] as const

const OPEN = "under legal review"

export const LEGAL_DOCS = {
  privacy: {
    title: "Privacy notice",
    summary:
      "What Kriya Tavi keeps about you, why, who else handles it, how long it's kept, and how you can see, correct or delete it.",
    sections: [
      {
        heading: "Who we are",
        paragraphs: [
          "Kriya Tavi is run by Kriya AI. For anything about your data, write to Kriya support from the email address on your account.",
          `The grievance officer and the other details the Digital Personal Data Protection Act, 2023 requires are ${OPEN}; they will be named here before paid plans launch.`,
        ],
      },
      {
        heading: "What we keep, and why",
        items: [
          "Account: your email, name and plan, to sign you in and bill you.",
          'Conversations and agent work: your messages, your agents\' replies and the record of what each agent did ("What I did" and receipts), so you can see and check it.',
          "Memory: notes your agents keep about you and your work, to help them next time. You can see, edit, pin, pause, export and delete them in Account → About you.",
          "Files: documents you upload and PDFs Kriya makes for you, for your agents to read and for you to download.",
          "Saved logins: if you sign in to a site in Kriya's browser and choose Save, Kriya keeps that site's session (its cookies and site storage), encrypted. Never your password. Used only for your own tasks on that site.",
          "Accounts (bills, ledger, invoices): figures you or your agents enter, for your own records. Nothing is filed or paid by Kriya.",
          "Usage: which model ran, tokens, time and cost per task, to bill fairly and show you what you spent.",
        ],
      },
      {
        heading: "Consent",
        paragraphs: [
          "Saving a login for a site, and letting agents use it when you're not there, are separate choices you make for each site, off until you turn them on. You can pause an agent's memory, and files and accounts hold only what you or your agents add. You can withdraw any of these by switching it off or deleting what was kept.",
        ],
      },
      {
        heading: "Who else handles your data",
        paragraphs: [
          "These services process data for Kriya to provide the service. We don't sell your data or use it for advertising.",
        ],
        items: PROCESSORS.map(
          (p) => `${p.name}: ${p.purpose} (${p.when.toLowerCase()}).`
        ),
      },
      {
        heading: "How long we keep it",
        items: [
          "Live progress of a task: deleted a day after the task ends.",
          "Screenshots taken as evidence: 30 days.",
          "Shared links: their copy is deleted 7 days after the link expires or you revoke it.",
          "Saved logins: deleted when you remove them, when they expire, or after 90 days unused.",
          `Everything else (conversations, memory, files, records of what agents did, accounts): until you delete it or your account. How long Kriya should keep its own copy of some of these is ${OPEN}.`,
        ],
      },
      {
        heading: "Your rights",
        items: [
          "See what we keep: your conversations, memory, files, saved logins and accounts are all in the app; memory can be exported.",
          "Correct it: edit memory, file names and your ledger.",
          "Delete it: delete any of them, or your whole account from Account settings, which removes everything tied to it.",
          "Withdraw consent for any of the above at any time.",
          `Nominating someone to act for you, and complaining to the Data Protection Board of India: how, is ${OPEN}.`,
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          "Each account's data is kept apart from every other account's in the database. Tokens of connected accounts and saved logins are encrypted with a key kept outside the database and are never shown to anyone, including Kriya staff. Logs never contain them.",
          `If a breach affects your data, we'll tell you and the authorities as the law requires; the exact timelines (the DPDP Rules' breach provisions) are ${OPEN}.`,
        ],
      },
      {
        heading: "People under 18",
        paragraphs: [
          `Whether and how Kriya can be used by people under 18, and the parental consent that would need, is ${OPEN}.`,
        ],
      },
    ],
  },
  terms: {
    title: "Terms of service",
    summary:
      "How Kriya Tavi works, what you're responsible for, and what Kriya does and doesn't do on your behalf.",
    sections: [
      {
        heading: "The service",
        paragraphs: [
          "Kriya Tavi gives you AI agents that do work for you: research, drafts, documents, keeping track of goals and deadlines, and, when you allow it, actions in accounts you connect. Kriya shows what each agent did, with evidence, so you can check it.",
        ],
      },
      {
        heading: "You stay in charge",
        items: [
          "Anything that changes something outside Kriya (posting, sending, booking, saving on another site) waits for your approval of that exact action.",
          "Agents never handle your passwords, one-time codes, CAPTCHAs, payments or identity documents. You do those yourself.",
          "On sites whose rules don't allow automation, Kriya prepares the text and you apply it yourself.",
          "You're responsible for what you ask agents to do and for checking their work before you rely on it. Agents can make mistakes.",
        ],
      },
      {
        heading: "Not professional advice",
        paragraphs: [
          `Accounts, GST figures and reports are prepared records, not tax, legal or financial advice. Kriya never files returns or makes payments. The final liability wording for accounting summaries and for actions on other sites at your direction is ${OPEN}.`,
        ],
      },
      {
        heading: "Fair use",
        items: [
          "Don't use Kriya to break the law, harm others, attack systems, scrape other people's data, send bulk messages, or get around other sites' rules.",
          "Each plan has limits, and Kriya enforces them.",
          "We may pause accounts that abuse the service.",
        ],
      },
      {
        heading: "Plans and payment",
        paragraphs: [
          "Paid plans are billed monthly in rupees and can be cancelled at any time; they stay active until the end of the period you paid for. Prices are shown before you pay.",
        ],
      },
      {
        heading: "Ending",
        paragraphs: [
          "You can delete your account from Account settings at any time. Its data is deleted as the privacy notice describes.",
        ],
      },
    ],
  },
  ai: {
    title: "AI disclosure",
    summary:
      "Kriya's agents are AI. Here's what that means for what they do, what they can't do, and how you can check their work.",
    sections: [
      {
        heading: "Your agents are AI",
        paragraphs: [
          "Every agent in Kriya Tavi is an AI system, not a person. Their replies are generated by AI models (the privacy notice says who provides them). They can be wrong, out of date or overconfident.",
        ],
      },
      {
        heading: "How you can check their work",
        items: [
          '"What I did" lists only actions a tool actually ran and checked, never what an agent says it did.',
          "Quoted sources are checked word for word against the page they came from.",
          "Money figures are computed by code, not by the AI.",
          "Some of these features are still being rolled out and may not be on for your account yet.",
        ],
      },
      {
        heading: "What agents can't do",
        items: [
          "Act outside Kriya without your approval of the exact action.",
          "See or type your passwords, one-time codes, CAPTCHAs, card or bank details, or identity documents.",
          "Pay, file returns, or decide what's yours to decide (confirming ledger entries, trusting a memory, sharing a link).",
        ],
      },
      {
        heading: "When an agent acts in the world",
        items: [
          "In Kriya's browser, an agent uses only sites you've allowed, within each site's rules. When you take over, what you type goes to the site through Kriya's browser and isn't stored or recorded.",
          "When Kriya places a phone call for you (once that feature is available), the call starts by saying it's an AI assistant calling on your behalf. That sentence is fixed, never generated.",
          `Whether Kriya's browser should identify itself to websites as an AI agent is ${OPEN}.`,
        ],
      },
    ],
  },
} satisfies Record<string, LegalDoc>

export type LegalDocName = keyof typeof LEGAL_DOCS
