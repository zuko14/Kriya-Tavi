import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { LogoMark, Wordmark } from "@/components/brand"
import { OwnerNav } from "@/components/owner/nav"
import { requireOwner } from "@/lib/auth"

export const metadata: Metadata = {
  title: { default: "Owner", template: "%s · Owner · Kriya Tavi" },
}

// The owner console. Everyone without the owner role gets a 404 from
// requireOwner(), here and again in every page and action.
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwner()
  return (
    <div className="aura flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col gap-6 border-r bg-background/40 px-4 py-5 backdrop-blur-2xl lg:flex">
        <Link href="/home" className="flex items-center gap-2.5 px-1">
          <LogoMark className="size-8" />
          <span className="flex flex-col leading-tight">
            <Wordmark className="text-[15px]" />
            <span className="font-mono text-[10px] tracking-[0.16em] text-betelgeuse uppercase">
              Owner console
            </span>
          </span>
        </Link>
        <OwnerNav variant="rail" />
        <div className="mt-auto flex flex-col gap-3 border-t pt-4">
          <span className="truncate px-1 font-mono text-[11px] text-muted-foreground">
            {owner.email}
          </span>
          <Link
            href="/home"
            className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
            Back to workspace
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b bg-background/70 backdrop-blur-2xl lg:hidden">
          <div className="flex h-14 items-center gap-2.5 px-4">
            <Link href="/home" className="flex min-h-11 items-center gap-2">
              <LogoMark className="size-7" />
              <Wordmark className="text-[15px]" />
            </Link>
            <span className="rounded-full bg-betelgeuse-soft px-2 py-0.5 font-mono text-[10px] text-betelgeuse uppercase">
              Owner
            </span>
            <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground max-sm:hidden">
              {owner.email}
            </span>
          </div>
          <OwnerNav variant="pills" />
        </header>
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
          {children}
        </main>
      </div>
    </div>
  )
}
