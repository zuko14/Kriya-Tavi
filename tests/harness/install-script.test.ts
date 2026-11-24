import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// S-2 (docs/kriya-harness/INSTALLER.md): GET /install.sh serves the
// kriya-harness installer only with harness.api and harness.installScript on,
// with this Kriya's configured address filled in. HT-INS-01…03.

vi.mock("server-only", () => ({}))

import { GET } from "@/app/install.sh/route"
import { installLine, installScript } from "@/lib/harness/install"
import { INSTALL_SCRIPT, INSTALL_SCRIPT_SHA256 } from "@/lib/harness/install-script"

import { harnessDb, harnessEnv } from "./setup"

beforeAll(async () => {
  await harnessDb()
})
beforeEach(() => harnessEnv({ KRIYA_HARNESS_INSTALL_SCRIPT: undefined }))

describe("HT-INS-01: the route", () => {
  it("answers 404 while either switch is off", async () => {
    expect((await GET()).status).toBe(404)
    harnessEnv({ KRIYA_HARNESS_API: "off", KRIYA_HARNESS_INSTALL_SCRIPT: "on" })
    expect((await GET()).status).toBe(404)
  })

  it("on: the script, with this Kriya's address, never cached", async () => {
    harnessEnv({ KRIYA_HARNESS_INSTALL_SCRIPT: "on" })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8")
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.text()
    expect(body).toContain('KRIYA_URL_DEFAULT="https://kriya.example"')
    expect(body.replace('"https://kriya.example"', '"__KRIYA_URL__"')).toBe(
      INSTALL_SCRIPT
    )
  })
})

describe("HT-INS-02: the address filled in", () => {
  it("only a plain https address, or a local one", () => {
    expect(installScript("https://kriya-web.onrender.com")).toContain(
      'KRIYA_URL_DEFAULT="https://kriya-web.onrender.com"'
    )
    expect(installScript("http://localhost:6796")).toContain(
      'KRIYA_URL_DEFAULT="http://localhost:6796"'
    )
    for (const bad of [
      'https://x.example"; rm -rf ~; "',
      "https://x.example/$(id)",
      "http://kriya.example",
      "https://x.example/path",
    ])
      expect(installScript(bad)).toBe(INSTALL_SCRIPT)
    expect(installLine("https://kriya.example")).toBe(
      "curl -fsSL https://kriya.example/install.sh | sh"
    )
  })
})

describe("HT-INS-03: the copy", () => {
  it("is the generated one (not hand-edited)", () => {
    expect(createHash("sha256").update(INSTALL_SCRIPT).digest("hex")).toBe(
      INSTALL_SCRIPT_SHA256
    )
    expect(INSTALL_SCRIPT).toContain('KRIYA_URL_DEFAULT="__KRIYA_URL__"')
    expect(INSTALL_SCRIPT.trimEnd().endsWith('\nmain "$@"')).toBe(true)
  })

  it("matches kriya-harness install.sh when that repository is beside this one", () => {
    const source = path.join(process.cwd(), "..", "kriya-harness", "install.sh")
    if (!fs.existsSync(source)) return
    expect(fs.readFileSync(source, "utf8")).toBe(INSTALL_SCRIPT)
  })
})
