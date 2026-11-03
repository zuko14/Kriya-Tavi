import { renderToStaticMarkup } from "react-dom/server"
import { beforeAll, describe, expect, it, vi } from "vitest"

// The owner's "Self-hosted nodes" panel (SH7): kriya.exec_metrics() read
// through privileged, and the cloud page unchanged while the fabric is
// unused (not the provider, no node registered).

vi.mock("@/lib/auth", () => ({ requireOwner: async () => ({ id: "owner" }) }))
vi.mock("server-only", () => ({}))

import OwnerCloud from "@/app/owner/cloud/page"
import { getExecMetrics } from "@/queries/cloud"

import { cloudDb } from "./db"

let db: Awaited<ReturnType<typeof cloudDb>>

beforeAll(async () => {
  db = await cloudDb()
  delete process.env.KRIYA_CLOUD_PROVIDER
})

const page = async () => renderToStaticMarkup(await OwnerCloud())

describe("CT-SH-UI-01: the owner's self-hosted panel", () => {
  it("is hidden while the fabric is unused", async () => {
    expect(await getExecMetrics()).toBeNull()
    const html = await page()
    expect(html).toContain("Workspaces")
    expect(html).not.toContain("Self-hosted nodes")
  })

  it("shows the queue with no nodes once the provider is selfhosted", async () => {
    process.env.KRIYA_CLOUD_PROVIDER = "selfhosted"
    try {
      expect(await getExecMetrics()).toMatchObject({ waiting: 0, nodes: [] })
      const html = await page()
      expect(html).toContain("Self-hosted nodes")
      expect(html).toContain("No nodes registered.")
    } finally {
      delete process.env.KRIYA_CLOUD_PROVIDER
    }
  })

  it("shows each node's capacity against what its leases reserve", async () => {
    await db.pg.query(
      `insert into kriya.exec_nodes (id, isolation, cpu_millis, mem_mb, disk_mb, disk_free_mb, healthy, psi_mem, reason, stats_at)
       values ('n1', 'gvisor', 4000, 8192, 40960, 30720, true, 1.5, null, now() - interval '5 seconds')`
    )
    const { rows } = await db.pg.query<{ id: string }>(
      `insert into kriya.workspaces (user_id, provider, image, size, status)
       values ($1, 'selfhosted', 'kriya-runner', '2c-4g', 'running') returning id`,
      [db.user]
    )
    await db.pg.query(
      `insert into kriya.exec_leases (user_id, workspace_id, generation, node_id, ref, cpu_millis, mem_mb, disk_mb, status, granted_at, requested_at)
       values ($1, $2, 1, 'n1', $3, 2000, 4096, 10240, 'running', now(), now() - interval '2 seconds')`,
      [db.user, rows[0].id, `sh-n1-${rows[0].id}-1`]
    )

    // A registered node keeps the panel on whatever the provider
    const metrics = await getExecMetrics()
    expect(metrics).toMatchObject({
      waiting: 0,
      lastHour: { granted: 1, expired: 0, cancelled: 0, startFailed: 0 },
      nodes: [
        {
          id: "n1",
          status: "active",
          healthy: true,
          isolation: "gvisor",
          cpuMillis: 4000,
          cpuReserved: 2000,
          memReserved: 4096,
          diskReserved: 10240,
          psiMem: 1.5,
          diskFreeMb: 30720,
        },
      ],
    })
    expect(metrics?.lastHour.waitP95).toBeCloseTo(2, 0)

    const html = await page()
    expect(html).toContain("Self-hosted nodes")
    expect(html).toContain("n1")
    expect(html).toContain("healthy")
    expect(html).toContain("2.0 / 4.0") // cpu cores
    expect(html).toContain("4.0 / 8.0") // memory GB
    expect(html).toContain("30.0 GB") // free disk
  })
})
