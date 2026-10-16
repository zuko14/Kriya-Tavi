import type { Metadata } from "next"
import Link from "next/link"

import { Empty, Section, Table, Td } from "@/components/owner/ui"
import { Input } from "@/components/ui/input"
import { requireOwner } from "@/lib/auth"
import { formatInr } from "@/lib/money"
import { searchUsers } from "@/lib/owner"

export const metadata: Metadata = { title: "Users" }

export default async function OwnerUsers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireOwner()
  const { q = "" } = await searchParams
  const users = await searchUsers(q.slice(0, 120))

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[32px] leading-tight font-normal sm:text-[38px]">
          Users
        </h1>
        <form className="flex max-w-md gap-2" role="search">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search by email or user id"
            aria-label="Search users"
            className="h-9"
          />
        </form>
      </header>
      <Section title={q ? `Results for “${q}”` : "Newest accounts"}>
        <Table head={["email", "name", "plan", "status", "tasks", "charged", "joined"]}>
          {users.length === 0 && <Empty colSpan={7}>No accounts match.</Empty>}
          {users.map((user) => (
            <tr key={user.id}>
              <Td>
                <Link
                  href={`/owner/users/${user.id}`}
                  className="text-rigel hover:underline"
                >
                  {user.email ?? user.id}
                </Link>
                {!user.email_confirmed_at && (
                  <span className="ml-1.5 font-mono text-[10px] text-betelgeuse">
                    unverified
                  </span>
                )}
              </Td>
              <Td>{user.display_name ?? "—"}</Td>
              <Td className="font-mono">{user.plan_id}</Td>
              <Td
                className={user.status === "suspended" ? "text-destructive" : undefined}
              >
                {user.status ?? "—"}
              </Td>
              <Td className="font-mono tabular-nums">{user.tasks}</Td>
              <Td className="font-mono tabular-nums">
                {formatInr(Number(user.charged))}
              </Td>
              <Td className="font-mono text-[11.5px] text-muted-foreground">
                {new Date(user.created_at).toLocaleDateString("en-IN")}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  )
}
