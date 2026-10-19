"use server"

import { z } from "zod"

import { requireUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { requestUndo, undoStates } from "@/lib/undo"

// Undo (K3, agents.undo): the person's own action, never an agent tool.
// This only queues the compensation; the worker runs it and reads it back
// (invariant 5), and "What I did" shows the result.
export async function undoExecution(executionId: string) {
  const user = await requireUser()
  if ((await getSetting("agents.undo")) !== "on")
    return { error: "Undo is switched off." }
  const id = z.uuid().safeParse(executionId)
  if (!id.success) return { error: "That action wasn't found." }
  return requestUndo(user.id, id.data)
}

// The button polls this while the worker runs the compensation
export async function undoStatus(executionId: string) {
  const user = await requireUser()
  const id = z.uuid().safeParse(executionId)
  if (!id.success || (await getSetting("agents.undo")) !== "on") return null
  return (await undoStates(user.id, [id.data]))[0] ?? null
}
