// The curated skill library: one directory per skill with SKILL.md (the
// instructions, Agent Skills format) and kriya.json (the manifest, validated
// by lib/skill-library.ts). Add a skill here when you add its directory;
// tests/agent/skill-library.test.ts checks the two match.

import browserWorkflow from "./browser-workflow/kriya.json"
import calendarOperations from "./calendar-operations/kriya.json"
import costAwareExecution from "./cost-aware-execution/kriya.json"
import debuggingRecovery from "./debugging-recovery/kriya.json"
import githubWorkflow from "./github-workflow/kriya.json"
import gstInvoices from "./gst-invoices/kriya.json"
import researchVerification from "./research-verification/kriya.json"
import securityUntrustedContent from "./security-untrusted-content/kriya.json"
import structuredData from "./structured-data/kriya.json"
import taskPlanning from "./task-planning/kriya.json"
import verificationBeforeCompletion from "./verification-before-completion/kriya.json"
import voiceFollowUp from "./voice-follow-up/kriya.json"
// next.skillsV2 (N8): these live outside skills/ so the library test that
// pairs skills/ directories with CATALOG stays as it is
import codeAssistance from "../skills-v2/code-assistance/kriya.json"
import creatorAnalytics from "../skills-v2/creator-analytics/kriya.json"
import deliveryProof from "../skills-v2/delivery-proof/kriya.json"
import documentsAndNotes from "../skills-v2/documents-and-notes/kriya.json"
import emailDrafting from "../skills-v2/email-drafting/kriya.json"
import indianDocumentsReading from "../skills-v2/indian-documents-reading/kriya.json"
import meetingPreparation from "../skills-v2/meeting-preparation/kriya.json"
import writingAndEditing from "../skills-v2/writing-and-editing/kriya.json"

export const SKILL_MANIFESTS: unknown[] = [
  browserWorkflow,
  calendarOperations,
  costAwareExecution,
  debuggingRecovery,
  githubWorkflow,
  gstInvoices,
  researchVerification,
  securityUntrustedContent,
  structuredData,
  taskPlanning,
  verificationBeforeCompletion,
  voiceFollowUp,
]

// Only used with next.skillsV2 on (lib/skill-library.ts CATALOG_V2)
export const SKILL_MANIFESTS_V2: unknown[] = [
  deliveryProof,
  indianDocumentsReading,
  // Added 2026-10-26 at the owner's request (status.md)
  emailDrafting,
  meetingPreparation,
  documentsAndNotes,
  writingAndEditing,
  codeAssistance,
  creatorAnalytics,
]
