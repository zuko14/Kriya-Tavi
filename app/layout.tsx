import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Fonts ship with the app (npm, SIL OFL); nothing is fetched from a font CDN
const inter = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
      weight: "100 900",
    },
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2",
      weight: "100 900",
    },
  ],
  variable: "--font-inter",
  display: "swap",
})
const mono = localFont({
  src: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  variable: "--font-jetbrains",
  display: "swap",
})

const fraunces = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2",
      weight: "100 900",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2",
      weight: "100 900",
      style: "italic",
    },
  ],
  variable: "--font-fraunces",
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.KRIYA_APP_URL || "http://localhost:6796"),
  title: {
    default: "Kriya Tavi — your personal AI, by Kriya AI",
    template: "%s · Kriya Tavi",
  },
  description:
    "Kriya Tavi by Kriya AI: a personal AI assistant with agents and sub-agents that research, plan, draft and remember, from your phone or browser, with every step shown and every rupee accounted for.",
  applicationName: "Kriya Tavi",
  appleWebApp: { capable: true, title: "Tavi", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  openGraph: {
    title: "Kriya Tavi",
    description: "Your personal AI, with a team of agents behind it.",
    siteName: "Kriya Tavi",
    images: [{ url: "/tavi/mascot-512.png", width: 512, height: 512, alt: "Tavi" }],
    locale: "en_IN",
    type: "website",
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a1213" },
    { media: "(prefers-color-scheme: light)", color: "#f5efe7" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

// Everything is read from the database at request time, per person
export const dynamic = "force-dynamic"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en-IN"
      suppressHydrationWarning
      className={cn(inter.variable, mono.variable, fraunces.variable)}
    >
      {/* Browser extensions add attributes to <body> before React loads */}
      <body suppressHydrationWarning>
        <ThemeProvider>
          <TooltipProvider delay={300}>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
