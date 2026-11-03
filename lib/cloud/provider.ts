import type { Limits } from "@/runner/protocol"

// The provider boundary (track C, CD-05; TOOLS_AND_CONTRACTS §1): lifecycle
// only. Every operation on files and commands goes to the runner inside
// the sandbox (lib/cloud/client.ts).

export type WorkspaceSpec = {
  workspaceId: string
  userId: string
  generation: number
  // cloud.image: the provider's template id
  image: string
  size: string
  network: "registries" | "offline"
  // runnerToken(workspaceId, generation), CD-09: only ever the runner
  // process's environment, never a URL, tag or log
  runnerToken: string
  limits: Partial<Limits>
  // Provider-side auto-stop if Kriya stops extending
  timeoutSeconds: number
}

// headers: what the provider's front proxy needs on every runner call (a
// traffic token), beside the runner's own bearer token
export type Opened = { ref: string; runnerUrl: string; headers?: Record<string, string> }

export interface WorkspaceProvider {
  readonly name: "local" | "e2b" | "daytona" | "device" | "selfhosted"
  create(spec: WorkspaceSpec): Promise<Opened>
  // null: the provider no longer has it (destroyed, expired) → restore path
  resume(ref: string, spec: WorkspaceSpec): Promise<Opened | null>
  pause(ref: string): Promise<void>
  // Idempotent
  destroy(ref: string): Promise<void>
  extend(ref: string, seconds: number): Promise<void>
  // Reconcile: every sandbox this deployment owns
  list(): Promise<{ ref: string; workspaceId: string | null; running: boolean }[]>
}

// A provider's refusal in words the person can read; payloads stay out
export class WorkspaceProviderError extends Error {}

// The repository at one commit as a gzip tar, the shape of githubTarball
// (C5); ref null means the default branch, and the answer names the branch
// it resolved to
export type RepoSource = {
  tarball(
    userId: string,
    repo: string,
    ref: string | null
  ): Promise<{
    sha: string
    ref?: string
    body: ReadableStream<Uint8Array> | Uint8Array
    bytes: number | null
  }>
}

// CD-12 `registries`: package registries only (npm, PyPI and its file host,
// crates.io, the Go module proxy), for providers with a domain allow-list
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
]

// The runner process's whole environment from Kriya: its token, limits and
// generation (CD-09). Adapters pass it only to the process they start
// inside the sandbox, never to a create call, tag, URL or log
export const runnerEnvironment = (spec: WorkspaceSpec) => ({
  KRIYA_RUNNER_TOKEN: spec.runnerToken,
  KRIYA_RUNNER_LIMITS: JSON.stringify(spec.limits),
  KRIYA_RUNNER_GENERATION: String(spec.generation),
})
