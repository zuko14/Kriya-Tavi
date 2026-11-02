"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowLeftIcon,
  AtSignIcon,
  BotIcon,
  CornerDownRightIcon,
  FlagIcon,
  NotebookTextIcon,
  OctagonXIcon,
  SendIcon,
  TargetIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import { deleteMessage, markRead, postMessage, stopAgents } from "@/actions/rooms"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { formatInr } from "@/lib/money"
import { cn } from "@/lib/utils"
import type {
  InviteRow,
  MyAgent,
  ProofCard as ProofCardData,
  RoomAgent,
  RoomGoal,
  RoomMessage,
  RoomNote,
  RoomPage,
} from "@/queries/rooms"

import { mergeMessages, POLL_MS } from "./merge"
import { ProofCard } from "./proof-card"
import { RoomAgents } from "./room-agents"
import { RoomGoals, type ProofChoice } from "./room-goals"
import { RoomNotes } from "./room-notes"
import { RoomInfo } from "./room-info"
import { ReportDialog } from "./report-dialog"

// The word being typed after an @, if any
const MENTION = /(^|\s)@([^\s@]*)$/

// Agents in the room the person may ask (the server decides again)
const canAsk = (agent: RoomAgent) =>
  agent.mine || (agent.invoke === "members" && !agent.limitReached)

// A room (UX_SPEC §2), with agents from R4 (rooms.agents): an @ picker in
// the composer, agent messages labelled as AI and as someone's, the owner's
// own cost on their agents' messages, and the agents sheet. New messages come
// through the catch-up route: on a Realtime ping when rooms.realtime is on
// and the channel is joined, otherwise by polling every 10 s (RT-RLT-04), and
// always when the tab comes back and after the person's own post. Messages
// merge by seq, so a repeated or overlapping fetch changes nothing.

const TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
})

// What the catch-up route sends: dates as strings
type Message = Omit<RoomMessage, "createdAt" | "deletedAt"> & {
  createdAt: string | Date
  deletedAt: string | Date | null
}

export function RoomView({
  room,
  me,
  initial,
  invites,
  realtime,
  agents,
  goals,
  notes,
}: {
  room: RoomPage["room"] & {
    role: RoomPage["role"]
    members: RoomPage["members"]
    // R9: people the reader blocked
    blocked: RoomPage["blocked"]
  }
  me: string
  initial: Message[]
  invites: InviteRow[]
  // The project's public URL and publishable key, with rooms.realtime on
  realtime: { url: string; key: string } | null
  // With rooms.agents on: the room's agents and the person's own to add
  agents: { list: RoomAgent[]; mine: MyAgent[] } | null
  // R7: the room's goals
  goals: RoomGoal[]
  // R8: the room's notes
  notes: RoomNote[]
}) {
  const router = useRouter()
  const [messages, setMessages] = React.useState(initial)
  // A refresh brings a newer render (a card since verified): merge it in
  const [rendered, setRendered] = React.useState(initial)
  if (rendered !== initial) {
    setRendered(initial)
    setMessages((have) => mergeMessages(have, initial))
  }
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [infoOpen, setInfoOpen] = React.useState(false)
  const [agentsOpen, setAgentsOpen] = React.useState(false)
  const [goalsOpen, setGoalsOpen] = React.useState(false)
  const [notesOpen, setNotesOpen] = React.useState(false)
  // R9: what is being reported (a message id, or "room"); blocked people's
  // messages the reader chose to show
  const [reporting, setReporting] = React.useState<string | null>(null)
  const [shown, setShown] = React.useState<Set<string>>(() => new Set())
  const blocked = new Set(room.blocked)
  // Agents and people picked with @, by id
  const [picked, setPicked] = React.useState<string[]>([])
  // The card the next message answers ("Ask an agent to verify", R5)
  const [replyTo, setReplyTo] = React.useState<Message | null>(null)
  const roomAgents = agents?.list ?? []
  const people = room.members.filter((m) => m.userId !== me)
  const typing = MENTION.exec(draft)?.[2]?.toLowerCase()
  const suggestions =
    typing === undefined
      ? []
      : roomAgents.filter((a) => a.name.toLowerCase().startsWith(typing))
  const peopleSuggested =
    typing === undefined
      ? []
      : people.filter((p) => p.name.toLowerCase().startsWith(typing))
  // A waiting line goes once its reply was shared (UX_SPEC §3)
  const shared = new Set(
    messages.flatMap((m) =>
      m.authorKind === "agent" && typeof m.parts?.disclosureId === "string"
        ? [m.parts.disclosureId]
        : []
    )
  )
  const lastSeq = React.useRef(initial.at(-1)?.seq ?? 0)
  const marked = React.useRef(0)
  const bottom = React.useRef<HTMLDivElement>(null)
  const archived = room.status !== "active"
  const unconfirmedNotes = notes.filter((n) => n.agent && !n.confirmedBy).length
  const paused = room.agentsPausedUntil
  const [stopping, setStopping] = React.useState(false)

  // Pauses every agent here for ten minutes; the person's own stop working
  async function stop() {
    setStopping(true)
    setError(null)
    const result = await stopAgents(room.id)
    setStopping(false)
    if ("error" in result) return setError(result.error)
    router.refresh()
  }
  const names = new Map(room.members.map((m) => [m.userId, m.name]))

  const poll = React.useCallback(async () => {
    // Up to 100 rows a request: keep asking until the gap is closed
    for (let page = 0; page < 10; page++) {
      const response = await fetch(
        `/api/rooms/${room.id}/messages?after=${lastSeq.current}`,
        { cache: "no-store" }
      ).catch(() => null)
      if (!response?.ok) return
      const { messages: rows } = (await response.json()) as { messages: Message[] }
      if (rows.length === 0) return
      lastSeq.current = Math.max(lastSeq.current, rows.at(-1)!.seq)
      setMessages((have) => mergeMessages(have, rows))
      // System lines (agents added, removed, working, stopped) and agents'
      // replies change what this page was rendered with: the @ picker's
      // agents and members, who is working, the pause. Refresh them
      if (rows.some((row) => row.authorKind !== "human")) router.refresh()
      if (rows.length < 100) return
    }
  }, [room.id, router])

  // Realtime (RF-06): the private channel room:<id> pings `{ seq }` after each
  // message; the page fetches through the catch-up route. The token comes
  // from /api/rooms/realtime and is asked for again close to its expiry
  const [live, setLive] = React.useState(false)
  React.useEffect(() => {
    if (!realtime) return
    let cancelled = false
    let held: { token: string; expiresAt: number } | null = null
    const accessToken = async () => {
      if (!held || held.expiresAt * 1000 - Date.now() < 60_000) {
        const response = await fetch("/api/rooms/realtime", { cache: "no-store" })
        if (!response.ok) throw new Error("No Realtime token")
        held = await response.json()
      }
      return held!.token
    }
    let stop = () => {}
    void import("@supabase/supabase-js").then(async ({ createClient }) => {
      if (cancelled) return
      const client = createClient(realtime.url, realtime.key, { accessToken })
      // Load the person's token before joining: otherwise the first join goes
      // in with the publishable key and the members-only policy refuses it
      await client.realtime.setAuth().catch(() => {})
      if (cancelled) return
      const channel = client
        .channel(`room:${room.id}`, { config: { private: true } })
        .on("broadcast", { event: "seq" }, () => void poll())
        .subscribe((status) => {
          setLive(status === "SUBSCRIBED")
          // Anything missed while joining
          if (status === "SUBSCRIBED") void poll()
        })
      stop = () => void client.removeChannel(channel)
    })
    return () => {
      cancelled = true
      setLive(false)
      stop()
    }
  }, [realtime, room.id, poll])

  // Polling every 10 s while the channel isn't joined (or Realtime is off)
  React.useEffect(() => {
    if (live) return
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [live, poll])

  React.useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && poll()
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [poll])

  // Keep the newest message in view and the read marker at it
  const newest = messages.at(-1)?.seq ?? 0
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
    if (newest > marked.current && document.visibilityState === "visible") {
      marked.current = newest
      void markRead({ roomId: room.id, seq: newest })
    }
  }, [newest, room.id])

  async function send() {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    // Cleared at once, so what's typed while this one is sending isn't wiped
    setDraft("")
    // Picked names still in the text, and any typed by a unique name
    const named = (id: string, name: string) =>
      body.includes(`@${name}`) &&
      (picked.includes(id) ||
        [...roomAgents.map((a) => a.name), ...people.map((p) => p.name)].filter(
          (n) => n === name
        ).length === 1)
    const mentions = roomAgents
      .filter((a) => named(a.agentId, a.name))
      .map((a) => a.agentId)
    const mentioned = people.filter((p) => named(p.userId, p.name)).map((p) => p.userId)
    const answering = replyTo
    setPicked([])
    setReplyTo(null)
    const result = await postMessage({
      roomId: room.id,
      body,
      ...(mentions.length > 0 && { mentions }),
      ...(mentioned.length > 0 && { people: mentioned }),
      ...(answering && { replyTo: answering.id }),
    })
    setSending(false)
    if ("error" in result) {
      setDraft((typed) => typed || body)
      setReplyTo((now) => now ?? answering)
      return setError(result.error)
    }
    await poll()
  }

  // R7: every verified action on a card in this room, for closing goal items
  const proofs: ProofChoice[] = messages.flatMap((m) =>
    m.authorKind === "agent" && !m.deletedAt
      ? ((m.parts?.proof as ProofCardData | undefined)?.done ?? []).flatMap((d, index) =>
          d.status === "verified"
            ? [
                {
                  messageId: m.id,
                  index,
                  label: `${d.title} · ${m.agentName ?? "Agent"}`,
                },
              ]
            : []
        )
      : []
  )

  // R5: the card on an agent's message, and whose card a reply is about
  const proofOf = (m: Message) => m.parts?.proof as ProofCardData | undefined
  const cardOwner = (id: string) =>
    messages.find((m) => m.id === id)?.agentName ?? "an agent"

  function pick(id: string, name: string) {
    setDraft((typed) => typed.replace(MENTION, `$1@${name} `))
    setPicked((ids) => (ids.includes(id) ? ids : [...ids, id]))
  }

  async function remove(message: Message) {
    const result = await deleteMessage({ roomId: room.id, messageId: message.id })
    if ("error" in result) return setError(result.error)
    setMessages((have) =>
      have.map((m) =>
        m.id === message.id
          ? { ...m, body: null, deletedAt: new Date().toISOString() }
          : m
      )
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="hairline-b flex shrink-0 items-center gap-2 px-2 py-2 sm:px-4">
        <Link
          href="/rooms"
          aria-label="All rooms"
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h1 className="truncate text-[15px] font-semibold">{room.title}</h1>
          <p className="truncate text-[12px] text-muted-foreground">
            {archived ? "Archived · " : ""}
            {room.topic ??
              `${room.members.length} ${room.members.length === 1 ? "person" : "people"}`}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setNotesOpen(true)}
          className="relative size-11 shrink-0"
          aria-label={`Notes${unconfirmedNotes ? `, ${unconfirmedNotes} to confirm` : ""}`}
        >
          <NotebookTextIcon />
          {unconfirmedNotes > 0 && (
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-betelgeuse" />
          )}
        </Button>
        <Button
          variant="outline"
          onClick={() => setGoalsOpen(true)}
          className="h-11 shrink-0 max-sm:w-11 max-sm:px-0"
          aria-label="Goals"
        >
          <TargetIcon />
          <span className="hidden tabular-nums sm:inline">
            {goals.filter((g) => g.status === "open").length}
          </span>
        </Button>
        {agents && (
          <Button
            variant="outline"
            onClick={() => setAgentsOpen(true)}
            className="h-11 shrink-0 max-sm:w-11 max-sm:px-0"
            aria-label="Agents"
          >
            <BotIcon />
            <span className="hidden tabular-nums sm:inline">{roomAgents.length}</span>
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => setInfoOpen(true)}
          className="h-11 shrink-0 max-sm:w-11 max-sm:px-0"
          aria-label="Room info"
        >
          <UsersIcon />
          <span className="hidden tabular-nums sm:inline">{room.members.length}</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <ol className="mx-auto flex max-w-3xl flex-col gap-2">
          {messages.length === 0 && (
            <li className="py-10 text-center text-[13px] text-muted-foreground">
              No messages yet. Say hello, or invite someone from Room info.
            </li>
          )}
          {messages.map((message) => {
            if (
              message.authorKind === "system" &&
              message.parts?.kind === "waiting" &&
              shared.has(message.parts.disclosureId as string)
            )
              return null
            if (message.authorKind === "system")
              return (
                <li
                  key={message.id}
                  className="py-1 text-center text-[12px] text-muted-foreground"
                >
                  {message.body}
                </li>
              )
            const mine = message.authorKind === "human" && message.userId === me
            // RD-18: a blocked person's messages, and their agents', collapse
            if (blocked.has(message.userId ?? "") && !shown.has(message.id))
              return (
                <li
                  key={message.id}
                  className="flex min-h-11 items-center gap-2 px-1 text-[12px] text-muted-foreground"
                >
                  {message.authorKind === "agent"
                    ? "Message from the agent of someone you blocked"
                    : "Message from someone you blocked"}
                  <button
                    type="button"
                    onClick={() => setShown((have) => new Set(have).add(message.id))}
                    className="min-h-11 rounded-full px-3 font-medium text-foreground hover:bg-accent"
                  >
                    Show
                  </button>
                </li>
              )
            const author =
              message.authorKind === "agent"
                ? `${message.agentName ?? "Agent"} · AI · ${names.get(message.userId ?? "") ?? "a former member"}'s agent`
                : (names.get(message.userId ?? "") ?? "Former member")
            return (
              <li
                key={message.id}
                className={cn(
                  "group flex flex-col gap-0.5",
                  mine ? "items-end" : "items-start"
                )}
              >
                {!mine && (
                  <span className="px-1 text-[11.5px] font-medium text-muted-foreground">
                    {author}
                  </span>
                )}
                {typeof message.parts?.replyTo === "string" && (
                  <span className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                    <CornerDownRightIcon className="size-3" /> about{" "}
                    {cardOwner(message.parts.replyTo)}&apos;s card
                  </span>
                )}
                <div
                  className={cn(
                    "flex max-w-[85%] items-center gap-1",
                    mine && "flex-row-reverse"
                  )}
                >
                  <div
                    className={cn(
                      "rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed break-words whitespace-pre-wrap",
                      mine ? "bg-primary text-primary-foreground" : "glass",
                      message.deletedAt && "italic opacity-60"
                    )}
                  >
                    {message.deletedAt ? "Message deleted" : message.body}
                  </div>
                  {mine && !message.deletedAt && (
                    <Confirm
                      trigger={
                        <button
                          type="button"
                          aria-label="Delete message"
                          className="grid size-11 shrink-0 place-items-center rounded-full text-faint opacity-100 transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      }
                      title="Delete this message?"
                      description="Its text is removed for everyone in the room."
                      action="Delete message"
                      onConfirm={() => remove(message)}
                    />
                  )}
                  {!mine && !message.deletedAt && (
                    <button
                      type="button"
                      aria-label="Report message"
                      onClick={() => setReporting(message.id)}
                      className="grid size-11 shrink-0 place-items-center rounded-full text-faint opacity-100 transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    >
                      <FlagIcon className="size-3.5" />
                    </button>
                  )}
                </div>
                {message.authorKind === "agent" && proofOf(message) && (
                  <ProofCard
                    card={proofOf(message)!}
                    onVerify={
                      agents && !archived
                        ? () => {
                            setReplyTo(message)
                            setDraft((typed) => typed || "@")
                          }
                        : undefined
                    }
                  />
                )}
                <span className="px-1 font-mono text-[10.5px] text-faint">
                  {TIME.format(new Date(message.createdAt))}
                  {/* RD-17: the owner alone sees what their agent's reply cost */}
                  {message.cost !== null && ` · Cost ${formatInr(message.cost)}`}
                </span>
              </li>
            )
          })}
        </ol>
        <div ref={bottom} />
      </div>

      <div className="hairline-t shrink-0 px-3 py-3 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
          {/* R6 (RD-12): any member can stop the agents for ten minutes */}
          {agents && !archived && (paused || roomAgents.some((a) => a.working)) && (
            <div className="flex min-h-11 items-center justify-between gap-2 text-[12.5px] text-muted-foreground">
              <span>
                {paused
                  ? `Agents are paused until ${TIME.format(new Date(paused))}.`
                  : `${roomAgents
                      .filter((a) => a.working)
                      .map((a) => a.name)
                      .join(", ")} working…`}
              </span>
              {!paused && (
                <Button
                  variant="outline"
                  className="h-11 shrink-0"
                  disabled={stopping}
                  onClick={stop}
                >
                  <OctagonXIcon />
                  Stop agents
                </Button>
              )}
            </div>
          )}
          {archived ? (
            <p className="py-2 text-center text-[13px] text-muted-foreground">
              This room is archived. You can read it, not post in it.
            </p>
          ) : (
            <>
              {suggestions.length > 0 && (
                <ul aria-label="Agents to ask" className="flex flex-wrap gap-1.5">
                  {suggestions.map((agent) => (
                    <li key={agent.agentId}>
                      <button
                        type="button"
                        disabled={!canAsk(agent)}
                        onClick={() => pick(agent.agentId, agent.name)}
                        className="flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[12.5px] disabled:opacity-50"
                      >
                        <BotIcon className="size-3.5" />
                        {agent.name}
                        <span className="text-muted-foreground">
                          {canAsk(agent)
                            ? agent.mine
                              ? "· yours"
                              : `· ${agent.ownerName}'s`
                            : agent.limitReached
                              ? "· limit reached today"
                              : `· answers only to ${agent.ownerName}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {peopleSuggested.length > 0 && (
                <ul aria-label="People to mention" className="flex flex-wrap gap-1.5">
                  {peopleSuggested.map((person) => (
                    <li key={person.userId}>
                      <button
                        type="button"
                        onClick={() => pick(person.userId, person.name)}
                        className="flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[12.5px]"
                      >
                        <AtSignIcon className="size-3.5" />
                        {person.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {replyTo && (
                <p className="flex min-h-11 items-center gap-2 text-[12.5px] text-muted-foreground">
                  <CornerDownRightIcon className="size-3.5 shrink-0" />
                  <span className="flex-1">
                    About {replyTo.agentName ?? "an agent"}&apos;s card: mention an agent
                    to check it.
                  </span>
                  <button
                    type="button"
                    aria-label="Stop replying to the card"
                    onClick={() => setReplyTo(null)}
                    className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-accent"
                  >
                    <XIcon className="size-4" />
                  </button>
                </p>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void send()
                }}
                className="flex items-end gap-2"
              >
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  maxLength={8000}
                  rows={1}
                  placeholder="Message the room"
                  aria-label="Message"
                  className="max-h-40 min-h-11 flex-1 resize-none"
                />
                <Button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  aria-label="Send"
                  className="size-11 shrink-0"
                >
                  <SendIcon />
                </Button>
              </form>
            </>
          )}
        </div>
      </div>

      <RoomInfo
        open={infoOpen}
        onOpenChange={setInfoOpen}
        room={room}
        me={me}
        invites={invites}
        onReport={() => {
          setInfoOpen(false)
          setReporting("room")
        }}
      />
      <ReportDialog
        open={reporting !== null}
        onOpenChange={(open) => !open && setReporting(null)}
        roomId={room.id}
        messageId={reporting && reporting !== "room" ? reporting : undefined}
      />
      <RoomNotes
        open={notesOpen}
        onOpenChange={setNotesOpen}
        roomId={room.id}
        active={!archived}
        notes={notes}
      />
      <RoomGoals
        open={goalsOpen}
        onOpenChange={setGoalsOpen}
        roomId={room.id}
        active={!archived}
        admin={room.role === "owner" || room.role === "admin"}
        goals={goals}
        proofs={proofs}
      />
      {agents && (
        <RoomAgents
          open={agentsOpen}
          onOpenChange={setAgentsOpen}
          roomId={room.id}
          active={!archived}
          agents={agents.list}
          mine={agents.mine}
        />
      )}
    </div>
  )
}
