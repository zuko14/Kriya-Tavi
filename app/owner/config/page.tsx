import type { Metadata } from "next"

import {
  AddModelForm,
  ModelToggle,
  PlanForm,
  SettingForm,
  SyncCatalogueButton,
} from "@/components/owner/forms"
import { Empty, Section, Table, Td } from "@/components/owner/ui"
import { requireOwner } from "@/lib/auth"
import { formatInr, formatUsd } from "@/lib/money"
import { VoicePriceForm } from "@/components/owner/voice-price-form"
import { configView, voicePriceSheet } from "@/lib/owner"

export const metadata: Metadata = { title: "Config" }

const GROUPS: { title: string; description: string; prefix: string[] }[] = [
  {
    title: "Model routing",
    description:
      "OpenRouter model ids per level. A level without a model falls back to the budget model. The fallback model is used once when a provider fails.",
    prefix: ["routing.", "agent."],
  },
  {
    title: "Currency and finance assumptions",
    description:
      "The USD→INR rate is never fetched or invented: enter it with its source. Infrastructure and fee figures only feed the contribution estimate.",
    prefix: ["fx.", "finance."],
  },
  {
    title: "Voice",
    description:
      "Once today's voice cost (reported + estimated) reaches the daily cap, no new call is placed. Until it's set, only the mock provider may dial.",
    prefix: ["voice."],
  },
  {
    title: "Agent features",
    description:
      "Track A switches. Each is off until set to on; off keeps agents exactly as before.",
    // skills.disabled and skills.pins: the skill library's kill switch and rollback
    prefix: ["agents.", "skills."],
  },
  {
    title: "Operator (jobs)",
    description:
      "Track O switches and limits. Jobs need agents.goals and agents.inbox on. The kill list removes tools from every agent from the next task on.",
    prefix: ["operator."],
  },
  { title: "Other", description: "", prefix: ["firecrawl.", "support."] },
]

const EVAL_TONE: Record<string, string> = {
  passed: "text-ok",
  failed: "text-destructive",
  untested: "text-muted-foreground",
}

export default async function OwnerConfig() {
  await requireOwner()
  const config = await configView()
  const prices = await voicePriceSheet()

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Config
        </h1>
        <p className="text-[13px] text-muted-foreground">
          Values saved here override the environment. Clearing a field returns to the
          environment value. Every change is audited.
        </p>
      </header>

      {GROUPS.map((group) => (
        <Section key={group.title} title={group.title} description={group.description}>
          <div className="divide-y rounded-xl border bg-surface/60 px-4">
            {config.settings
              .filter((setting) =>
                group.prefix.some((prefix) => setting.key.startsWith(prefix))
              )
              .map((setting) => (
                <SettingForm
                  key={setting.key}
                  settingKey={setting.key}
                  value={setting.value}
                  source={setting.source}
                  hint={setting.hint}
                  env={setting.env}
                />
              ))}
          </div>
        </Section>
      ))}

      <Section
        title="Model registry"
        description="Declared capabilities and prices come from OpenRouter's catalogue. 'Eval' is set only by npm run models:eval, which makes real tool-call and structured-output requests."
        aside={<SyncCatalogueButton />}
      >
        <AddModelForm />
        <Table
          head={["model", "tools", "json", "images", "in / M", "out / M", "eval", ""]}
        >
          {config.models.length === 0 && (
            <Empty colSpan={8}>No models yet. Add the ones your routing uses.</Empty>
          )}
          {config.models.map((model) => (
            <tr key={model.id}>
              <Td className="font-mono text-[11.5px]">
                {model.id}
                {!model.enabled && <span className="ml-1 text-faint">(disabled)</span>}
              </Td>
              <Td>{model.supportsTools ? "yes" : "—"}</Td>
              <Td>{model.supportsStructured ? "yes" : "—"}</Td>
              <Td>{model.supportsImages ? "yes" : "—"}</Td>
              <Td className="font-mono tabular-nums">
                {formatUsd(model.inputMicroUsdPerMtok)}
              </Td>
              <Td className="font-mono tabular-nums">
                {formatUsd(model.outputMicroUsdPerMtok)}
              </Td>
              <Td className={EVAL_TONE[model.evalStatus]}>
                <span title={model.evalNotes ?? undefined}>{model.evalStatus}</span>
              </Td>
              <Td>
                <ModelToggle id={model.id} enabled={model.enabled} />
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Voice prices"
        description="From written quotes only, each with its source. A component without a price stays unmetered (no estimate, never ₹0). Saving reprices estimated and unpriced voice charges; final ones never change."
      >
        <VoicePriceForm />
        <Table head={["id", "unit", "price", "from", "source", "checked"]}>
          {prices.length === 0 && (
            <Empty colSpan={6}>No prices yet: every voice cost is unmetered.</Empty>
          )}
          {prices.map((price) => (
            <tr key={price.id}>
              <Td className="font-mono text-[11.5px]">{price.id}</Td>
              <Td>{price.unit}</Td>
              <Td className="font-mono tabular-nums">
                {price.currency === "INR"
                  ? formatInr(price.priceMicro)
                  : formatUsd(price.priceMicro)}
              </Td>
              <Td>{price.effectiveFrom.toISOString().slice(0, 10)}</Td>
              <Td className="max-w-56 truncate">
                <span title={price.source}>{price.source}</span>
              </Td>
              <Td>{price.checkedAt.toISOString().slice(0, 10)}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="Plans"
        description="Prices, allowances and limits are enforced on the server as soon as you save. A paid plan needs a price before it can be made available."
      >
        <div className="flex flex-col gap-4">
          {config.plans.map((plan) => (
            <PlanForm key={plan.id} plan={plan} />
          ))}
        </div>
      </Section>
    </>
  )
}
