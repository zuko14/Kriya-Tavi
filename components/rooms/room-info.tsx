"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CopyIcon, LinkIcon } from "lucide-react"

import {
  archiveRoom,
  blockPerson,
  createInvite,
  leaveRoom,
  removeMember,
  revokeInvite,
  setMemberRole,
  unblockPerson,
} from "@/actions/rooms"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { InviteRow, RoomPage } from "@/queries/rooms"

// Room info (UX_SPEC §2): members and roles, the privacy line, invite links
// for the owner and admins (shown once, then only counted), leave, archive
// and remove; block and report (R9). Every rule is the server's; this only hides what would be
// refused.

const DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
})

const ROLE = { owner: "Owner", admin: "Admin", member: "Member" } as const

export function RoomInfo({
  open,
  onOpenChange,
  room,
  me,
  invites,
  onReport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: RoomPage["room"] & {
    role: RoomPage["role"]
    members: RoomPage["members"]
    blocked: RoomPage["blocked"]
  }
  me: string
  invites: InviteRow[]
  // R9: opens the report dialog for the whole room
  onReport: () => void
}) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [link, setLink] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [maxUses, setMaxUses] = React.useState(10)
  const [busy, setBusy] = React.useState(false)
  const admin = room.role === "owner" || room.role === "admin"
  const active = room.status === "active"

  async function run(action: () => Promise<{ error: string } | { ok: true }>) {
    setError(null)
    const result = await action()
    if ("error" in result) setError(result.error)
    else router.refresh()
    return result
  }

  async function invite() {
    setBusy(true)
    setError(null)
    setCopied(false)
    const result = await createInvite({ roomId: room.id, maxUses })
    setBusy(false)
    if ("error" in result) return setError(result.error)
    setLink(result.url)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{room.title}</DialogTitle>
          <DialogDescription>
            Agents in this room read its messages. Rooms aren&apos;t end-to-end encrypted.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="label-mono">People · {room.members.length}</h3>
          <ul className="flex flex-col divide-y rounded-xl border">
            {room.members.map((member) => (
              <li
                key={member.userId}
                className="flex min-h-12 flex-wrap items-center gap-x-2 px-3 py-1.5"
              >
                {/* On phones the buttons wrap below the name instead of hiding it */}
                <span className="flex min-w-36 flex-1 flex-col leading-tight">
                  <span className="truncate text-[13.5px] font-medium">
                    {member.name}
                    {member.userId === me && " (you)"}
                  </span>
                  <span className="text-[11.5px] text-muted-foreground">
                    {ROLE[member.role]}
                    {room.blocked.includes(member.userId) && " · Blocked"}
                  </span>
                </span>
                {/* R9 (RD-18): anyone blocks anyone else, privately */}
                {member.userId !== me &&
                  (room.blocked.includes(member.userId) ? (
                    <Button
                      variant="ghost"
                      className="h-11"
                      onClick={() => run(() => unblockPerson({ userId: member.userId }))}
                    >
                      Unblock
                    </Button>
                  ) : (
                    <Confirm
                      trigger={
                        <Button variant="ghost" className="h-11">
                          Block
                        </Button>
                      }
                      title={`Block ${member.name}?`}
                      description="Their messages collapse for you, they can't ask your agents, and neither of you can join a room through the other's invite. They aren't told."
                      action="Block"
                      onConfirm={async () => {
                        await run(() => blockPerson({ userId: member.userId }))
                      }}
                    />
                  ))}
                {admin && member.userId !== me && member.role !== "owner" && (
                  <Button
                    variant="ghost"
                    className="h-11"
                    onClick={() =>
                      run(() =>
                        setMemberRole({
                          roomId: room.id,
                          userId: member.userId,
                          role: member.role === "admin" ? "member" : "admin",
                        })
                      )
                    }
                  >
                    {member.role === "admin" ? "Make member" : "Make admin"}
                  </Button>
                )}
                {admin && member.userId !== me && member.role !== "owner" && (
                  <Confirm
                    trigger={
                      <Button variant="ghost" className="h-11 text-destructive">
                        Remove
                      </Button>
                    }
                    title={`Remove ${member.name}?`}
                    description="They lose access to this room at once and can't join it again."
                    action="Remove"
                    onConfirm={async () => {
                      await run(() =>
                        removeMember({ roomId: room.id, userId: member.userId })
                      )
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>

        {admin && active && (
          <section className="flex flex-col gap-2">
            <h3 className="label-mono">Invite</h3>
            <p className="text-[12.5px] text-muted-foreground">
              Anyone with the link and a Kriya account can join until it expires or is
              used up. The link is shown once.
            </p>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-[13px]">
                Uses
                <select
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                  className="h-11 rounded-lg border bg-background px-2 text-[13px]"
                >
                  {[1, 5, 10, 25].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Button onClick={invite} disabled={busy} className="h-11">
                <LinkIcon />
                {busy ? "Making…" : "Make a link"}
              </Button>
            </div>
            {link && (
              <div className="flex items-center gap-2 rounded-xl border p-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">
                  {link}
                </code>
                <Button
                  variant="outline"
                  className="h-11 shrink-0"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link).catch(() => {})
                    setCopied(true)
                  }}
                >
                  <CopyIcon />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            )}
            {invites.length > 0 && (
              <ul className="flex flex-col divide-y rounded-xl border">
                {invites.map((i) => (
                  <li key={i.id} className="flex min-h-12 items-center gap-2 px-3 py-1.5">
                    <span className="flex-1 text-[12.5px] text-muted-foreground">
                      {i.uses} of {i.maxUses} used · until{" "}
                      {DATE.format(new Date(i.expiresAt))}
                    </span>
                    <Button
                      variant="ghost"
                      className="h-11"
                      onClick={() =>
                        run(() => revokeInvite({ roomId: room.id, inviteId: i.id }))
                      }
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" className="h-11" onClick={onReport}>
            Report room
          </Button>
          {room.role !== "owner" && (
            <Confirm
              trigger={
                <Button variant="destructive" className="h-11">
                  Leave room
                </Button>
              }
              title="Leave this room?"
              description="You stop seeing it. Someone can invite you back."
              action="Leave"
              onConfirm={async () => {
                const result = await leaveRoom(room.id)
                if ("error" in result) setError(result.error)
                else router.push("/rooms")
              }}
            />
          )}
          {admin && active && (
            <Confirm
              trigger={
                <Button variant="outline" className="h-11">
                  Archive room
                </Button>
              }
              title="Archive this room?"
              description="Everyone can still read it, but nobody can post in it."
              action="Archive"
              onConfirm={async () => {
                await run(() => archiveRoom(room.id))
              }}
            />
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
