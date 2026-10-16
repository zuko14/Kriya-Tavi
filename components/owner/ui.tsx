import { cn } from "@/lib/utils"

// Presentational pieces shared by the owner console pages

export function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: "warn" | "bad" | "good"
}) {
  return (
    <div className="glass relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-[18px] px-4 py-4 sm:px-5">
      <span className="absolute inset-x-5 top-0 h-px bg-linear-to-r from-transparent via-rigel/50 to-transparent" />
      <span className="label-mono truncate">{label}</span>
      <span
        className={cn(
          "truncate font-display text-[26px] leading-none tabular-nums sm:text-[30px]",
          tone === "warn" && "text-betelgeuse",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-ok"
        )}
      >
        {value}
      </span>
      {hint && (
        <span className="truncate font-mono text-[10.5px] text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  )
}

export function Tiles({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
      {children}
    </div>
  )
}

export function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string
  description?: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-display text-[21px] leading-tight font-normal">{title}</h2>
          {description && (
            <p className="text-[12.5px] text-muted-foreground">{description}</p>
          )}
        </div>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="glass overflow-x-auto rounded-[18px]">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b bg-muted/60 text-left font-mono text-[10.5px] tracking-wide text-muted-foreground uppercase">
            {head.map((label) => (
              <th key={label} className="px-4 py-3 font-normal whitespace-nowrap">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y [&>tr]:transition-colors [&>tr:hover]:bg-rigel-soft/50">
          {children}
        </tbody>
      </table>
    </div>
  )
}

export function Td({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <td className={cn("px-4 py-3 align-top", className)}>{children}</td>
}

export function Empty({
  colSpan,
  children,
}: {
  colSpan: number
  children: React.ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-6 text-center text-muted-foreground">
        {children}
      </td>
    </tr>
  )
}

// Two stacked series per day, e.g. reported vs estimated cost
export function Bars({
  data,
  label,
}: {
  data: { key: string; a: number; b?: number; title: string }[]
  label: string
}) {
  const peak = Math.max(1, ...data.map((d) => d.a + (d.b ?? 0)))
  return (
    <div className="glass rounded-[18px] p-4 sm:p-5">
      <div
        className="flex h-36 items-end gap-[3px] sm:gap-1"
        role="img"
        aria-label={label}
      >
        {data.length === 0 && (
          <span className="self-center text-[12px] text-muted-foreground">
            No data yet.
          </span>
        )}
        {data.map((d) => (
          <div
            key={d.key}
            title={d.title}
            className="flex h-full flex-1 flex-col justify-end"
          >
            {d.b ? (
              <div
                className="w-full rounded-t-[4px] bg-betelgeuse/80"
                style={{ height: `${(d.b / peak) * 100}%` }}
              />
            ) : null}
            <div
              className={cn("w-full bg-rigel/75", !d.b && "rounded-t-[4px]")}
              style={{ height: d.a ? `${Math.max(2, (d.a / peak) * 100)}%` : "2px" }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
