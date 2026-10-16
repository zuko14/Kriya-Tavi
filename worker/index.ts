import { hostname } from "node:os"

import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { privileged, rowsOf } from "@/db"
import { taskEvents, tasks, workers, type Task } from "@/db/schema"
import { runTask } from "@/lib/agent/run-task"
import { checkEnvironment } from "@/lib/env"
import { log } from "@/lib/log"
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

const shutdown = new AbortController()
const running = new Map<string, Promise<void>>()

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
    Promise.allSettled(running.values()),
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
