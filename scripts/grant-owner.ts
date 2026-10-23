// The owner bootstrap. Platform roles can't be granted from the app or from
// sign-up data: only by someone holding the database credentials, running
//
//   DATABASE_URL=... npm run owner:grant -- person@example.com
//   DATABASE_URL=... npm run owner:grant -- person@example.com --revoke
//
// The account must already exist and have a confirmed email address.

import postgres from "postgres"

const arg = process.argv[2] === "--" ? process.argv[3] : process.argv[2]
const email = arg?.trim().toLowerCase()
const revoke = process.argv.includes("--revoke")
const url = process.env.DATABASE_URL || process.env.MIGRATION_DATABASE_URL

if (!email || !email.includes("@") || !url) {
  console.error("Usage: DATABASE_URL=... npm run owner:grant -- <email> [--revoke]")
  process.exit(1)
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

async function main() {
  const [user] = await sql<{ id: string; email_confirmed_at: Date | null }[]>`
    select id, email_confirmed_at from auth.users where lower(email) = ${email}`
  if (!user) throw new Error(`No account with the email ${email}. Sign up first.`)
  if (!user.email_confirmed_at)
    throw new Error(`${email} hasn't confirmed its email address yet.`)

  if (revoke) {
    await sql`delete from kriya.platform_roles where user_id = ${user.id}`
  } else {
    await sql`insert into kriya.platform_roles (user_id, role) values (${user.id}, 'owner')
              on conflict (user_id) do update set role = 'owner'`
  }
  await sql`insert into kriya.audit_events (action, target_type, target_id, details)
            values (${revoke ? "owner.revoke" : "owner.grant"}, 'user', ${user.id},
                    ${sql.json({ via: "scripts/grant-owner.ts" })})`
  console.log(`${revoke ? "Revoked" : "Granted"} owner for ${email} (${user.id}).`)
}

main()
  .catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  .finally(() => sql.end())
