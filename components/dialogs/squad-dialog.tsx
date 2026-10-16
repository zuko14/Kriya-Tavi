"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { Trash2Icon } from "lucide-react"
import { Controller, useForm, useWatch } from "react-hook-form"

import { createSquad, deleteSquad, updateSquad } from "@/actions/squads"
import { Confirm } from "@/components/confirm"
import { Glyph, SquadGlyph } from "@/components/glyph"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { useWorkspace } from "@/components/workspace/context"
import { squadInputSchema } from "@/db/schema"
import type { NavSquad } from "@/queries/workspace"

function SquadForm({ squad }: { squad?: NavSquad }) {
  const router = useRouter()
  const { nav, closeDialog, openAgentDialog } = useWorkspace()

  const form = useForm({
    resolver: zodResolver(squadInputSchema),
    defaultValues: { name: squad?.name ?? "", agentIds: squad?.agentIds ?? [] },
  })
  const { isSubmitting } = form.formState
  const selected = useWatch({ control: form.control, name: "agentIds" })

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (squad) {
        await updateSquad(squad.id, values)
        toast.add({ type: "success", title: `${values.name} updated` })
        closeDialog()
      } else {
        const { squad: created, threadId } = await createSquad(values)
        toast.add({ type: "success", title: `${created.name} assembled` })
        closeDialog()
        router.push(`/s/${created.id}/${threadId}`)
      }
    } catch (error) {
      toast.add({
        type: "error",
        title: squad ? "Couldn't save the squad" : "Couldn't create the squad",
        description: error instanceof Error ? error.message : undefined,
      })
    }
  })

  const seeds = selected
    .map((id) => nav.agents.find((agent) => agent.id === id)?.glyph)
    .filter((seed): seed is string => !!seed)

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
      <DialogHeader className="gap-1 border-b px-5 pt-5 pb-4">
        <span className="label-mono">
          {squad ? "// configure squad" : "// new squad"}
        </span>
        <DialogTitle className="text-lg font-semibold tracking-tight">
          {squad ? squad.name : "Assemble a squad"}
        </DialogTitle>
        <DialogDescription>
          Talk to several agents in one thread. The first is the lead: it can split a
          request so the others work on their parts at the same time, or hand the whole
          thing to the one whose role fits.
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-5">
        <FieldGroup className="gap-4">
          <div className="flex items-end gap-3">
            <SquadGlyph
              seeds={seeds.length ? seeds : ["empty"]}
              className="size-[52px]"
            />
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className="flex-1">
                  <FieldLabel htmlFor="squad-name">Name</FieldLabel>
                  <Input
                    {...field}
                    id="squad-name"
                    placeholder="Launch crew"
                    autoComplete="off"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </div>

          <Controller
            name="agentIds"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <div className="flex items-baseline justify-between">
                  <FieldLabel>Members</FieldLabel>
                  <span className="font-mono text-[10.5px] text-faint">
                    {field.value.length} selected · order = who answers first
                  </span>
                </div>
                {nav.agents.length < 2 ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-3 text-[13px] text-muted-foreground">
                    You need at least two agents.
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openAgentDialog()}
                    >
                      New agent
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col divide-y rounded-md border">
                    {nav.agents.map((agent) => {
                      const checked = field.value.includes(agent.id)
                      const position = field.value.indexOf(agent.id)
                      return (
                        <label
                          key={agent.id}
                          className="flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/40"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) =>
                              field.onChange(
                                next
                                  ? [...field.value, agent.id]
                                  : field.value.filter((id) => id !== agent.id)
                              )
                            }
                          />
                          <Glyph seed={agent.glyph} className="size-6" />
                          <span className="flex min-w-0 flex-1 flex-col leading-tight">
                            <span className="truncate text-[13px] font-medium">
                              {agent.name}
                            </span>
                            <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                              {agent.role}
                            </span>
                          </span>
                          {checked && (
                            <span className="font-mono text-[10.5px] text-rigel">
                              #{position + 1}
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                )}
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </FieldGroup>
      </div>

      <DialogFooter className="mx-0 mb-0 items-center rounded-b-xl px-5 py-3">
        {squad && (
          <Confirm
            trigger={
              <Button
                type="button"
                variant="ghost"
                className="text-destructive sm:mr-auto"
              >
                <Trash2Icon data-icon="inline-start" />
                Disband
              </Button>
            }
            title={`Disband ${squad.name}?`}
            description="The squad and its threads are deleted. Its agents and their memory stay."
            action="Disband squad"
            onConfirm={async () => {
              await deleteSquad(squad.id)
              toast.add({ type: "success", title: `${squad.name} disbanded` })
              closeDialog()
              router.push("/home")
            }}
          />
        )}
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={isSubmitting || nav.agents.length < 2}>
          {isSubmitting && <Spinner data-icon="inline-start" />}
          {squad ? "Save" : "Create squad"}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function SquadDialog() {
  const { dialog, closeDialog } = useWorkspace()
  const state = dialog?.kind === "squad" ? dialog : null

  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="flex max-h-[min(90svh,720px)] flex-col gap-0 p-0 sm:max-w-lg">
        {state && <SquadForm key={state.squad?.id ?? "new"} squad={state.squad} />}
      </DialogContent>
    </Dialog>
  )
}
