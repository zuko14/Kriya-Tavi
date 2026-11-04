import fs from "node:fs"
import path from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { createTestDb, type TestDb } from "./harness"

// 20270701000000_model_limits.sql (harness upgrade U9, owner 2026-11-04):
// kriya.models gains context_window and max_output_tokens, positive or null;
// the rollback removes them and the migration applies again.

const read = (dir: string, file: string) =>
  fs.readFileSync(path.join(process.cwd(), "supabase", dir, file), "utf8")

let pg: TestDb

beforeAll(async () => {
  pg = await createTestDb()
})

const columns = async () =>
  (
    await pg.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'kriya' and table_name = 'models' and column_name in ('context_window', 'max_output_tokens') order by 1"
    )
  ).rows.map((r) => r.column_name)

describe("HU-DB-01: model limits on kriya.models", () => {
  it("positive or null; rolls back and applies again", async () => {
    expect(await columns()).toEqual(["context_window", "max_output_tokens"])
    await pg.query(
      "insert into kriya.models (id, label, context_window, max_output_tokens) values ('t/a', 'A', 131072, 16384), ('t/b', 'B', null, null)"
    )
    await expect(
      pg.query(
        "insert into kriya.models (id, label, context_window) values ('t/c', 'C', 0)"
      )
    ).rejects.toThrow()
    await expect(
      pg.query(
        "insert into kriya.models (id, label, max_output_tokens) values ('t/d', 'D', -1)"
      )
    ).rejects.toThrow()
    await pg.exec(read("rollback", "20270701000000_model_limits.down.sql"))
    expect(await columns()).toEqual([])
    // The rows themselves stay
    expect(
      (await pg.query("select id from kriya.models where id like 't/%'")).rows
    ).toHaveLength(2)
    await pg.exec(read("migrations", "20270701000000_model_limits.sql"))
    expect(await columns()).toEqual(["context_window", "max_output_tokens"])
  })
})
