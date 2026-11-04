import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { __test, syncCatalogue } from "@/lib/models"

import type { TestDb } from "../db/harness"
import { harnessDb, harnessEnv } from "./setup"

// Harness upgrade U9 (HU-SYNC-01): the catalogue sync fills kriya.models'
// context_window and max_output_tokens from the provider's public catalogue;
// anything that isn't a positive integer stays null. No network: fetch is stubbed.

let pg: TestDb

beforeAll(async () => {
  pg = (await harnessDb()).pg
  harnessEnv()
  await pg.query(
    "insert into kriya.models (id, label) values ('sync/a', 'A'), ('sync/b', 'B') on conflict (id) do nothing"
  )
})

afterEach(() => vi.unstubAllGlobals())

describe("HU-SYNC-01: the catalogue sync records model limits", () => {
  it("positive integers kept, anything else null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "sync/a",
              name: "A",
              context_length: 1048576,
              top_provider: { max_completion_tokens: 393216 },
            },
            {
              id: "sync/b",
              name: "B",
              context_length: "lots",
              top_provider: { max_completion_tokens: null },
            },
          ],
        })
      )
    )
    expect(await syncCatalogue(["sync/a", "sync/b"])).toEqual({ updated: 2, missing: [] })
    const { rows } = await pg.query(
      "select id, context_window, max_output_tokens from kriya.models where id like 'sync/%' order by id"
    )
    expect(rows).toEqual([
      { id: "sync/a", context_window: 1048576, max_output_tokens: 393216 },
      { id: "sync/b", context_window: null, max_output_tokens: null },
    ])
    expect(__test.positiveInt(2 ** 40)).toBeNull()
    expect(__test.positiveInt(0)).toBeNull()
  })
})
