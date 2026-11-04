import { promisify } from "node:util"
import { gunzip } from "node:zlib"

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
const inflate = promisify(gunzip)

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

// Request-body forms besides plain JSON (owner decision 2026-11-04,
// "Encode bodies"): the host's web application firewall (Render, no
// per-path setting) blocked harness requests whose conversation held
// commands, HTML or test code. The client (kriya-harness
// src/gateway-proxy.js) sends JSON gzip-compressed then base64-encoded,
// with `x-kriya-body: gzip+base64`; it is decoded here under size limits
// and then validated by the same schema as plain JSON. Device-token routes
// only (harnessRoute authenticates before any handler reads a body).
export const BODY_ENCODINGS = ["gzip+base64"] as const
// Limits on an encoded body: its base64 text, and the JSON it inflates to
export const MAX_ENCODED_BODY = 48 * 1024 * 1024
export const MAX_DECODED_BODY = 64 * 1024 * 1024
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The request's JSON, decoding an encoded body; a Response when it can't be read */
export async function readJson(request: Request): Promise<unknown | Response> {
  const encoding = request.headers.get("x-kriya-body")
  if (!encoding) return request.json().catch(() => undefined)
  if (encoding !== "gzip+base64")
    return fail(400, "bad_request", "That request body encoding isn't supported.")
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_ENCODED_BODY)
    return fail(413, "too_large", "That request is too large.")
  const text = (await request.text().catch(() => "")).trim()
  if (text.length > MAX_ENCODED_BODY)
    return fail(413, "too_large", "That request is too large.")
  if (!text || text.length % 4 !== 0 || !BASE64.test(text))
    return fail(400, "bad_request", "That request isn't what this API expects.")
  try {
    const json = await inflate(Buffer.from(text, "base64"), {
      maxOutputLength: MAX_DECODED_BODY,
    })
    return JSON.parse(json.toString("utf8"))
  } catch (error) {
    // RangeError: it inflates past the limit (a zip bomb stops here)
    return error instanceof RangeError
      ? fail(413, "too_large", "That request is too large.")
      : fail(400, "bad_request", "That request isn't what this API expects.")
  }
}

// The body against its schema; a Response when it isn't the contract
export async function readBody<T extends z.ZodType>(request: Request, schema: T) {
  const json = await readJson(request)
  if (json instanceof Response) return json
  const parsed = schema.safeParse(json)
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
