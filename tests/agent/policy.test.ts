import { describe, expect, it } from "vitest"

import { browserDecision, classifyBrowserAction } from "@/lib/agent/policy"
import type { BrowserAction, PageElement, PageView } from "@/lib/browser/provider"
import { registrableDomain, siteFor, type SiteRule } from "@/lib/browser/sites"

// Browser risk classes (AD-03) are decided here from facts about the page,
// never from what the model says. AT-POL-03…06.

const el = (ref: string, over: Partial<PageElement> = {}): PageElement => ({
  ref,
  role: "button",
  name: "",
  inForm: false,
  sensitive: false,
  ...over,
})

const page = (
  elements: PageElement[],
  facts: Partial<PageView["facts"]> = {}
): PageView => ({
  elements,
  facts: {
    url: "https://example.test/",
    domain: "example.test",
    hasForm: elements.some((e) => e.inForm),
    focusedSensitive: false,
    captcha: false,
    ...facts,
  },
})

const supervised: SiteRule = {
  domain: "example.test",
  mode: "supervised",
  reviewed: null,
}
const click = (ref: string, intent?: "commit"): BrowserAction => ({
  action: "click",
  ref,
  ...(intent && { intent }),
})

describe("AT-POL-03 commit lexicon", () => {
  const names = [
    "Save",
    "Submit application",
    "Post",
    "Publish",
    "Send message",
    "Apply now",
    "Confirm",
    "Pay ₹499",
    "Buy",
    "Place order",
    "Delete",
    "Remove skill",
    "Connect",
    "Follow",
    "Accept",
    "I agree",
    "Upload",
    "Update profile",
    // Social actions: never automatic (AD-06, no fake engagement)
    "Like",
    "Share",
    "Repost",
    "Comment",
    "Reply",
    "Subscribe",
    "Join group",
    "Endorse",
    "Vote",
    "Sign up",
    "Register",
    "सहेजें",
    "भेजें",
    "सबमिट करें",
    "సేవ్ చేయి",
    "పంపు",
    "సమర్పించు",
  ]
  it.each(names)("a button named %j is a commit (R4)", (name) => {
    expect(
      classifyBrowserAction(click("e1"), page([el("e1", { name })]), supervised)
    ).toBe("R4")
  })

  it("a submit button is a commit whatever its name", () => {
    const view = page([el("e1", { name: "Next", type: "submit", inForm: true })])
    expect(classifyBrowserAction(click("e1"), view, supervised)).toBe("R4")
  })

  it("links and expanders are reads (R0)", () => {
    const view = page([
      el("e1", { role: "link", name: "Pricing" }),
      el("e2", { name: "Show more" }),
      el("e3", { name: "Add another skill", inForm: true }),
    ])
    for (const ref of ["e1", "e2", "e3"]) {
      expect(classifyBrowserAction(click(ref), view, supervised)).toBe("R0")
    }
  })

  it("doesn't match commit words inside other words", () => {
    const view = page([el("e1", { name: "Postcode help" }), el("e2", { name: "Sendai" })])
    expect(classifyBrowserAction(click("e1"), view, supervised)).toBe("R0")
    expect(classifyBrowserAction(click("e2"), view, supervised)).toBe("R0")
  })

  it("a link whose name is a commit word is still a commit", () => {
    const view = page([el("e1", { role: "link", name: "Delete account" })])
    expect(classifyBrowserAction(click("e1"), view, supervised)).toBe("R4")
  })

  it("site commit patterns raise a click to R4", () => {
    const view = page([el("e1", { name: "Give kudos" })])
    expect(classifyBrowserAction(click("e1"), view, supervised)).toBe("R0")
    const rule = { ...supervised, commitPatterns: ["kudos"] }
    expect(classifyBrowserAction(click("e1"), view, rule)).toBe("R4")
  })

  it("typing and choosing are fills (R3); ticking a box is a fill", () => {
    const view = page([
      el("e1", { role: "textbox", name: "Headline", inForm: true }),
      el("e2", { role: "checkbox", name: "Open to work", inForm: true }),
    ])
    expect(
      classifyBrowserAction({ action: "type", ref: "e1", text: "x" }, view, supervised)
    ).toBe("R3")
    expect(
      classifyBrowserAction({ action: "select", ref: "e1", value: "x" }, view, supervised)
    ).toBe("R3")
    expect(classifyBrowserAction(click("e2"), view, supervised)).toBe("R3")
  })

  it("an element the page doesn't have counts as a commit", () => {
    expect(classifyBrowserAction(click("e99"), page([]), supervised)).toBe("R4")
  })
})

describe("AT-POL-04 sensitive fields and CAPTCHAs", () => {
  it("typing into a sensitive field is R5", () => {
    const view = page([el("e1", { role: "textbox", name: "Password", sensitive: true })])
    expect(
      classifyBrowserAction({ action: "type", ref: "e1", text: "x" }, view, supervised)
    ).toBe("R5")
  })

  const blocked: BrowserAction[] = [
    { action: "open", url: "https://example.test/" },
    click("e1"),
    { action: "type", ref: "e1", text: "x" },
    { action: "select", ref: "e1", value: "x" },
    { action: "scroll", direction: "down" },
    { action: "screenshot" },
  ]
  const allowed: BrowserAction[] = [
    { action: "handoff", reason: "otp" },
    { action: "snapshot" },
    { action: "close" },
  ]
  for (const facts of [{ focusedSensitive: true }, { captcha: true }]) {
    it(`with ${Object.keys(facts)[0]}, everything but handoff, snapshot and close is R5`, () => {
      const view = page([el("e1", { role: "link", name: "Home" })], facts)
      for (const action of blocked) {
        expect(classifyBrowserAction(action, view, supervised), action.action).toBe("R5")
      }
      for (const action of allowed) {
        expect(classifyBrowserAction(action, view, supervised), action.action).toBe("R0")
      }
    })
  }

  it("R5 is refused with an instruction to hand off, in every mode", () => {
    const view = page([el("e1", { role: "textbox", name: "OTP", sensitive: true })])
    const decision = browserDecision(
      { action: "type", ref: "e1", text: "123456" },
      view,
      supervised
    )
    expect(decision).toMatchObject({ cls: "R5", gate: "refuse" })
    expect(decision.reason).toMatch(/browser_handoff/)
  })
})

describe("AT-POL-05 site modes", () => {
  const view = page([
    el("e1", { role: "textbox", name: "About", inForm: true }),
    el("e2", { name: "Save", inForm: true }),
    el("e3", { role: "link", name: "Help" }),
  ])
  const fill: BrowserAction = { action: "type", ref: "e1", text: "x" }

  it("supervised: fills and commits wait for the person's approval", () => {
    expect(browserDecision(fill, view, supervised).gate).toBe("user-approval")
    expect(browserDecision(click("e2"), view, supervised).gate).toBe("user-approval")
    expect(browserDecision(click("e3"), view, supervised).gate).toBe("none")
  })

  it("assisted: fills and commits are refused; the agent hands off for review", () => {
    const rule: SiteRule = { domain: "example.test", mode: "assisted", reviewed: null }
    for (const action of [fill, click("e2")]) {
      const decision = browserDecision(action, view, rule)
      expect(decision.gate).toBe("refuse")
      expect(decision.reason).toMatch(/review/)
    }
    expect(browserDecision(click("e3"), view, rule).gate).toBe("none")
  })

  it("api: only reading", () => {
    const rule: SiteRule = { domain: "example.test", mode: "api", reviewed: null }
    expect(browserDecision(fill, view, rule).gate).toBe("refuse")
    expect(browserDecision(click("e3"), view, rule).gate).toBe("none")
  })

  it("blocked: even opening is refused", () => {
    const rule: SiteRule = { domain: "example.test", mode: "blocked", reviewed: null }
    expect(
      browserDecision({ action: "open", url: "https://example.test/" }, page([]), rule)
        .gate
    ).toBe("refuse")
    expect(browserDecision({ action: "snapshot" }, view, rule).gate).toBe("refuse")
    expect(browserDecision({ action: "close" }, view, rule).gate).toBe("none")
  })

  it("an unknown domain is read-only", () => {
    expect(browserDecision(fill, view, null).gate).toBe("refuse")
    expect(browserDecision(click("e2"), view, null).gate).toBe("refuse")
    expect(browserDecision(click("e3"), view, null).gate).toBe("none")
    expect(
      browserDecision({ action: "open", url: "https://unknown.test/" }, page([]), null)
        .gate
    ).toBe("none")
  })
})

describe("AT-POL-06 model intent only raises", () => {
  it("a stated commit raises a read or a fill to R4", () => {
    const view = page([
      el("e1", { role: "link", name: "Help" }),
      el("e2", { role: "textbox", name: "Note", inForm: true }),
    ])
    expect(classifyBrowserAction(click("e1", "commit"), view, supervised)).toBe("R4")
    expect(
      classifyBrowserAction(
        { action: "type", ref: "e2", text: "x", intent: "commit" },
        view,
        supervised
      )
    ).toBe("R4")
  })

  it("no intent lowers a commit or an R5", () => {
    const view = page([
      el("e1", { name: "Save", inForm: true }),
      el("e2", { role: "textbox", name: "Password", sensitive: true }),
    ])
    // The schema has no way to say "read"; an unexpected intent changes nothing
    const lower = { ...click("e1"), intent: "read" } as unknown as BrowserAction
    expect(classifyBrowserAction(lower, view, supervised)).toBe("R4")
    expect(
      classifyBrowserAction(
        {
          action: "type",
          ref: "e2",
          text: "x",
          intent: "read",
        } as unknown as BrowserAction,
        view,
        supervised
      )
    ).toBe("R5")
  })
})

describe("site registry (AD-06)", () => {
  it("finds the registrable domain", () => {
    expect(registrableDomain("www.linkedin.com")).toBe("linkedin.com")
    expect(registrableDomain("in.linkedin.com")).toBe("linkedin.com")
    expect(registrableDomain("gate2027.iitr.ac.in")).toBe("iitr.ac.in")
    expect(registrableDomain("services.gst.gov.in")).toBe("gst.gov.in")
    expect(registrableDomain("EXAMPLE.co.in.")).toBe("example.co.in")
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1")
  })

  it("LinkedIn and Upwork are assisted; GitHub is api; unknown sites have no rule", () => {
    expect(siteFor("https://www.linkedin.com/in/someone")?.mode).toBe("assisted")
    expect(siteFor("https://www.upwork.com/")?.mode).toBe("assisted")
    expect(siteFor("https://github.com/")?.mode).toBe("api")
    expect(siteFor("https://example.com/")).toBeNull()
  })

  it("no site is supervised until its terms are reviewed (AB-04)", async () => {
    const { SITES } = await import("@/lib/browser/sites")
    expect(SITES.filter((rule) => rule.mode === "supervised")).toEqual([])
  })
})
