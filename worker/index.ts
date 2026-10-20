import { hostname } from "node:os"

import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, rowsOf } from "@/db"
import { taskEvents, tasks, workers, type Task } from "@/db/schema"
import { expireApprovals } from "@/lib/agent/approvals"
import { crossCheckEpisode, episodesToCheck, modelJudge } from "@/lib/agent/crosscheck"
import { runTask } from "@/lib/agent/run-task"
import { getSetting } from "@/lib/config"
import { checkEnvironment } from "@/lib/env"
import { log } from "@/lib/log"
import { claimFile, extractFile, modelReader } from "@/lib/extract"
import { runFactJob } from "@/lib/facts"
import { guardCanary } from "@/lib/improve"
import { markMissed } from "@/lib/radar/obligations"
import { claimJob, recoverJobs, runJob, withinCap } from "@/lib/memory/maintenance"
import { claimDueSchedules, recoverClaimedRuns, runDue } from "@/lib/schedules"
import { profileJanitor } from "@/lib/browser/profiles"
import { purgeExpired } from "@/lib/share"
import { runUndos } from "@/lib/undo"
import { exotelConfigFromEnv, exotelTelephony } from "@/lib/voice/exotel"
import { voiceHousekeeping } from "@/lib/voice/housekeeping"
import { voiceLoop } from "@/lib/voice/run-call"
import { version } from "@/package.json"

// The Kriya worker: claims queued tasks from Postgres and runs them. Any
// number of workers can run side by side; each task is held by one worker
// through a lease it renews every few seconds. A worker that dies simply
// stops renewing, and recover_tasks() hands its tasks to another.

process.env.KRIYA_SERVICE = "worker"
checkEnvironment("worker")

const WORKER_ID = `${hostname()}-${nanoid(6)}`
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 4)
const LEASE_SECONDS = 30
const IDLE_POLL_MS = 1_000
const RECOVER_MS = 15_000
const JANITOR_MS = 60 * 60_000
const SHUTDOWN_GRACE_MS = 25_000

// Memory v2 background jobs (thread summaries): their own loop, slots and
// map, so they never take a task slot or hold up claiming tasks
const MAINTENANCE_CONCURRENCY = Math.max(
  1,
  Number(process.env.MAINTENANCE_CONCURRENCY) || 1
)
const MAINTENANCE_POLL_MS = 5_000

// Schedules fire only where this is set (A3); unset it to stop new runs
const SCHEDULES_ENABLED = process.env.KRIYA_SCHEDULES_ENABLED === "1"
const SCHEDULER_POLL_MS = 30_000
// A12: how often the canary's guard metrics are checked
const CANARY_GUARD_MS = 10 * 60_000
const UNDO_POLL_MS = 5_000
const EXTRACT_POLL_MS = 5_000
const CROSS_CHECK_POLL_MS = 30_000

const shutdown = new AbortController()
const running = new Map<string, Promise<void>>()
const maintenance = new Map<string, Promise<unknown>>()

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    shutdown.signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

async function claim(): Promise<Task | null> {
  const result = await privileged.execute(
    sql`select id from kriya.claim_task(${WORKER_ID}, ${LEASE_SECONDS})`
  )
  const id = rowsOf<{ id: string }>(result)[0]?.id
  if (!id) return null
  const [task] = await privileged.select().from(tasks).where(eq(tasks.id, id))
  return task ?? null
}

function start(task: Task) {
  log.info("task claimed", { taskId: task.id, attempt: task.attempts, tier: task.tier })
  const work = runTask(task, {
    workerId: WORKER_ID,
    leaseSeconds: LEASE_SECONDS,
    shutdown: shutdown.signal,
  })
    .catch(async (error) => {
      // A bug in the runner must not strand the task: fail it visibly
      log.error("task crashed", { taskId: task.id, error })
      await privileged
        .update(tasks)
        .set({
          status: "failed",
          errorCode: "internal",
          error: "Something went wrong on our side.",
          finishedAt: new Date(),
          leaseOwner: null,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.leaseOwner, WORKER_ID)))
        .catch(() => {})
    })
    .finally(() => running.delete(task.id))
  running.set(task.id, work)
}

async function recover() {
  const result = await privileged.execute(sql`select kriya.recover_tasks() as n`)
  const n = rowsOf<{ n: number }>(result)[0]?.n ?? 0
  if (n > 0) log.warn("recovered tasks", { count: n })
}

// Stream chunks are only needed while a task is followed live; the reply
// itself is saved as a message. Rate-limit windows expire on their own.
async function janitor() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000)
  const finished = privileged
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["succeeded", "failed", "canceled"]),
        lt(tasks.finishedAt, dayAgo)
      )
    )
  await privileged.delete(taskEvents).where(inArray(taskEvents.taskId, finished))
  await privileged.execute(
    sql`delete from kriya.rate_limits where window_start < now() - interval '1 day'`
  )
  // Finished maintenance jobs are kept a week (DATA_MODEL §5)
  await privileged.execute(
    sql`delete from kriya.maintenance_jobs where status = 'done' and created_at < now() - interval '7 days'`
  )
  // Ended shares' snapshots after 7 days, and old screenshots (A5)
  if ((await getSetting("agents.files")) === "on") {
    const purged = await purgeExpired()
    if (purged > 0) log.info("files purged", { count: purged })
  }
  // A6: login state is deleted on expiry or after 90 days unused, whatever
  // the switch says (DATA_MODEL §5); unfinished sign-ins are cleared
  const profiles = await profileJanitor()
  if (profiles.expired || profiles.abandoned || profiles.resealed) {
    log.info("login profiles tidied", profiles)
  }
  // Voice: charges, transcript retention, improvement signals. Runs whether
  // or not the voice loop does, since finished calls still need them
  await voiceHousekeeping()
}

// Reading uploads (A5): one file at a time, its own loop and timer like the
// undo loop. PDFs and images need agents.fileReaderModel, and count toward
// the person's daily maintenance cap.
async function extractLoop() {
  while (!shutdown.signal.aborted) {
    try {
      if ((await getSetting("agents.files")) === "on") {
        const model = await getSetting("agents.fileReaderModel")
        const read = model ? modelReader(model) : null
        for (
          let file;
          (file = await claimFile(WORKER_ID, !!read)) && !shutdown.signal.aborted;
        ) {
          const outcome = await extractFile(file, { read, allowed: withinCap })
          log.info("file read", { fileId: file.id, outcome })
          if (outcome === "skipped") break
        }
      }
    } catch (error) {
      log.error("extract loop error", { error })
    }
    await sleep(EXTRACT_POLL_MS)
  }
}

// K7 step 2 (A7): a cheap model judges cited claims the verbatim check
// couldn't decide, never money. Its own loop and timer; needs
// agents.crossCheck and a model, and stays within the daily cap.
async function crossCheckLoop() {
  let after = new Date(Date.now() - 24 * 60 * 60_000)
  while (!shutdown.signal.aborted) {
    try {
      const model = await getSetting("agents.crossCheckModel")
      if ((await getSetting("agents.crossCheck")) === "on" && model) {
        const judge = modelJudge(model)
        for (const episode of await episodesToCheck(after)) {
          if (shutdown.signal.aborted) break
          const stored = await crossCheckEpisode(episode, { judge, allowed: withinCap })
          if (stored > 0)
            log.info("claims cross-checked", { episodeId: episode.id, stored })
          after = episode.createdAt
        }
      }
    } catch (error) {
      log.error("cross-check loop error", { error })
    }
    await sleep(CROSS_CHECK_POLL_MS)
  }
}

async function maintenanceLoop() {
  while (!shutdown.signal.aborted) {
    try {
      if ((await getSetting("agents.memoryV2")) === "on") {
        const recovered = await recoverJobs()
        if (recovered > 0) log.warn("recovered maintenance jobs", { count: recovered })
        while (maintenance.size < MAINTENANCE_CONCURRENCY && !shutdown.signal.aborted) {
          const job = await claimJob()
          if (!job) break
          maintenance.set(
            job.id,
            runJob(job).finally(() => maintenance.delete(job.id))
          )
        }
      }
    } catch (error) {
      log.error("maintenance loop error", { error })
    }
    await sleep(MAINTENANCE_POLL_MS)
  }
}

// Background runs (A3): approvals that waited too long expire as declined,
// and due schedules become ordinary tasks. Its own loop and timer, so a
// failure here never holds up claiming tasks, and the reverse.
let lastCanaryGuard = 0
async function schedulerLoop() {
  while (!shutdown.signal.aborted) {
    try {
      if ((await getSetting("agents.inbox")) === "on") {
        const expired = await expireApprovals()
        if (expired > 0) log.info("approvals expired", { count: expired })
      }
    } catch (error) {
      log.error("approval expiry failed", { error })
    }
    // A13: deadlines past their time become missed (K4); the owner's fact
    // targets are fetched (K6). Watchers are checked inside runDue (K5).
    try {
      if ((await getSetting("agents.radar")) === "on") {
        const missed = await markMissed()
        if (missed > 0) log.info("obligations missed", { count: missed })
      }
      if ((await getSetting("agents.facts")) === "on") {
        for (const result of await runFactJob()) log.info("fact fetched", result)
      }
    } catch (error) {
      log.error("radar or facts step failed", { error })
    }
    // A12: a canary whose guard metrics worsen is rolled back (AD-25)
    try {
      if (
        Date.now() - lastCanaryGuard >= CANARY_GUARD_MS &&
        (await getSetting("agents.improvement")) === "on"
      ) {
        lastCanaryGuard = Date.now()
        const result = await guardCanary()
        if (result?.breaches.length) log.warn("canary rolled back", result)
      }
    } catch (error) {
      log.error("canary guard failed", { error })
    }
    try {
      if (SCHEDULES_ENABLED) {
        for (const run of await claimDueSchedules()) {
          await runDue(run).catch((error) =>
            log.error("schedule run failed", { scheduleId: run.scheduleId, error })
          )
        }
        const recovered = await recoverClaimedRuns()
        if (recovered > 0) log.warn("recovered schedule runs", { count: recovered })
      }
    } catch (error) {
      log.error("scheduler loop error", { error })
    }
    await sleep(SCHEDULER_POLL_MS)
  }
}

// Undo (K3): compensations the person asked for change outside accounts,
// so they run here, never on the web server (invariant 5). Its own loop and
// timer, like the scheduler.
async function undoLoop() {
  while (!shutdown.signal.aborted) {
    try {
      if ((await getSetting("agents.undo")) === "on") {
        const count = await runUndos()
        if (count > 0) log.info("undos run", { count })
      }
    } catch (error) {
      log.error("undo loop error", { error })
    }
    await sleep(UNDO_POLL_MS)
  }
}

// Voice calls (docs/voice-assistant, D-05): lib/voice/run-call.ts voiceLoop,
// with its own map and VOICE_CONCURRENCY, never this file's task slots (F6).
// Exotel only; it dials only with KRIYA_VOICE_LIVE=1, voice.liveCalls on and
// to voice.testNumbers (run-call.ts). Missing config: no loop, never a fake.
function startVoice() {
  if (process.env.KRIYA_VOICE_ENABLED !== "1") return
  const exotel = exotelConfigFromEnv()
  const callerId = process.env.EXOTEL_CALLER_ID?.trim()
  const appUrl = process.env.KRIYA_APP_URL?.trim() ?? ""
  const voiceUrl = process.env.KRIYA_VOICE_URL?.trim() ?? ""
  if (
    !exotel ||
    !callerId ||
    !appUrl.startsWith("https://") ||
    !voiceUrl.startsWith("wss://")
  ) {
    log.warn(
      "voice: needs the Exotel settings, EXOTEL_CALLER_ID, an https KRIYA_APP_URL and a wss KRIYA_VOICE_URL; no calls are placed"
    )
    return
  }
  void voiceLoop({
    workerId: WORKER_ID,
    provider: exotelTelephony(exotel),
    appUrl,
    voiceUrl,
    callerId,
    concurrency: Math.max(1, Number(process.env.VOICE_CONCURRENCY) || 2),
    signal: shutdown.signal,
  }).catch((error) => log.error("voice loop stopped", { error }))
}

async function beat() {
  await privileged
    .update(workers)
    .set({ heartbeatAt: new Date(), running: running.size })
    .where(eq(workers.id, WORKER_ID))
}

async function main() {
  await privileged
    .insert(workers)
    .values({ id: WORKER_ID, version, concurrency: CONCURRENCY })
  log.info("worker started", { workerId: WORKER_ID, concurrency: CONCURRENCY, version })
  void maintenanceLoop()
  void schedulerLoop()
  void undoLoop()
  void extractLoop()
  void crossCheckLoop()
  startVoice()

  let lastRecover = 0
  let lastJanitor = 0
  let lastBeat = 0
  while (!shutdown.signal.aborted) {
    try {
      const now = Date.now()
      if (now - lastRecover > RECOVER_MS) {
        lastRecover = now
        await recover()
      }
      if (now - lastJanitor > JANITOR_MS) {
        lastJanitor = now
        await janitor().catch((error) => log.error("janitor failed", { error }))
      }
      if (now - lastBeat > 10_000) {
        lastBeat = now
        await beat()
      }

      let claimed = false
      while (running.size < CONCURRENCY && !shutdown.signal.aborted) {
        const task = await claim()
        if (!task) break
        claimed = true
        start(task)
      }
      if (!claimed) await sleep(IDLE_POLL_MS)
    } catch (error) {
      log.error("worker loop error", { error })
      await sleep(5_000)
    }
  }
}

async function stop(signal: string) {
  if (shutdown.signal.aborted) return
  log.info("worker stopping", { signal, running: running.size })
  shutdown.abort()
  // Running tasks release their leases; recovery requeues them elsewhere
  await Promise.race([
    Promise.allSettled([...running.values(), ...maintenance.values()]),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
  ])
  await privileged
    .update(workers)
    .set({ stoppedAt: new Date(), running: 0 })
    .where(eq(workers.id, WORKER_ID))
    .catch(() => {})
  log.info("worker stopped", { workerId: WORKER_ID })
  process.exit(0)
}

process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))

main().catch((error) => {
  log.error("worker failed to start", { error })
  process.exit(1)
})
