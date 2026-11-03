// The container runtime behind the node agent (CD-30, CD-33). The product
// implementation is docker.ts (Docker with runsc); tests drive the same
// server through a runtime that runs the runner as a child process.

export type SandboxSpec = {
  ref: string
  workspaceId: string
  cpuMillis: number
  memMb: number
  diskMb: number
  pids: number
  // Passed to the runner only through its environment
  env: Record<string, string>
}

export type Probe = {
  ready: boolean
  reasons: string[]
  isolation: "gvisor" | "runc" | null
  imageDigest: string | null
}

export interface SandboxRuntime {
  probe(): Promise<Probe>
  // Created and started
  create(spec: SandboxSpec): Promise<void>
  start(ref: string): Promise<void>
  // Stops every process in the sandbox and starts the runner again
  restart(ref: string): Promise<void>
  // Idempotent; the disk stays
  stop(ref: string): Promise<void>
  // Idempotent; the disk goes too
  remove(ref: string): Promise<void>
  // null: no such sandbox
  inspect(ref: string): Promise<{ running: boolean } | null>
  // The runner's base URL as this host reaches it
  address(ref: string): Promise<string | null>
  list(): Promise<{ ref: string; running: boolean }[]>
  // Bytes each sandbox's disk holds, where measurable
  usage(): Promise<Map<string, number>>
}
