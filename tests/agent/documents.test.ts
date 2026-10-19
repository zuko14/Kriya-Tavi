import { chromium, type Browser } from "playwright-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createBrowserService } from "@/browser/index"
import { HttpBrowserProvider } from "@/lib/browser/client"
import {
  DOCUMENT_TEMPLATES,
  renderLedgerReport,
  renderReceipt,
  renderTaxInvoice,
  renderTemplate,
  type DocumentTemplate,
} from "@/lib/documents/templates"
import { sniff } from "@/lib/files"

// AT-PDF-01 (templates): every template renders valid, escaped HTML with
// Indian number and date formatting and Hindi/Telugu text kept as written;
// with KRIYA_TEST_BROWSER=1 each one also fits a 360 px phone without
// sideways scrolling and prints through kriya-browser's /render/pdf (which
// has no network) to an A4 PDF that embeds an Indic-capable font.

const SAMPLES: { [T in DocumentTemplate]: unknown } = {
  invoice: {
    seller: {
      name: "Fixture Studio",
      address: "12 MG Road\nBengaluru 560001",
      gstin: "29ABCDE1234F1Z5",
    },
    buyer: { name: "रमेश ट्रेडर्स", address: "Hyderabad" },
    date: "2026-10-18",
    dueDate: "2026-11-02",
    items: [
      { description: "Logo design", quantity: 1, unitPaise: 12_345_600 },
      { description: "వెబ్‌సైట్ పేజీలు", quantity: 3, unitPaise: 250_000 },
    ],
    notes: "Payable by UPI or bank transfer.",
  },
  resume: {
    name: "Ananya Rao",
    headline: "Final-year B.Tech, Computer Science",
    contact: ["ananya@example.test", "Pune"],
    summary: "Builds small web apps; हिंदी और తెలుగు बोलती है।",
    sections: [
      {
        title: "Projects",
        items: [
          {
            title: "Bus pass app",
            period: "2025",
            points: ["Used by 1,20,000 students"],
          },
        ],
      },
    ],
  },
  report: {
    title: "October spend",
    date: "2026-10-31",
    sections: [
      {
        heading: "Summary",
        paragraphs: ["Bills paid this month."],
        table: {
          columns: ["Bill", "Amount"],
          rows: [
            ["Electricity", "₹1,180.00"],
            ["Internet", "₹708.00"],
          ],
        },
      },
    ],
  },
  media_kit: {
    name: "Chai with Code",
    handle: "@chaiwithcode",
    bio: "Tech explainers in Telugu and English.",
    stats: [{ label: "YouTube subscribers", value: "1,25,000" }],
    audience: ["18–24", "Hyderabad"],
    rates: [{ item: "Integrated video", paise: 4_500_000 }],
    contact: "hello@example.test",
  },
  letter: {
    from: { name: "Ravi Kumar", address: "Flat 4, Indiranagar" },
    to: { name: "The Landlord" },
    date: "2026-10-18",
    subject: "Rent receipt for October",
    body: ["नमस्ते। Please share the rent receipt for ₹25,000.", "ధన్యవాదాలు."],
    signOff: "Regards",
  },
}

const RECEIPT = {
  seq: 7,
  hash: "ab".repeat(32),
  createdAt: "2026-10-18T09:30:00Z",
  done: [
    {
      title: "Commented on issue #12",
      evidence: [{ kind: "url", value: "https://example.test/12" }],
    },
  ],
  unconfirmed: [
    { claim: "Emailed the client", reason: "Ran, but wasn't checked afterwards." },
  ],
  chargeMicroInr: 4_500_000,
  chargeStatus: "estimated",
}

// A7: a tax invoice (inter-state, Telugu client name) and a CA period report
const TAX_INVOICE = {
  numberText: "INV/26-27/001",
  issueDate: "2026-10-18",
  dueDate: "2026-11-02",
  supplier: {
    name: "Fixture Studio",
    gstin: "29ABCDE1234F1Z5",
    address: "Bengaluru",
    state_code: "29",
  },
  client: { name: "శ్రీనివాస్ ట్రేడర్స్", address: "Hyderabad", state_code: "36" },
  placeOfSupply: "36",
  items: [
    {
      description: "Logo design",
      hsn_sac: "998391",
      qty_milli: 1000,
      rate_paise: 12_345_600,
      tax_rate_bps: 1800,
      amount_paise: 12_345_600,
      cgst_paise: 0,
      sgst_paise: 0,
      igst_paise: 2_222_208,
    },
  ],
  taxablePaise: 12_345_600,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 2_222_208,
  cessPaise: 0,
  roundOffPaise: 0,
  totalPaise: 14_567_808,
  notes: "UPI या बैंक ट्रांसफर से भुगतान करें।",
}

const all = () => [
  ...DOCUMENT_TEMPLATES.map((t) => ({ name: t, ...renderTemplate(t, SAMPLES[t]) })),
  { name: "receipt", ...renderReceipt(RECEIPT) },
  { name: "tax_invoice", ...renderTaxInvoice(TAX_INVOICE) },
  {
    name: "ledger_report",
    ...renderLedgerReport({
      from: "2026-10-01",
      to: "2026-10-31",
      entries: 3,
      summary: [
        {
          kind: "expense",
          key: "बिजली",
          entries: 2,
          taxablePaise: 200_000,
          cgstPaise: 18_000,
          sgstPaise: 18_000,
          igstPaise: 0,
          cessPaise: 0,
          totalPaise: 236_000,
        },
        {
          kind: "income",
          key: "Design",
          entries: 1,
          taxablePaise: 12_345_600,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 2_222_208,
          cessPaise: 0,
          totalPaise: 14_567_808,
        },
      ],
    }),
  },
]

describe("AT-PDF-01 templates", () => {
  it("covers invoice, resume, report, media kit and letter", () => {
    expect(DOCUMENT_TEMPLATES.sort()).toEqual([
      "invoice",
      "letter",
      "media_kit",
      "report",
      "resume",
    ])
  })

  it("formats money and dates the Indian way, totals computed by code", () => {
    const { html } = renderTemplate("invoice", SAMPLES.invoice)
    expect(html).toContain("₹1,23,456.00")
    // 1 × ₹1,23,456 + 3 × ₹2,500
    expect(html).toContain("₹1,30,956.00")
    expect(html).toContain("18 Oct 2026")
    expect(html).toContain("not a tax invoice")
    expect(renderTemplate("media_kit", SAMPLES.media_kit).html).toContain("₹45,000.00")
    const receipt = renderReceipt(RECEIPT).html
    expect(receipt).toContain("₹4.50")
    expect(receipt).toContain("estimated")
    expect(receipt).toContain("can't prove anything about Kriya itself")
  })

  it("keeps Hindi and Telugu as written", () => {
    expect(renderTemplate("invoice", SAMPLES.invoice).html).toContain("వెబ్‌సైట్ పేజీలు")
    expect(renderTemplate("letter", SAMPLES.letter).html).toContain("नमस्ते।")
  })

  it("escapes every value", () => {
    const { html } = renderTemplate("letter", {
      ...(SAMPLES.letter as object),
      subject: `<img src=x onerror=alert(1)>`,
      body: [`</p><script>alert("x")</script>`],
    })
    expect(html).not.toMatch(/<script|<img/)
    expect(html).toContain("&lt;script&gt;")
  })

  it("refuses data outside its schema", () => {
    expect(() =>
      renderTemplate("invoice", { ...(SAMPLES.invoice as object), items: [] })
    ).toThrow()
    expect(() =>
      renderTemplate("invoice", {
        ...(SAMPLES.invoice as object),
        items: [{ description: "x", quantity: 1, unitPaise: 1.5 }],
      })
    ).toThrow()
  })

  it("has no external resources or scripts", () => {
    for (const { name, html } of all()) {
      expect(html, name).not.toMatch(
        /<script|<link|src=|url\(|@import|https?:\/\/(?!example\.test)/
      )
    }
  })
})

const enabled = process.env.KRIYA_TEST_BROWSER === "1"
const SECRET = "test-secret-".padEnd(48, "x")

describe.skipIf(!enabled)("AT-PDF-01 in Chromium", () => {
  let browser: Browser
  let service: Awaited<ReturnType<typeof createBrowserService>>
  let renderer: HttpBrowserProvider

  beforeAll(async () => {
    const executablePath = process.env.BROWSER_CHROMIUM_PATH || undefined
    browser = await chromium.launch({ executablePath })
    service = await createBrowserService({
      secret: SECRET,
      executablePath,
      lookup: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" })
      },
    })
    renderer = new HttpBrowserProvider(service.url, SECRET, 60_000)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await service?.close()
  })

  it("every template fits a 360 px screen without sideways scrolling", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 360, height: 740 } })
    ).newPage()
    for (const { name, html } of all()) {
      await page.setContent(html)
      const width = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(width, name).toBeLessThanOrEqual(360)
    }
  })

  it("prints each to an A4 PDF with an Indic-capable font", async () => {
    for (const { name, html } of all()) {
      const pdf = await renderer.renderPdf(html)
      const text = pdf.toString("latin1")
      expect(text.startsWith("%PDF-"), name).toBe(true)
      // What Kriya makes passes its own upload checks (saveGenerated sniffs it)
      expect(sniff(pdf, "application/pdf"), name).toEqual({
        ok: true,
        mime: "application/pdf",
      })
      // A4 is about 595 × 842 points (Chromium writes 595.91998 × 842.88)
      expect(text.includes("/MediaBox [0 0 595"), name).toBe(true)
      expect(/\/MediaBox \[0 0 59[56](\.\d+)? 84[23](\.\d+)?\]/.test(text), name).toBe(
        true
      )
      if (
        ["invoice", "resume", "letter", "tax_invoice", "ledger_report"].includes(name)
      ) {
        // Noto in the kriya-browser image; Nirmala UI on a Windows dev machine
        expect(text, name).toMatch(
          /BaseFont \/[A-Z]{6}\+(Noto\w*(Devanagari|Telugu)|NirmalaUI)/
        )
      }
    }
  }, 120_000)
})
