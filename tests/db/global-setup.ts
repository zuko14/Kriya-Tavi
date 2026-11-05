import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { migratedTestDb } from "./harness"

// Runs once before the test workers start, which inherit the variable
export default async function setup() {
  const pg = await migratedTestDb()
  const dump = await pg.dumpDataDir("none")
  await pg.close()
  const file = path.join(os.tmpdir(), `kriya-test-db-${process.pid}.tar`)
  fs.writeFileSync(file, Buffer.from(await dump.arrayBuffer()))
  process.env.KRIYA_TEST_DB_SNAPSHOT = file
  return () => fs.rmSync(file, { force: true })
}
