// Kriya Radar obligation templates (K4, AD-30). A template says what kind
// of deadline a role usually has and where to look for it. It never holds
// a date: dates come only from a source read at run time, with its quote
// (AT-RAD-03 checks this file has none).

export type ObligationTemplate = {
  kind: string
  label: string
  // Use cases (onboarding) the template applies to; empty = everyone
  roles: string[]
  where: string
  // Official domains to look on; empty = the person's own documents or words
  domains: string[]
  appliesIf?: string
}

export const OBLIGATION_TEMPLATES: ObligationTemplate[] = [
  {
    kind: "exam_registration",
    label: "Exam registration window",
    roles: ["student"],
    where: "The exam authority's official notice page",
    domains: ["gov.in", "nic.in", "ac.in"],
  },
  {
    kind: "scholarship",
    label: "Scholarship last date",
    roles: ["student"],
    where: "The scholarship's official page",
    domains: ["gov.in", "nic.in"],
  },
  {
    kind: "gst_return",
    label: "GST return due date",
    roles: ["founder", "freelancer", "business"],
    where: "The GST portal or CBIC notifications",
    domains: ["gst.gov.in", "cbic-gst.gov.in"],
    appliesIf: "the person has a GSTIN",
  },
  {
    kind: "advance_tax",
    label: "Advance tax instalment",
    roles: ["founder", "freelancer", "business", "creator"],
    where: "The income tax department's site",
    domains: ["incometax.gov.in"],
  },
  {
    kind: "income_tax_return",
    label: "Income tax return due date",
    roles: [],
    where: "The income tax department's site",
    domains: ["incometax.gov.in"],
  },
  {
    kind: "insurance_renewal",
    label: "Insurance renewal",
    roles: [],
    where: "The insurer's renewal notice in the person's mail, or the person",
    domains: [],
  },
  {
    kind: "vehicle_renewal",
    label: "Vehicle insurance or PUC renewal",
    roles: [],
    where: "The renewal notice, or the person",
    domains: [],
  },
  {
    kind: "rent_or_fee",
    label: "Rent or fee due",
    roles: [],
    where: "The person",
    domains: [],
  },
  {
    kind: "other",
    label: "Other deadline",
    roles: [],
    where: "Any source with a quote",
    domains: [],
  },
]

export const OBLIGATION_KINDS = OBLIGATION_TEMPLATES.map((t) => t.kind)

export const templatesFor = (role: string | null | undefined) =>
  OBLIGATION_TEMPLATES.filter(
    (t) => t.roles.length === 0 || (role && t.roles.includes(role))
  )
