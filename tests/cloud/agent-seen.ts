// What runs through runTask showed the model, shared by the mocks in
// agent-mocks.ts. No imports: the "ai" mock reads this, and a module that
// imported "ai" here would wait on its own mock.
export const seen = {
  approvals: [] as unknown[],
  tools: [] as { run: string; names: string[] }[],
  prompts: [] as string[],
  web: [] as string[],
}

export function reset() {
  for (const list of Object.values(seen)) list.length = 0
}

export const aiMock = <T extends { streamText: (options: never) => unknown }>(
  actual: T
) => ({
  ...actual,
  streamText: ((options: { toolApproval?: unknown }) => {
    seen.approvals.push(options.toolApproval)
    return actual.streamText(options as never)
  }) as unknown as T["streamText"],
})
