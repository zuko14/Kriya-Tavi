"use client"

import * as React from "react"
import { CheckIcon, DownloadIcon, PinIcon, PinOffIcon, XIcon } from "lucide-react"

import {
  addAboutYou,
  confirmMemory,
  exportMemory,
  forgetForGood,
  pinMemory,
  setAgentMemoryPaused,
  type AboutYou as AboutYouData,
} from "@/actions/memory"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"

// Memory v2, the person's side (MEMORY_AND_CONTEXT.md §11): what all their
// agents know about them, notes waiting for their confirmation, and export

const failed = (title: string) => (error: unknown) =>
  toast.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  })

const label = (slot: string | null) =>
  slot?.replace(/^profile\./, "").replace(/\[\]$/, "")

export function AboutYou({ initial }: { initial: AboutYouData }) {
  const [data, setData] = React.useState(initial)
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const run = async (work: () => Promise<AboutYouData>, error: string) => {
    setBusy(true)
    try {
      setData(await work())
      return true
    } catch (e) {
      failed(error)(e)
      return false
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    try {
      const notes = await exportMemory()
      const blob = new Blob([JSON.stringify(notes, null, 2)], {
        type: "application/json",
      })
      const link = document.createElement("a")
      link.href = URL.createObjectURL(blob)
      link.download = `kriya-memory-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e) {
      failed("Couldn't export your memory")(e)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {data.review.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-betelgeuse/40 bg-betelgeuse/5 p-4">
          <span className="text-[14px] font-semibold">New memories to review</span>
          <p className="text-[12.5px] text-muted-foreground">
            Saved after an agent read a web page, an email or a document, so they might
            carry someone else&apos;s words. Agents treat them as unverified until you
            confirm them.
          </p>
          <ul className="flex flex-col divide-y">
            {data.review.map((note) => (
              <li key={note.id} className="flex items-center gap-2 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] break-words">{note.content}</span>
                  <span className="label-mono">{note.agentName ?? "all agents"}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 sm:h-9"
                  disabled={busy}
                  onClick={() => run(() => confirmMemory(note.id), "Couldn't confirm it")}
                >
                  <CheckIcon data-icon="inline-start" />
                  Confirm
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="size-11 sm:size-9"
                  aria-label="Delete"
                  disabled={busy}
                  onClick={() => run(() => forgetForGood(note.id), "Couldn't delete it")}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          const content = draft.trim()
          if (!content) return
          if (await run(() => addAboutYou({ content }), "Couldn't save the note")) {
            setDraft("")
          }
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Something all your agents should know…"
          maxLength={2000}
          className="h-11 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-[13px] outline-none placeholder:text-faint focus-visible:border-ring sm:h-9 dark:bg-input/30"
        />
        <Button type="submit" className="h-11 sm:h-9" disabled={busy || !draft.trim()}>
          Add
        </Button>
      </form>

      {data.notes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Nothing shared yet. Notes here go to every one of your agents.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-2xl border">
          {data.notes.map((note) => (
            <li key={note.id} className="flex items-center gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] break-words">
                  {note.slot && (
                    <span className="text-muted-foreground">{label(note.slot)}: </span>
                  )}
                  {note.content}
                </span>
                <span className="label-mono">
                  {note.source === "user" ? "from you" : "saved by an agent"}
                  {note.pinned && " · pinned"}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="size-11 sm:size-9"
                aria-label={note.pinned ? "Unpin" : "Pin"}
                disabled={busy}
                onClick={() =>
                  run(() => pinMemory(note.id, !note.pinned), "Couldn't change the pin")
                }
              >
                {note.pinned ? <PinOffIcon /> : <PinIcon />}
              </Button>
              <Confirm
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 sm:size-9"
                    aria-label="Forget"
                    disabled={busy}
                  >
                    <XIcon />
                  </Button>
                }
                title="Forget this for good?"
                description="The note and its earlier versions are deleted. No agent will see them again."
                action="Forget"
                onConfirm={async () => {
                  await run(() => forgetForGood(note.id), "Couldn't forget it")
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {data.agents.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[14px] font-semibold">Memory per agent</span>
          <p className="text-[12.5px] text-muted-foreground">
            A paused agent still reads what it knows but saves nothing new.
          </p>
          <ul className="flex flex-col divide-y rounded-2xl border">
            {data.agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 text-[13px] break-words">
                  {agent.name}
                  {agent.memoryPaused && (
                    <span className="label-mono"> · memory paused</span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 sm:h-9"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => setAgentMemoryPaused(agent.id, !agent.memoryPaused),
                      "Couldn't change it"
                    )
                  }
                >
                  {agent.memoryPaused ? "Resume" : "Pause"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          className="h-11 sm:h-9"
          onClick={download}
        >
          <DownloadIcon data-icon="inline-start" />
          Export everything remembered (JSON)
        </Button>
      </div>
    </div>
  )
}
