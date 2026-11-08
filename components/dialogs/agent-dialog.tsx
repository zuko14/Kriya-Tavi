"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { Trash2Icon } from "lucide-react"
import { Controller, useForm, useWatch } from "react-hook-form"

import { createAgent, deleteAgent, updateAgent } from "@/actions/agents"
import { Confirm } from "@/components/confirm"
import { AppChoices } from "@/components/dialogs/app-choices"
import { AvatarPicker } from "@/components/dialogs/avatar-picker"
import { SkillPicker } from "@/components/dialogs/skill-picker"
import { TierPicker } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import {
  agentTemplates,
  useWorkspace,
  type AgentTemplate,
} from "@/components/workspace/context"
import { agentInputSchema } from "@/db/schema"
import { isTier } from "@/lib/tiers"
import type { NavAgent } from "@/queries/workspace"

// A thrown action's text is hidden in production; network or server trouble
// Track E (EH-11): passed in through features, because lib/templates.ts is shared
// with screens a server switch can't reach. Guidance lives in the tools (EH-12)
const VIDEO_EDITOR: AgentTemplate = {
  name: "Video editor",
  role: "Cuts your footage on your computer",
  instructions:
    "You produce video edits on the person's own computer. Ask what they want, check which computers and folders are available, then start one edit at a time. Say plainly what came back.",
  forUseCases: [],
  keywords: [],
  suggestions: ["Cut last night's recording into a 45 second reel."],
}

const UNEXPECTED =
  "Something went wrong on our side. Check your connection and try again."

function AgentForm({ agent, template }: { agent?: NavAgent; template?: AgentTemplate }) {
  const router = useRouter()
  const { status, features, closeDialog } = useWorkspace()
  const form = useForm({
    resolver: zodResolver(agentInputSchema),
    defaultValues: {
      name: agent?.name ?? template?.name ?? "",
      role: agent?.role ?? template?.role ?? "",
      instructions: agent?.instructions ?? template?.instructions ?? "",
      model: isTier(agent?.model) ? agent.model : "",
      // The person's chosen avatar; unset follows the role (never sent then)
      glyph: agent?.glyphChoice ?? undefined,
      // Unset (role defaults) until the person changes a skill; never sent
      // while the Skills section is hidden
      skills: status.skills ? (agent?.skills ?? undefined) : undefined,
    },
  })
  const { isSubmitting } = form.formState

  const applyTemplate = (next: AgentTemplate) => {
    const options = { shouldDirty: true, shouldValidate: true }
    form.setValue("name", next.name, options)
    form.setValue("role", next.role, options)
    form.setValue("instructions", next.instructions, options)
  }

  const onSubmit = form.handleSubmit(async (input) => {
    // Skills are saved only once the person changes one; until then the
    // agent keeps following its role's recommendations. A skill Kriya has
    // since retired drops out instead of blocking the save.
    const offered = status.skills
    const changed = offered && input.skills && form.getFieldState("skills").isDirty
    const values = changed
      ? {
          ...input,
          skills: {
            ...input.skills!,
            on: input.skills!.on.filter((id) => offered.some((o) => o.id === id)),
          },
        }
      : { ...input, skills: undefined }
    const failed = (description: string) => {
      toast.add({
        type: "error",
        title: agent ? "Couldn't save the agent" : "Couldn't create the agent",
        description,
      })
    }
    try {
      if (agent) {
        const updated = await updateAgent(agent.id, values)
        if ("error" in updated) return failed(updated.error)
        toast.add({ type: "success", title: `${updated.name} updated` })
        closeDialog()
      } else {
        const created = await createAgent(values)
        if ("error" in created) return failed(created.error)
        toast.add({ type: "success", title: `${created.agent.name} is online` })
        closeDialog()
        router.push(`/a/${created.agent.id}/${created.threadId}`)
      }
    } catch {
      failed(UNEXPECTED)
    }
  })

  const instructions = useWatch({ control: form.control, name: "instructions" }) ?? ""
  const role = useWatch({ control: form.control, name: "role" }) ?? ""
  const name = useWatch({ control: form.control, name: "name" }) ?? ""

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
      <DialogHeader className="gap-1 border-b px-5 pt-5 pb-4">
        <span className="label-mono">
          {agent ? "// configure agent" : "// new agent"}
        </span>
        <DialogTitle className="text-lg font-semibold tracking-tight">
          {agent ? agent.name : "Create an agent"}
        </DialogTitle>
        <DialogDescription>
          {agent
            ? "Identity, standing orders and the model it thinks with."
            : "An agent gets its own role, its own memory and the model level you pick."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-5">
        {!agent && (
          <div className="flex flex-col gap-2">
            <span className="label-mono">Start from</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(features.editing
                ? [...agentTemplates, VIDEO_EDITOR]
                : agentTemplates
              ).map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => applyTemplate(preset)}
                  className="flex flex-col items-start gap-0.5 rounded-md border bg-background/40 px-2.5 py-2 text-left transition-colors hover:border-input hover:bg-accent/50"
                >
                  <span className="text-[13px] font-medium">{preset.name}</span>
                  <span className="line-clamp-1 font-mono text-[10.5px] text-muted-foreground">
                    {preset.role}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <FieldGroup className="gap-4">
          <div className="flex items-start gap-4">
            <Controller
              name="glyph"
              control={form.control}
              render={({ field }) => (
                <AvatarPicker
                  value={field.value ?? undefined}
                  role={role}
                  name={name}
                  onChange={(value) => field.onChange(value)}
                />
              )}
            />
            <div className="grid flex-1 gap-3">
              <Controller
                name="name"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="agent-name">Name</FieldLabel>
                    <Input
                      {...field}
                      id="agent-name"
                      placeholder="Vega"
                      autoComplete="off"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                name="role"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="agent-role">Role</FieldLabel>
                    <Input
                      {...field}
                      id="agent-role"
                      placeholder="Research analyst"
                      autoComplete="off"
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </div>
          </div>

          <Controller
            name="model"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel>Model</FieldLabel>
                <TierPicker
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  allowed={status.plan.allowedTiers}
                />
                <FieldDescription>
                  Kriya picks and updates the exact model for each level; you choose how
                  much power the agent gets.
                </FieldDescription>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            name="instructions"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <div className="flex items-baseline justify-between">
                  <FieldLabel htmlFor="agent-instructions">Standing orders</FieldLabel>
                  <span className="font-mono text-[10.5px] text-faint tabular-nums">
                    {instructions.length}/6000
                  </span>
                </div>
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  id="agent-instructions"
                  placeholder="How should it work? What should it always or never do?"
                  className="max-h-64 min-h-28 text-[13px] leading-relaxed"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          {status.apps && agent && <AppChoices apps={status.apps} agentId={agent.id} />}

          {status.skills && (
            <Controller
              name="skills"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <SkillPicker
                    options={status.skills!}
                    role={role}
                    value={field.value}
                    onChange={field.onChange}
                  />
                </Field>
              )}
            />
          )}
        </FieldGroup>
      </div>

      <DialogFooter className="mx-0 mb-0 items-center rounded-b-xl px-5 py-3">
        {agent && (
          <Confirm
            trigger={
              <Button
                type="button"
                variant="ghost"
                className="text-destructive sm:mr-auto"
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
            }
            title={`Delete ${agent.name}?`}
            description="Its threads and its memory are deleted. This can't be undone."
            action="Delete agent"
            onConfirm={async () => {
              const failed = (description: string) => {
                toast.add({
                  type: "error",
                  title: "Couldn't delete the agent",
                  description,
                })
              }
              try {
                const result = await deleteAgent(agent.id)
                if (result && "error" in result) return failed(result.error)
                toast.add({ type: "success", title: `${agent.name} deleted` })
                closeDialog()
                router.push("/home")
              } catch {
                failed(UNEXPECTED)
              }
            }}
          />
        )}
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner data-icon="inline-start" />}
          {agent ? "Save" : "Create agent"}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function AgentDialog() {
  const { dialog, closeDialog } = useWorkspace()
  const state = dialog?.kind === "agent" ? dialog : null

  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="flex max-h-[min(90svh,760px)] flex-col gap-0 p-0 sm:max-w-xl">
        {state && (
          <AgentForm
            key={state.agent?.id ?? state.template?.name ?? "new"}
            agent={state.agent}
            template={state.template}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
