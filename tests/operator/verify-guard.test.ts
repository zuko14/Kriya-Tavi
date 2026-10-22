import { describe, expect, it } from "vitest"

import { envFileNames, problems } from "@/scripts/verify-guard"

// OT-UIV-01 (UI_VERIFICATION §3): the guard refuses anything that could reach
// the live database, place a call or spend money, and never prints a value.

const LOCAL = {
  DATABASE_URL: "postgresql://postgres:pw-secret@127.0.0.1:54322/postgres",
  MIGRATION_DATABASE_URL: "postgresql://postgres:pw-secret@127.0.0.1:54322/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  OPENROUTER_BASE_URL: "http://127.0.0.1:6797/v1",
  OPENROUTER_API_KEY: "stub",
}
const LIVE_HOST = "db.kiyfofxkechnzeeluhtv.supabase.co"

describe("verify:guard (OT-UIV-01)", () => {
  it("passes a fully local environment", () => {
    expect(problems(LOCAL, [])).toEqual([])
  })

  it("refuses the live project or any non-local host, without printing values", () => {
    const live = problems(
      {
        ...LOCAL,
        DATABASE_URL: `postgresql://postgres:pw-secret@${LIVE_HOST}:5432/postgres`,
      },
      []
    )
    expect(live.join(" ")).toMatch(/DATABASE_URL/)
    const remote = problems(
      { ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://other.example.com" },
      []
    )
    expect(remote.join(" ")).toMatch(/NEXT_PUBLIC_SUPABASE_URL/)
    for (const out of [live, remote]) {
      const text = out.join(" ")
      expect(text).not.toContain("pw-secret")
      expect(text).not.toContain("kiyfofxkechnzeeluhtv")
    }
  })

  it("refuses a missing database or auth URL", () => {
    expect(problems({ ...LOCAL, DATABASE_URL: undefined }, []).join(" ")).toMatch(
      /DATABASE_URL/
    )
  })

  it("refuses live calls: KRIYA_VOICE_LIVE or any EXOTEL_* with a value", () => {
    expect(problems({ ...LOCAL, KRIYA_VOICE_LIVE: "1" }, [])).toHaveLength(1)
    expect(problems({ ...LOCAL, EXOTEL_API_KEY: "k" }, []).join(" ")).toMatch(
      /EXOTEL_API_KEY/
    )
    // Set but empty is how .env.verify switches a name off
    expect(problems({ ...LOCAL, KRIYA_VOICE_LIVE: "", EXOTEL_API_KEY: "" }, [])).toEqual(
      []
    )
  })

  it("refuses a model key without the local stub, unless paid checks were allowed", () => {
    const paid = {
      ...LOCAL,
      OPENROUTER_API_KEY: "sk-or-real",
      OPENROUTER_BASE_URL: undefined,
    }
    expect(problems(paid, []).join(" ")).toMatch(/OPENROUTER/)
    expect(
      problems({ ...paid, OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1" }, [])
    ).toHaveLength(1)
    expect(problems({ ...paid, KRIYA_VERIFY_PAID: "1" }, [])).toEqual([])
    expect(problems(paid, []).join(" ")).not.toContain("sk-or-real")
  })

  it("refuses any name in .env or .env.local the environment leaves undefined (OF-17)", () => {
    // Next.js would fill these from the files
    expect(problems(LOCAL, ["FIRECRAWL_API_KEY", "DATABASE_URL"])).toEqual([
      expect.stringMatching(/FIRECRAWL_API_KEY/),
    ])
    expect(problems({ ...LOCAL, FIRECRAWL_API_KEY: "" }, ["FIRECRAWL_API_KEY"])).toEqual(
      []
    )
  })

  it("reads only names from env files", () => {
    expect(
      envFileNames(
        "# comment\nDATABASE_URL=postgres://x\n\nexport KRIYA_TOKEN_KEY='abc'\nBAD LINE\n"
      )
    ).toEqual(["DATABASE_URL", "KRIYA_TOKEN_KEY"])
  })
})
