import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { asUser, createTestDb, createUser, type TestDb } from "./harness"

// 20270501000000_cloud_fabric.sql (SH1, CD-29, CD-31, CD-32): the capacity
// queue below open_workspace_session. Leases are granted in fair order onto
// the best-fitting healthy node, never past a node's memory or disk, with
// backpressure instead of unbounded queues, and no client role sees either
// table (CT-SH-DB-01…14).

let pg: TestDb

const POLICY = {
  admission: "on",
  isolation: "gvisor",
  cpuOvercommitPct: 100,
  maxPerUser: 1,
  maxQueued: 50,
  maxQueuedPerUser: 2,
  starvationSeconds: 120,
  staleSeconds: 90,
  abandonSeconds: 30,
  psiCpuMax: 60,
  psiMemMax: 10,
  psiIoMax: 40,
}
type Policy = typeof POLICY

async function node(
  id: string,
  set: Partial<{
    cpu: number
    mem: number
    disk: number
    isolation: string
    status: string
    healthy: boolean
    psiMem: number
    statsAgo: number
    diskFree: number
  }> = {}
) {
  await pg.query(
    `insert into kriya.exec_nodes (id, status, isolation, cpu_millis, mem_mb, disk_mb, disk_free_mb, healthy, psi_mem, stats_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - make_interval(secs => $10))`,
    [
      id,
      set.status ?? "active",
      set.isolation ?? "gvisor",
      set.cpu ?? 4000,
      set.mem ?? 8192,
      set.disk ?? 40_000,
      set.diskFree ?? 40_000,
      set.healthy ?? true,
      set.psiMem ?? 0,
      set.statsAgo ?? 5,
    ]
  )
}

async function workspace(user: string) {
  const { rows } = await pg.query<{ id: string }>(
    `insert into kriya.workspaces (user_id, provider, image, size, status)
     values ($1, 'selfhosted', 'kriya-runner', '2c-4g', 'paused') returning id`,
    [user]
  )
  return rows[0].id
}

async function request(
  user: string,
  ws: string,
  size: Partial<{ cpu: number; mem: number; disk: number }> = {},
  extra: Partial<{
    pinned: string
    replaces: number
    generation: number
    policy: Policy
  }> = {}
) {
  const { rows } = await pg.query<{ id: string }>(
    "select kriya.exec_request($1, $2, $3, $4, $5, $6, $7, $8, 0, $9) as id",
    [
      user,
      ws,
      extra.generation ?? 1,
      size.cpu ?? 2000,
      size.mem ?? 4096,
      size.disk ?? 10_000,
      extra.pinned ?? null,
      extra.replaces ?? null,
      JSON.stringify(extra.policy ?? POLICY),
    ]
  )
  return Number(rows[0].id)
}

async function admit(lease: number, policy: Policy = POLICY) {
  const { rows } = await pg.query<{
    lease_status: string
    node_id: string | null
    ref: string | null
  }>("select * from kriya.exec_admit($1, $2)", [lease, JSON.stringify(policy)])
  return rows[0]
}

const status = async (lease: number) =>
  (
    await pg.query<{ status: string }>(
      "select status from kriya.exec_leases where id = $1",
      [lease]
    )
  ).rows[0].status

const age = (lease: number, seconds: number) =>
  pg.query(
    "update kriya.exec_leases set requested_at = now() - make_interval(secs => $2) where id = $1",
    [lease, seconds]
  )

// One database for the file; each case starts from an empty fabric
beforeAll(async () => {
  pg = await createTestDb()
})

beforeEach(async () => {
  await pg.query("delete from kriya.exec_leases")
  await pg.query("delete from kriya.exec_nodes")
  await pg.query("delete from kriya.workspaces")
})

describe("exec_request", () => {
  it("CT-SH-DB-01: refuses another person's workspace", async () => {
    const [alice, bob] = [await createUser(pg), await createUser(pg)]
    const ws = await workspace(alice)
    await expect(request(bob, ws)).rejects.toThrow(/another person/)
  })

  it("CT-SH-DB-02: one waiter per workspace; a later request supersedes a crashed one", async () => {
    const alice = await createUser(pg)
    const ws = await workspace(alice)
    const first = await request(alice, ws)
    const second = await request(alice, ws)
    expect(await status(first)).toBe("cancelled")
    expect(await status(second)).toBe("waiting")
  })

  it("CT-SH-DB-03: backpressure when the queue or the person's share is full", async () => {
    const policy = { ...POLICY, maxQueued: 3, maxQueuedPerUser: 2 }
    const alice = await createUser(pg)
    await request(alice, await workspace(alice), {}, { policy })
    await request(alice, await workspace(alice), {}, { policy })
    await expect(request(alice, await workspace(alice), {}, { policy })).rejects.toThrow(
      /queue is full/
    )
    const bob = await createUser(pg)
    await request(bob, await workspace(bob), {}, { policy })
    const carol = await createUser(pg)
    await expect(request(carol, await workspace(carol), {}, { policy })).rejects.toThrow(
      /queue is full/
    )
  })

  it("CT-SH-DB-04: a waiter that stops polling is abandoned", async () => {
    const [alice, bob] = [await createUser(pg), await createUser(pg)]
    const silent = await request(alice, await workspace(alice))
    await pg.query(
      "update kriya.exec_leases set polled_at = now() - interval '1 minute' where id = $1",
      [silent]
    )
    await request(bob, await workspace(bob))
    expect(await status(silent)).toBe("expired")
  })
})

describe("exec_admit", () => {
  it("CT-SH-DB-05: best fit — the node left with the least memory", async () => {
    await node("big", { mem: 16_384 })
    await node("small", { mem: 5000 })
    const alice = await createUser(pg)
    const ws = await workspace(alice)
    const lease = await request(alice, ws)
    const got = await admit(lease)
    expect(got).toEqual({
      lease_status: "granted",
      node_id: "small",
      ref: `sh-small-${ws}-1`,
    })
  })

  it("CT-SH-DB-06: memory is never overcommitted; CPU only by the policy", async () => {
    await node("n1", { cpu: 2000, mem: 8192 })
    const users = await Promise.all([createUser(pg), createUser(pg), createUser(pg)])
    const leases = []
    for (const u of users) leases.push(await request(u, await workspace(u)))
    // CPU 2000 at 100%: one 2-CPU sandbox
    for (const l of leases) await admit(l)
    expect(await Promise.all(leases.map(status))).toEqual([
      "granted",
      "waiting",
      "waiting",
    ])
    // 200% CPU: a second fits (memory 8192 = 2 × 4096), a third never does
    const over = { ...POLICY, cpuOvercommitPct: 200 }
    for (const l of leases) await admit(l, over)
    expect(await Promise.all(leases.map(status))).toEqual([
      "granted",
      "granted",
      "waiting",
    ])
    await admit(leases[2], { ...POLICY, cpuOvercommitPct: 400 })
    expect(await status(leases[2])).toBe("waiting")
  })

  it("CT-SH-DB-07: fair share — everyone's first lease before anyone's second", async () => {
    await node("n1", { cpu: 8000, mem: 8192 })
    const policy = { ...POLICY, maxPerUser: 2 }
    const [alice, bob] = [await createUser(pg), await createUser(pg)]
    const a1 = await request(alice, await workspace(alice), {}, { policy })
    const a2 = await request(alice, await workspace(alice), {}, { policy })
    await age(a1, 20)
    await age(a2, 19)
    const b1 = await request(bob, await workspace(bob), {}, { policy })
    // Alice asked first twice; Bob still gets one of the two slots
    await admit(a1, policy)
    expect(await status(a1)).toBe("granted")
    expect(await status(b1)).toBe("granted")
    expect(await status(a2)).toBe("waiting")
  })

  it("CT-SH-DB-08: the per-person ceiling holds however much is free", async () => {
    await node("n1", { cpu: 64_000, mem: 65_536 })
    const alice = await createUser(pg)
    const a1 = await request(alice, await workspace(alice))
    await admit(a1)
    const a2 = await request(alice, await workspace(alice))
    await admit(a2)
    expect(await status(a1)).toBe("granted")
    expect(await status(a2)).toBe("waiting")
  })

  it("CT-SH-DB-09: a starving large request stops smaller ones from jumping ahead", async () => {
    await node("n1", { cpu: 8000, mem: 8192 })
    const [alice, bob, carol] = [
      await createUser(pg),
      await createUser(pg),
      await createUser(pg),
    ]
    const small1 = await request(alice, await workspace(alice), { mem: 4096 })
    await admit(small1)
    // Bob needs the whole node and has waited past starvationSeconds
    const big = await request(bob, await workspace(bob), { mem: 8192 })
    await age(big, 300)
    const small2 = await request(carol, await workspace(carol), { mem: 2048 })
    await admit(small2)
    expect(await status(big)).toBe("waiting")
    expect(await status(small2)).toBe("waiting")
    // Not starving yet: smaller work backfills
    await age(big, 10)
    await admit(small2)
    expect(await status(small2)).toBe("granted")
  })

  it("CT-SH-DB-16: a starving waiter that can't fit anywhere blocks nobody else", async () => {
    await node("sick", { healthy: false })
    await node("n1", { cpu: 8000, mem: 8192 })
    const [alice, bob, carol] = [
      await createUser(pg),
      await createUser(pg),
      await createUser(pg),
    ]
    // A resume pinned to a node that is down, starving
    const ws = await workspace(alice)
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status)
       values ($1, $2, 1, 'sick', $3, 2000, 4096, 10000, 'stopped') returning id`,
      [alice, ws, `sh-sick-${ws}-1`]
    )
    const pinned = await request(
      alice,
      ws,
      {},
      { pinned: "sick", replaces: Number(rows[0].id) }
    )
    await age(pinned, 300)
    // A request bigger than any whole node, starving
    const huge = await request(bob, await workspace(bob), { mem: 65_536 })
    await age(huge, 300)
    const small = await request(carol, await workspace(carol), { mem: 2048 })
    await admit(small)
    expect(await status(small)).toBe("granted")
    expect(await status(pinned)).toBe("waiting")
    expect(await status(huge)).toBe("waiting")
  })

  it("CT-SH-DB-17: a starving resume holds its own node only", async () => {
    await node("a", { cpu: 8000, mem: 8192 })
    await node("b", { cpu: 8000, mem: 8192 })
    const [alice, bob, carol] = [
      await createUser(pg),
      await createUser(pg),
      await createUser(pg),
    ]
    // Node a is busy; Alice's resume there is starving
    const busy = await request(bob, await workspace(bob), { mem: 6144 })
    await admit(busy, { ...POLICY, placement: "spread" } as Policy)
    const { rows: busyAt } = await pg.query<{ node_id: string }>(
      "select node_id from kriya.exec_leases where id = $1",
      [busy]
    )
    const held = busyAt[0].node_id
    const ws = await workspace(alice)
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status)
       values ($1, $2, 1, $3, $4, 2000, 4096, 10000, 'stopped') returning id`,
      [alice, ws, held, `sh-${held}-${ws}-1`]
    )
    const resume = await request(
      alice,
      ws,
      {},
      { pinned: held, replaces: Number(rows[0].id) }
    )
    await age(resume, 300)
    // Carol fits on either node: she goes to the other one, never ahead of
    // Alice on hers
    const small = await request(carol, await workspace(carol), { mem: 2048 })
    const got = await admit(small)
    expect(got.lease_status).toBe("granted")
    expect(got.node_id).not.toBe(held)
    expect(await status(resume)).toBe("waiting")
  })

  it("CT-SH-DB-10: unhealthy, stale, pressured or runc nodes take nothing", async () => {
    await node("sick", { healthy: false })
    await node("stale", { statsAgo: 600 })
    await node("swapping", { psiMem: 35 })
    await node("runc", { isolation: "runc" })
    await node("full", { diskFree: 100 })
    const alice = await createUser(pg)
    const lease = await request(alice, await workspace(alice))
    expect((await admit(lease)).lease_status).toBe("waiting")
    // runc only when the owner chose trusted-runc
    const got = await admit(lease, { ...POLICY, isolation: "trusted-runc" })
    expect(got.node_id).toBe("runc")
  })

  it("CT-SH-DB-11: a draining node resumes its own sandboxes and starts no new ones", async () => {
    await node("old", { status: "draining" })
    const alice = await createUser(pg)
    const ws = await workspace(alice)
    // A stopped sandbox on the draining node
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status)
       values ($1, $2, 3, 'old', $3, 2000, 4096, 10000, 'stopped') returning id`,
      [alice, ws, `sh-old-${ws}-3`]
    )
    const stopped = Number(rows[0].id)
    const fresh = await request(alice, await workspace(alice))
    expect((await admit(fresh)).lease_status).toBe("waiting")
    await pg.query("update kriya.exec_leases set status = 'cancelled' where id = $1", [
      fresh,
    ])
    const resume = await request(
      alice,
      ws,
      {},
      { pinned: "old", replaces: stopped, generation: 3 }
    )
    const got = await admit(resume)
    expect(got).toEqual({
      lease_status: "granted",
      node_id: "old",
      ref: `sh-old-${ws}-3`,
    })
    // The fence moved forward and the old lease is gone
    expect(resume).toBeGreaterThan(stopped)
    expect(await status(stopped)).toBe("released")
  })

  it("CT-SH-DB-12: a resume doesn't count its own disk twice; one live lease per ref", async () => {
    await node("n1", { disk: 10_000, diskFree: 0 })
    const alice = await createUser(pg)
    const ws = await workspace(alice)
    const { rows } = await pg.query<{ id: string }>(
      `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status)
       values ($1, $2, 1, 'n1', $3, 2000, 4096, 10000, 'stopped') returning id`,
      [alice, ws, `sh-n1-${ws}-1`]
    )
    const resume = await request(
      alice,
      ws,
      {},
      { pinned: "n1", replaces: Number(rows[0].id) }
    )
    expect((await admit(resume)).lease_status).toBe("granted")
    await expect(
      pg.query(
        `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status)
         values ($1, $2, 1, 'n1', $3, 1, 64, 0, 'stopped')`,
        [alice, ws, `sh-n1-${ws}-1`]
      )
    ).rejects.toThrow(/exec_leases_one_live_ref/)
    // A request can't take over a lease of another workspace
    const other = await workspace(alice)
    await expect(
      request(alice, other, {}, { pinned: "n1", replaces: Number(rows[0].id) })
    ).rejects.toThrow(/doesn't own/)
  })

  it("CT-SH-DB-13: the kill switch leaves everyone waiting; granted leases stay granted", async () => {
    await node("n1")
    const alice = await createUser(pg)
    const lease = await request(alice, await workspace(alice))
    expect((await admit(lease, { ...POLICY, admission: "off" })).lease_status).toBe(
      "waiting"
    )
    await admit(lease)
    expect((await admit(lease, { ...POLICY, admission: "off" })).lease_status).toBe(
      "granted"
    )
  })

  it("CT-SH-DB-14: no client role reads or writes the fabric; metrics add up", async () => {
    await node("n1")
    const alice = await createUser(pg)
    const lease = await request(alice, await workspace(alice))
    await admit(lease)
    const seen = await asUser(pg, alice, async (tx) => ({
      leases: (await tx.query("select * from kriya.exec_leases")).rows.length,
      nodes: (await tx.query("select * from kriya.exec_nodes")).rows.length,
    })).catch(() => "denied")
    expect([{ leases: 0, nodes: 0 }, "denied"]).toContainEqual(seen)
    await expect(
      asUser(pg, alice, (tx) => tx.query("select kriya.exec_metrics()"))
    ).rejects.toThrow()
    const { rows } = await pg.query<{ m: Record<string, unknown> }>(
      "select kriya.exec_metrics() as m"
    )
    expect(rows[0].m).toMatchObject({
      waiting: 0,
      nodes: [{ id: "n1", memReserved: 4096, cpuReserved: 2000, diskReserved: 10_000 }],
    })
  })
})
