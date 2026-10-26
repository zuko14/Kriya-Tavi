import type { Metadata } from "next"

import {
  AddServerForm,
  ApproveDriftButton,
  EditServerForm,
  PinToolForm,
  ServerStatusButton,
  ToolStatusButton,
} from "@/components/owner/apps-forms"
import { Empty, Section, Table, Td } from "@/components/owner/ui"
import { canonical } from "@/lib/agent/episodes"
import { requireOwner } from "@/lib/auth"
import { liveAsOwner } from "@/lib/mcp/live"
import { registry } from "@/lib/mcp/owner"
import { changedParts, definitionHash } from "@/lib/mcp/tools"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Apps" }

// The owner's registry of apps (N7, ND-06/07/12; UX_SPEC §4): servers, the
// tools pinned from each, and any tool whose definition changed since it was
// pinned, shown old and new side by side. Counts and statuses only: no tool
// input or output appears here (AT-OWN-A1). Read-only except the forms.

const TONE = {
  draft: "text-muted-foreground",
  active: "text-ok",
  suspended: "text-betelgeuse",
  retired: "text-faint",
  pinned: "text-ok",
  drifted: "text-destructive",
  disabled: "text-faint",
} as const

const READ_ERROR = {
  connect: "Sign in to this app yourself (Account → Apps) to see its new definition.",
  reconnect: "Your sign-in to this app stopped working. Reconnect it to compare.",
  unreachable: "The app didn't answer, so its new definition can't be shown now.",
} as const

const Chip = ({ status }: { status: keyof typeof TONE }) => (
  <span className={cn("font-mono text-[11px] tracking-wide uppercase", TONE[status])}>
    {status}
  </span>
)

// Keys in one order on both sides, so a difference is a difference of content
const json = (value: unknown) =>
  JSON.stringify(JSON.parse(canonical(value ?? null)), null, 2)

export default async function AppsPage() {
  const owner = await requireOwner()
  const servers = await registry()
  const drifted = servers.flatMap((server) =>
    server.tools
      .filter((tool) => tool.status === "drifted")
      .map((tool) => ({ server, tool }))
  )
  // One look per app that has a drifted tool, as the owner (never as a person)
  const lives = new Map(
    await Promise.all(
      [...new Set(drifted.map(({ server }) => server.id))].map(
        async (id) =>
          [
            id,
            await liveAsOwner(
              servers.find((s) => s.id === id)!,
              owner.id
            ),
          ] as const
      )
    )
  )

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[28px] leading-tight font-normal">Apps</h1>
        <p className="text-[13px] text-muted-foreground">
          Only tools you pin exist for an agent. A pinned tool is held to the exact
          definition you read; if the app changes it, it leaves every agent until you
          approve the new one. Switches are in Config (next.mcp).
        </p>
      </header>

      {drifted.length > 0 && (
        <Section
          title="Changed since you pinned them"
          description="These are off every agent until you approve the new definition."
        >
          <div className="flex flex-col gap-4">
            {drifted.map(({ server, tool }) => {
              const read = lives.get(server.id)
              const now = read && "live" in read ? read.live.get(tool.name) : undefined
              const nowHash = now ? definitionHash(now) : null
              return (
                <article
                  key={tool.kriyaName}
                  className="glass flex flex-col gap-3 rounded-[18px] p-4"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <h3 className="font-mono text-[13px] font-medium">
                      {tool.kriyaName}
                    </h3>
                    <span className="text-[12px] text-muted-foreground">
                      in {server.name}
                    </span>
                    {now && (
                      <span className="text-[12px] text-betelgeuse">
                        Changed:{" "}
                        {changedParts(tool.definition ?? {}, now).join(", ") || "—"}
                      </span>
                    )}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="label-mono">Pinned</span>
                      <pre className="max-h-80 overflow-auto rounded-lg border bg-surface/60 p-3 text-[11.5px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                        {json(tool.definition)}
                      </pre>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="label-mono">The app says now</span>
                      {now ? (
                        <pre className="max-h-80 overflow-auto rounded-lg border bg-surface/60 p-3 text-[11.5px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                          {json(now)}
                        </pre>
                      ) : (
                        <p className="rounded-lg border p-3 text-[12.5px] text-muted-foreground">
                          {read && "error" in read
                            ? READ_ERROR[read.error]
                            : "The app no longer lists this tool."}
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    Read the description for instructions aimed at a model, and check the
                    hints (read-only, destructive, open-world) before approving.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {nowHash && (
                      <ApproveDriftButton
                        serverId={server.id}
                        name={tool.name}
                        kriyaName={tool.kriyaName}
                        seenHash={nowHash}
                      />
                    )}
                    <ToolStatusButton
                      serverId={server.id}
                      name={tool.name}
                      kriyaName={tool.kriyaName}
                      status="disabled"
                    />
                  </div>
                </article>
              )
            })}
          </div>
        </Section>
      )}

      <Section
        title="Apps"
        description="Calls are the last 7 days across everyone; connections are people signed in."
      >
        {servers.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            No apps yet. Add the first one below.
          </p>
        )}
        {servers.map((server) => (
          <article
            key={server.id}
            className="glass flex flex-col gap-4 rounded-[18px] p-4"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-display text-[19px] font-normal">{server.name}</h3>
              <Chip status={server.status} />
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {server.id} · {new URL(server.url).hostname} · {server.auth}
              </span>
              <span className="ml-auto font-mono text-[11.5px] text-muted-foreground tabular-nums">
                {server.connections} connected · {server.calls} calls
              </span>
            </div>
            {server.review && (
              <p className="text-[12.5px] whitespace-pre-line text-muted-foreground">
                {server.review}
              </p>
            )}
            <Table head={["Kriya name", "risk", "repeatable", "read-back", "status", ""]}>
              {server.tools.length === 0 && <Empty colSpan={6}>No tools pinned.</Empty>}
              {server.tools.map((tool) => (
                <tr key={tool.kriyaName}>
                  <Td className="font-mono text-[11.5px]">
                    {tool.kriyaName}
                    {tool.category && (
                      <span className="ml-1 text-destructive">
                        ({tool.category}, never on a belt)
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono">{tool.ownerRisk}</Td>
                  <Td>{tool.idempotent ? "yes" : "—"}</Td>
                  <Td>{tool.readBack ? "yes" : "—"}</Td>
                  <Td>
                    <Chip status={tool.status} />
                  </Td>
                  <Td>
                    {tool.status === "disabled" ? (
                      <ToolStatusButton
                        serverId={server.id}
                        name={tool.name}
                        kriyaName={tool.kriyaName}
                        status="pinned"
                      />
                    ) : tool.status === "pinned" ? (
                      <ToolStatusButton
                        serverId={server.id}
                        name={tool.name}
                        kriyaName={tool.kriyaName}
                        status="disabled"
                      />
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="flex flex-wrap gap-3">
              {server.status === "draft" && (
                <ServerStatusButton
                  id={server.id}
                  appName={server.name}
                  status="active"
                  label="Make active"
                  variant="default"
                />
              )}
              {server.status === "active" && (
                <ServerStatusButton
                  id={server.id}
                  appName={server.name}
                  status="suspended"
                  label="Pause"
                />
              )}
              {server.status === "suspended" && (
                <ServerStatusButton
                  id={server.id}
                  appName={server.name}
                  status="active"
                  label="Resume"
                  variant="default"
                />
              )}
              {server.status !== "retired" && (
                <ServerStatusButton
                  id={server.id}
                  appName={server.name}
                  status="retired"
                  label="Retire"
                  variant="destructive"
                />
              )}
            </div>
            {server.status !== "retired" && (
              <>
                <details className="rounded-xl border bg-surface/60 px-4 py-2">
                  <summary className="min-h-11 cursor-pointer py-3 text-[13px]">
                    Pin a tool
                  </summary>
                  <div className="pb-3">
                    <PinToolForm serverId={server.id} />
                  </div>
                </details>
                <details className="rounded-xl border bg-surface/60 px-4 py-2">
                  <summary className="min-h-11 cursor-pointer py-3 text-[13px]">
                    Edit name, scopes and review notes
                  </summary>
                  <div className="pb-3">
                    <EditServerForm
                      id={server.id}
                      name={server.name}
                      scopes={server.scopes}
                      origins={server.allowedAuthOrigins}
                      review={server.review}
                    />
                  </div>
                </details>
              </>
            )}
          </article>
        ))}
      </Section>

      <Section
        title="Add an app"
        description="Starts as a draft: nobody sees it until you pin a tool and make it active."
      >
        <AddServerForm />
      </Section>
    </div>
  )
}
