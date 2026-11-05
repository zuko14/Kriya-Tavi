import {
  BanIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleDashedIcon,
  FlagIcon,
  HandIcon,
  Link2Icon,
  ListChecksIcon,
  LoaderIcon,
  MergeIcon,
  OctagonXIcon,
  PlayIcon,
  RepeatIcon,
  SparklesIcon,
  UserCheckIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import type { NodeType } from "@/lib/flows/graph"

// One visual language for the editor and for runs (UX_AND_INTERACTION_SPEC §3).
// Only the glyph carries a type's colour; a state always has an icon too, so
// colour is never the only signal.

export const TYPE_LOOK: Record<
  NodeType,
  { label: string; icon: LucideIcon; tint: string }
> = {
  start: { label: "Start", icon: PlayIcon, tint: "text-foreground bg-accent" },
  agent: { label: "Agent", icon: SparklesIcon, tint: "text-rigel bg-rigel-soft" },
  check: { label: "Check", icon: CheckCheckIcon, tint: "text-ok bg-ok/12" },
  approval: {
    label: "Your approval",
    icon: UserCheckIcon,
    tint: "text-betelgeuse bg-betelgeuse-soft",
  },
  merge: { label: "Merge", icon: MergeIcon, tint: "text-muted-foreground bg-accent" },
  loop: { label: "Loop", icon: RepeatIcon, tint: "text-rigel bg-rigel-soft" },
  end: { label: "Finish", icon: FlagIcon, tint: "text-foreground bg-accent" },
  step: { label: "Step", icon: ListChecksIcon, tint: "text-rigel bg-rigel-soft" },
}

export const PORT_LABEL: Record<string, string> = {
  out: "",
  error: "if it fails",
  pass: "pass",
  fail: "fail",
  approved: "approved",
  declined: "declined",
  done: "passed",
  exhausted: "out of rounds",
}

// The ways out that aren't the good path
export const ALTERNATE = new Set(["fail", "declined", "exhausted"])

export type RunState =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "skipped"
  | "canceled"
  | "reused"
  // It ran, and the answer was no: a failed check, a decline, no rounds left
  | "missed"

export const STATE_LOOK: Record<
  RunState,
  { label: string; icon: LucideIcon; ring: string; text: string }
> = {
  idle: { label: "Not reached", icon: CircleDashedIcon, ring: "", text: "text-faint" },
  running: {
    label: "Running",
    icon: LoaderIcon,
    ring: "ring-2 ring-rigel/70",
    text: "text-rigel",
  },
  waiting: {
    label: "Needs you",
    icon: HandIcon,
    ring: "ring-2 ring-betelgeuse/80",
    text: "text-betelgeuse",
  },
  done: { label: "Done", icon: CheckIcon, ring: "", text: "text-ok" },
  failed: {
    label: "Failed",
    icon: OctagonXIcon,
    ring: "ring-2 ring-destructive/70",
    text: "text-destructive",
  },
  skipped: { label: "Skipped", icon: BanIcon, ring: "", text: "text-faint" },
  canceled: { label: "Stopped", icon: BanIcon, ring: "", text: "text-muted-foreground" },
  missed: { label: "Didn't pass", icon: XIcon, ring: "", text: "text-betelgeuse" },
  reused: {
    label: "From an earlier run",
    icon: Link2Icon,
    ring: "",
    text: "text-muted-foreground",
  },
}

export const RUN_LABEL: Record<string, string> = {
  queued: "Starting",
  running: "Running",
  waiting: "Waiting for you",
  completed: "Finished",
  failed: "Failed",
  canceled: "Stopped",
}

export const SOURCE_LABEL: Record<string, string> = {
  person: "You",
  copilot: "From a description",
  improve: "An improvement",
  rollback: "Restored",
}

export const RULE_LABEL: Record<string, string> = {
  contains: "Mentions",
  not_contains: "Doesn't mention",
  equals: "Is exactly",
  min_chars: "At least this many characters",
  max_chars: "At most this many characters",
  number_at_least: "Number is at least",
  number_at_most: "Number is at most",
  tool_ran: "A tool really ran",
}
