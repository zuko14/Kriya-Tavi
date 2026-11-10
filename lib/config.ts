import { eq } from "drizzle-orm"

import { privileged } from "@/db"
import { platformSettings } from "@/db/schema"
import { log } from "@/lib/log"

// Platform configuration. Every setting is defined once here with its
// environment variable and default. The owner can override a setting from
// /owner/config; that value (kriya.platform_settings) wins over the
// environment, which wins over the default.
//
// Secrets are never settings: they come from the environment only and never
// leave the server. See SECRETS below.

type SettingDef = {
  env: string | null
  fallback?: string
  // Checked before an owner can save a value
  pattern?: RegExp
  hint?: string
}

const MODEL_ID = /^[a-z0-9-]+\/[A-Za-z0-9._:~-]+$/

export const SETTINGS = {
  // OpenRouter model ids for each routing tier
  "routing.budget": {
    env: "OPENROUTER_DEFAULT_MODEL",
    pattern: MODEL_ID,
    hint: "An OpenRouter model id, e.g. deepseek/deepseek-v4.1-flash-1017",
  },
  "routing.balanced": { env: "OPENROUTER_BALANCED_MODEL", pattern: MODEL_ID },
  "routing.escalation": { env: "OPENROUTER_ESCALATION_MODEL", pattern: MODEL_ID },
  // Used for a retry when a tier's model fails with a provider error
  "routing.fallback": { env: "OPENROUTER_FALLBACK_MODEL", pattern: MODEL_ID },
  // Tier for agents that don't choose one
  "routing.defaultTier": {
    env: "KRIYA_DEFAULT_TIER",
    fallback: "budget",
    pattern: /^(budget|balanced|escalation)$/,
  },
  // Hard ceiling over every plan's step limit
  "agent.maxSteps": { env: "KRIYA_MAX_STEPS", fallback: "60", pattern: /^\d{1,3}$/ },
  // INR per USD for converting provider costs. No default: Kriya never makes
  // up an exchange rate. Until it is set, charges are recorded as unpriced.
  "fx.usdInr": {
    env: "KRIYA_FX_USD_INR",
    pattern: /^\d{1,4}(\.\d{1,4})?$/,
    hint: "e.g. 84.2500",
  },
  // Where the rate came from, stored with every charge
  "fx.source": { env: "KRIYA_FX_SOURCE", hint: "e.g. RBI reference rate, 2026-10-15" },
  "firecrawl.apiUrl": {
    env: "FIRECRAWL_API_URL",
    fallback: "https://api.firecrawl.dev",
    pattern: /^https:\/\//,
  },
  // Shown to users who reach a limit
  "support.email": { env: "KRIYA_SUPPORT_EMAIL" },
  // Monthly hosting and services cost in rupees (Render, Supabase, Firecrawl…),
  // entered by the owner. Used only for contribution estimates in /owner.
  "finance.infraMonthlyInr": {
    env: "KRIYA_INFRA_MONTHLY_INR",
    pattern: /^\d{1,9}$/,
    hint: "Whole rupees per month, e.g. 4500",
  },
  // Payment processing fee in basis points of revenue, for estimates only
  "finance.paymentFeeBps": {
    env: "KRIYA_PAYMENT_FEE_BPS",
    pattern: /^\d{1,4}$/,
    hint: "Basis points, e.g. 236 for 2.36%",
  },
  // Voice (COST_AND_METERING §5): once today's voice cost (reported +
  // estimated) reaches this, no new call is claimed. Unset: no live calls
  "voice.dailySpendCapMicroInr": {
    env: "KRIYA_VOICE_DAILY_SPEND_CAP_MICRO_INR",
    pattern: /^\d{1,15}$/,
    hint: "Micro-rupees per day, e.g. 500000000 for ₹500",
  },
  // Live calls (D-12, AGENTS.md voice rule 5): a real provider dials only
  // while this is on and KRIYA_VOICE_LIVE=1 is set on the worker. Turning it
  // off stops new dials within the settings cache window (T-SEC-04)
  // The behaviour bundle new calls run on (voice phase 10, D-17): v1 in code
  // or a stored version the owner promoted. Setting it back is the rollback
  "voice.policyVersion": {
    env: null,
    fallback: "v1",
    pattern: /^v[0-9][a-z0-9.-]{0,38}$/,
    hint: "A policy version id, e.g. v1",
  },
  // Owner-only (no env), so it stays a second switch beside KRIYA_VOICE_LIVE
  "voice.liveCalls": {
    env: null,
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // D-19: drafts may carry a contact's number for Tavi to give the callee.
  // Off until counsel answers Q12 (docs/voice-assistant/UPGRADE_PROPOSAL.md)
  "voice.shareContact": {
    env: null,
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // D-21: languages calls may use, English first. Hindi and Telugu are draft
  // translations until a native speaker and counsel (Q4) review them
  "voice.languages": {
    env: null,
    fallback: "en-IN",
    pattern: /^en-IN(,(hi-IN|te-IN)){0,2}$/,
    hint: "en-IN, or en-IN,hi-IN,te-IN",
  },
  // Until phase 9 a real provider dials only these numbers (F25). Unset: none
  "voice.testNumbers": {
    env: "KRIYA_VOICE_TEST_NUMBERS",
    pattern: /^\+91[6-9]\d{9}(,\+91[6-9]\d{9}){0,9}$/,
    hint: "Comma-separated, e.g. +919876543210,+919812345678",
  },
  // Agent platform switches (docs/agent-platform). Each is off by default,
  // and off means existing agents get the same prompt and tools as before.
  // Memory v2: typed, shared and retrieved memory, thread summaries
  "agents.memoryV2": {
    env: "KRIYA_AGENTS_MEMORY_V2",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Model spend on summaries and memory consolidation, per person per day.
  // A platform cost, never charged to the person. 0 runs no such job.
  "agents.maintenanceCapMicroUsd": {
    env: "KRIYA_MAINTENANCE_CAP_MICRO_USD",
    fallback: "0",
    pattern: /^\d{1,9}$/,
    hint: "Micro-USD per person per day, e.g. 20000 for $0.02",
  },
  // Onboarding offers "Meet your team": the use case's role pack as a squad (A2)
  "agents.rolePacks": {
    env: "KRIYA_AGENTS_ROLE_PACKS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Agent browser tools (A4). Also needs the plan's browser minutes and
  // KRIYA_BROWSER_URL + KRIYA_BROWSER_SECRET on the worker.
  "agents.browser": {
    env: "KRIYA_AGENTS_BROWSER",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Inbox and "What I did" (A3): approvals indexed for the Inbox and expired
  // after agents.approvalTtlHours, records of verified actions after each task
  "agents.inbox": {
    env: "KRIYA_AGENTS_INBOX",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  "agents.approvalTtlHours": {
    env: "KRIYA_APPROVAL_TTL_HOURS",
    fallback: "72",
    pattern: /^\d{1,4}$/,
    hint: "Hours an approval waits before it counts as declined, e.g. 72",
  },
  // Goal and schedule tools (A3). Runs also need KRIYA_SCHEDULES_ENABLED=1
  // on the worker.
  "agents.goals": {
    env: "KRIYA_AGENTS_GOALS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // GitHub, Sheets, YouTube and Instagram tools and their Account options (A8)
  "agents.connectors": {
    env: "KRIYA_AGENTS_CONNECTORS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Google Sheets alone (its Account option and tools), without the rest of
  // agents.connectors. Needs the Sheets API on the Google client.
  "google.sheets": {
    env: "KRIYA_GOOGLE_SHEETS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The Undo window for reversible tools (K3): 10 minutes, run by the worker
  "agents.undo": {
    env: "KRIYA_AGENTS_UNDO",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Skills (A9): save, approve and replay procedures
  "agents.skills": {
    env: "KRIYA_AGENTS_SKILLS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Skill library (SKILLS_ENGINE.md): curated instruction packs per task and
  // the Creator's Skills section. Off: prompts and the Creator are unchanged
  "agents.skillLibrary": {
    env: "KRIYA_AGENTS_SKILL_LIBRARY",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Library skills switched off for everyone (empty: none)
  "skills.disabled": {
    env: "KRIYA_SKILLS_DISABLED",
    pattern: /^[a-z][a-z0-9-]{2,40}(,[a-z][a-z0-9-]{2,40}){0,49}$/,
    hint: "Comma-separated skill ids, e.g. browser-workflow,github-workflow",
  },
  // Roll a library skill back to an archived version for everyone
  "skills.pins": {
    env: "KRIYA_SKILLS_PINS",
    pattern:
      /^[a-z][a-z0-9-]{2,40}@\d{1,3}\.\d{1,3}\.\d{1,3}(,[a-z][a-z0-9-]{2,40}@\d{1,3}\.\d{1,3}\.\d{1,3}){0,49}$/,
    hint: "Comma-separated id@version, e.g. browser-workflow@1.0.0",
  },
  // Receipt cards and "Verify my records" (K1)
  "agents.receipts": {
    env: "KRIYA_AGENTS_RECEIPTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Files, generated PDFs and Kriya Share (A5, K8): uploads, extraction in
  // the worker, receipt PDFs and share links
  "agents.files": {
    env: "KRIYA_AGENTS_FILES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // A vision-capable model that reads PDFs and images; unset = they wait
  "agents.fileReaderModel": {
    env: "KRIYA_FILE_READER_MODEL",
    pattern: MODEL_ID,
    hint: "an OpenRouter model id that accepts images and PDFs",
  },
  // Accounts (A7): ledger entries, GST invoices with gapless numbers, CA
  // exports. Each plan also needs ledger_enabled in /owner (default off)
  "agents.ledger": {
    env: "KRIYA_AGENTS_LEDGER",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // K7 step 2: a cheap model checks cited, quote-less claims (never money)
  "agents.crossCheck": {
    env: "KRIYA_AGENTS_CROSS_CHECK",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  "agents.crossCheckModel": {
    env: "KRIYA_CROSS_CHECK_MODEL",
    pattern: MODEL_ID,
    hint: "a budget OpenRouter model, ideally another provider than the agents'",
  },
  // K5 watchers: schedule_create can watch a page; unchanged pages cost no
  // task or model call (fetches are metered)
  "agents.watchers": {
    env: "KRIYA_AGENTS_WATCHERS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // K4 Radar: obligations with their quotes; reminders in-app until voice
  "agents.radar": {
    env: "KRIYA_AGENTS_RADAR",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // K6 public facts commons: the fact job and facts_lookup
  "agents.facts": {
    env: "KRIYA_AGENTS_FACTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Governed improvement (A12, AD-25): tasks use the active or canary policy
  // bundle and are stamped with its version; off = the code baseline
  "agents.improvement": {
    env: "KRIYA_AGENTS_IMPROVEMENT",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Login profiles and take-over (A6, AD-05): Account → Logins, and tasks
  // use a saved sign-in. Also needs KRIYA_TOKEN_KEY and kriya-browser
  "agents.loginProfiles": {
    env: "KRIYA_AGENTS_LOGIN_PROFILES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Ready-to-apply kits (K9, AD-35): kit_prepare and kit_check
  "agents.kits": {
    env: "KRIYA_AGENTS_KITS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // ₹ quotes and caps (K2)
  "agents.quotes": {
    env: "KRIYA_AGENTS_QUOTES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Operator track (docs/operator). The owner's kill list: tools named here
  // leave every agent's belt from the next task on. Unset: none
  "operator.disabledTools": {
    env: "KRIYA_OPERATOR_DISABLED_TOOLS",
    pattern: /^[a-z_]{1,40}(,[a-z_]{1,40}){0,99}$/,
    hint: "Comma-separated tool names, e.g. instagram_publish,github_comment",
  },
  // O3: jobs (mandate_propose, mandate_status, the job card and pages).
  // Needs agents.goals and agents.inbox on too (OD-21)
  "operator.mandates": {
    env: "KRIYA_OPERATOR_MANDATES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // O4: a call that matches a job's standing grant runs without asking
  // (OD-02). Off: every call asks, as before
  "operator.grants": {
    env: "KRIYA_OPERATOR_GRANTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // O5: mandate_report, verdicts on the job page, the handover PDF
  "operator.reports": {
    env: "KRIYA_OPERATOR_REPORTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // O6: the worker's review pass: stuck, expired and completed jobs
  "operator.checkIns": {
    env: "KRIYA_OPERATOR_CHECK_INS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // O7: the "Hand Kriya a job" playbooks on Home (OD-09)
  "operator.playbooks": {
    env: "KRIYA_OPERATOR_PLAYBOOKS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // O11: crew_dispatch for a job's squad lead and the worker's crew pass
  // (OD-19). Off: no new crews; parts already queued finish as ordinary tasks
  "operator.crews": {
    env: "KRIYA_OPERATOR_CREWS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // G2: drive_import and drive_share (OD-15, OD-17). Sharing also needs the
  // person to tick "Drive sharing" when connecting Google
  "operator.driveShare": {
    env: "KRIYA_OPERATOR_DRIVE_SHARE",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // G2: gmail_send_draft sends a draft Kriya saved, after exact approval (OD-16)
  "operator.gmailSend": {
    env: "KRIYA_OPERATOR_GMAIL_SEND",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // calendar_delete_event deletes one event the person names, after exact approval
  "operator.calendarDelete": {
    env: "KRIYA_OPERATOR_CALENDAR_DELETE",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Next platform (track N)
  // N4: retries and a circuit breaker for reads that are safe to repeat (ND-05)
  "next.reliability": {
    env: "KRIYA_NEXT_RELIABILITY",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // N2: the delivery line on "What I did" (ND-03); needs agents.inbox
  "next.delivery": {
    env: "KRIYA_NEXT_DELIVERY",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // N3: one late re-check of runs that weren't confirmed (ND-04); needs
  // agents.inbox and next.delivery
  "next.recheck": {
    env: "KRIYA_NEXT_RECHECK",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // N6: Account → Apps and the connect flow (ND-09); needs next.mcp
  "next.mcpConnect": {
    env: "KRIYA_NEXT_MCP_CONNECT",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // N5: owner-pinned MCP tools on the belt (ND-06); needs agents.inbox
  "next.mcp": {
    env: "KRIYA_NEXT_MCP",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // N5: most MCP tools on one belt (ND-13)
  "next.mcpMaxTools": {
    env: "KRIYA_NEXT_MCP_MAX_TOOLS",
    fallback: "20",
    pattern: /^([1-9]|[1-3][0-9]|40)$/,
    hint: "1 to 40",
  },
  // N9: rerank recalled notes by meaning (ND-15); needs agents.memoryV2 and
  // next.embeddingModel. Confirmed notes go to the embedding provider (NB-05)
  "next.memoryRerank": {
    env: "KRIYA_NEXT_MEMORY_RERANK",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // N9: the OpenRouter embedding model; unset = no rerank, whatever the switch
  "next.embeddingModel": { env: "KRIYA_NEXT_EMBEDDING_MODEL", pattern: MODEL_ID },
  // N8: Unicode keyword matching and the v2 skills (ND-14); needs agents.skillLibrary
  "next.skillsV2": {
    env: "KRIYA_NEXT_SKILLS_V2",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Skill Studio (docs/next-platform/SKILL_STUDIO.md): people describe a skill
  // and Kriya designs it; they approve it before any agent uses it. Needs
  // agents.skillLibrary. Off: no page, and every prompt and catalogue as today
  "next.skillStudio": {
    env: "KRIYA_NEXT_SKILL_STUDIO",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The OpenRouter model that designs skills (owner's choice, 2026-10-30:
  // structured outputs, 1M context; checked in the OpenRouter catalogue)
  "next.skillStudioModel": {
    env: "KRIYA_NEXT_SKILL_STUDIO_MODEL",
    fallback: "deepseek/deepseek-v4.1-flash-1017",
    pattern: MODEL_ID,
    hint: "An OpenRouter model id with structured outputs",
  },
  // Skill designs per person per day (three model calls each)
  "next.skillStudioDaily": {
    env: "KRIYA_NEXT_SKILL_STUDIO_DAILY",
    fallback: "10",
    pattern: /^([1-9]|[1-9]\d)$/,
    hint: "1 to 99",
  },
  // N10: provider cache markers on the model routes proven to pass them through
  // (CACHE_VERIFIED in lib/next.ts, NRG-2). No route is proven yet, so this
  // changes nothing until one is (ND-16)
  "next.promptCache": {
    env: "KRIYA_NEXT_PROMPT_CACHE",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // G1: the Google app is in Testing, where Google expires refresh tokens
  // after 7 days; the Account card says so (OD-15). Display only
  "google.testingMode": {
    env: "KRIYA_GOOGLE_TESTING_MODE",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Active and needs-you jobs per person, checked on approval (OD-14)
  "operator.maxActive": {
    env: "KRIYA_OPERATOR_MAX_ACTIVE",
    fallback: "3",
    pattern: /^([1-9]|1[0-9]|20)$/,
    hint: "1 to 20",
  },
  // Cloud workspaces (track C, docs/cloud-execution, CD-23). Off means
  // existing agents get the same prompt, tools and approvals (CT-REG-01).
  // Also needs the plan's workspace minutes and a provider
  "cloud.workspaces": {
    env: "KRIYA_CLOUD_WORKSPACES",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Where sandboxes run; local only on the verify stack. none: no workspace
  "cloud.provider": {
    env: "KRIYA_CLOUD_PROVIDER",
    fallback: "none",
    pattern: /^(none|local|e2b|daytona|device|selfhosted)$/,
    hint: "none, local, e2b, daytona, device or selfhosted",
  },
  // The provider's template id for the runner image
  "cloud.image": {
    env: "KRIYA_CLOUD_IMAGE",
    pattern: /^[A-Za-z0-9._:/@-]{1,200}$/,
    hint: "The provider's template id, e.g. kriya-runner:1.0",
  },
  // CPUs and memory per sandbox, as kriya.workspaces.size
  "cloud.size": {
    env: "KRIYA_CLOUD_SIZE",
    fallback: "2c-4g",
    pattern: /^[1-8]c-[1-9][0-9]?g$/,
    hint: "e.g. 2c-4g",
  },
  // registries: package registries only (CD-12); offline: no network
  "cloud.network": {
    env: "KRIYA_CLOUD_NETWORK",
    fallback: "registries",
    pattern: /^(registries|offline)$/,
    hint: "registries or offline",
  },
  // One workspace_run command, at most
  "cloud.commandTimeoutSeconds": {
    env: "KRIYA_CLOUD_COMMAND_TIMEOUT_SECONDS",
    fallback: "600",
    pattern: /^([1-9]\d{0,2}|1[0-7]\d\d|1800)$/,
    hint: "1 to 1800",
  },
  // Sandboxes running at once across the platform (open_workspace_session)
  "cloud.maxRunning": {
    env: "KRIYA_CLOUD_MAX_RUNNING",
    fallback: "3",
    pattern: /^([1-9]|[1-9]\d)$/,
    hint: "1 to 99",
  },
  // A paused sandbox is destroyed after this (after a checkpoint)
  "cloud.pausedHours": {
    env: "KRIYA_CLOUD_PAUSED_HOURS",
    fallback: "24",
    pattern: /^([1-9]|[1-9]\d|1[0-5]\d|16[0-8])$/,
    hint: "1 to 168",
  },
  // An unused workspace is closed after this
  "cloud.retentionDays": {
    env: "KRIYA_CLOUD_RETENTION_DAYS",
    fallback: "14",
    pattern: /^([1-9]|[1-8]\d|90)$/,
    hint: "1 to 90",
  },
  // A session without a heartbeat for this long is an orphan
  "cloud.orphanSeconds": {
    env: "KRIYA_CLOUD_ORPHAN_SECONDS",
    fallback: "120",
    pattern: /^([3-9]\d|[1-9]\d{2}|[12]\d{3}|3[0-5]\d\d|3600)$/,
    hint: "30 to 3600",
  },
  // Largest repository archive imported into a workspace
  "cloud.maxImportMb": {
    env: "KRIYA_CLOUD_MAX_IMPORT_MB",
    fallback: "200",
    pattern: /^([1-9]\d{0,2}|1000)$/,
    hint: "1 to 1000",
  },
  // Largest checkpoint patch stored
  "cloud.maxCheckpointMb": {
    env: "KRIYA_CLOUD_MAX_CHECKPOINT_MB",
    fallback: "50",
    pattern: /^([1-9]\d{0,2}|1000)$/,
    hint: "1 to 1000",
  },
  // The provider's price for the configured size, in micro-USD per hour,
  // entered by the owner from the provider's price page. No default: Kriya
  // never makes up a price; until set, workspace_seconds rows are unpriced
  "cloud.costMicroUsdPerHour": {
    env: "KRIYA_CLOUD_COST_MICRO_USD_PER_HOUR",
    pattern: /^[1-9]\d{0,9}$/,
    hint: "Integer micro-USD per hour, e.g. 180000 for $0.18",
  },
  // workspace_publish: a draft pull request after the person approves the
  // exact change set (CD-10). Needs cloud.workspaces
  "cloud.publish": {
    env: "KRIYA_CLOUD_PUBLISH",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Self-hosted execution fabric (track C extension, CD-28…CD-37,
  // docs/cloud-execution/SELF_HOSTED_ARCHITECTURE.md): machines Kriya runs
  // (kriya-node) as cloud.provider = selfhosted. Nothing here takes effect
  // until cloud.provider is selfhosted; empty lists mean no node and nobody.
  // The nodes: id=https://address, comma-separated (http only on loopback)
  "selfhosted.nodes": {
    env: "KRIYA_SELFHOSTED_NODES",
    fallback: "",
    pattern:
      /^$|^[a-z0-9][a-z0-9-]{0,31}=https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(,[a-z0-9][a-z0-9-]{0,31}=https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?){0,15}$/,
    hint: "e.g. kvm4-1=https://node1.example.com",
  },
  // Who may run on them: user ids, comma-separated, or * for everyone
  "selfhosted.users": {
    env: "KRIYA_SELFHOSTED_USERS",
    fallback: "",
    pattern: /^$|^\*$|^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,199}$/,
    hint: "user ids, comma-separated, or *",
  },
  // Kill switch: on holds every new sandbox start; running ones carry on
  "selfhosted.holdAdmissions": {
    env: "KRIYA_SELFHOSTED_HOLD_ADMISSIONS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Nodes taking no new sandboxes; their paused ones are checkpointed away
  "selfhosted.drain": {
    env: "KRIYA_SELFHOSTED_DRAIN",
    fallback: "",
    pattern: /^$|^[a-z0-9][a-z0-9-]{0,31}(,[a-z0-9][a-z0-9-]{0,31}){0,15}$/,
    hint: "node ids, comma-separated",
  },
  // gvisor: sandboxes only on nodes that proved runsc (CD-30). trusted-runc
  // also uses plain containers, which share the host kernel: only for
  // workloads the owner trusts, never people's code
  "selfhosted.isolation": {
    env: "KRIYA_SELFHOSTED_ISOLATION",
    fallback: "gvisor",
    pattern: /^(gvisor|trusted-runc)$/,
    hint: "gvisor or trusted-runc",
  },
  // How long a workspace start waits for capacity before "busy"
  "selfhosted.maxWaitSeconds": {
    env: "KRIYA_SELFHOSTED_MAX_WAIT_SECONDS",
    fallback: "60",
    pattern: /^([5-9]|[1-9]\d|[1-5]\d\d|600)$/,
    hint: "5 to 600",
  },
  // Sandboxes one person runs at once on the fabric
  "selfhosted.maxPerUser": {
    env: "KRIYA_SELFHOSTED_MAX_PER_USER",
    fallback: "1",
    pattern: /^([1-9]|10)$/,
    hint: "1 to 10",
  },
  // Waiting starts across the fabric; more are refused as busy
  "selfhosted.maxQueued": {
    env: "KRIYA_SELFHOSTED_MAX_QUEUED",
    fallback: "50",
    pattern: /^([1-9]|[1-9]\d|[1-4]\d\d|500)$/,
    hint: "1 to 500",
  },
  // CPU reserved may reach this share of a node's CPUs (memory never
  // exceeds 100%)
  "selfhosted.cpuOvercommitPct": {
    env: "KRIYA_SELFHOSTED_CPU_OVERCOMMIT_PCT",
    fallback: "150",
    pattern: /^(1\d\d|[23]\d\d|400)$/,
    hint: "100 to 400",
  },
  // Disk each sandbox may use
  "selfhosted.diskGb": {
    env: "KRIYA_SELFHOSTED_DISK_GB",
    fallback: "10",
    pattern: /^([1-9]|[1-9]\d|1\d\d|200)$/,
    hint: "1 to 200",
  },
  // A sandbox without traffic this long is stopped by its node
  "selfhosted.idleMinutes": {
    env: "KRIYA_SELFHOSTED_IDLE_MINUTES",
    fallback: "15",
    pattern: /^([5-9]|[1-9]\d|[1-9]\d\d|1[0-3]\d\d|14[0-3]\d|1440)$/,
    hint: "5 to 1440",
  },
  // A start waiting this long goes first, and nothing jumps ahead of it
  "selfhosted.starvationSeconds": {
    env: "KRIYA_SELFHOSTED_STARVATION_SECONDS",
    fallback: "120",
    pattern: /^([1-9]\d|[1-9]\d\d|[1-2]\d{3}|3[0-5]\d\d|3600)$/,
    hint: "10 to 3600",
  },
  // Kriya Harness (track H, docs/kriya-harness, HD-18). Off means every
  // harness route answers 404 and nothing else changes (HT-REG-01). Each
  // plan also needs a harness_monthly_micro_inr cap above 0 (HD-07)
  "harness.api": {
    env: "KRIYA_HARNESS_API",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The model gateway for signed-in devices; needs harness.api
  "harness.gateway": {
    env: "KRIYA_HARNESS_GATEWAY",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Kriya default skills (skills-harness/) served to every device's agent
  // (WORKSPACE_PANEL_SKILLS_PLUGINS.md §4); the person can switch each off
  "harness.defaultSkills": {
    env: "KRIYA_HARNESS_DEFAULT_SKILLS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Device sessions mirrored into threads (each device opts in too)
  "harness.mirror": {
    env: "KRIYA_HARNESS_MIRROR",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Laptop ↔ cloud workspace handoff; needs cloud.workspaces
  "harness.handoff": {
    env: "KRIYA_HARNESS_HANDOFF",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Older clients are refused with an upgrade message
  "harness.minClientVersion": {
    env: "KRIYA_HARNESS_MIN_CLIENT_VERSION",
    fallback: "0.0.0",
    pattern: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    hint: "e.g. 0.1.0",
  },
  // A device unused this long is signed out
  "harness.deviceIdleDays": {
    env: "KRIYA_HARNESS_DEVICE_IDLE_DAYS",
    fallback: "90",
    pattern: /^([1-9]|[1-9]\d|[12]\d\d|3[0-5]\d|36[0-5])$/,
    hint: "1 to 365",
  },
  // An unanswered approval from a device expires (the device fails closed)
  "harness.approvalTtlMinutes": {
    env: "KRIYA_HARNESS_APPROVAL_TTL_MINUTES",
    fallback: "30",
    pattern: /^([1-9]|[1-9]\d|1[01]\d|120)$/,
    hint: "1 to 120",
  },
  // Gateway requests per minute per device
  "harness.rpm": {
    env: "KRIYA_HARNESS_RPM",
    fallback: "60",
    pattern: /^([1-9]|[1-9]\d|[1-5]\d\d|600)$/,
    hint: "1 to 600",
  },
  // H10, HD-12: a person's own machine (`kriya serve`) as the execution
  // world of cloud workspaces, through kriya-relay; cloud.provider = device
  "harness.deviceWorld": {
    env: "KRIYA_HARNESS_DEVICE_WORLD",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The Control Center (CONTROL_CENTER.md): from /harness the person queues
  // tasks, health checks, rule decisions, handoffs and serve for their own
  // computer, which runs them through `kriya daemon`; kriya processes report
  // what they run. Off: the page and every route are exactly as before
  "harness.controlCenter": {
    env: "KRIYA_HARNESS_CONTROL_CENTER",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Remote Control (REMOTE_CONTROL.md): the switch in Kriya Harness streams a
  // session to /harness and listens for the Control Center without a command.
  // Off: POST /live answers 404 and /harness is as before
  "harness.remoteControl": {
    env: "KRIYA_HARNESS_REMOTE_CONTROL",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off; the Control Center also needs harness.controlCenter",
  },
  // Beta until the owner's gates pass (HD-02: H9's gates, the H12 pilot and
  // a stable, audited DeepSeek Harness line); "ga" drops the Beta label
  // Harness upgrade U9 (owner, 2026-11-04: "raising the reasoning output
  // limits"): the most output one gateway answer may ask for, reasoning
  // included; never above the model's own max_output_tokens. Each request
  // reserves its upper cost at this cap (HD-16 open item, now settled)
  "harness.maxOutputTokens": {
    env: "KRIYA_HARNESS_MAX_OUTPUT_TOKENS",
    fallback: "65536",
    // Digits only here; lib/harness/model-limits.ts keeps it within 1,024–262,144
    pattern: /^[1-9]\d{3,5}$/,
    hint: "1,024 to 262,144 tokens per answer (reasoning included)",
  },
  // Flows (track S, docs/kriya-studio/): off means no entry, no routes, no pass
  "studio.flows": {
    env: "KRIYA_STUDIO_FLOWS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The describe box: one capped model call a time, previewed before use
  "studio.copilot": {
    env: "KRIYA_STUDIO_COPILOT",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off; needs studio.flows",
  },
  // Flows for the person's computer; needs harness.controlCenter
  "studio.deviceFlows": {
    env: "KRIYA_STUDIO_DEVICE_FLOWS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off; needs studio.flows and harness.controlCenter",
  },
  // The validator refuses a flow whose worst case passes this (SD-05)
  "studio.maxNodeRuns": {
    env: "KRIYA_STUDIO_MAX_NODE_RUNS",
    fallback: "40",
    pattern: /^[1-9][0-9]{0,2}$/,
    hint: "agent runs at most, 1 to 999",
  },
  "studio.maxConcurrentNodes": {
    env: "KRIYA_STUDIO_MAX_CONCURRENT_NODES",
    fallback: "4",
    pattern: /^[1-9][0-9]?$/,
    hint: "agents at once per run, 1 to 99",
  },
  "studio.dailyRuns": {
    env: "KRIYA_STUDIO_DAILY_RUNS",
    fallback: "50",
    pattern: /^[1-9][0-9]{0,3}$/,
    hint: "runs per person per day",
  },
  "studio.copilotDaily": {
    env: "KRIYA_STUDIO_COPILOT_DAILY",
    fallback: "20",
    pattern: /^[1-9][0-9]{0,2}$/,
    hint: "designs per person per day",
  },
  "harness.releaseStage": {
    env: "KRIYA_HARNESS_RELEASE_STAGE",
    fallback: "beta",
    pattern: /^(beta|ga)$/,
    hint: "beta or ga (only once the HD-02 gates pass)",
  },
  // The install line on the Kriya Harness page. Empty until the client is
  // published (HQ-03), so the page never offers an install that doesn't exist
  "harness.installCommand": {
    env: "KRIYA_HARNESS_INSTALL_COMMAND",
    pattern: /^(npm|npx|pnpm|brew) [A-Za-z0-9@/._:=+ -]{1,120}$/,
    hint: "e.g. npm install -g @kriya-ai/harness",
  },
  // Editing Studio (track E, docs/kriya-harness/kriya_video_editing). Off: the
  // manifest route answers 404, which is how a client learns editing isn't here
  "editing.studio": {
    env: "KRIYA_EDITING_STUDIO",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Which approved Media Runtime is served (lib/editing/manifest.ts)
  "editing.runtimeChannel": {
    env: "KRIYA_EDITING_RUNTIME_CHANNEL",
    fallback: "stable",
    pattern: /^(stable|beta)$/,
    hint: "stable or beta",
  },
  // Contact sheets may go to the Director's model, and then only with the
  // project's own consent, asked once (EDD-14). Off: no frame leaves the computer
  "editing.frameVision": {
    env: "KRIYA_EDITING_FRAME_VISION",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Model-written motion compositions (EDD-44), only inside the OS sandbox and
  // after lint. Off: only Kriya's own blocks and captions render
  "editing.customMotion": {
    env: "KRIYA_EDITING_CUSTOM_MOTION",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The kriya-edit-* skills (skills-harness/, SKILLS_AND_OPEN_SOURCE §4) go to
  // devices with the default skills. Off: harness.defaultSkills serves as before
  "editing.skills": {
    env: "KRIYA_EDITING_SKILLS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The Director's playbooks (EDD-56, DIRECTOR_PLAYBOOKS.md): the plan names the
  // video's genre and follows its rules. Off: the same plan, prompt and schema
  "editing.playbooks": {
    env: "KRIYA_EDITING_PLAYBOOKS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Licensed pictures and cited definitions from the internet (EDD-52, EDD-57). Off:
  // no search words leave a computer
  "editing.mediaSearch": {
    env: "KRIYA_EDITING_MEDIA_SEARCH",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // A stock narrator and generated images (EDD-24). Never synthetic people or
  // cloned voices; off: no generative tool exists
  "editing.generative": {
    env: "KRIYA_EDITING_GENERATIVE",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Animated explainer scenes the Director proposes on the Plan Card (EDD-51,
  // docs/kriya-harness/kriya_video_editing/VISUAL_SCENES.md). Off: the same plan,
  // the same prompt, no extra model call, and a make drops any scene it's sent
  "editing.visuals": {
    env: "KRIYA_EDITING_VISUALS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // The motion kit: titles, lower thirds, intro and end cards the Director proposes
  // and chat can add, drawn by Kriya's code (EDD-58,
  // docs/kriya-harness/kriya_video_editing/MOTION_GRAPHICS.md). Off: the same plan,
  // prompt and console, no extra model call, and a make drops any graphic it's sent
  "editing.motion": {
    env: "KRIYA_EDITING_MOTION",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Importing a reference from a link (EDD-22, owner-gated, counsel first).
  // Off: a person drops a file they already have
  "editing.urlImport": {
    env: "KRIYA_EDITING_URL_IMPORT",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Tavi reaches a computer (ED14, EDD-28): the video_edit_* tools, dispatch kind
  // edit and editLoop. Off: agents get the same tools and nothing can queue an edit
  "editing.tavi": {
    env: "KRIYA_EDITING_TAVI",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Previews may be uploaded to the bucket kriya-edit-previews (EDD-46)
  "editing.previews": {
    env: "KRIYA_EDITING_PREVIEWS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // 45 MiB: under the platform's 50 MiB object limit (EH-23)
  "editing.previewMaxBytes": {
    env: "KRIYA_EDITING_PREVIEW_MAX_BYTES",
    fallback: "47185920",
    pattern: /^[1-9][0-9]{0,8}$/,
    hint: "bytes per file, e.g. 47185920",
  },
  "editing.previewDays": {
    env: "KRIYA_EDITING_PREVIEW_DAYS",
    fallback: "14",
    pattern: /^[1-9][0-9]{0,2}$/,
    hint: "days a preview is kept, e.g. 14",
  },
  // Jobs from Tavi per person per day
  "editing.dailyJobs": {
    env: "KRIYA_EDITING_DAILY_JOBS",
    fallback: "20",
    pattern: /^[1-9][0-9]{0,3}$/,
    hint: "jobs a day, e.g. 20",
  },
  // A running job the computer has said nothing about for this long is lost
  "editing.jobLostMinutes": {
    env: "KRIYA_EDITING_JOB_LOST_MINUTES",
    fallback: "30",
    pattern: /^[1-9][0-9]{0,3}$/,
    hint: "minutes, e.g. 30",
  },
  // The Review Room, decision cards and notes (ED15). Off: no card, no note, and a job's
  // own questions take their default at once
  "editing.review": {
    env: "KRIYA_EDITING_REVIEW",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // New-recording cards (ED15, EDD-47). Also off per folder, on the computer. Only a name
  // and a duration leave it, and nothing runs until the person taps
  "editing.watchFolders": {
    env: "KRIYA_EDITING_WATCH_FOLDERS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Rooms (track R, docs/rooms, RD-19). Off means no room page, route or
  // query exists for anyone and agents are unchanged (RT-REG-01)
  "rooms.enabled": {
    env: "KRIYA_ROOMS_ENABLED",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // People's agents in rooms; needs rooms.enabled
  "rooms.agents": {
    env: "KRIYA_ROOMS_AGENTS",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // Supabase Realtime pings for new messages; off → polling only (RD-10).
  // Off by default (track A rule 2), until the owner turns Realtime's public
  // access off in Supabase (RB-03)
  "rooms.realtime": {
    env: "KRIYA_ROOMS_REALTIME",
    fallback: "off",
    pattern: /^(on|off)$/,
    hint: "on or off",
  },
  // People in one room
  "rooms.maxHumans": {
    env: "KRIYA_ROOMS_MAX_HUMANS",
    fallback: "25",
    pattern: /^([2-9]|1\d|2[0-5])$/,
    hint: "2 to 25",
  },
  // Agents in one room
  "rooms.maxAgents": {
    env: "KRIYA_ROOMS_MAX_AGENTS",
    fallback: "10",
    pattern: /^([1-9]|10)$/,
    hint: "1 to 10",
  },
  // Active rooms one person may belong to
  "rooms.maxPerPerson": {
    env: "KRIYA_ROOMS_MAX_PER_PERSON",
    fallback: "20",
    pattern: /^([1-9]|[1-9]\d|100)$/,
    hint: "1 to 100",
  },
  // Days an invite link works (the table allows at most 7)
  "rooms.inviteDays": {
    env: "KRIYA_ROOMS_INVITE_DAYS",
    fallback: "7",
    pattern: /^[1-7]$/,
    hint: "1 to 7",
  },
  // Agent-to-agent turns one person's message may set off (the conductor)
  "rooms.agentTurnBudget": {
    env: "KRIYA_ROOMS_AGENT_TURN_BUDGET",
    fallback: "4",
    pattern: /^([1-9]|10)$/,
    hint: "1 to 10",
  },
  // Recent room messages an agent is given as context
  "rooms.contextMessages": {
    env: "KRIYA_ROOMS_CONTEXT_MESSAGES",
    fallback: "30",
    pattern: /^([5-9]|[1-9]\d|100)$/,
    hint: "5 to 100",
  },
} satisfies Record<string, SettingDef>

export type SettingKey = keyof typeof SETTINGS

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS
}

const CACHE_MS = 15_000
// An expired copy still answers this long while a refresh fails (a busy
// pool), instead of failing every page; after a Save there's no copy
const STALE_MS = 5 * 60_000
const globalForSettings = globalThis as unknown as {
  __kriyaSettings?: { at: number; values: Map<string, string> }
  __kriyaSettingsLoad?: Promise<Map<string, string>>
  // Bumped by every Save, so a load that started before it can't cache
  __kriyaSettingsGen?: number
}

async function stored() {
  const cache = globalForSettings.__kriyaSettings
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.values
  // One query however many getSetting calls miss at once: a page asks for
  // a dozen settings in parallel, and each query would hold a connection
  const gen = globalForSettings.__kriyaSettingsGen ?? 0
  const load = (globalForSettings.__kriyaSettingsLoad ??= privileged
    .select()
    .from(platformSettings)
    .then((rows) => {
      const values = new Map(rows.map((row) => [row.key, row.value]))
      if ((globalForSettings.__kriyaSettingsGen ?? 0) === gen)
        globalForSettings.__kriyaSettings = { at: Date.now(), values }
      return values
    })
    .finally(() => {
      if (globalForSettings.__kriyaSettingsLoad === load)
        globalForSettings.__kriyaSettingsLoad = undefined
    }))
  try {
    return await load
  } catch (error) {
    if (cache && Date.now() - cache.at < STALE_MS) {
      log.warn("settings refresh failed; using the last copy", {
        error: error instanceof Error ? error.message : String(error),
      })
      return cache.values
    }
    throw error
  }
}

function envValue(key: SettingKey) {
  const def: SettingDef = SETTINGS[key]
  return (def.env && process.env[def.env]?.trim()) || undefined
}

export async function getSetting(key: SettingKey): Promise<string | undefined> {
  const def: SettingDef = SETTINGS[key]
  return (await stored()).get(key) || envValue(key) || def.fallback
}

export type SettingSource = "owner" | "env" | "default" | null

export async function describeSetting(key: SettingKey) {
  const def: SettingDef = SETTINGS[key]
  const saved = (await stored()).get(key)
  const env = envValue(key)
  const source: SettingSource = saved
    ? "owner"
    : env
      ? "env"
      : def.fallback
        ? "default"
        : null
  return {
    key,
    env: def.env,
    source,
    value: saved || env || def.fallback || null,
    hint: def.hint ?? null,
  }
}

export type SettingView = Awaited<ReturnType<typeof describeSetting>>

// Validates and saves (null or "" removes the override). Callers must have
// checked that the actor is an owner.
// actorId null: the system (an automatic voice policy rollback)
export async function setSetting(
  key: SettingKey,
  value: string | null,
  actorId: string | null
) {
  const def: SettingDef = SETTINGS[key]
  const trimmed = value?.trim()
  if (!trimmed) {
    await privileged.delete(platformSettings).where(eq(platformSettings.key, key))
  } else {
    if (def.pattern && !def.pattern.test(trimmed)) {
      throw new Error(`${key}: ${def.hint ?? "invalid value"}`)
    }
    await privileged
      .insert(platformSettings)
      .values({ key, value: trimmed, updatedBy: actorId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: trimmed, updatedBy: actorId, updatedAt: new Date() },
      })
  }
  globalForSettings.__kriyaSettings = undefined
  globalForSettings.__kriyaSettingsLoad = undefined
  globalForSettings.__kriyaSettingsGen = (globalForSettings.__kriyaSettingsGen ?? 0) + 1
}

export async function getMaxSteps() {
  const value = Number.parseInt((await getSetting("agent.maxSteps")) ?? "", 10)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : 60
}

/* ───────────────────────────── secrets ──────────────────────────── */

// Environment-only. Reported to the owner as present or missing, never shown.
export const SECRETS = [
  "DATABASE_URL",
  "SUPABASE_SECRET_KEY",
  "OPENROUTER_API_KEY",
  "FIRECRAWL_API_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "KRIYA_TOKEN_KEY",
  // Only during a key rotation (runbooks/key-rotation.md)
  "KRIYA_TOKEN_KEY_PREVIOUS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "KRIYA_BROWSER_SECRET",
  // A8 connectors (AB-06: the owner creates the apps)
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  // Voice (phase 3): HMAC key for recipient number hashes (limits, opt-outs)
  "KRIYA_PHONE_HASH_KEY",
  // Cloud workspaces (track C, CD-09): signs each workspace's runner token
  "KRIYA_WORKSPACE_SECRET",
  // C8: the sandbox providers in the bake-off (CD-07); the one not chosen is
  // removed when the result is recorded
  "E2B_API_KEY",
  "DAYTONA_API_KEY",
  // H10, HD-12: the worker's key to kriya-relay (32+ random characters)
  "KRIYA_RELAY_SECRET",
  // CD-36: each kriya-node's key is derived from this (32+ random characters)
  "KRIYA_NODE_SECRET",
] as const

export type SecretName = (typeof SECRETS)[number]

export function getSecret(name: SecretName) {
  return process.env[name]?.trim() || undefined
}

export function secretStatus() {
  return SECRETS.map((name) => ({ name, set: !!getSecret(name) }))
}
