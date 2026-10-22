import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// file_list, file_save_attachment, document_render (A5, TOOLS_AND_CONTRACTS
// §2.3) on fixtures: Gmail answers from hand-written responses, the PDF
// renderer is a stub, storage is in memory. Nothing leaves the machine.

vi.mock("@/lib/secrets", async (original) => ({
  ...(await original<typeof import("@/lib/secrets")>()),
  isSecretsConfigured: () => true,
}))

import type { Agent } from "@/db/schema"
import { CAPABILITIES } from "@/lib/agent/capabilities"
import { classifyTool, TOOL_WRITES } from "@/lib/agent/policy"
import { createFileTools, SIDE_EFFECT_TOOLS, type Connected } from "@/lib/agent/tools"
import type { BrowserProvider } from "@/lib/browser/provider"
import { setBrowserProviderForTests } from "@/lib/browser/session"
import { gmailRead } from "@/lib/connectors"
import { pdfPages } from "@/lib/documents/render"
import { setFileStoreForTests } from "@/lib/files"

import { connectedUser, serve } from "../connectors/fixtures"
import { createUser } from "../db/harness"

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type/Page >> endobj\n%%EOF\n"
)
const GMAIL = /^https:\/\/www\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/M1\?/

const message = {
  id: "M1",
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "Subject", value: "Your bill" }],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("See attached.").toString("base64url") },
      },
      {
        mimeType: "application/pdf",
        filename: "bill.pdf",
        body: { attachmentId: "ATT1", size: PDF.length },
      },
      {
        mimeType: "application/zip",
        filename: "archive.zip",
        body: { attachmentId: "ATT2", size: 10 },
      },
    ],
  },
}

const objects = new Map<string, Buffer>()
const rendered: string[] = []
beforeEach(() => {
  objects.clear()
  rendered.length = 0
  setFileStoreForTests({
    uploadUrl: async (p) => p,
    read: async (p) => objects.get(p) ?? null,
    write: async (p, bytes) => void objects.set(p, bytes),
    signedUrl: async (p) => p,
    remove: async () => {},
  })
  setBrowserProviderForTests({
    renderPdf: async (html: string) => {
      rendered.push(html)
      return PDF
    },
  } as unknown as BrowserProvider)
})
afterEach(() => {
  vi.unstubAllGlobals()
  setFileStoreForTests(undefined)
  setBrowserProviderForTests(null)
})

const gmail: Connected = { google: ["gmail"], notion: false } as Connected
const none: Connected = { google: [], notion: false } as Connected
const tools = (userId: string, connected = gmail) =>
  createFileTools(
    { current: () => ({ id: "a1" }) as Agent, userId, threadId: "t1" },
    connected
  ) as unknown as Record<
    string,
    { execute: (i: unknown, o: unknown) => Promise<unknown> }
  >
const run = (userId: string, name: string, input: unknown) =>
  tools(userId)[name].execute(input, { toolCallId: "c1", messages: [] })

describe("file_list", () => {
  it("lists only the person's own files, filtered and capped", async () => {
    const { pg, userId } = await connectedUser([])
    const bob = await createUser(pg)
    const add = (user: string, name: string, origin: string) =>
      pg.query(
        `insert into kriya.files (user_id, name, mime, size_bytes, origin, status, sha256)
         values ($1, $2, 'application/pdf', 10, $3, 'ready', $4)`,
        [user, name, origin, "a".repeat(64)]
      )
    await add(userId, "rent_march.pdf", "upload")
    await add(userId, "rent-april.pdf", "email_attachment")
    await add(userId, "shot.png", "screenshot")
    await add(bob, "rent-bob.pdf", "upload")

    const all = (await run(userId, "file_list", { limit: 20 })) as {
      files: { name: string }[]
    }
    expect(all.files.map((f) => f.name).sort()).toEqual([
      "rent-april.pdf",
      "rent_march.pdf",
    ])
    expect(JSON.stringify(all)).not.toContain("bob")

    const byOrigin = (await run(userId, "file_list", {
      origin: "email_attachment",
      limit: 20,
    })) as { files: { name: string }[] }
    expect(byOrigin.files.map((f) => f.name)).toEqual(["rent-april.pdf"])

    // "_" is a literal underscore, not a wildcard
    const literal = (await run(userId, "file_list", { query: "rent_", limit: 20 })) as {
      files: { name: string }[]
    }
    expect(literal.files.map((f) => f.name)).toEqual(["rent_march.pdf"])

    const one = (await run(userId, "file_list", { limit: 1 })) as { files: unknown[] }
    expect(one.files).toHaveLength(1)
  })
})

describe("file_save_attachment", () => {
  it("gmail_read lists attachments by name, never their bytes", async () => {
    const { userId } = await connectedUser(["google"])
    serve([{ url: GMAIL, body: message }])
    const read = await gmailRead(userId, "M1")
    expect(read.attachments).toEqual([
      {
        attachmentId: "ATT1",
        name: "bill.pdf",
        mime: "application/pdf",
        sizeBytes: PDF.length,
      },
      {
        attachmentId: "ATT2",
        name: "archive.zip",
        mime: "application/zip",
        sizeBytes: 10,
      },
    ])
  })

  it("saves the attachment as the person's email_attachment file, verified", async () => {
    const { pg, userId } = await connectedUser(["google"])
    const calls = serve([
      { url: GMAIL, body: message },
      {
        url: /\/messages\/M1\/attachments\/ATT1$/,
        body: { data: PDF.toString("base64url") },
      },
    ])
    const out = (await run(userId, "file_save_attachment", {
      gmailMessageId: "M1",
      attachmentId: "ATT1",
    })) as { fileId: string }
    expect(out).toEqual({
      fileId: expect.any(String),
      name: "bill.pdf",
      verification: {
        status: "verified",
        method: "file",
        evidence: [{ kind: "file", value: out.fileId }],
      },
    })
    const { rows } = await pg.query(
      "select origin, status, user_id from kriya.files where id = $1",
      [out.fileId]
    )
    expect(rows).toEqual([
      { origin: "email_attachment", status: "ready", user_id: userId },
    ])
    expect([...objects.values()]).toEqual([PDF])
    expect(calls.every((c) => c.method === "GET")).toBe(true)
  })

  it("refuses an unknown id or an unaccepted type before downloading", async () => {
    const { userId } = await connectedUser(["google"])
    const calls = serve([
      { url: GMAIL, body: message },
      { url: GMAIL, body: message },
    ])
    await expect(
      run(userId, "file_save_attachment", { gmailMessageId: "M1", attachmentId: "NOPE" })
    ).rejects.toThrow(/no attachment with that id/)
    await expect(
      run(userId, "file_save_attachment", { gmailMessageId: "M1", attachmentId: "ATT2" })
    ).rejects.toThrow(/can't be saved/)
    expect(calls.some((c) => c.url.includes("/attachments/"))).toBe(false)
    expect(objects.size).toBe(0)
  })

  it("is offered only with Gmail connected", async () => {
    const { userId } = await connectedUser([])
    expect(Object.keys(tools(userId, none)).sort()).toEqual([
      "document_render",
      "file_list",
      "file_read",
    ])
    expect(tools(userId)).toHaveProperty("file_save_attachment")
  })
})

describe("document_render", () => {
  const letter = {
    from: { name: "Asha Rao" },
    to: { name: "Landlord" },
    date: "2026-10-22",
    subject: "Notice <b>to vacate</b>",
    body: ["I'll move out on 30 November."],
    signOff: "Regards",
  }

  it("renders the template to a PDF in the person's files", async () => {
    const { pg, userId } = await connectedUser([])
    const out = (await run(userId, "document_render", {
      template: "letter",
      data: letter,
      name: "notice",
    })) as { fileId: string }
    expect(out).toEqual({
      fileId: expect.any(String),
      name: "notice.pdf",
      pages: 2,
      verification: {
        status: "verified",
        method: "file",
        evidence: [{ kind: "file", value: out.fileId }],
      },
    })
    // Every value is escaped by the template
    expect(rendered[0]).toContain("Notice &lt;b&gt;to vacate&lt;/b&gt;")
    const { rows } = await pg.query(
      "select origin, mime, user_id from kriya.files where id = $1",
      [out.fileId]
    )
    expect(rows).toEqual([
      { origin: "generated", mime: "application/pdf", user_id: userId },
    ])
  })

  it("data that doesn't fit the template, or no renderer, is an error, not a file", async () => {
    const { userId } = await connectedUser([])
    expect(
      await run(userId, "document_render", {
        template: "invoice",
        data: letter,
        name: "x",
      })
    ).toMatchObject({ error: expect.stringMatching(/doesn't fit the invoice template/) })
    setBrowserProviderForTests(null)
    expect(
      await run(userId, "document_render", {
        template: "letter",
        data: letter,
        name: "x",
      })
    ).toMatchObject({ error: expect.stringMatching(/PDFs aren't available/) })
    expect(objects.size).toBe(0)
  })

  it("counts page objects, not the page tree", () => {
    expect(pdfPages(PDF)).toBe(2)
  })
})

describe("classes and capabilities", () => {
  it("file_list is R0; saving and rendering are R1 writes to the person's files", () => {
    expect(classifyTool("file_list", {})).toBe("R0")
    expect(classifyTool("file_save_attachment", {})).toBe("R1")
    expect(classifyTool("document_render", {})).toBe("R1")
    expect(TOOL_WRITES.file_list).toEqual([])
    expect(TOOL_WRITES.file_save_attachment).toEqual(["files+"])
    expect(TOOL_WRITES.document_render).toEqual(["files+"])
    for (const name of ["file_list", "file_save_attachment", "document_render"]) {
      expect(SIDE_EFFECT_TOOLS.has(name)).toBe(false)
      expect(CAPABILITIES[name].grantable).toBe(false)
    }
    expect(CAPABILITIES.file_save_attachment).toMatchObject({
      system: "google",
      verification: "file",
    })
    expect(CAPABILITIES.document_render).toMatchObject({
      system: "kriya",
      verification: "file",
    })
  })
})
