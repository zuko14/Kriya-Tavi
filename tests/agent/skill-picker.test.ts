import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { SkillPicker } from "@/components/dialogs/skill-picker"
import { skillRisk } from "@/lib/skill-engine"
import { CATALOG } from "@/lib/skill-library"
import type { SkillOption } from "@/queries/skills"

// The Creator's Skills section as rendered (no effects): required skills
// can't be unchecked, optional ones have named checkboxes reflecting the
// saved choice, the role's recommendations show, and anything unavailable
// says why instead of pretending to work.

const options: SkillOption[] = CATALOG.map((s) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  version: s.version,
  required: s.required,
  roles: s.roles,
  source: "Kriya",
  tools: [...s.tools.all, ...s.tools.any, ...s.tools.uses],
  ...skillRisk(s),
  prerequisites: s.id === "gst-invoices" ? s.prerequisites : [],
  missing: s.id === "gst-invoices" ? ["ledger_list"] : [],
  offByKriya: s.id === "github-workflow",
}))

// The checkbox's own tag, found by its accessible name
const checkbox = (html: string, name: string) =>
  new RegExp(`<[^>]*aria-label="Use ${name}"[^>]*>`).exec(html)?.[0] ?? ""

const render = (props: Partial<Parameters<typeof SkillPicker>[0]>) =>
  renderToStaticMarkup(
    createElement(SkillPicker, {
      options,
      role: "Accounts: bills, GST and reports",
      value: undefined,
      onChange: () => {},
      ...props,
    })
  )

describe("the Creator's Skills section", () => {
  it("shows required skills without a checkbox and optional ones with named checkboxes", () => {
    const html = render({})
    expect(html).toContain('aria-label="Always on"')
    expect(html).not.toContain('aria-label="Use Verification before completion"')
    expect(html).toContain('aria-label="Use Task planning"')
    expect(html).toContain('aria-label="Use GitHub workflow"')
  })

  it("an agent with no saved choice shows its role's recommendations, checked", () => {
    const html = render({})
    expect(html).toContain("recommended")
    expect(checkbox(html, "Invoices, ledger and GST")).toContain('aria-checked="true"')
    expect(checkbox(html, "GitHub workflow")).toContain('aria-checked="false"')
    // Two required plus structured data, GST, planning and cost-aware
    expect(html).toContain("6 on")
  })

  it("reflects a saved choice exactly", () => {
    const html = render({ value: { auto: false, on: ["task-planning"] } })
    expect(html).toContain("3 on")
    expect(checkbox(html, "Task planning")).toContain('aria-checked="true"')
    expect(checkbox(html, "Invoices, ledger and GST")).toContain('aria-checked="false"')
    expect(html).toContain("Uses every checked skill on every task")
  })

  it("says why a skill isn't available, and when Kriya switched it off", () => {
    const html = render({})
    expect(html).toContain("Not available yet: Ledger, switched on by Kriya")
    expect(html).toContain("Switched off by Kriya for now.")
    expect(html).toContain("waits for your approval: github_comment")
  })
})
