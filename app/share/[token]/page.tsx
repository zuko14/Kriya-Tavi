import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { LogoMark } from "@/components/brand"
import { formatDate } from "@/lib/documents/templates"
import { allow, clientIp } from "@/lib/rate-limit"
import { ipHash, openShare, recordView } from "@/lib/share"

// A Kriya Share (K8, AD-34): public on purpose, outside PROTECTED in
// proxy.ts (AT-SHR-05). It shows one snapshot, read-only: no account, no
// live data, no sign-up prompt, no tracking beyond the person's own view
// log. Unknown, expired and revoked links are the same 404.

export const metadata: Metadata = {
  title: "Shared from Kriya",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const ip = await clientIp()
  if (!(await allow(`share:${ipHash(ip) ?? ip}`, 60, 60))) {
    return (
      <main className="grid min-h-svh place-items-center p-4 text-[14px] text-muted-foreground">
        Too many requests. Try again in a minute.
      </main>
    )
  }
  const share = await openShare(token)
  if (!share) notFound()
  await recordView(share, ip)

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-5 px-4 py-8">
      <LogoMark className="size-8" />
      <div className="flex flex-col gap-1.5">
        <span className="label-mono text-faint">Shared snapshot</span>
        <h1 className="text-xl font-semibold tracking-tight">{share.title}</h1>
        <p className="text-[13.5px] text-muted-foreground">
          Shared by {share.sharedBy || "a Kriya user"} on {formatDate(share.createdAt)}.
          Expires {formatDate(share.expiresAt)}.
        </p>
      </div>
      <a
        href={`/share/${token}/pdf`}
        rel="noreferrer"
        className="inline-flex min-h-11 items-center justify-center rounded-md bg-rigel px-4 text-[14px] font-medium text-white"
      >
        Open the PDF
      </a>
      <p className="text-[12px] text-faint">
        A read-only copy made when it was shared; it doesn&apos;t change afterwards. The
        person who shared it can see that it was opened, and can revoke it at any time.
      </p>
    </main>
  )
}
