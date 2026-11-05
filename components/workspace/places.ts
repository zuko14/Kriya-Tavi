import {
  BlocksIcon,
  BriefcaseIcon,
  IndianRupeeIcon,
  LaptopIcon,
  MessagesSquareIcon,
  PhoneIcon,
  RadarIcon,
  TargetIcon,
  WandSparklesIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"

import type { Features } from "@/queries/features"

// One list of the places beyond chat, shared by the sidebar, the command
// palette and Home's "What Kriya can do", so names and blurbs never drift.
export type Place = {
  feature: keyof Features
  href: string
  label: string
  icon: LucideIcon
  blurb: string
}

// The sidebar's Tools section, in order
export const TOOLS: Place[] = [
  {
    feature: "flows",
    href: "/flows",
    label: "Flows",
    icon: WorkflowIcon,
    blurb: "Describe a job, see how it runs, and run it the same way each time.",
  },
  {
    feature: "goals",
    href: "/goals",
    label: "Goals",
    icon: TargetIcon,
    blurb: "Bigger aims broken into steps your agents keep moving.",
  },
  {
    feature: "jobs",
    href: "/settings",
    label: "Jobs",
    icon: BriefcaseIcon,
    blurb: "Work you handed Kriya, and what it may do without asking.",
  },
  {
    feature: "calls",
    href: "/calls",
    label: "Phone calls",
    icon: PhoneIcon,
    blurb: "Tavi calls people for you and tells you what was said.",
  },
  {
    feature: "ledger",
    href: "/accounts",
    label: "Accounts",
    icon: IndianRupeeIcon,
    blurb: "Bills, income and GST invoices, ready for your CA.",
  },
  {
    feature: "radar",
    href: "/radar",
    label: "Radar",
    icon: RadarIcon,
    blurb: "Deadlines with their source, and pages watched for you.",
  },
  {
    feature: "studio",
    href: "/agents/skills",
    label: "Skill Studio",
    icon: WandSparklesIcon,
    blurb: "Teach your agents a new skill from a few words.",
  },
]

// Places that live elsewhere but are worth discovering from Home
export const CONNECT: Place[] = [
  {
    feature: "rooms",
    href: "/rooms",
    label: "Rooms",
    icon: MessagesSquareIcon,
    blurb: "Work with other people and their agents in one place.",
  },
  {
    feature: "apps",
    href: "/account#apps",
    label: "Apps",
    icon: BlocksIcon,
    blurb: "Let agents use the apps you already work in.",
  },
  {
    feature: "harness",
    href: "/harness",
    label: "Kriya Harness",
    icon: LaptopIcon,
    blurb: "Your agents on your own computer: terminal, editor and browser.",
  },
]

export const available = (places: Place[], features: Features) =>
  places.filter((place) => features[place.feature])
