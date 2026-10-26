import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"

// Shared fixtures for the N11 golden scenarios (EVALUATION_PLAN §2): the
// connectors Kriya talks to are faked at module level, as the operator golden
// jobs do, and everything else is real: the runner, approvals, the verifier,
// the episode and its delivery status, on PGlite. Each test file wires these
// into vi.mock with `await import("./mocks")` so one state is shared.

export type Readback = "verified" | "unverified" | "failed"

export const seen = {
  drafts: [] as { to: string[] }[],
  appends: [] as { range: string; rows: unknown[][] }[],
  sheets: [] as { title: string }[],
  events: [] as { title: string; attendees?: string[] }[],
  comments: [] as { repo: string; number: number; body: string }[],
  inbox: [] as { from: string; subject: string; snippet: string }[],
  web: [] as string[],
  tools: [] as string[][],
  prompts: [] as string[],
  warnings: [] as string[],
}
export const behave = {
  calendar: "verified" as Readback,
  comment: "verified" as Readback,
}

export function reset() {
  for (const list of Object.values(seen)) list.length = 0
  behave.calendar = behave.comment = "verified"
}

const readback = (status: Readback, id: string) => ({
  status,
  method: "api_readback" as const,
  evidence: [{ kind: "provider_id" as const, value: id }],
})

export const connectors = (real: Record<string, unknown>) => ({
  ...real,
  gmailDraft: async (_u: string, input: { to: string[] }) => {
    seen.drafts.push(input)
    const id = `d${seen.drafts.length}`
    return {
      draftId: id,
      link: "https://mail.google.com",
      verification: readback("verified", id),
    }
  },
  gmailSearch: async () => ({ messages: seen.inbox }),
  calendarCreate: async (_u: string, input: { title: string; attendees?: string[] }) => {
    seen.events.push(input)
    // A Google-shaped id (5 or more of [A-Za-z0-9_-])
    const id = `evt${seen.events.length}abc12345`
    // AS-DLV: a title's first letters pick how the read-back went
    const status: Readback = input.title.startsWith("U-")
      ? "unverified"
      : input.title.startsWith("F-")
        ? "failed"
        : behave.calendar
    return {
      eventId: id,
      link: "https://calendar.example/e",
      verification: readback(status, id),
    }
  },
})

export const sheetsConnector = (real: Record<string, unknown>) => ({
  ...real,
  sheetsAppend: async (_u: string, input: { range: string; rows: unknown[][] }) => {
    seen.appends.push(input)
    return {
      range: input.range,
      rows: input.rows.length,
      verification: readback("verified", input.range),
    }
  },
  sheetsCreate: async (_u: string, input: { title: string }) => {
    seen.sheets.push(input)
    return {
      spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvW",
      url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvW",
      verification: readback("verified", "1AbCdEfGhIjKlMnOpQrStUvW"),
    }
  },
})

export const githubConnector = (real: Record<string, unknown>) => ({
  ...real,
  githubComment: async (
    _u: string,
    input: { repo: string; number: number; body: string }
  ) => {
    seen.comments.push(input)
    return {
      ...input,
      commentId: 99,
      url: "https://github.example/c/99",
      verification: readback(behave.comment, "99"),
    }
  },
})

export const webMock = (real: Record<string, unknown>) => ({
  ...real,
  isWebConfigured: () => true,
  webFetch: async (url: string) => (
    seen.web.push(url),
    { url, title: "Page", markdown: "Some page." }
  ),
  webSearch: async (query: string) => (seen.web.push(query), { results: [] }),
})

// The scripted model: the test sets `model.script` in the operator harness
export const modelMock = (real: Record<string, unknown>) => ({
  ...real,
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        const { respond } = await import("../../operator/golden/harness")
        const prompt = JSON.stringify(options.prompt)
        seen.tools.push((options.tools ?? []).map((t) => t.name))
        const system = options.prompt.find((m) => m.role === "system")
        seen.prompts.push(system && "content" in system ? String(system.content) : "")
        return { stream: simulateReadableStream({ chunks: respond(prompt) as never[] }) }
      },
    }),
})

// The app registry's runner entry, with the sign-in step skipped: the fixture
// app is registered as an OAuth app and its tests (N6) cover the real sign-in
export const registryMock = (real: {
  loadMcp: (
    ...args: [
      { id: string; userId: string },
      string,
      { maxTools: number; disabled: Set<string>; authFor?: () => undefined },
    ]
  ) => Promise<unknown>
}) => ({
  ...real,
  loadMcp: (...[task, agent, options]: Parameters<typeof real.loadMcp>) =>
    real.loadMcp(task, agent, { ...options, authFor: () => undefined }),
})
