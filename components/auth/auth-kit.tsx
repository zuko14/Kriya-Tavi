"use client"

import * as React from "react"
import { useFormStatus } from "react-dom"
import Link from "next/link"
import { CircleCheckIcon, EyeIcon, EyeOffIcon, TriangleAlertIcon } from "lucide-react"

import { LogoMark, Mascot, Wordmark } from "@/components/brand"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

// Building blocks shared by the sign-in, sign-up and recovery screens

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <main className="aura grid min-h-svh lg:grid-cols-[1fr_minmax(480px,1fr)]">
      {/* Studio panel: Tavi on cream, desktop only */}
      <aside className="relative hidden overflow-hidden bg-[radial-gradient(70%_60%_at_50%_45%,#fbf5ee,#f2e8df_60%,#e4d4c3)] text-[#13292b] lg:flex lg:flex-col">
        <Link
          href="/"
          className="flex items-center gap-2 p-8"
          aria-label="Kriya Tavi home"
        >
          <LogoMark className="size-9" />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">
            Kriya{" "}
            <span className="font-display font-normal text-[#1f6362] italic">Tavi</span>
          </span>
        </Link>
        <div className="flex flex-1 flex-col items-center justify-center gap-8 px-10 pb-16">
          <Mascot priority sizes="380px" className="rise w-[min(380px,70%)]" />
          <p className="max-w-md text-center font-display text-[34px] leading-[1.1] text-balance">
            Your personal AI, <em className="text-[#b4622f]">with a team</em> behind it.
          </p>
        </div>
        <p className="px-8 pb-8 font-mono text-[10.5px] tracking-[0.24em] text-[#13292b]/50 uppercase">
          Kriya AI · Made in India
        </p>
      </aside>

      <div className="relative flex min-h-svh flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="rise flex w-full max-w-[420px] flex-col gap-6">
          <Link
            href="/"
            className="flex flex-col items-center gap-3 self-center lg:hidden"
            aria-label="Kriya Tavi home"
          >
            <span className="grid size-24 place-items-center overflow-hidden rounded-full bg-[radial-gradient(circle,#fbf5ee,#efe3d6)] shadow-[0_16px_40px_-16px_rgb(19_41_43/0.5)] ring-1 ring-black/5">
              <Mascot priority sizes="120px" className="w-[118%] max-w-none" />
            </span>
            <Wordmark className="text-[18px]" />
          </Link>
          <section className="glass-strong flex flex-col gap-6 rounded-[28px] p-6 sm:p-8">
            <header className="flex flex-col gap-2">
              <h1 className="font-display text-[30px] leading-tight font-normal">
                {title}
              </h1>
              {subtitle && (
                <p className="text-[14px] leading-relaxed text-muted-foreground">
                  {subtitle}
                </p>
              )}
            </header>
            {children}
          </section>
          {footer && (
            <div className="text-center text-[13.5px] text-muted-foreground">
              {footer}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

export function TextField({
  label,
  name,
  type = "text",
  autoComplete,
  defaultValue,
  required = true,
  hint,
  autoFocus,
  minLength,
  maxLength,
}: {
  label: string
  name: string
  type?: "text" | "email" | "password"
  autoComplete?: string
  defaultValue?: string
  required?: boolean
  hint?: string
  autoFocus?: boolean
  minLength?: number
  maxLength?: number
}) {
  const id = React.useId()
  const [visible, setVisible] = React.useState(false)
  const isPassword = type === "password"
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={isPassword && visible ? "text" : type}
          autoComplete={autoComplete}
          defaultValue={defaultValue}
          required={required}
          autoFocus={autoFocus}
          minLength={minLength}
          maxLength={maxLength}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cn(
            "h-12 rounded-xl bg-background/60 px-4 text-[15px]",
            isPassword && "pr-12"
          )}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setVisible((value) => !value)}
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            className="absolute inset-y-0 right-0 grid w-12 place-items-center text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        )}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-liquid h-12 w-full text-[15px]"
    >
      {pending && <Spinner />}
      {children}
    </button>
  )
}

export function Notice({
  tone,
  children,
}: {
  tone: "error" | "success"
  children: React.ReactNode
}) {
  const Icon = tone === "error" ? TriangleAlertIcon : CircleCheckIcon
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-snug",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-foreground"
          : "border-ok/30 bg-ok/5 text-foreground"
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error" ? "text-destructive" : "text-ok"
        )}
      />
      <span>{children}</span>
    </div>
  )
}

export function StateNotice({
  state,
}: {
  state: { error?: string; message?: string } | null
}) {
  if (state?.error) return <Notice tone="error">{state.error}</Notice>
  if (state?.message) return <Notice tone="success">{state.message}</Notice>
  return null
}
