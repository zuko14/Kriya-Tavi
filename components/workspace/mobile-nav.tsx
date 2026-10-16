"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { MenuIcon, SquarePenIcon } from "lucide-react"

import { LogoMark, Wordmark } from "@/components/brand"
import { useWorkspace } from "@/components/workspace/context"
import { Sidebar } from "@/components/workspace/sidebar"
import { cn } from "@/lib/utils"

// Below md: a slim top bar; the full sidebar (every agent and thread) opens as
// a drawer from the left. Everyday navigation is the bottom tab bar.
export function MobileNav() {
  const { mobileNavOpen, setMobileNavOpen } = useWorkspace()
  // A thread has its own header with a back button; one bar is enough
  const inThread = /^\/(a|s)\/[^/]+\/[^/]+/.test(usePathname())

  // Widening the window past the phone layout shows the real sidebar; close
  // the drawer so it can't keep the page locked while hidden
  React.useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)")
    const close = () => desktop.matches && setMobileNavOpen(false)
    desktop.addEventListener("change", close)
    return () => desktop.removeEventListener("change", close)
  }, [setMobileNavOpen])

  return (
    <>
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-2 border-b bg-background/70 px-2 backdrop-blur-xl md:hidden",
          inThread && "hidden"
        )}
      >
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
          className="grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-accent"
        >
          <MenuIcon className="size-5" />
        </button>
        <Link href="/home" className="flex items-center gap-2">
          <LogoMark className="size-7" />
          <Wordmark className="text-[15px]" />
        </Link>
        <Link
          href="/home"
          aria-label="New task"
          className="ml-auto grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SquarePenIcon className="size-[18px]" />
        </Link>
      </div>

      {/* A side sheet, not a centred dialog: solid, full height, slides in */}
      <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 md:hidden" />
          <DialogPrimitive.Popup className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,86vw)] flex-col overflow-hidden rounded-r-[22px] border-r bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-[0_0_60px_-10px_rgb(0_0_0/0.5)] transition-transform duration-200 ease-out outline-none data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full md:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <Sidebar onNavigate={() => setMobileNavOpen(false)} />
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  )
}
