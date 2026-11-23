import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Harness 2.0 W9 (docs/kriya-harness/upgrade_2.0/SELF_EVOLUTION.md §2.5, §3,
// §4, §7): cartridge candidates. Lint (WT-LINT-00…12), the proposal flow
// and its SQL guards (WT-PRO-01…06), owner-only access (WT-SEC-01), drafting
// with a scripted model (WT-DR-01…03), the table's rollback (WT-DB-04) and
// the bench's candidate arm (WT-BEN-01, bench-only env). No web, no model
// call, no spend.

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
let owner: string | null = null
vi.mock("@/lib/auth", () => ({
  requireOwner: async () => {
    if (!owner) throw new Error("NEXT_HTTP_ERROR_FALLBACK;404")
    return { id: owner }
  },
}))

import {
  benchCandidateAction,
  decideCandidateAction,
  freezeScoutAction,
} from "@/actions/harness-evolve"
import { gate } from "@/lib/harness/evolve/gate"
import { bodySha256, readCandidateFile } from "@/lib/harness/scout/candidate-file"
import { buildCandidate, draftOne, loadIncumbent } from "@/lib/harness/scout/draft"
import { lintCartridge, TOOL_NAMES, type CartridgeText } from "@/lib/harness/scout/lint"
import {
  benchCandidate,
  candidateFile,
  decideCandidate,
  getCandidate,
  ProposalError,
} from "@/lib/harness/scout/proposal"
import type { ScoutDeps } from "@/lib/harness/scout/run"
import { privileged } from "@/db"
import { harnessCartridgeCandidates } from "@/db/schema"

import { asUser, createTestDb, type TestDb } from "../../db/harness"
import { harnessDb, harnessEnv } from "../setup"

let pg: TestDb
let newUser: () => Promise<string>

const base = () => loadIncumbent("kriya-role-frontend")
const ADDED =
  "- Use `:focus-visible` for focus styles, so a mouse click doesn't draw a ring but the keyboard always does."
// A realistic candidate: one line added under Rules
const realistic = (b = base()) => ({
  ...b,
  body: b.body.replace("- Every image has `alt`", `${ADDED}\n- Every image has \`alt\``),
})
const withBody = (line: string, b = base()): CartridgeText => ({
  ...b,
  body: b.body.replace("## Anti-patterns", `${line}\n\n## Anti-patterns`),
})
const refused = (next: CartridgeText, rule: number) => {
  const r = lintCartridge(base(), next)
  expect(r.ok).toBe(false)
  expect(r.rules.find((x) => x.rule === rule)?.ok, JSON.stringify(r.rules)).toBe(false)
  return r
}

describe("WT-LINT: lintCartridge (SELF_EVOLUTION §7)", () => {
  it("WT-LINT-00: a realistic candidate passes every rule; unchanged base words aren't judged", () => {
    const b = base()
    // The base text says "tokens" (design tokens): only added lines count (RA-31)
    expect(b.body).toMatch(/tokens/)
    const r = lintCartridge(b, realistic(b))
    expect(r.rules.map((x) => x.ok)).toEqual([true, true, true, true, true])
    expect(r.changedLines).toBe(1)
    expect(lintCartridge(b, b).ok).toBe(true)
  })

  it("WT-LINT-01: rule 1, a field other than body, judgement, added ids and keywords", () => {
    const b = base()
    refused({ ...b, manifest: { ...b.manifest, name: "Something else" } }, 1)
    refused(
      {
        ...b,
        manifest: { ...b.manifest, tools: { all: ["web_fetch"], any: [], uses: [] } },
      },
      1
    )
    refused({ ...b, cartridge: { ...b.cartridge, globs: ["**/*"] } }, 1)
    // A gate the client catalogue doesn't have
    refused(
      {
        ...b,
        cartridge: { ...b.cartridge, gates: [...b.cartridge.gates, "G-ROOT" as never] },
      },
      1
    )
    const activation = b.manifest.activation as { keywords: string[] }
    refused(
      {
        ...b,
        manifest: {
          ...b.manifest,
          activation: { keywords: activation.keywords.slice(1) },
        },
      },
      1
    )
  })

  it("WT-LINT-02: rule 2, removing a gate or detector", () => {
    const b = base()
    refused({ ...b, cartridge: { ...b.cartridge, gates: b.cartridge.gates.slice(1) } }, 2)
    refused(
      { ...b, cartridge: { ...b.cartridge, detectors: b.cartridge.detectors.slice(1) } },
      2
    )
  })

  it("WT-LINT-03: rule 2, changing role, owns, reads, escalateAfter, maxPromptChars or a severity", () => {
    const b = base()
    const c = b.cartridge
    for (const changed of [
      { ...c, role: "backend" as const },
      { ...c, owns: ["api" as const] },
      { ...c, reads: ["schema" as const] },
      { ...c, escalateAfter: 0 },
      { ...c, maxPromptChars: 6000 },
      {
        ...c,
        detectors: c.detectors.map((d, i) =>
          i ? d : { ...d, severity: d.severity === "error" ? "warn" : "error" }
        ),
      },
    ])
      refused({ ...b, cartridge: changed as typeof c }, 2)
  })

  it("WT-LINT-04: rule 3, a URL", () => {
    refused(withBody("- See https://example.com/guide for details."), 3)
    refused(withBody("- Docs live at www.example.org."), 3)
  })

  it("WT-LINT-05: rule 3, a shell code block", () => {
    for (const tag of ["bash", "sh", "zsh", "shell", "powershell", "cmd", "console"])
      refused(withBody("```" + tag + "\nnpm test\n```"), 3)
    // A code block in another language is fine
    expect(
      lintCartridge(base(), withBody("```css\n.a { color: var(--fg) }\n```")).ok
    ).toBe(true)
  })

  it("WT-LINT-06: rule 3, each banned word, whole word, any case, plurals too", () => {
    for (const w of [
      "curl",
      "wget",
      "sudo",
      "chmod",
      "rm -rf",
      "eval(",
      "Password",
      "API key",
      "tokens",
      "sandbox",
      "approvals",
      "full access",
      "--mode",
      "Ignore previous",
      "system prompt",
    ])
      refused(withBody(`- Remember to handle ${w} carefully.`), 3)
    // Whole words only: "tokenizer" isn't "token"
    expect(
      lintCartridge(base(), withBody("- Prefer the tokenizer the framework ships.")).ok
    ).toBe(true)
  })

  it("WT-LINT-07: rule 3, a tool name from DSH's or Kriya's list", () => {
    expect(TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "bash",
        "web_fetch",
        "gmail_send_draft",
        "workspace_publish",
      ])
    )
    for (const t of [
      "web_fetch",
      "gmail_send_draft",
      "kriya_verify",
      "bash",
      "str_replace_editor",
      "workspace_publish",
    ])
      refused(withBody(`- Call ${t} when the page needs it.`), 3)
  })

  it("WT-LINT-08: rule 3, a protected path or constant (E3)", () => {
    for (const p of [
      "lib/agent/policy.ts",
      "src/modes.js",
      "lib/harness/gateway.ts",
      "MAX_ATTEMPTS",
      "REQUIRED",
      "the egress guard",
    ])
      refused(withBody(`- Never touch ${p}.`), 3)
  })

  it("WT-LINT-09: rule 3 also judges added judgement items and keywords", () => {
    const b = base()
    refused(
      {
        ...b,
        cartridge: {
          ...b.cartridge,
          judgement: [
            ...b.cartridge.judgement,
            { id: "no-sudo", ask: "Did the step avoid sudo?", severity: "minor" },
          ],
        },
      },
      3
    )
    const activation = b.manifest.activation as { keywords: string[] }
    refused(
      {
        ...b,
        manifest: {
          ...b.manifest,
          activation: { keywords: [...activation.keywords, "web_search"] },
        },
      },
      3
    )
  })

  it("WT-LINT-10: rule 4, a font, asset or code source without an allowed licence", () => {
    refused(withBody("- Use the Brandon Grotesque font for headings."), 4)
    refused(withBody("- Reuse the snippets from the GPL project."), 4)
    refused(withBody("- Animate with GSAP timelines."), 4)
    expect(
      lintCartridge(
        base(),
        withBody("- Prefer the Inter font (OFL) when the project has no font.")
      ).ok
    ).toBe(true)
  })

  it("WT-LINT-11: rule 5, more than 30% of lines changed", () => {
    const b = base()
    const lines = b.body.split("\n")
    const rewritten = lines
      .map((l, i) => (l.startsWith("- ") && i % 2 ? `${l} Always.` : l))
      .join("\n")
    const r = refused({ ...b, body: rewritten }, 5)
    expect(r.changedLines / r.baseLines).toBeGreaterThan(0.3)
  })

  it("WT-LINT-12: rule 5, the size bounds: body length and judgement items", () => {
    const b = base()
    refused(withBody("- " + "Keep it short. ".repeat(300)), 5)
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `ask-${i}-item`,
      ask: `Is item ${i} done?`,
      severity: "minor" as const,
    }))
    refused({ ...b, cartridge: { ...b.cartridge, judgement: many } }, 5)
    refused({ ...b, body: "" }, 5)
  })
})

/* ───────────────────────────── proposal ───────────────────────────── */

const TASKS = Array.from({ length: 12 }, (_, i) => `fe-task-${i}`)
const report = (
  passes: number,
  run: number,
  extra: Record<string, unknown> = {},
  over: (r: Record<string, unknown>, i: number) => Record<string, unknown> = (r) => r
) =>
  JSON.stringify({
    seedVersion: "99da9e832cf6",
    agent: "kriya run --mode auto",
    results: TASKS.map((id, i) =>
      over(
        {
          id,
          kind: "fix",
          level: "multi",
          status: i < passes ? "passed" : "failed",
          verifyExit: i < passes ? 0 : 1,
          escaped: false,
          leaked: false,
          tampered: false,
          constraintBroken: false,
          agentExit: 0,
          agentTimedOut: false,
          durationMs: 1000 + i,
          inputTokens: null,
          outputTokens: null,
          costMicroUsd: null,
          costMicroInr: "1000",
          agentOutputTail: "",
        },
        i
      )
    ),
    summary: {},
    finishedAt: `2026-11-23T0${run}:00:00.000Z`,
    ...extra,
  })

async function insertCandidate() {
  const { values } = buildCandidate(base(), { body: realistic().body }, [])
  // A finding id is required; candidates here don't need a real one
  const [row] = await privileged
    .insert(harnessCartridgeCandidates)
    .values({ ...values, findingIds: ["00000000-0000-4000-8000-000000000001"] })
    .returning()
  return row
}
const ranOf = (c: { id: string; cartridgeId: string; bodySha256: string }) => ({
  cartridgeCandidate: { id: c.id, cartridgeId: c.cartridgeId, sha256: c.bodySha256 },
})
const arms = (
  c: { id: string; cartridgeId: string; bodySha256: string },
  inc: number,
  cand: number,
  runs = 3
) => ({
  incumbent: Array.from({ length: runs }, (_, r) => report(inc, r)),
  candidate: Array.from({ length: runs }, (_, r) => report(cand, r, ranOf(c))),
})

beforeAll(async () => {
  ;({ pg, createUser: newUser } = await harnessDb())
})
beforeEach(async () => {
  harnessEnv({ KRIYA_HARNESS_SCOUT: "on", KRIYA_HARNESS_SCOUT_MONTHLY_INR: undefined })
  // W11: an approval stores a version that references its candidate
  await pg.exec(
    "delete from kriya.harness_cartridge_outcomes; delete from kriya.harness_cartridge_versions; delete from kriya.harness_cartridge_candidates"
  )
  owner = await newUser()
})

describe("WT-PRO: benchmark evidence, gate() and the owner's decision", () => {
  it("WT-PRO-01: the verdict is gate()'s on the uploaded reports, and the status follows it", async () => {
    const c = await insertCandidate()
    expect(c.status).toBe("awaiting_bench")
    const { incumbent, candidate } = arms(c, 4, 12)
    const verdict = await benchCandidate(c.id, incumbent, candidate, owner!)
    const parse = (t: string) => {
      const r = JSON.parse(t)
      return {
        ...r,
        results: r.results.map((x: { costMicroInr: string }) => ({
          ...x,
          costMicroInr: BigInt(x.costMicroInr),
        })),
      }
    }
    const direct = gate(incumbent.map(parse), candidate.map(parse))
    expect(direct.verdict).toBe("adopt")
    expect(verdict.verdict).toBe(direct.verdict)
    expect(verdict.reasons).toEqual(direct.reasons)
    const after = await getCandidate(c.id)
    expect(after?.status).toBe("proposed")
    expect(after?.evidence).toMatchObject({
      seedVersion: "99da9e832cf6",
      runs: 3,
      profileId: null,
    })
    const { rows } = await pg.query<{ action: string }>(
      "select action from kriya.audit_events where target_id = $1 order by id",
      [c.id]
    )
    expect(rows.map((r) => r.action)).toEqual([
      "harness.candidate.benched",
      "harness.candidate.proposed",
    ])
  })

  it("WT-PRO-02: evidence that doesn't match the candidate is refused, and nothing changes", async () => {
    const c = await insertCandidate()
    const good = arms(c, 4, 12)
    const wrongHash = good.candidate.map((_, r) =>
      report(12, r, {
        cartridgeCandidate: {
          id: c.id,
          cartridgeId: c.cartridgeId,
          sha256: bodySha256("another text"),
        },
      })
    )
    await expect(benchCandidate(c.id, good.incumbent, wrongHash, owner!)).rejects.toThrow(
      /hash doesn't match/
    )
    const noCandidate = good.candidate.map((_, r) => report(12, r + 3))
    await expect(
      benchCandidate(c.id, good.incumbent, noCandidate, owner!)
    ).rejects.toThrow(ProposalError)
    const incWithCand = good.incumbent.map((_, r) => report(4, r + 3, ranOf(c)))
    await expect(
      benchCandidate(c.id, incWithCand, good.candidate, owner!)
    ).rejects.toThrow(/incumbent report ran a candidate/)
    const otherSeed = [
      report(4, 0, { seedVersion: "0123456789ab" }),
      ...good.incumbent.slice(1),
    ]
    await expect(benchCandidate(c.id, otherSeed, good.candidate, owner!)).rejects.toThrow(
      /different seed sets/
    )
    await expect(
      benchCandidate(
        c.id,
        [good.incumbent[0], good.incumbent[0], good.incumbent[1]],
        good.candidate,
        owner!
      )
    ).rejects.toThrow(/twice/)
    await expect(
      benchCandidate(c.id, good.incumbent.slice(1), good.candidate, owner!)
    ).rejects.toThrow(/same number/)
    await expect(
      benchCandidate(c.id, ["{not json"], [good.candidate[0]], owner!)
    ).rejects.toThrow(/isn't JSON/)
    expect((await getCandidate(c.id))?.status).toBe("awaiting_bench")
  })

  it("WT-PRO-03: a rejected candidate can't be approved, by code or in SQL", async () => {
    const c = await insertCandidate()
    // Passes more but leaks: infeasible, whatever the pass rate
    const incumbent = [0, 1, 2].map((r) => report(4, r))
    const candidate = [0, 1, 2].map((r) =>
      report(12, r, ranOf(c), (x, i) => (i === 0 ? { ...x, leaked: true } : x))
    )
    expect((await benchCandidate(c.id, incumbent, candidate, owner!)).verdict).toBe(
      "reject"
    )
    expect((await getCandidate(c.id))?.status).toBe("rejected")
    await expect(
      decideCandidate(c.id, "approve", owner!, "I like it anyway")
    ).rejects.toThrow(/rejected candidate can't be approved/)
    await expect(
      pg.query(
        "update kriya.harness_cartridge_candidates set status = 'approved', decided_by = $2 where id = $1",
        [c.id, owner]
      )
    ).rejects.toThrow(/can't go from rejected to approved/)
    await expect(
      pg.query(
        "select kriya.harness_candidate_transition($1, 'approved', $2, 'reason here', null, null)",
        [c.id, owner]
      )
    ).rejects.toThrow(/can't go from rejected to approved/)
    // Benching it again is refused too
    await expect(benchCandidate(c.id, incumbent, candidate, owner!)).rejects.toThrow(
      /isn't waiting/
    )
  })

  it("WT-PRO-04: a held candidate is approved only with a typed reason, by the owner", async () => {
    const c = await insertCandidate()
    // One run per arm: too little evidence, hold
    const { incumbent, candidate } = arms(c, 4, 12, 1)
    expect((await benchCandidate(c.id, incumbent, candidate, owner!)).verdict).toBe(
      "hold"
    )
    expect((await getCandidate(c.id))?.status).toBe("held")
    await expect(decideCandidate(c.id, "approve", owner!)).rejects.toThrow(
      /needs a reason/
    )
    await expect(
      pg.query(
        "select kriya.harness_candidate_transition($1, 'approved', $2, 'short', null, null)",
        [c.id, owner]
      )
    ).rejects.toThrow(/typed reason/)
    await decideCandidate(c.id, "approve", owner!, "Owner judgement: the line is safe.")
    const after = await getCandidate(c.id)
    expect(after).toMatchObject({
      status: "approved",
      decidedBy: owner,
      reason: "Owner judgement: the line is safe.",
    })
    expect(after?.decidedAt).toBeInstanceOf(Date)
  })

  it("WT-PRO-05: SQL keeps the status with the verdict, and what was measured never changes", async () => {
    const c = await insertCandidate()
    const hold = { verdict: "hold", reasons: [], metrics: {} }
    await expect(
      pg.query(
        "select kriya.harness_candidate_transition($1, 'benched', $2, null, $3, '{}')",
        [c.id, owner, JSON.stringify(hold)]
      )
    ).resolves.toBeTruthy()
    await expect(
      pg.query(
        "select kriya.harness_candidate_transition($1, 'proposed', $2, null, null, null)",
        [c.id, owner]
      )
    ).rejects.toThrow(/only an adopt or canary verdict is proposed/)
    await expect(
      pg.query(
        'update kriya.harness_cartridge_candidates set verdict = \'{"verdict":"adopt"}\' where id = $1',
        [c.id]
      )
    ).rejects.toThrow(/written once/)
    await expect(
      pg.query(
        "update kriya.harness_cartridge_candidates set body = 'changed' where id = $1",
        [c.id]
      )
    ).rejects.toThrow(/content never changes/)
    await expect(
      pg.query(
        "update kriya.harness_cartridge_candidates set lint = '{}' where id = $1",
        [c.id]
      )
    ).rejects.toThrow(/content never changes/)
  })

  it("WT-PRO-06: no input carries a verdict or a status; skipping the benchmark is refused", async () => {
    const c = await insertCandidate()
    // A report claiming a verdict changes nothing: gate() reads only results
    const { incumbent, candidate } = arms(c, 4, 4)
    const claimed = candidate.map((t) =>
      JSON.stringify({ ...JSON.parse(t), verdict: "adopt", status: "approved" })
    )
    expect((await benchCandidate(c.id, incumbent, claimed, owner!)).verdict).toBe("hold")
    const d = await insertCandidate()
    await expect(
      decideCandidate(d.id, "approve", owner!, "skip the bench please")
    ).rejects.toThrow(/isn't waiting for a decision/)
    await expect(
      pg.query(
        "select kriya.harness_candidate_transition($1, 'approved', $2, 'skip the bench', null, null)",
        [d.id, owner]
      )
    ).rejects.toThrow(/can't go from awaiting_bench to approved/)
    // The decision form takes only approve or reject
    const form = new FormData()
    form.set("id", d.id)
    form.set("decision", "adopt")
    expect(await decideCandidateAction(null, form)).toEqual({
      error: "Invalid decision.",
    })
  })
})

describe("WT-SEC-01: owner only", () => {
  it("every action refuses a non-owner before touching anything", async () => {
    const c = await insertCandidate()
    owner = null
    const form = new FormData()
    form.set("id", c.id)
    form.set("decision", "reject")
    await expect(decideCandidateAction(null, form)).rejects.toThrow(/404/)
    await expect(benchCandidateAction(null, form)).rejects.toThrow(/404/)
    await expect(freezeScoutAction()).rejects.toThrow(/404/)
    expect((await getCandidate(c.id))?.status).toBe("awaiting_bench")
  })

  it("no client role reads, writes or transitions a candidate", async () => {
    const c = await insertCandidate()
    const user = await newUser()
    // Refused outright, or (if a grant ever appears) the policy shows nothing
    const nothing = (q: string, params: unknown[] = []) =>
      asUser(pg, user, (tx) => tx.query(q, params)).then(
        (r) => r.rows,
        (e) => String(e)
      )
    for (const q of [
      "select id from kriya.harness_cartridge_candidates",
      "update kriya.harness_cartridge_candidates set reason = 'x' returning id",
      "delete from kriya.harness_cartridge_candidates returning id",
    ]) {
      const out = await nothing(q)
      expect(Array.isArray(out) ? out : [], q).toEqual([])
      if (!Array.isArray(out)) expect(out).toMatch(/permission denied/)
    }
    expect((await getCandidate(c.id))?.reason).toBeNull()
    await expect(
      asUser(pg, user, (tx) =>
        tx.query(
          "select kriya.harness_candidate_transition($1, 'benched', $2, null, '{}', '{}')",
          [c.id, user]
        )
      )
    ).rejects.toThrow(/permission denied/)
  })

  it("the pages check the role before reading anything", async () => {
    for (const file of [
      "app/owner/harness/page.tsx",
      "app/owner/harness/candidates/[id]/page.tsx",
    ]) {
      const text = await fs.readFile(path.join(process.cwd(), file), "utf8")
      const body = text.slice(text.indexOf("export default async function"))
      expect(body.indexOf("await requireOwner()"), file).toBeGreaterThan(-1)
      expect(body.indexOf("await requireOwner()")).toBeLessThan(
        body.indexOf("await ", body.indexOf("await requireOwner()") + 10)
      )
    }
    const actions = await fs.readFile(
      path.join(process.cwd(), "actions/harness-evolve.ts"),
      "utf8"
    )
    const exported = [
      ...actions.matchAll(
        /export async function (\w+)[\s\S]*?\{\n {2}const owner = await requireOwner\(\)/g
      ),
    ].map((m) => m[1])
    expect(exported.sort()).toEqual(
      [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort()
    )
  })
})

/* ───────────────────────────── drafting ───────────────────────────── */

describe("WT-DR: drafting a confirmed finding (scripted model)", () => {
  let reply = ""
  const asked: string[] = []
  const deps: ScoutDeps = {
    now: () => new Date("2026-12-01T10:00:00Z"),
    fetchPage: async () => "",
    ask: async ({ prompt }) => (
      asked.push(prompt),
      { text: reply, tokens: 500, costMicroUsd: 100 }
    ),
  }
  const finding = async () => {
    await pg.exec(
      "delete from kriya.harness_scout_findings; delete from kriya.harness_scout_runs; delete from kriya.harness_scout_sources"
    )
    const {
      rows: [s],
    } = await pg.query<{ id: string }>(
      "insert into kriya.harness_scout_sources (discipline, url, kind) values ('frontend', 'https://web.example/notes', 'guideline') returning id"
    )
    const {
      rows: [r],
    } = await pg.query<{ id: string }>(
      "insert into kriya.harness_scout_runs (status) values ('done') returning id"
    )
    const {
      rows: [f],
    } = await pg.query<{ id: string }>(
      `insert into kriya.harness_scout_findings (run_id, source_id, discipline, kind, claim, quote, quote_hash, status, confirmed_at)
       values ($1, $2, 'frontend', 'practice', 'Use :focus-visible for focus rings', 'Authors should use :focus-visible.', $3, 'confirmed', now()) returning id`,
      [r.id, s.id, "a".repeat(64)]
    )
    return f.id
  }
  beforeAll(async () => {
    await pg.query(
      "insert into kriya.models (id, label, input_micro_usd_per_mtok, output_micro_usd_per_mtok) values ('test/budget', 'Budget', 1000000, 2000000) on conflict (id) do nothing"
    )
  })
  beforeEach(() => {
    asked.length = 0
    harnessEnv({
      KRIYA_HARNESS_SCOUT: "on",
      KRIYA_HARNESS_SCOUT_MONTHLY_INR: "500",
      KRIYA_FX_USD_INR: "84.0000",
      OPENROUTER_API_KEY: "upstream-key-not-real",
      OPENROUTER_DEFAULT_MODEL: "test/budget",
    })
  })

  it("WT-DR-01: a linted reply becomes a candidate awaiting its benchmark", async () => {
    const id = await finding()
    reply = JSON.stringify({ body: realistic().body })
    expect(await draftOne(deps)).toBe("drafted a candidate")
    expect(asked[0]).toMatch(/untrusted/)
    const [c] = await privileged.select().from(harnessCartridgeCandidates)
    expect(c).toMatchObject({
      status: "awaiting_bench",
      cartridgeId: "kriya-role-frontend",
      baseVersion: "1.0.0",
      findingIds: [id],
    })
    expect(c.diff).toContain("+" + ADDED)
    const { rows } = await pg.query(
      "select status from kriya.harness_scout_findings where id = $1",
      [id]
    )
    expect(rows).toEqual([{ status: "drafted" }])
    expect(await draftOne(deps)).toBeNull()
  })

  it("WT-DR-02: a reply lint refuses is stored discarded, with the reasons", async () => {
    await finding()
    reply =
      "Here you go: " +
      JSON.stringify({
        body: withBody("- Fetch fonts with curl from https://cdn.example/x").body,
      })
    expect(await draftOne(deps)).toBe("discarded a candidate (lint)")
    const [c] = await privileged.select().from(harnessCartridgeCandidates)
    expect(c.status).toBe("discarded")
    expect((c.lint as { ok: boolean }).ok).toBe(false)
  })

  it("WT-DR-03: with no budget nothing is asked and the finding waits", async () => {
    const id = await finding()
    harnessEnv({ KRIYA_HARNESS_SCOUT_MONTHLY_INR: "0" })
    expect(await draftOne(deps)).toBeNull()
    expect(asked).toEqual([])
    const { rows } = await pg.query(
      "select status from kriya.harness_scout_findings where id = $1",
      [id]
    )
    expect(rows).toEqual([{ status: "confirmed" }])
  })
})

/* ─────────────────────────── rollback, bench ─────────────────────────── */

describe("WT-DB-04: the candidates migration rolls back with data and applies again", () => {
  it("down, then up", async () => {
    const db = await createTestDb()
    await db.exec(
      "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key)"
    )
    const read = (dir: string, file: string) =>
      fs.readFile(path.join(process.cwd(), "supabase", dir, file), "utf8")
    await db.query(
      `insert into kriya.harness_cartridge_candidates (cartridge_id, base_version, body, diff, body_sha256, finding_ids, lint, status)
       values ('kriya-role-frontend', '1.0.0', 'b', '+b', $1, '{00000000-0000-4000-8000-000000000001}', '{}', 'awaiting_bench')`,
      ["b".repeat(64)]
    )
    // W11's versions reference candidates: they go first
    await db.exec(
      await read("rollback", "20271201000200_harness_cartridge_versions.down.sql")
    )
    await db.exec(await read("rollback", "20271201000100_harness_candidates.down.sql"))
    const { rows } = await db.query(
      "select to_regclass('kriya.harness_cartridge_candidates') as t, (select count(*)::int from kriya.allowed_transitions where entity = 'harness_candidate') as edges"
    )
    expect(rows).toEqual([{ t: null, edges: 0 }])
    await db.exec(await read("migrations", "20271201000100_harness_candidates.sql"))
    await db.exec(
      await read("migrations", "20271201000200_harness_cartridge_versions.sql")
    )
    const { rows: edges } = await db.query(
      "select count(*)::int as n from kriya.allowed_transitions where entity = 'harness_candidate'"
    )
    expect(edges).toEqual([{ n: 8 }])
  })
})

describe("WT-BEN-01 (W9 part): the candidate arm's bench-only environment", () => {
  const run = promisify(execFile)
  // The agent prints what it sees; commandAgent passes the prompt as an extra argument
  const agent =
    "node -e console.log('SEEN='+process.env.KRIYA_BENCH+'|'+process.env.KRIYA_CARTRIDGE_FILE)"
  const bench = async (
    dir: string,
    extra: string[],
    env: Record<string, string> = {}
  ) => {
    const out = path.join(dir, `r-${extra.length}-${Object.keys(env).length}.json`)
    await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "lib/harness/bench/cli.ts",
        "--agent",
        agent,
        "--level",
        "role-security",
        "--only",
        "sec-csp-header",
        "--out",
        out,
        ...extra,
      ],
      { env: { ...process.env, ...env }, timeout: 120_000 }
    )
    return JSON.parse(await fs.readFile(out, "utf8"))
  }

  it("sets KRIYA_BENCH and KRIYA_CARTRIDGE_FILE only with --cartridge-candidate, and records the candidate", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kriya-w9-"))
    const c = await insertCandidate()
    const file = path.join(dir, "candidate.json")
    await fs.writeFile(file, JSON.stringify(candidateFile(c)))
    const withCand = await bench(dir, ["--cartridge-candidate", file])
    expect(withCand.results[0].agentOutputTail).toContain(`SEEN=on|${file}`)
    expect(withCand.cartridgeCandidate).toEqual({
      id: c.id,
      cartridgeId: c.cartridgeId,
      sha256: c.bodySha256,
    })
    // The shell's own values never reach the incumbent arm
    const inc = await bench(dir, [], { KRIYA_BENCH: "on", KRIYA_CARTRIDGE_FILE: file })
    expect(inc.results[0].agentOutputTail).toContain("SEEN=undefined|undefined")
    expect(inc.cartridgeCandidate).toBeUndefined()
    // A tampered file is refused before anything runs
    await fs.writeFile(file, JSON.stringify({ ...candidateFile(c), body: "changed" }))
    await expect(bench(dir, ["--cartridge-candidate", file])).rejects.toThrow(/sha256/)
    expect(() =>
      readCandidateFile(JSON.stringify({ ...candidateFile(c), body: "x" }))
    ).toThrow(/sha256/)
  }, 240_000)
})
