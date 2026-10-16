"use client"

import * as React from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatDistanceToNowStrict } from "date-fns"
import {
  ArrowLeftIcon,
  BrainIcon,
  ChevronDownIcon,
  ListChecksIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import {
  createThread,
  deleteThread,
  renameThread,
  threadMessages,
} from "@/actions/threads"
import { Confirm } from "@/components/confirm"
import { Glyph, SquadGlyph } from "@/components/glyph"
import { Composer } from "@/components/thread/composer"
import { ApprovalContext } from "@/components/thread/tool-call"
import { Transcript, type AgentLite } from "@/components/thread/transcript"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ActivityPanel } from "@/components/workbench/activity"
import { MemoryPanel } from "@/components/workbench/memory"
import { useWorkspace } from "@/components/workspace/context"
import { useNotifications } from "@/components/workspace/notifier"
import type { KriyaMessage } from "@/lib/agent/tools"
import { suggestionsFor } from "@/lib/templates"
import { tierName } from "@/lib/tiers"
import { cn } from "@/lib/utils"

export type ThreadSummary = { id: string; title: string | null; activeAt: string }

export type ThreadViewProps = {
  threadId: string
  title: string | null
  kind: "agent" | "squad"
  owner: { id: string; name: string; subtitle: string; glyphs: string[] }
  members: AgentLite[]
  threads: ThreadSummary[]
  initialMessages: KriyaMessage[]
  workbenchOpen: boolean
}

function parseError(error: Error): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(error.message)
    if (typeof parsed?.error === "string")
      return { message: parsed.error, code: parsed.code }
  } catch {}
  return { message: error.message || "Something went wrong." }
}

// Room for the activity panel beside the chat (laptops and up), decided in
// the browser; the server renders the wide layout. Narrower screens get the
// panel as a bottom sheet so neither the chat nor the panel is squeezed.
const desktopQuery = "(min-width: 1024px)"
function useIsDesktop() {
  return React.useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(desktopQuery)
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    },
    () => window.matchMedia(desktopQuery).matches,
    () => true
  )
}

/* ─────────────────────────── side panel ─────────────────────────── */

const TABS = [
  { id: "activity", label: "Activity", icon: ListChecksIcon },
  { id: "memory", label: "Memory", icon: BrainIcon },
] as const

function Workbench({
  threadId,
  agentId,
  refreshKey,
}: {
  threadId: string
  agentId: string | null
  refreshKey: number
}) {
  const tabs = agentId ? TABS : TABS.slice(0, 1)
  const [tab, setTab] = React.useState<(typeof TABS)[number]["id"]>("activity")
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface/40">
      <div
        role="tablist"
        className="hairline-b flex h-10 shrink-0 items-stretch gap-1 px-2"
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "relative flex items-center gap-1.5 px-2 font-mono text-[11px] tracking-wide uppercase transition-colors",
              tab === id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-3.5" />
            {label}
            {tab === id && (
              <span className="absolute inset-x-1 -bottom-px h-px bg-rigel" />
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "activity" || !agentId ? (
          <ActivityPanel threadId={threadId} refreshKey={refreshKey} />
        ) : (
          <MemoryPanel agentId={agentId} refreshKey={refreshKey} />
        )}
      </div>
    </div>
  )
}

/* ──────────────────────────── header ───────────────────────────── */

function RenameThreadDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: string
  onSave: (title: string) => Promise<void>
}) {
  const [value, setValue] = React.useState(initial)
  const [saving, setSaving] = React.useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(initial)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            if (!value.trim()) return
            setSaving(true)
            try {
              await onSave(value.trim())
              onOpenChange(false)
            } finally {
              setSaving(false)
            }
          }}
          className="flex flex-col gap-4"
        >
          <DialogTitle>Rename thread</DialogTitle>
          <Input
            autoFocus
            value={value}
            maxLength={80}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Thread title"
            aria-label="Thread title"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !value.trim()}>
              {saving && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ThreadHeader({
  props,
  panelOpen,
  onTogglePanel,
}: {
  props: ThreadViewProps
  panelOpen: boolean
  onTogglePanel: () => void
}) {
  const router = useRouter()
  const { nav, openAgentDialog, openSquadDialog } = useWorkspace()
  const { threadId, kind, owner, threads, title } = props
  const base = kind === "agent" ? `/a/${owner.id}` : `/s/${owner.id}`
  const [renaming, setRenaming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const configure = () => {
    if (kind === "agent") {
      const agent = nav.agents.find((a) => a.id === owner.id)
      if (agent) openAgentDialog({ agent })
    } else {
      const squad = nav.squads.find((s) => s.id === owner.id)
      if (squad) openSquadDialog({ squad })
    }
  }

  const newThread = async () => {
    const id = await createThread(
      kind === "agent" ? { agentId: owner.id } : { squadId: owner.id }
    )
    router.push(`${base}/${id}`)
  }

  const agentTier = kind === "agent" ? tierName(props.members[0]?.model) : null

  return (
    <header className="hairline-b flex h-12 shrink-0 items-center gap-1 px-1.5 max-md:h-14 sm:gap-3 sm:px-4">
      <Link
        href="/home"
        aria-label="Back to home"
        className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent md:hidden"
      >
        <ArrowLeftIcon className="size-4" />
      </Link>
      <button
        type="button"
        onClick={configure}
        className="flex min-w-0 items-center gap-2.5 rounded-md py-1 pr-2 text-left hover:bg-accent/50"
      >
        {kind === "agent" ? (
          <Glyph seed={owner.glyphs[0]} className="size-7" />
        ) : (
          <SquadGlyph seeds={owner.glyphs} className="size-7" />
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13.5px] font-semibold">{owner.name}</span>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {owner.subtitle}
          </span>
        </span>
      </button>

      <span className="hidden h-5 w-px bg-border lg:block" />

      <DropdownMenu>
        <DropdownMenuTrigger className="hidden min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent/50 hover:text-foreground lg:flex">
          <span className="max-w-72 truncate">{title ?? "New thread"}</span>
          <ChevronDownIcon className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuItem onClick={newThread}>
            <MessageSquarePlusIcon />
            New thread
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="label-mono">Threads</DropdownMenuLabel>
            {threads.map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                onClick={() => router.push(`${base}/${thread.id}`)}
                className={cn(thread.id === threadId && "bg-accent")}
              >
                <span className="min-w-0 flex-1 truncate">
                  {thread.title ?? "New thread"}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-faint">
                  {formatDistanceToNowStrict(new Date(thread.activeAt))}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
        {agentTier && (
          <span className="mr-1 hidden rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground lg:inline-flex">
            {agentTier} model
          </span>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="New thread"
                onClick={newThread}
                className="max-md:size-11"
              />
            }
          >
            <MessageSquarePlusIcon />
          </TooltipTrigger>
          <TooltipContent>New thread</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Configure ${kind}`}
                onClick={configure}
                className="max-sm:hidden"
              />
            }
          >
            <SlidersHorizontalIcon />
          </TooltipTrigger>
          <TooltipContent>Configure {kind}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Thread options"
                className="max-md:size-11"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={configure} className="sm:hidden">
              <SlidersHorizontalIcon />
              Configure {kind}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2Icon />
              Delete thread
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant={panelOpen ? "secondary" : "ghost"}
                aria-label="Activity and memory"
                aria-pressed={panelOpen}
                onClick={onTogglePanel}
                className="max-md:size-11"
              />
            }
          >
            {panelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
          </TooltipTrigger>
          <TooltipContent>Activity and memory</TooltipContent>
        </Tooltip>
      </div>
      <Confirm
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this thread?"
        description={`"${title ?? "New thread"}" and its messages are deleted. ${owner.name} keeps its memory.`}
        action="Delete thread"
        onConfirm={async () => {
          await deleteThread(threadId)
          toast.add({ type: "success", title: "Thread deleted" })
          router.push(base)
        }}
      />
      <RenameThreadDialog
        open={renaming}
        onOpenChange={setRenaming}
        initial={title ?? ""}
        onSave={async (next) => {
          await renameThread(threadId, next)
          router.refresh()
        }}
      />
    </header>
  )
}

/* ─────────────────────────── empty state ───────────────────────── */

function EmptyThread({
  props,
  onPick,
}: {
  props: ThreadViewProps
  onPick: (text: string) => void
}) {
  const { nav } = useWorkspace()
  // Fitted to who's in the thread; a squad's show off splitting the work
  const lead = props.members[0]
  const fitted = suggestionsFor({
    role: lead?.role ?? "",
    instructions: nav.agents.find((agent) => agent.id === lead?.id)?.instructions,
  })
  const suggestions =
    props.kind === "squad"
      ? [
          "Plan a product launch: split it so each of you takes the part that fits your role.",
          "Compare three options for a family trip to Kerala, one each, then sum up.",
          ...fitted.slice(0, 2),
        ]
      : fitted

  return (
    <div className="flex flex-col items-center gap-6 pt-[6vh] text-center">
      <div className="relative">
        <div className="absolute -inset-10 rounded-full bg-rigel/10 blur-2xl" />
        {props.kind === "agent" ? (
          <Glyph seed={props.owner.glyphs[0]} className="relative size-16" />
        ) : (
          <SquadGlyph seeds={props.owner.glyphs} className="relative size-16" />
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold tracking-tight">{props.owner.name}</h2>
        <p className="font-mono text-[12px] text-muted-foreground">
          {props.owner.subtitle}
        </p>
      </div>
      <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {suggestions.slice(0, 4).map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="min-h-12 rounded-lg border bg-surface/50 px-3 py-2.5 text-left text-[13px] leading-snug text-muted-foreground transition-colors hover:border-input hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ──────────────────────────── thread ───────────────────────────── */

export function ThreadView(props: ThreadViewProps) {
  const { threadId, kind, members, initialMessages } = props
  const router = useRouter()
  const isDesktop = useIsDesktop()
  const [addresseeId, setAddresseeId] = React.useState(members[0]?.id)
  const [refreshKey, setRefreshKey] = React.useState(0)
  // Remembered in a cookie so the server renders the right layout first time
  const [panelOpen, setPanelOpen] = React.useState(props.workbenchOpen)
  const [sheetOpen, setSheetOpen] = React.useState(false)

  const togglePanel = () => {
    if (!isDesktop) return setSheetOpen(true)
    const next = !panelOpen
    document.cookie = `kriya_panel=${next ? "open" : "closed"}; path=/; max-age=31536000; samesite=lax`
    setPanelOpen(next)
  }

  const api = `/api/threads/${threadId}/turn`
  const transport = React.useMemo(
    () =>
      new DefaultChatTransport<KriyaMessage>({
        api,
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { message: messages[messages.length - 1], agentId: body?.agentId },
        }),
        prepareReconnectToStreamRequest: () => ({ api }),
      }),
    [api]
  )

  // A task handed over from the home screen (see components/home/ask.tsx).
  // Only read here: StrictMode may call this twice, so it's removed on send.
  const [handover] = React.useState(() => {
    if (typeof window === "undefined" || initialMessages.length > 0) return null
    try {
      return sessionStorage.getItem(`kriya:pending:${threadId}`)
    } catch {
      return null
    }
  })

  const {
    messages,
    sendMessage,
    setMessages,
    resumeStream,
    status: chatStatus,
    stop,
    error,
    clearError,
  } = useChat<KriyaMessage>({
    id: threadId,
    messages: initialMessages,
    transport,
    // A brand-new thread has nothing running to re-attach to, and resuming
    // would race the handed-over send
    resume: !handover,
    onFinish: () => {
      // The worker settles the task (charge, preview) just after the last chunk
      setTimeout(() => {
        setRefreshKey((key) => key + 1)
        router.refresh()
      }, 1200)
    },
  })

  const busy = chatStatus === "submitted" || chatStatus === "streaming"

  // A task started from another tab or device shows up here live: catch up
  // with what's saved, then follow the stream
  const { listen } = useNotifications()
  const busyRef = React.useRef(busy)
  React.useEffect(() => {
    busyRef.current = busy
  }, [busy])
  React.useEffect(
    () =>
      listen((event) => {
        if (event.type !== "turn-started" || event.threadId !== threadId) return
        if (busyRef.current) return
        void threadMessages(threadId)
          .then((saved) => {
            setMessages(saved as KriyaMessage[])
            return resumeStream()
          })
          .catch(() => {})
      }),
    [listen, threadId, setMessages, resumeStream]
  )
  const addressee = members.find((member) => member.id === addresseeId) ?? members[0]

  const send = (text: string) => {
    clearError()
    sendMessage(
      { text, metadata: kind === "squad" ? { agentId: addressee.id } : undefined },
      { body: { agentId: addressee?.id } }
    )
    // Let the sidebar pick up the new title and the busy indicator
    setTimeout(() => router.refresh(), 600)
  }

  // Send the handover once the thread has settled. Scheduled and cancelled on
  // unmount, so a mount that's torn down at once (StrictMode, a fast
  // navigation) can't swallow it; removed first so a refresh can't resend it.
  const handedOver = React.useRef(false)
  React.useEffect(() => {
    if (!handover || handedOver.current) return
    const timer = setTimeout(() => {
      handedOver.current = true
      try {
        sessionStorage.removeItem(`kriya:pending:${threadId}`)
      } catch {}
      send(handover)
    }, 0)
    return () => clearTimeout(timer)
    // Runs once per thread; ThreadView is keyed by thread id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Approve or decline a tool call the agent is waiting on, then follow the
  // reply as it carries on in the worker
  const respond = async (approvalId: string, approved: boolean) => {
    const response = await fetch(`/api/threads/${threadId}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, approved }),
    })
    const body = (await response.json().catch(() => null)) as {
      queued?: boolean
      error?: string
    } | null
    if (!response.ok) {
      toast.add({ type: "error", title: body?.error ?? "Couldn't record your answer." })
      setMessages((await threadMessages(threadId)) as KriyaMessage[])
      throw new Error(body?.error ?? "approval failed")
    }
    clearError()
    setMessages((await threadMessages(threadId)) as KriyaMessage[])
    if (body?.queued) {
      await resumeStream()
      setTimeout(() => router.refresh(), 600)
    }
  }

  const halt = () => {
    stop()
    fetch(api, { method: "DELETE" }).finally(() => {
      setTimeout(() => {
        setRefreshKey((key) => key + 1)
        router.refresh()
      }, 1500)
    })
  }

  const failure = error ? parseError(error) : null
  const limitReached =
    !!failure && ["daily_limit", "allowance"].includes(failure.code ?? "")

  const chat = (
    <ApprovalContext value={respond}>
      <div className="flex h-full min-h-0 flex-col">
        <Transcript
          messages={messages}
          members={members}
          status={chatStatus}
          isSquad={kind === "squad"}
          empty={<EmptyThread props={props} onPick={send} />}
          footer={
            failure ? (
              <div
                role="alert"
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]",
                  limitReached
                    ? "border-betelgeuse/40 bg-betelgeuse-soft"
                    : "border-destructive/30 bg-destructive/5"
                )}
              >
                <TriangleAlertIcon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    limitReached ? "text-betelgeuse" : "text-destructive"
                  )}
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">
                    {limitReached
                      ? "You've reached your plan's limit"
                      : "The task didn't finish"}
                  </span>
                  <span className="break-words text-muted-foreground">
                    {failure.message}
                  </span>
                  {limitReached ? (
                    <Link href="/account#plan" className="text-rigel hover:underline">
                      See plans →
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRefreshKey((key) => key + 1)
                        if (isDesktop) setPanelOpen(true)
                        else setSheetOpen(true)
                      }}
                      className="self-start text-rigel hover:underline"
                    >
                      See what happened →
                    </button>
                  )}
                </div>
              </div>
            ) : null
          }
        />
        <Composer
          draftKey={threadId}
          placeholder={
            kind === "squad"
              ? `Message ${addressee?.name ?? "the squad"}…`
              : `Message ${props.owner.name}…`
          }
          busy={busy}
          onSend={send}
          onStop={halt}
          members={kind === "squad" ? members : undefined}
          addressee={kind === "squad" ? addressee : undefined}
          onAddresseeChange={setAddresseeId}
          tier={addressee?.model ?? null}
        />
      </div>
    </ApprovalContext>
  )

  const agentId = kind === "agent" ? members[0].id : null
  const workbench = (
    <Workbench threadId={threadId} agentId={agentId} refreshKey={refreshKey} />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader
        props={props}
        panelOpen={isDesktop ? panelOpen : sheetOpen}
        onTogglePanel={togglePanel}
      />
      {isDesktop && panelOpen ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel id="chat" minSize="40%">
            {chat}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="workbench" defaultSize="32%" minSize="22%" maxSize="50%">
            {workbench}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">{chat}</div>
      )}
      {!isDesktop && (
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <DialogContent className="top-auto bottom-0 left-0 flex h-[85svh] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-t-2xl rounded-b-none p-0 sm:max-w-none">
            <DialogTitle className="sr-only">Activity and memory</DialogTitle>
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" />
            <div className="min-h-0 flex-1">{workbench}</div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
