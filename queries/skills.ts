import { withUser } from "@/db"
import { connections, type Plan } from "@/db/schema"
import { browserProvider } from "@/lib/browser/session"
import { getSetting } from "@/lib/config"
import { EXTRA_GOOGLE_SERVICES, googleServices } from "@/lib/connectors"
import { isSecretsConfigured } from "@/lib/secrets"
import { skillRisk } from "@/lib/skill-engine"
import { CATALOG, parseSkillList } from "@/lib/skill-library"
import { voiceAvailable } from "@/lib/voice/tasks"
import { isWebConfigured } from "@/lib/web"

// The Creator's Skills section: every active library skill with what it
// needs and whether this person has it now. The tools mirror the switches
// and connections run-task.ts reads; the worker checks again on every task,
// so this is what the person sees, never what grants anything.
// shortcut: duplicates the belt's switch logic; move to a shared helper if
// the two drift (tests/agent/skill-options.test.ts pins the main cases).
async function availableTools(userId: string, plan: Plan) {
  const on = async (key: Parameters<typeof getSetting>[0]) =>
    (await getSetting(key)) === "on"
  const connectorsV2 = await on("agents.connectors")
  const accounts = isSecretsConfigured()
    ? await withUser(userId, (tx) =>
        tx
          .select({ provider: connections.provider, scopes: connections.scopes })
          .from(connections)
      )
    : []
  const google = googleServices(
    accounts.find((a) => a.provider === "google")?.scopes ?? []
  ).filter((service) => connectorsV2 || !EXTRA_GOOGLE_SERVICES.includes(service))
  const tools = new Set<string>()
  const add = (when: boolean, ...names: string[]) => {
    if (when) for (const name of names) tools.add(name)
  }
  add(isWebConfigured(), "web_search", "web_fetch")
  add(
    (await on("agents.browser")) && plan.browserMinutes > 0 && browserProvider() !== null,
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_scroll",
    "browser_handoff",
    "browser_close"
  )
  add(google.includes("calendar"), "calendar_events", "calendar_create_event")
  add(google.includes("sheets"), "sheets_read", "sheets_append", "sheets_update")
  add(
    connectorsV2 && accounts.some((a) => a.provider === "github"),
    "github_search",
    "github_read_issue",
    "github_read_pr"
  )
  add(await on("agents.files"), "file_read", "file_list")
  add(
    (await on("agents.ledger")) && plan.ledgerEnabled,
    "ledger_list",
    "ledger_draft_entry",
    "invoice_draft"
  )
  add(await voiceAvailable(userId), "propose_call")
  return tools
}

export async function skillOptions(userId: string, plan: Plan) {
  if ((await getSetting("agents.skillLibrary")) !== "on") return null
  const disabled = parseSkillList(await getSetting("skills.disabled"))
  const tools = await availableTools(userId, plan)
  return CATALOG.filter((s) => s.status === "active").map((s) => {
    const missing = s.tools.all.filter((t) => !tools.has(t))
    if (s.tools.any.length && !s.tools.any.some((t) => tools.has(t)))
      missing.push(s.tools.any.join(" or "))
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      required: s.required,
      roles: s.roles,
      source: s.source.length
        ? s.source.map((x) => `${x.project} ${x.version} (${x.license})`).join(", ")
        : "Kriya",
      tools: [...s.tools.all, ...s.tools.any, ...s.tools.uses],
      ...skillRisk(s),
      prerequisites: missing.length ? s.prerequisites : [],
      missing,
      offByKriya: disabled.has(s.id),
    }
  })
}

export type SkillOption = NonNullable<Awaited<ReturnType<typeof skillOptions>>>[number]
