"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ActivityIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WalletIcon,
  BookCheckIcon,
  BriefcaseIcon,
  FlaskConicalIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

const NAV = [
  { href: "/owner", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/owner/finance", label: "Finance", icon: WalletIcon },
  { href: "/owner/users", label: "Members", icon: UsersIcon },
  { href: "/owner/operations", label: "Operations", icon: ActivityIcon },
  { href: "/owner/config", label: "Config", icon: SlidersHorizontalIcon },
  // Track O: jobs and grants (O8)
  { href: "/owner/operator", label: "Operator", icon: BriefcaseIcon },
  // A13: the public facts commons (K6)
  { href: "/owner/facts", label: "Facts", icon: BookCheckIcon },
  // A12: policy versions, canary and rollback
  { href: "/owner/improve", label: "Improve", icon: FlaskConicalIcon },
  { href: "/owner/audit", label: "Audit", icon: ScrollTextIcon },
]

function isActive(pathname: string, href: string) {
  return href === "/owner" ? pathname === href : pathname.startsWith(href)
}

// Desktop: a vertical rail. Phones: a scrollable row of glass pills.
export function OwnerNav({ variant }: { variant: "rail" | "pills" }) {
  const pathname = usePathname()
  if (variant === "pills") {
    return (
      <nav
        aria-label="Owner"
        className="flex [scrollbar-width:none] gap-1.5 overflow-x-auto px-3 pb-3"
      >
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13px] whitespace-nowrap transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "glass text-muted-foreground"
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          )
        })}
      </nav>
    )
  }
  return (
    <nav aria-label="Owner" className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13.5px] transition-colors",
              active
                ? "bg-rigel-soft font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {active && (
              <span className="absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-rigel" />
            )}
            <Icon className={cn("size-4", active && "text-rigel")} />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
