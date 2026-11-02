import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"

import { seen } from "./agent-seen"

// Module-level fakes for runs through runTask (the next-platform golden
// pattern): each test file wires them into vi.mock with
// `await import("./agent-mocks")`, so one state is shared. The model is the
// operator harness's scripted model; the web is faked; nothing leaves.

export { aiMock, reset, seen } from "./agent-seen"

export const modelMock = (real: Record<string, unknown>) => ({
  ...real,
  isGatewayConfigured: () => true,
  createGatewayModel: (modelId: string) =>
    new MockLanguageModelV4({
      modelId,
      doStream: async (options) => {
        const { respond } = await import("../operator/golden/harness")
        const prompt = JSON.stringify(options.prompt)
        seen.tools.push({
          run: prompt.slice(prompt.lastIndexOf('"role":"user"')),
          names: (options.tools ?? []).map((t) => t.name),
        })
        const system = options.prompt.find((m) => m.role === "system")
        seen.prompts.push(system && "content" in system ? String(system.content) : "")
        return { stream: simulateReadableStream({ chunks: respond(prompt) as never[] }) }
      },
    }),
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
