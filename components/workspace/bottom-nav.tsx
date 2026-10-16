"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { HouseIcon, ListChecksIcon, UserIcon, UsersIcon } from "lucide-react"

import { useWorkspace } from "@/components/workspace/context"
import { cn } from "@/lib/utils"

// Phone navigation: four thumb-reachable tabs. Hidden inside a conversation,
// where the composer needs the space and the header has a back button.
export function BottomNav() {
  const pathname = usePathname()
  const { status } = useWorkspace()
  if (/^\/(a|s)\/[^/]+\/[^/]+/.test(pathname)) return null

  const tabs = [
    { href: "/home", label: "Home", icon: HouseIcon },
    { href: "/agents", label: "Agents", icon: UsersIcon },
    {
      href: "/tasks",
      label: "Tasks",
      icon: ListChecksIcon,
      badge: status.running.length || null,
    },
    { href: "/account", label: "You", icon: UserIcon, dot: status.usage.warn },
  ]

  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 border-t bg-background/80 pb-safe backdrop-blur-2xl md:hidden"
    >
      {tabs.map(({ href, label, icon: Icon, badge, dot }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
              active ? "text-rigel" : "text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "relative grid h-7 w-14 place-items-center rounded-full transition-colors",
                active && "bg-rigel-soft"
              )}
            >
              <Icon className="size-5" />
              {badge ? (
                <span className="absolute -top-1 right-2 grid h-4 min-w-4 place-items-center rounded-full bg-rigel px-1 font-mono text-[9.5px] text-background tabular-nums">
                  {badge}
                </span>
              ) : dot ? (
                <span className="absolute top-0 right-3 size-2 rounded-full bg-betelgeuse" />
              ) : null}
            </span>
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
