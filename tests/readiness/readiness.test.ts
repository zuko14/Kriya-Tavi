import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { SECRETS, SETTINGS } from "@/lib/config"
import { LEGAL_DOCS, LEGAL_STATUS, PROCESSORS } from "@/lib/legal"
import { configChecks, databaseChecks, GATES, type Check } from "@/lib/readiness"
import { keyId, seal } from "@/lib/secrets"

import { createTestDb, createUser, type TestDb } from "../db/harness"

// Production readiness verification (A11). Repository checks that must hold
// for every release, plus the deployment checks behind `npm run readiness`
// run against a scripted database. No outside calls.

const ROOT = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id)

describe("release invariants", () => {
  it("every migration has a rollback", () => {
    const up = fs.readdirSync(path.join(ROOT, "supabase/migrations"))
    const down = new Set(fs.readdirSync(path.join(ROOT, "supabase/rollback")))
    const missing = up
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !down.has(f.replace(/\.sql$/, ".down.sql")))
    // Known exception, recorded here so a new one fails: the brand migration
    // predates rollback files for every migration
    expect(missing).toEqual(["20261018000000_brand.sql"])
  })

  it("every on/off capability switch ships off (AGENTS.md track A rule 2)", () => {
    const defs = SETTINGS as Record<string, { pattern?: RegExp; fallback?: string }>
    const on = Object.entries(defs)
      .filter(([, def]) => def.pattern?.source === "^(on|off)$")
      .filter(([, def]) => def.fallback !== "off")
      .map(([name]) => name)
    expect(on).toEqual([])
  })

  it("no secret is public, or written into render.yaml (invariant 4)", () => {
    expect(SECRETS.filter((name) => name.startsWith("NEXT_PUBLIC_"))).toEqual([])
    const valued = [...read("render.yaml").matchAll(/- key: (\w+)\r?\n\s+value:/g)].map(
      (m) => m[1]
    )
    const secrets = SECRETS as readonly string[]
    expect(valued.filter((name) => secrets.includes(name))).toEqual([])
  })

  it("the privacy notice names every outside service the code is configured for", () => {
    const SERVICES: Record<string, string> = {
      SUPABASE: "Supabase",
      OPENROUTER: "OpenRouter",
      FIRECRAWL: "Firecrawl",
      RAZORPAY: "Razorpay",
      GOOGLE: "Google",
      NOTION: "Notion",
      GITHUB: "GitHub",
      META: "Meta",
    }
    const names = [
      ...SECRETS,
      ...[...read("lib/env.ts").matchAll(/name: "([A-Z0-9_]+)"/g)].map((m) => m[1]),
    ]
    const prefixes = new Set(
      names.map((name) => name.replace(/^NEXT_PUBLIC_/, "").split("_")[0])
    )
    // Kriya's own settings and infrastructure, not outside services
    const own = new Set(["KRIYA", "DATABASE", "DB", "OWNER"])
    expect([...prefixes].filter((p) => !own.has(p) && !SERVICES[p])).toEqual([])
    const named = PROCESSORS.map((p) => p.name).join(" ")
    for (const prefix of prefixes) {
      if (SERVICES[prefix]) expect(named, prefix).toContain(SERVICES[prefix])
    }
    expect(named).toContain("Render")
  })

  it("legal pages: privacy, terms and AI disclosure, labelled drafts until counsel signs off", () => {
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual(["ai", "privacy", "terms"])
    expect(LEGAL_STATUS).toMatchObject({
      draft: true,
      label: "Draft, pending legal review",
    })
    const privacy = JSON.stringify(LEGAL_DOCS.privacy)
    for (const topic of [
      "Saved logins",
      "How long we keep it",
      "Your rights",
      "under 18",
    ]) {
      expect(privacy, topic).toContain(topic)
    }
    // Open legal points are written as open, not as settled law
    expect(privacy).toContain("under legal review")
    expect(JSON.stringify(LEGAL_DOCS.ai)).toContain("AI assistant calling on your behalf")
    expect(read("app/legal/[doc]/page.tsx")).toContain("LEGAL_STATUS.label")
  })

  it("the runbooks exist and each has its drill", () => {
    const dir = "docs/agent-platform/runbooks"
    expect(read(`${dir}/restore.md`)).toMatch(
      /## Drill \(staging only\)[\s\S]*RPO[\s\S]*RTO/
    )
    expect(read(`${dir}/key-rotation.md`)).toMatch(/## Emergency rotation[\s\S]*## Drill/)
    expect(read(`${dir}/incident.md`)).toMatch(
      /## First 15 minutes[\s\S]*## Breach intimation/
    )
    // Every switch the incident runbook tells you to use exists
    const switches = [...read(`${dir}/incident.md`).matchAll(/`(agents\.\w+)`/g)].map(
      (m) => m[1]
    )
    expect(switches.length).toBeGreaterThan(5)
    for (const name of switches) expect(Object.keys(SETTINGS), name).toContain(name)
  })

  it("lists all eight gates", () => {
    expect(GATES.map((g) => g.id)).toEqual([
      "GA-1",
      "GA-2",
      "GA-3",
      "GA-4",
      "GA-5",
      "GA-6",
      "GA-7",
      "GA-8",
    ])
  })
})

describe("deployment checks (npm run readiness)", () => {
  const KEY = randomBytes(32).toString("base64")
  const OLD = randomBytes(32).toString("base64")
  const BASE = {
    DATABASE_URL: "postgres://x",
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk",
    KRIYA_APP_URL: "https://kriya.example",
    OPENROUTER_API_KEY: "or",
  }

  it("configuration: required variables, key shapes, browser secrets, never a value", () => {
    const missing = configChecks({})
    expect(byId(missing, "env.required")?.status).toBe("fail")
    expect(byId(missing, "keys.token")?.status).toBe("warn")
    const good = configChecks({
      ...BASE,
      KRIYA_TOKEN_KEY: KEY,
      KRIYA_BROWSER_URL: "http://kriya-browser:10000",
      KRIYA_BROWSER_SECRET: "s".repeat(40),
      KRIYA_BROWSER_LIVE_URL: "wss://live.kriya.example",
    })
    expect(good.filter((c) => c.status === "fail")).toEqual([])
    expect(JSON.stringify(good)).not.toContain(KEY)
    expect(byId(good, "legal.reviewed")?.status).toBe("warn")
    const bad = configChecks({
      ...BASE,
      KRIYA_TOKEN_KEY: "short",
      KRIYA_TOKEN_KEY_PREVIOUS: "short",
      KRIYA_BROWSER_URL: "http://x",
      KRIYA_BROWSER_SECRET: "short",
      KRIYA_BROWSER_LIVE_URL: "http://live",
    })
    expect(
      bad
        .filter((c) => c.status === "fail")
        .map((c) => c.id)
        .sort()
    ).toEqual(["browser.live", "browser.secret", "keys.rotation", "keys.token"])
    const rotating = configChecks({
      ...BASE,
      KRIYA_TOKEN_KEY: KEY,
      KRIYA_TOKEN_KEY_PREVIOUS: OLD,
    })
    expect(byId(rotating, "keys.rotation")).toMatchObject({ status: "warn" })
    expect(byId(rotating, "keys.rotation")?.detail).toContain(
      keyId(Buffer.from(OLD, "base64"))
    )
  })

  describe("database", () => {
    let pg: TestDb
    const query = async <T>(sql: string) => (await pg.query<T>(sql)).rows

    beforeAll(async () => {
      pg = await createTestDb()
      await pg.exec(
        "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key)"
      )
    })

    it("finds pending migrations, then passes once all are applied", async () => {
      const pending = await databaseChecks(query, {})
      expect(byId(pending, "db.migrations")?.status).toBe("fail")
      for (const file of fs.readdirSync(path.join(ROOT, "supabase/migrations"))) {
        await pg.query("insert into supabase_migrations.schema_migrations values ($1)", [
          file.split("_")[0],
        ])
      }
      const checks = await databaseChecks(query, {})
      expect(checks.map((c) => [c.id, c.status])).toEqual([
        ["db.migrations", "pass"],
        ["db.rls", "pass"],
        ["db.anon", "pass"],
      ])
    })

    it("counts sealed values still on an older key, reading prefixes only", async () => {
      const user = await createUser(pg)
      process.env.KRIYA_TOKEN_KEY = OLD
      await pg.query(
        "insert into kriya.connections (id, user_id, provider, access_token) values ('c1', $1, 'notion', $2)",
        [user, seal("secret-notion-token", `${user}:notion`)]
      )
      const stale = byId(
        await databaseChecks(query, { KRIYA_TOKEN_KEY: KEY }),
        "keys.sealed"
      )!
      expect(stale.status).toBe("warn")
      expect(stale.detail).toContain(
        `connections v2_${keyId(Buffer.from(OLD, "base64"))} ×1`
      )
      expect(stale.detail).not.toContain("secret-notion-token")
      process.env.KRIYA_TOKEN_KEY = KEY
      await pg.query("update kriya.connections set access_token = $1 where id = 'c1'", [
        seal("secret-notion-token", `${user}:notion`),
      ])
      const fresh = await databaseChecks(query, { KRIYA_TOKEN_KEY: KEY })
      expect(byId(fresh, "keys.sealed")?.status).toBe("pass")
    })

    it("fails a table without RLS and a schema open to anon", async () => {
      await pg.exec(
        "create table kriya.scratch_no_rls (id int); grant usage on schema kriya to anon"
      )
      const checks = await databaseChecks(query, {})
      expect(byId(checks, "db.rls")).toMatchObject({
        status: "fail",
        detail: "no RLS: scratch_no_rls",
      })
      expect(byId(checks, "db.anon")?.status).toBe("fail")
      await pg.exec(
        "drop table kriya.scratch_no_rls; revoke usage on schema kriya from anon"
      )
    })
  })
})
