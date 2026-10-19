"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { HouseIcon, InboxIcon, ListChecksIcon, UserIcon, UsersIcon } from "lucide-react"

import { inboxBadge } from "@/actions/inbox"
import { useWorkspace } from "@/components/workspace/context"
import { cn } from "@/lib/utils"

// Phone navigation: four thumb-reachable tabs. Hidden inside a conversation,
// where the composer needs the space and the header has a back button.
export function BottomNav() {
  const pathname = usePathname()
  const { status } = useWorkspace()
  // The Inbox tab (A3) shows only while agents.inbox is on (null otherwise);
  // its count is refreshed on every navigation
  const [inbox, setInbox] = React.useState<number | null>(null)
  React.useEffect(() => {
    inboxBadge().then(setInbox, () => {})
  }, [pathname])
  if (/^\/(a|s)\/[^/]+\/[^/]+/.test(pathname)) return null

  const tabs = [
    { href: "/home", label: "Home", icon: HouseIcon },
    { href: "/agents", label: "Agents", icon: UsersIcon },
    ...(inbox === null
      ? []
      : [{ href: "/inbox", label: "Inbox", icon: InboxIcon, badge: inbox || null }]),
    {
      href: "/tasks",
      label: "Tasks",
      icon: ListChecksIcon,
      badge: status.running.length || null,
    },
    { href: "/account", label: "You", icon: UserIcon, dot: status.usage.warn },
  ]

  const current = tabs.findIndex(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`)
  )

  return (
    // A floating glass capsule; the lit lens glides to the active tab
    <nav
      aria-label="Main"
      className="shrink-0 px-3 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.625rem)] md:hidden"
    >
      <div className="glass-strong relative flex rounded-[26px] p-1">
        {current >= 0 && (
          <span
            aria-hidden
            className="absolute inset-y-1 left-1 rounded-[22px] bg-rigel-soft shadow-[inset_0_1px_0_var(--glass-rim),0_6px_16px_-10px_var(--rigel)] transition-transform duration-500 ease-[var(--ease-spring)]"
            style={{
              width: `calc((100% - 0.5rem) / ${tabs.length})`,
              transform: `translateX(${current * 100}%)`,
            }}
          />
        )}
        {tabs.map(({ href, label, icon: Icon, badge, dot }, index) => {
          const active = index === current
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "press relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                active ? "text-rigel" : "text-muted-foreground"
              )}
            >
              <span className="relative grid h-6 w-12 place-items-center">
                <Icon
                  className={cn(
                    "size-5 transition-transform duration-500 ease-[var(--ease-spring)]",
                    active && "-translate-y-px scale-110"
                  )}
                />
                {badge ? (
                  <span className="absolute -top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-rigel px-1 font-mono text-[9.5px] text-background tabular-nums">
                    {badge}
                  </span>
                ) : dot ? (
                  <span className="absolute top-0 right-2 size-2 rounded-full bg-betelgeuse" />
                ) : null}
              </span>
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
