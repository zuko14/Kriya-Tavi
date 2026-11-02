import type { z } from "zod"

import { authenticateDevice, type DeviceUser } from "@/lib/auth"
import { getSetting } from "@/lib/config"
import { SEMVER } from "@/lib/harness/contract"
import { log } from "@/lib/log"
import { allow } from "@/lib/rate-limit"

// Every Kriya Harness route goes through this (API_AND_CONTRACTS §1): the
// switch (off → 404 saying nothing), the client version (below the minimum
// → 426), the device token (401, or 403 for a suspended person), requests per
// minute per device (429) and plain errors. Logs carry the path, status and
// device id only (HD-17), never a body.

const NO_STORE = { "cache-control": "no-store" }

export const fail = (
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {}
) => Response.json({ error, message, ...extra }, { status, headers: NO_STORE })

export const ok = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: NO_STORE })

const version = (text: string) => text.split(".").map(Number)
function older(client: string, minimum: string) {
  const [a, b] = [version(client), version(minimum)]
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

// The client's address, from Render's proxy
export const addressOf = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"

// The body against its schema; a Response when it isn't the contract
export async function readBody<T extends z.ZodType>(request: Request, schema: T) {
  const parsed = schema.safeParse(await request.json().catch(() => undefined))
  return parsed.success
    ? (parsed.data as z.infer<T>)
    : fail(400, "bad_request", "That request isn't what this API expects.")
}

type Route<D> = (request: Request, device: D) => Promise<Response>

export function harnessRoute(
  auth: true,
  handler: Route<DeviceUser>
): (request: Request) => Promise<Response>
export function harnessRoute(
  auth: false,
  handler: Route<null>
): (request: Request) => Promise<Response>
// The overloads pair `auth` with the handler's device type
export function harnessRoute(auth: boolean, handler: Route<never>) {
  return async (request: Request) => {
    const path = new URL(request.url).pathname
    if ((await getSetting("harness.api")) !== "on")
      return fail(404, "not_found", "Not found.")
    const minimum = (await getSetting("harness.minClientVersion")) ?? "0.0.0"
    const client = request.headers.get("x-kriya-harness") ?? ""
    if (!SEMVER.test(client) || older(client, minimum)) {
      return fail(426, "upgrade", `Update Kriya Harness to ${minimum} or later.`, {
        minVersion: minimum,
      })
    }
    let device: DeviceUser | null = null
    if (auth) {
      const found = await authenticateDevice(request)
      if (found === "suspended")
        return fail(403, "suspended", "This Kriya account is paused.")
      if (!found) return fail(401, "unauthorized", "Sign in again with kriya login.")
      const rpm = Number.parseInt((await getSetting("harness.rpm")) ?? "", 10) || 60
      if (!(await allow(`harness:rpm:${found.deviceId}`, rpm, 60))) {
        return fail(429, "rate_limited", "Too many requests; slow down.", {
          retryAfter: 60,
        })
      }
      device = found
    }
    try {
      return await handler(request, device as never)
    } catch (error) {
      log.error("harness route failed", {
        path,
        deviceId: device?.deviceId,
        error: error instanceof Error ? error.name : "unknown",
      })
      return fail(500, "server_error", "Something went wrong. Try again.")
    }
  }
}
