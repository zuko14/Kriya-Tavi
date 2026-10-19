"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import {
  cancelLogin,
  removeLogin,
  saveLogin,
  setLoginBackground,
  signInAgain,
  startLogin,
} from "@/actions/profiles"
import { LiveView } from "@/components/browser/live-view"
import { Confirm } from "@/components/confirm"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

// Account → Logins (A6, UX_SPEC §7): sites the person signed in to in
// Kriya's browser. Kriya keeps the site's session, sealed, never a password.

export type LoginItem = {
  id: string
  domain: string
  label: string
  status: "pending" | "active" | "expired"
  backgroundAllowed: boolean
  lastUsedAt: Date | null
  expiresAt: Date | null
}

type Takeover = { profileId: string; sessionId: string; domain: string; mode: string }

const DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
})

const MODES: Record<string, string> = {
  assisted: "Agents read this site as you and prepare changes; you apply them.",
  supervised: "Agents may fill and save on this site, each time with your approval.",
  api: "Agents use this site's official connection; the browser only reads it.",
}

const errorOf = (result: object) =>
  "error" in result && typeof result.error === "string" ? result.error : null

export function Logins({ logins }: { logins: LoginItem[] }) {
  const router = useRouter()
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<React.ReactNode>(null)
  const [busy, setBusy] = React.useState(false)
  const [takeover, setTakeover] = React.useState<Takeover | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [background, setBackground] = React.useState(false)
  // Rendered on the server; "now" only decides the label
  const [now] = React.useState(() => Date.now())

  const begin = async (start: () => ReturnType<typeof startLogin>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await start()
    setBusy(false)
    if ("sessionId" in result) setTakeover(result)
    else setError(errorOf(result))
  }

  const end = () => {
    setTakeover(null)
    setSaving(false)
    setBackground(false)
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          void begin(() =>
            startLogin(String(form.get("url") ?? ""), String(form.get("label") ?? ""))
          )
        }}
      >
        <Input
          name="url"
          required
          inputMode="url"
          placeholder="Site, like linkedin.com/login"
          aria-label="Site address"
          className="min-h-11 flex-1"
        />
        <Input
          name="label"
          maxLength={60}
          placeholder="Name (optional)"
          aria-label="Name for this login"
          className="min-h-11 sm:w-40"
        />
        <Button type="submit" className="min-h-11" disabled={busy}>
          Sign in
        </Button>
      </form>
      <p className="text-[12px] text-muted-foreground">
        You sign in yourself, in Kriya&apos;s browser. Kriya keeps the site&apos;s
        session, sealed, so agents can use it within the site&apos;s rules. It never keeps
        your password.
      </p>
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-[12.5px]">
          {notice}
        </p>
      )}

      {logins.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {logins.map((login) => {
            const due =
              login.status === "active" &&
              login.expiresAt !== null &&
              new Date(login.expiresAt).getTime() - now < 7 * 86_400_000
            const status =
              login.status === "pending"
                ? "Not saved"
                : login.status === "expired"
                  ? "Expired"
                  : due
                    ? "Needs re-confirmation"
                    : "Active"
            return (
              <li
                key={login.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13.5px]">
                    {login.domain}
                    {login.label !== login.domain && (
                      <span className="text-muted-foreground"> · {login.label}</span>
                    )}
                  </span>
                  <span className="font-mono text-[10.5px] text-faint">
                    {status}
                    {login.lastUsedAt &&
                      ` · used ${DATE.format(new Date(login.lastUsedAt))}`}
                  </span>
                </div>
                {login.status === "active" && (
                  <label className="flex min-h-11 items-center gap-2 text-[12px] sm:min-h-6">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={login.backgroundAllowed}
                      onChange={async (event) => {
                        const result = await setLoginBackground(
                          login.id,
                          event.currentTarget.checked
                        )
                        setError(errorOf(result))
                        router.refresh()
                      }}
                    />
                    Allow when I&apos;m not here
                  </label>
                )}
                {(login.status !== "active" || due) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="min-h-11 sm:min-h-6"
                    disabled={busy}
                    onClick={() => void begin(() => signInAgain(login.id))}
                  >
                    Sign in again
                  </Button>
                )}
                <Confirm
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="min-h-11 sm:min-h-6"
                    >
                      Remove
                    </Button>
                  }
                  title={`Remove the login for ${login.domain}?`}
                  description="Kriya deletes the saved session. Agents can't use this site as you until you sign in again."
                  action="Remove"
                  onConfirm={async () => {
                    const result = await removeLogin(login.id)
                    setError(errorOf(result))
                    if ("removed" in result) {
                      setNotice(
                        result.securityPage ? (
                          <>
                            Removed. To end the session on the site itself,{" "}
                            <a
                              href={result.securityPage}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-rigel underline"
                            >
                              sign out other sessions on {login.domain}
                            </a>
                            .
                          </>
                        ) : (
                          `Removed. To end the session on ${login.domain} itself, sign out of other sessions in its security settings.`
                        )
                      )
                    }
                    router.refresh()
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}

      {takeover && !saving && (
        <LiveView
          sessionId={takeover.sessionId}
          domain={takeover.domain}
          reason={`Sign in to ${takeover.domain} as you normally do, including any code it sends you, then press Done.`}
          onDone={() => setSaving(true)}
          onCancel={async () => {
            await cancelLogin(takeover.profileId)
            end()
          }}
        />
      )}

      <Dialog
        open={Boolean(takeover && saving)}
        onOpenChange={(open) => {
          if (!open && takeover) void cancelLogin(takeover.profileId).then(end)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save login for {takeover?.domain}?</DialogTitle>
            <DialogDescription>
              Kriya keeps this site&apos;s session (its cookies and site storage),
              encrypted. Not your password. Agents can then act as you on{" "}
              {takeover?.domain} within its rules.
            </DialogDescription>
          </DialogHeader>
          <p className="text-[12.5px]">
            {MODES[takeover?.mode ?? ""] ??
              "Kriya hasn't reviewed this site's rules, so agents only read it."}
          </p>
          <label className="flex min-h-11 items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="size-4"
              checked={background}
              onChange={(event) => setBackground(event.currentTarget.checked)}
            />
            Allow when I&apos;m not here (scheduled runs)
          </label>
          {error && (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                if (takeover) void cancelLogin(takeover.profileId).then(end)
              }}
            >
              Don&apos;t save
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={busy}
              onClick={async () => {
                if (!takeover) return
                setBusy(true)
                const result = await saveLogin(takeover.profileId, background)
                setBusy(false)
                const failure = errorOf(result)
                setError(failure)
                if (!failure) {
                  setNotice(`Saved. Agents can now use ${takeover.domain} as you.`)
                  end()
                }
              }}
            >
              Save login
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
