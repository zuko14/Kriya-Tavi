import fs from "node:fs/promises"
import os from "node:os"

// What a node measures about itself (CD-32): PSI pressure, memory, disk and
// inodes. Linux only; elsewhere (a developer's Mac) the measured fields are
// null and the control plane treats the node as unmeasured.

// /proc/pressure/<resource>: "some avg10=1.23 avg60=… total=…"; the some
// line's avg10 (percent of the last ~10 s with at least one task stalled)
export function parsePsi(text: string): number | null {
  const match = /^some avg10=([\d.]+)/m.exec(text)
  return match ? Number(match[1]) : null
}

// /proc/meminfo in kB → MB
export function parseMeminfo(text: string) {
  const field = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)
    return match ? Math.floor(Number(match[1]) / 1024) : null
  }
  return { totalMb: field("MemTotal"), availableMb: field("MemAvailable") }
}

const read = (file: string) => fs.readFile(file, "utf8").catch(() => null)

export async function measure(dataDir: string) {
  const [cpu, memory, io, meminfo] = await Promise.all([
    read("/proc/pressure/cpu"),
    read("/proc/pressure/memory"),
    read("/proc/pressure/io"),
    read("/proc/meminfo"),
  ])
  const mem = meminfo ? parseMeminfo(meminfo) : { totalMb: null, availableMb: null }
  const disk = await fs.statfs(dataDir).catch(() => null)
  return {
    cpus: os.availableParallelism(),
    memTotalMb: mem.totalMb ?? Math.floor(os.totalmem() / 1024 / 1024),
    memAvailableMb: mem.availableMb,
    diskTotalMb: disk ? Math.floor((disk.blocks * disk.bsize) / 1024 / 1024) : null,
    diskFreeMb: disk ? Math.floor((disk.bavail * disk.bsize) / 1024 / 1024) : null,
    inodesFree: disk ? disk.ffree : null,
    psi: {
      cpu: cpu ? parsePsi(cpu) : null,
      memory: memory ? parsePsi(memory) : null,
      io: io ? parsePsi(io) : null,
    },
    load1: process.platform === "linux" ? os.loadavg()[0] : null,
  }
}
