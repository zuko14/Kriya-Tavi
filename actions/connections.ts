"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { CONNECTION_PROVIDERS } from "@/db/schema"
import { requireUser } from "@/lib/auth"
import { disconnect } from "@/lib/connectors"

// Revokes the grant where the provider allows it and forgets the tokens
export async function disconnectAccount(provider: string) {
  const user = await requireUser()
  await disconnect(user.id, z.enum(CONNECTION_PROVIDERS).parse(provider))
  revalidatePath("/account")
}
