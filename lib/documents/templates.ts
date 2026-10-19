import { z } from "zod"

import { stateName, stateTaxLabel } from "@/lib/gst"
import { formatInr, formatPaise } from "@/lib/money"

// Kriya's document templates (AD-18): HTML that kriya-browser prints to A4
// PDF with no network and no JavaScript. Every value is escaped; money is
// integer paise (or micro-INR on receipts) and formatted the Indian way;
// totals are computed here, never taken from the model. The same HTML
// reads on a 360 px phone: nothing has a fixed width.

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  )

const DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
})
const TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
})
export const formatDate = (value: string | Date) => DATE.format(new Date(value))

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 16px; color: #1c1b29; background: #fff;
  font: 14px/1.5 "Inter", "Noto Sans", "Noto Sans Devanagari", "Noto Sans Telugu", system-ui, sans-serif;
  overflow-wrap: anywhere; }
@media print { body { padding: 0; } }
main { max-width: 720px; margin: 0 auto; }
h1 { font-size: 22px; line-height: 1.25; margin: 0 0 4px; color: #2f2a7a; }
h2 { font-size: 15px; margin: 20px 0 6px; color: #2f2a7a; }
h3 { font-size: 14px; margin: 12px 0 2px; }
p { margin: 0 0 8px; }
.muted { color: #6b6a7d; font-size: 12px; }
.mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between; }
.row > * { min-width: 0; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; }
/* A wide table scrolls by itself on a phone; the page never does */
.wide { overflow-x: auto; }
th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid #e4e3ee; vertical-align: top; }
th { font-size: 12px; color: #6b6a7d; font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; }
.total td { font-weight: 700; border-bottom: 0; }
ul { margin: 4px 0 8px; padding-left: 18px; }
.chip { display: inline-block; border: 1px solid #e4e3ee; border-radius: 999px; padding: 0 8px; font-size: 11px; }
footer { margin-top: 28px; padding-top: 8px; border-top: 1px solid #e4e3ee; }
`

function layout(title: string, body: string, footer = "Made by Kriya") {
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}<footer class="muted">${esc(footer)}</footer></main></body></html>`
}

const lines = (text?: string) =>
  text
    ? text
        .split("\n")
        .map((line) => esc(line))
        .join("<br>")
    : ""

/* ───────────────────────────── schemas ──────────────────────────── */

const short = z.string().trim().min(1).max(200)
const long = z.string().trim().max(4000)
const isoDate = z.iso.date()
// ≤ ₹1 crore a unit, so 50 lines × 100,000 units stay exact (< 2^53)
const paise = z.number().int().min(0).max(1_000_000_000)
const party = z.object({ name: short, address: long.optional(), gstin: short.optional() })

export const DOCUMENT_SCHEMAS = {
  invoice: z.object({
    seller: party,
    buyer: party,
    date: isoDate,
    dueDate: isoDate.optional(),
    items: z
      .array(
        z.object({
          description: short,
          quantity: z.number().int().min(1).max(100_000),
          unitPaise: paise,
        })
      )
      .min(1)
      .max(50),
    notes: long.optional(),
  }),
  resume: z.object({
    name: short,
    headline: short.optional(),
    contact: z.array(short).max(6).default([]),
    summary: long.optional(),
    sections: z
      .array(
        z.object({
          title: short,
          items: z
            .array(
              z.object({
                title: short,
                subtitle: short.optional(),
                period: short.optional(),
                points: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
              })
            )
            .max(20),
        })
      )
      .max(10),
  }),
  report: z.object({
    title: short,
    subtitle: short.optional(),
    date: isoDate,
    sections: z
      .array(
        z.object({
          heading: short,
          paragraphs: z.array(long).max(20).default([]),
          table: z
            .object({
              columns: z.array(short).min(1).max(8),
              rows: z.array(z.array(z.string().max(500)).max(8)).max(200),
            })
            .optional(),
        })
      )
      .min(1)
      .max(20),
  }),
  media_kit: z.object({
    name: short,
    handle: short.optional(),
    bio: long,
    stats: z
      .array(z.object({ label: short, value: short }))
      .max(8)
      .default([]),
    audience: z.array(short).max(8).default([]),
    rates: z
      .array(z.object({ item: short, paise }))
      .max(12)
      .default([]),
    contact: short,
  }),
  letter: z.object({
    from: party,
    to: party,
    date: isoDate,
    subject: short,
    body: z.array(long).min(1).max(20),
    signOff: short,
  }),
} as const

export type DocumentTemplate = keyof typeof DOCUMENT_SCHEMAS
export type DocumentData<T extends DocumentTemplate> = z.input<
  (typeof DOCUMENT_SCHEMAS)[T]
>
export const DOCUMENT_TEMPLATES = Object.keys(DOCUMENT_SCHEMAS) as DocumentTemplate[]

/* ──────────────────────────── templates ─────────────────────────── */

const partyBlock = (label: string, p: z.infer<typeof party>) =>
  `<div><p class="muted">${esc(label)}</p><p><strong>${esc(p.name)}</strong><br>${lines(p.address)}${
    p.gstin ? `<br><span class="muted">GSTIN</span> ${esc(p.gstin)}` : ""
  }</p></div>`

type Rendered = { title: string; html: string }

const RENDER: {
  [T in DocumentTemplate]: (d: z.infer<(typeof DOCUMENT_SCHEMAS)[T]>) => Rendered
} = {
  // A7 issues numbered tax invoices (AD-16, AD-17); this one has no number
  invoice: (d) => {
    const rows = d.items.map((item) => ({
      ...item,
      amount: item.quantity * item.unitPaise,
    }))
    const total = rows.reduce((sum, row) => sum + row.amount, 0)
    return {
      title: `Invoice for ${d.buyer.name}`,
      html: `<h1>Invoice</h1><p class="muted">Draft · not a tax invoice · ${esc(formatDate(d.date))}${
        d.dueDate ? ` · due ${esc(formatDate(d.dueDate))}` : ""
      }</p>
<div class="row">${partyBlock("From", d.seller)}${partyBlock("Bill to", d.buyer)}</div>
<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
${rows
  .map(
    (row) =>
      `<tr><td>${esc(row.description)}</td><td class="num">${row.quantity.toLocaleString("en-IN")}</td><td class="num">${esc(formatPaise(row.unitPaise))}</td><td class="num">${esc(formatPaise(row.amount))}</td></tr>`
  )
  .join("")}
<tr class="total"><td colspan="3">Total</td><td class="num">${esc(formatPaise(total))}</td></tr></tbody></table>
${d.notes ? `<h2>Notes</h2><p>${lines(d.notes)}</p>` : ""}`,
    }
  },
  resume: (d) => ({
    title: `${d.name}: resume`,
    html: `<h1>${esc(d.name)}</h1>${d.headline ? `<p>${esc(d.headline)}</p>` : ""}
<p class="muted">${d.contact.map(esc).join(" · ")}</p>
${d.summary ? `<p>${lines(d.summary)}</p>` : ""}
${d.sections
  .map(
    (s) =>
      `<h2>${esc(s.title)}</h2>${s.items
        .map(
          (i) =>
            `<h3>${esc(i.title)}</h3><p class="muted">${[i.subtitle, i.period]
              .filter(Boolean)
              .map(esc)
              .join(
                " · "
              )}</p>${i.points.length ? `<ul>${i.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}`
        )
        .join("")}`
  )
  .join("")}`,
  }),
  report: (d) => ({
    title: d.title,
    html: `<h1>${esc(d.title)}</h1><p class="muted">${[d.subtitle, formatDate(d.date)]
      .filter(Boolean)
      .map(esc)
      .join(" · ")}</p>
${d.sections
  .map(
    (s) =>
      `<h2>${esc(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${lines(p)}</p>`).join("")}${
        s.table
          ? `<table><thead><tr>${s.table.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.table.rows
              .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
              .join("")}</tbody></table>`
          : ""
      }`
  )
  .join("")}`,
  }),
  media_kit: (d) => ({
    title: `${d.name}: media kit`,
    html: `<h1>${esc(d.name)}</h1>${d.handle ? `<p class="muted">${esc(d.handle)}</p>` : ""}<p>${lines(d.bio)}</p>
${d.stats.length ? `<h2>Numbers</h2><table><tbody>${d.stats.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${esc(s.value)}</td></tr>`).join("")}</tbody></table>` : ""}
${d.audience.length ? `<h2>Audience</h2><p>${d.audience.map((a) => `<span class="chip">${esc(a)}</span>`).join(" ")}</p>` : ""}
${d.rates.length ? `<h2>Rates</h2><table><tbody>${d.rates.map((r) => `<tr><td>${esc(r.item)}</td><td class="num">${esc(formatPaise(r.paise))}</td></tr>`).join("")}</tbody></table>` : ""}
<h2>Contact</h2><p>${esc(d.contact)}</p>`,
  }),
  letter: (d) => ({
    title: d.subject,
    html: `<div class="row">${partyBlock("From", d.from)}<p class="muted">${esc(formatDate(d.date))}</p></div>
${partyBlock("To", d.to)}<h2>${esc(d.subject)}</h2>${d.body.map((p) => `<p>${lines(p)}</p>`).join("")}<p>${esc(d.signOff)}<br><strong>${esc(d.from.name)}</strong></p>`,
  }),
}

// Validates and renders; throws a ZodError on bad data
export function renderTemplate<T extends DocumentTemplate>(template: T, data: unknown) {
  const parsed = DOCUMENT_SCHEMAS[template].parse(data) as z.infer<
    (typeof DOCUMENT_SCHEMAS)[T]
  >
  const { title, html } = RENDER[template](parsed)
  return { title, html: layout(title, html) }
}

/* ───────────────────────────── receipt ──────────────────────────── */

export type ReceiptData = {
  seq: number
  hash: string
  createdAt: Date | string
  done: { title: string; evidence: { kind: string; value: string }[] }[]
  unconfirmed: { claim: string; reason: string }[]
  chargeMicroInr: number | null
  chargeStatus: string | null
}

const CHARGE: Record<string, string> = {
  final: "final",
  estimated: "estimated",
  unpriced: "price pending",
}

// The Kriya Receipt (K1) with its honest limit, said plainly (S19)
export function renderReceipt(r: ReceiptData) {
  const title = `Kriya Receipt #${r.seq}`
  const html = `<h1>${esc(title)}</h1><p class="muted">${esc(TIME.format(new Date(r.createdAt)))} IST</p>
<h2>Done and checked</h2>${
    r.done.length
      ? `<ul>${r.done
          .map(
            (d) =>
              `<li>${esc(d.title)}${d.evidence
                .map((e) => ` <span class="chip">${esc(e.kind)}: ${esc(e.value)}</span>`)
                .join("")}</li>`
          )
          .join("")}</ul>`
      : `<p class="muted">Nothing checked in this record.</p>`
  }
${
  r.unconfirmed.length
    ? `<h2>Not confirmed</h2><ul>${r.unconfirmed.map((u) => `<li>${esc(u.claim)} <span class="muted">· ${esc(u.reason)}</span></li>`).join("")}</ul>`
    : ""
}
${
  r.chargeStatus
    ? `<h2>Charge</h2><p>${esc(formatInr(r.chargeMicroInr))} <span class="chip">${esc(CHARGE[r.chargeStatus] ?? r.chargeStatus)}</span></p>`
    : ""
}
<h2>Record</h2><p class="mono">#${r.seq} · ${esc(r.hash)}</p>
<p class="muted">This hash links this record to your earlier ones. Keep this PDF: it lets "Verify my records" show that this record wasn't changed after today. It can't prove anything about Kriya itself unless you keep your receipts.</p>`
  return { title, html: layout(title, html, "Made by Kriya · Kriya Receipt") }
}

/* ─────────────────────────── accounts (A7) ──────────────────────── */

const CA_FOOTER = "Prepared by Kriya from your records. Review with your CA."

type TaxInvoiceData = {
  numberText: string | null
  issueDate: string | null
  dueDate: string | null
  supplier: { name: string; gstin?: string; address?: string; state_code: string }
  client: { name: string; gstin?: string; address?: string; state_code: string }
  placeOfSupply: string
  items: {
    description: string
    hsn_sac?: string
    qty_milli: number
    rate_paise: number
    tax_rate_bps: number
    amount_paise: number
    cgst_paise: number
    sgst_paise: number
    igst_paise: number
  }[]
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  cessPaise: number
  roundOffPaise: number
  totalPaise: number
  notes: string | null
}

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`
const qty = (milli: number) =>
  (milli / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 })

// A GST tax invoice with the particulars of CGST Rule 46 that Kriya holds:
// supplier and recipient with GSTINs, a number ≤ 16 characters, date,
// HSN/SAC, taxable value, rate and amount of each tax, and the place of
// supply with the State's name. Amounts come from the stored invoice,
// computed by lib/ledger.ts; nothing is recomputed here.
export function renderTaxInvoice(inv: TaxInvoiceData) {
  const inter = inv.igstPaise > 0 || inv.supplier.state_code !== inv.placeOfSupply
  const local = stateTaxLabel(inv.placeOfSupply)
  const taxHead = inter
    ? `<th class="num">IGST</th>`
    : `<th class="num">CGST</th><th class="num">${local}</th>`
  const row = (i: TaxInvoiceData["items"][number]) =>
    `<tr><td>${esc(i.description)}${i.hsn_sac ? `<br><span class="muted">HSN/SAC ${esc(i.hsn_sac)}</span>` : ""}</td>
<td class="num">${esc(qty(i.qty_milli))}</td><td class="num">${esc(formatPaise(i.rate_paise))}</td>
<td class="num">${esc(formatPaise(i.amount_paise))}</td>${
      inter
        ? `<td class="num">${esc(pct(i.tax_rate_bps))}<br>${esc(formatPaise(i.igst_paise))}</td>`
        : `<td class="num">${esc(pct(i.tax_rate_bps / 2))}<br>${esc(formatPaise(i.cgst_paise))}</td><td class="num">${esc(pct(i.tax_rate_bps / 2))}<br>${esc(formatPaise(i.sgst_paise))}</td>`
    }</tr>`
  const title = `Tax invoice ${inv.numberText ?? ""}`.trim()
  const html = `<h1>Tax invoice</h1>
<p class="mono">${esc(inv.numberText)} · ${esc(inv.issueDate ? formatDate(inv.issueDate) : "")}${
    inv.dueDate ? ` · due ${esc(formatDate(inv.dueDate))}` : ""
  }</p>
<div class="row">${partyBlock("Supplier", inv.supplier)}${partyBlock("Recipient", inv.client)}</div>
<p class="muted">Place of supply: ${esc(stateName(inv.placeOfSupply) ?? inv.placeOfSupply)} (${esc(inv.placeOfSupply)})</p>
<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th>${taxHead}</tr></thead><tbody>
${inv.items.map(row).join("")}</tbody></table>
<table><tbody>
<tr><td>Taxable value</td><td class="num">${esc(formatPaise(inv.taxablePaise))}</td></tr>
${inter ? `<tr><td>IGST</td><td class="num">${esc(formatPaise(inv.igstPaise))}</td></tr>` : `<tr><td>CGST</td><td class="num">${esc(formatPaise(inv.cgstPaise))}</td></tr><tr><td>${local}</td><td class="num">${esc(formatPaise(inv.sgstPaise))}</td></tr>`}
${inv.cessPaise ? `<tr><td>Cess</td><td class="num">${esc(formatPaise(inv.cessPaise))}</td></tr>` : ""}
${inv.roundOffPaise ? `<tr><td>Round-off</td><td class="num">${esc(formatPaise(inv.roundOffPaise))}</td></tr>` : ""}
<tr class="total"><td>Total</td><td class="num">${esc(formatPaise(inv.totalPaise))}</td></tr>
</tbody></table>
${inv.notes ? `<h2>Notes</h2><p>${lines(inv.notes)}</p>` : ""}`
  return { title, html: layout(title, html, CA_FOOTER) }
}

// The period summary that goes with the CSV for the person's CA
export function renderLedgerReport(r: {
  from: string
  to: string
  entries: number
  summary: {
    kind: string
    key: string
    entries: number
    taxablePaise: number
    cgstPaise: number
    sgstPaise: number
    igstPaise: number
    cessPaise: number
    totalPaise: number
  }[]
}) {
  const title = `Accounts ${formatDate(r.from)} to ${formatDate(r.to)}`
  const section = (kind: string, heading: string) => {
    const rows = r.summary.filter((s) => s.kind === kind)
    if (!rows.length) return ""
    const sum = (
      k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "totalPaise"
    ) => rows.reduce((a, s) => a + s[k], 0)
    return `<h2>${esc(heading)}</h2><div class="wide"><table><thead><tr><th>Category</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST/UTGST</th><th class="num">IGST</th><th class="num">Total</th></tr></thead><tbody>
${rows.map((s) => `<tr><td>${esc(s.key)} <span class="muted">(${s.entries})</span></td><td class="num">${esc(formatPaise(s.taxablePaise))}</td><td class="num">${esc(formatPaise(s.cgstPaise))}</td><td class="num">${esc(formatPaise(s.sgstPaise))}</td><td class="num">${esc(formatPaise(s.igstPaise))}</td><td class="num">${esc(formatPaise(s.totalPaise))}</td></tr>`).join("")}
<tr class="total"><td>Total</td><td class="num">${esc(formatPaise(sum("taxablePaise")))}</td><td class="num">${esc(formatPaise(sum("cgstPaise")))}</td><td class="num">${esc(formatPaise(sum("sgstPaise")))}</td><td class="num">${esc(formatPaise(sum("igstPaise")))}</td><td class="num">${esc(formatPaise(sum("totalPaise")))}</td></tr></tbody></table></div>`
  }
  const html = `<h1>${esc(title)}</h1><p class="muted">${r.entries.toLocaleString("en-IN")} confirmed entries. Entries not yet confirmed aren't counted.</p>
${section("income", "Income")}${section("expense", "Expenses")}`
  return { title, html: layout(title, html, CA_FOOTER) }
}
