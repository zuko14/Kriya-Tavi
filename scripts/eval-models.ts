// Live checks of the things an agent needs from a model, through the same
// gateway the worker uses. Each check makes one short, cheap request.
//
//   OPENROUTER_API_KEY=... npm run models:eval -- deepseek/deepseek-v4-flash
//   (add DATABASE_URL to record the result in kriya.models)
//
// Checks: 1. calls a tool with valid arguments; 2. returns schema-valid
// structured output; 3. streams, and reports usage and cost (what billing
// depends on). A model is "passed" only if all three pass.

import { generateText, Output, streamText, tool } from "ai"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { privileged } from "@/db"
import { models } from "@/db/schema"
import { createGatewayModel, syncCatalogue, usageFromMetadata } from "@/lib/models"

type Check = { name: string; ok: boolean; detail: string }

async function check(name: string, run: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await run() }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function evaluate(modelId: string) {
  const model = createGatewayModel(modelId)
  const checks: Check[] = []

  checks.push(
    await check("tool call", async () => {
      const result = await generateText({
        model,
        maxRetries: 1,
        tools: {
          get_weather: tool({
            description: "Current weather for a city",
            inputSchema: z.object({ city: z.string() }),
          }),
        },
        toolChoice: "required",
        prompt: "What's the weather in Pune right now? Use the tool.",
      })
      const call = result.toolCalls[0]
      if (!call || call.toolName !== "get_weather") throw new Error("no get_weather call")
      const city = String((call.input as { city?: string }).city ?? "")
      if (!/pune/i.test(city)) throw new Error(`unexpected city: ${city}`)
      return `called get_weather(${city})`
    })
  )

  checks.push(
    await check("structured output", async () => {
      const { output } = await generateText({
        model,
        maxRetries: 1,
        output: Output.object({
          schema: z.object({
            city: z.string(),
            state: z.string(),
            population_millions: z.number(),
          }),
        }),
        prompt:
          "Give the city, state and approximate population in millions of Hyderabad, India.",
      })
      if (!/hyderabad/i.test(output.city))
        throw new Error(`unexpected: ${JSON.stringify(output)}`)
      return JSON.stringify(output)
    })
  )

  checks.push(
    await check("streaming usage and cost", async () => {
      let metadata: unknown
      let usage: { inputTokens?: number; outputTokens?: number } | undefined
      const result = streamText({
        model,
        maxRetries: 1,
        prompt: "Reply with the single word: namaste",
        onLanguageModelCallEnd: (call) => {
          metadata = call.providerMetadata
          usage = call.usage
        },
      })
      const text = await result.text
      const reported = usageFromMetadata(metadata)
      if (usage?.inputTokens == null || usage?.outputTokens == null) {
        throw new Error("no token usage in the stream")
      }
      if (reported?.costMicroUsd == null)
        throw new Error("no cost in the final usage chunk")
      return `"${text.trim().slice(0, 20)}" · ${usage.inputTokens}+${usage.outputTokens} tokens · ${reported.costMicroUsd} micro-USD`
    })
  )

  return checks
}

async function main() {
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  if (ids.length === 0) {
    console.error("Usage: npm run models:eval -- <openrouter-model-id> [...]")
    process.exit(1)
  }
  const record = !!process.env.DATABASE_URL
  if (record)
    await syncCatalogue(ids).catch((error) =>
      console.warn("catalogue sync:", error.message)
    )

  let failed = 0
  for (const id of ids) {
    const checks = await evaluate(id)
    const passed = checks.every((c) => c.ok)
    if (!passed) failed++
    console.log(`\n${passed ? "PASS" : "FAIL"}  ${id}`)
    for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
    if (record) {
      await privileged
        .update(models)
        .set({
          evalStatus: passed ? "passed" : "failed",
          evalNotes: checks
            .map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`)
            .join("\n")
            .slice(0, 2000),
          evaluatedAt: new Date(),
        })
        .where(eq(models.id, id))
    }
  }
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
