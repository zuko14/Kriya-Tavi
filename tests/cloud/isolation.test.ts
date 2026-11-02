import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { RunnerClient } from "@/lib/cloud/client"
import type { Opened, WorkspaceProvider, WorkspaceSpec } from "@/lib/cloud/provider"
import { LocalWorkspaceProvider } from "@/lib/cloud/providers/local"
import { healthy, workspaceProvider } from "@/lib/cloud/session"
import { runnerToken } from "@/lib/cloud/token"

import { dockerAvailable, DockerProvider, imageExists } from "./docker-provider"

// The isolation suite (SECURITY_AND_THREATS §4, CT-ISO-*; gate CR-2): probes
// sent from inside a sandbox through the runner protocol, as the command
// user, exactly as workspace_run sends them. The target decides what is
// proven:
//
//   KRIYA_ISO_TARGET unset    `npm run check`: CT-ISO-08 on the local
//                             provider only (no isolation exists there)
//   KRIYA_ISO_TARGET=docker   the real runner image (runner/Dockerfile,
//                             KRIYA_ISO_IMAGE, default kriya-runner:c9) on
//                             this machine's Docker: the user split, the
//                             token's reach and the runner's signals
//   KRIYA_ISO_TARGET=provider cloud.provider's real adapter (owner-approved,
//                             paid; CB-02): everything, which is CR-2
//
// Egress (CT-ISO-03…05) is enforced by the image itself (CD-12: the root
// runner's firewall lets `kriya` reach loopback only, and its proxy reaches
// the registries only), so it is asserted on both isolated targets;
// KRIYA_ISO_EGRESS=off records instead (an image from before C9). Each
// address is tried directly (--noproxy, the firewall) and as a CONNECT
// through the proxy. CT-ISO-05 needs the internet (the registries).
// CT-ISO-02 needs a provider's network: provider target only.

const TARGET = process.env.KRIYA_ISO_TARGET ?? "local"
const IMAGE = process.env.KRIYA_ISO_IMAGE ?? "kriya-runner:c9"
const EGRESS = process.env.KRIYA_ISO_EGRESS !== "off"
const isolated = TARGET === "docker" || TARGET === "provider"

process.env.KRIYA_WORKSPACE_SECRET ??= "s".repeat(43)

const report: Record<string, unknown> = {
  target: TARGET,
  image: TARGET === "docker" ? IMAGE : undefined,
  egressEnforced: EGRESS,
  at: new Date().toISOString(),
}

async function targetProvider(): Promise<WorkspaceProvider | null> {
  if (TARGET === "docker")
    return (await dockerAvailable()) && (await imageExists(IMAGE))
      ? new DockerProvider(IMAGE)
      : null
  if (TARGET === "provider") return workspaceProvider()
  // The local provider refuses to run anywhere but a local stack
  process.env.KRIYA_WORKSPACE_LOCAL = "1"
  process.env.DATABASE_URL ??= "postgres://127.0.0.1:5432/isolation-suite"
  return new LocalWorkspaceProvider()
}

function specFor(
  workspaceId: string,
  generation = 1,
  network: WorkspaceSpec["network"] = "registries"
): WorkspaceSpec {
  return {
    workspaceId,
    userId: randomUUID(),
    generation,
    image: IMAGE,
    size: "2c-4g",
    network,
    runnerToken: runnerToken(workspaceId, generation),
    limits: { commandTimeoutSeconds: 60, network },
    timeoutSeconds: 600,
  }
}

async function open(provider: WorkspaceProvider, spec: WorkspaceSpec) {
  const opened: Opened = await provider.create(spec)
  const client = new RunnerClient(
    opened.runnerUrl,
    spec.runnerToken,
    60_000,
    opened.headers
  )
  await healthy(client, spec.generation, 60_000)
  return { opened, client }
}

const sh = async (client: RunnerClient, command: string, timeoutSeconds = 30) => {
  const end = await client.exec({ command, timeoutSeconds })
  return {
    exitCode: end.exitCode,
    stdout: end.stdout,
    stderr: end.stderr,
    timedOut: end.timedOut,
  }
}

let provider: WorkspaceProvider | null = null
let sandbox: { opened: Opened; client: RunnerClient; spec: WorkspaceSpec } | null = null

beforeAll(async () => {
  provider = await targetProvider()
  if (provider && isolated) {
    const spec = specFor(randomUUID())
    sandbox = { ...(await open(provider, spec)), spec }
  }
}, 120_000)

afterAll(async () => {
  if (sandbox && provider) await provider.destroy(sandbox.opened.ref)
  if (process.env.KRIYA_ISO_REPORT) {
    fs.mkdirSync(path.dirname(process.env.KRIYA_ISO_REPORT), { recursive: true })
    fs.writeFileSync(process.env.KRIYA_ISO_REPORT, JSON.stringify(report, null, 2) + "\n")
  }
}, 60_000)

const inSandbox = () => {
  if (!sandbox) throw new Error("no sandbox")
  return sandbox
}

describe.runIf(isolated)(`CT-ISO-01: escape probes (${TARGET})`, () => {
  it("commands run as kriya (uid 1000), not root, with no sudo", async () => {
    const { client } = inSandbox()
    const id = await sh(client, "id -u; id -un; sudo -n true 2>&1; echo sudo=$?")
    report.identity = id.stdout
    expect(id.stdout).toMatch(/^1000\nkriya\n/)
    expect(id.stdout).toMatch(/sudo=(1|127)\n?$/)
  })

  it("the runner's token is nowhere a command can read: not its own environment, not /proc/1/environ, not any process's", async () => {
    const { client, spec } = inSandbox()
    const own = await sh(client, "env")
    expect(own.stdout).not.toContain(spec.runnerToken)
    expect(own.stdout).not.toMatch(/KRIYA_RUNNER_(TOKEN|LIMITS|GENERATION)/)

    const pid1 = await sh(client, "cat /proc/1/environ")
    report.proc1Environ = { exitCode: pid1.exitCode, stderr: pid1.stderr.trim() }
    expect(pid1.exitCode).not.toBe(0)
    expect(pid1.stderr).toMatch(/Permission denied/)

    const every = await sh(
      client,
      "for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < \"$f\" 2>/dev/null; done; true"
    )
    expect(every.stdout).not.toContain(spec.runnerToken)
    expect(every.stdout).not.toContain("KRIYA_RUNNER_TOKEN")
  })

  it("root processes (the runner) can't be inspected: no fd, environ, memory or trace access", async () => {
    const { client } = inSandbox()
    const scan = await sh(
      client,
      [
        "roots=0",
        "for p in /proc/[0-9]*; do",
        '  [ "$(stat -c %u "$p" 2>/dev/null)" = 0 ] || continue',
        "  roots=$((roots+1))",
        '  ls "$p/fd" >/dev/null 2>&1 && echo "fd-readable ${p#/proc/}"',
        '  cat "$p/environ" >/dev/null 2>&1 && echo "environ-readable ${p#/proc/}"',
        '  head -c1 "$p/mem" >/dev/null 2>&1 && echo "mem-readable ${p#/proc/}"',
        "done",
        'echo "roots=$roots"',
      ].join("\n")
    )
    report.rootProcesses = scan.stdout.trim()
    expect(scan.stdout).toMatch(/roots=[1-9]/)
    expect(scan.stdout).not.toMatch(/readable/)
  })

  it("only the sandbox's own processes are visible", async () => {
    const { client } = inSandbox()
    // The image has no ps: /proc directly
    const ps = await sh(
      client,
      'for p in /proc/[0-9]*; do echo "${p#/proc/} $(stat -c %U "$p" 2>/dev/null) $(cat "$p/comm" 2>/dev/null)"; done'
    )
    const lines = ps.stdout.trim().split("\n")
    report.processes = lines
    expect(lines.length).toBeLessThan(40)
    // Nothing but the sandbox's own two users: no host or other tenant
    expect(new Set(lines.map((line) => line.split(" ")[1]))).toEqual(
      new Set(["root", "kriya"])
    )
  })
})

// One curl from inside: its exit code, HTTP status and first error line
async function curl(client: RunnerClient, args: string) {
  const out = await sh(
    client,
    `curl -sS -m 6 -o /dev/null -w '%{http_code}' ${args}; echo " exit=$?"`
  )
  const [, code = "000", exit = "-1"] = /(\d{3})? ?exit=(\d+)/.exec(out.stdout) ?? []
  return { code, exit: Number(exit), error: out.stderr.trim().split("\n")[0] ?? "" }
}

// Reached: a connection was made (anything but resolve, connect or
// timeout failures, or the proxy refusing the tunnel)
const madeIt = (r: { exit: number; error: string }) =>
  r.exit === 0 || (![6, 7, 28].includes(r.exit) && !/CONNECT tunnel failed/.test(r.error))

// Each address, directly (the firewall) and through the proxy (CONNECT)
async function reachability(client: RunnerClient, urls: string[]) {
  const results: Record<string, { direct: string; proxied: string; reached: boolean }> =
    {}
  for (const url of urls) {
    const direct = await curl(client, `--noproxy '*' ${JSON.stringify(url)}`)
    const proxied = await curl(client, `-p ${JSON.stringify(url)}`)
    results[url] = {
      direct: `${direct.code} exit=${direct.exit} ${direct.error}`.trim(),
      proxied: `${proxied.code} exit=${proxied.exit} ${proxied.error}`.trim(),
      reached: madeIt(direct) || proxied.exit === 0,
    }
  }
  return results
}
const reached = (results: Record<string, { reached: boolean }>) =>
  Object.entries(results)
    .filter(([, r]) => r.reached)
    .map(([url]) => url)

const list = (name: string, fallback: string[]) =>
  process.env[name]
    ?.split(",")
    .map((url) => url.trim())
    .filter(Boolean) ?? fallback

describe.runIf(isolated)(`CT-ISO-03/04: egress (${TARGET})`, () => {
  it("CT-ISO-03: metadata addresses and private ranges are unreachable", async (ctx) => {
    const results = await reachability(
      inSandbox().client,
      list("KRIYA_ISO_PRIVATE", [
        "http://169.254.169.254/latest/meta-data/",
        "http://[fd00:ec2::254]/",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.0.1/",
        "http://192.168.65.1/",
        "http://172.17.0.1/",
      ])
    )
    report["CT-ISO-03"] = { results, reached: reached(results) }
    if (!EGRESS)
      ctx.skip(`egress recorded only; reached: ${reached(results).join(", ") || "none"}`)
    expect(reached(results)).toEqual([])
  }, 180_000)

  it("CT-ISO-04: Kriya's own services and the database are unreachable", async (ctx) => {
    const host =
      provider instanceof DockerProvider
        ? await provider.hostAddress(inSandbox().opened.ref)
        : null
    report.hostAddress = host
    const results = await reachability(
      inSandbox().client,
      list(
        "KRIYA_ISO_KRIYA_URLS",
        TARGET === "docker"
          ? [
              "http://host.docker.internal:6796/api/health",
              "http://host.docker.internal:54321/",
              "http://host.docker.internal:54322/",
              // The same services by IP, so the firewall itself is what refuses
              ...(host
                ? [
                    `http://${host}:6796/api/health`,
                    `http://${host}:54321/`,
                    `http://${host}:54322/`,
                  ]
                : []),
            ]
          : []
      )
    )
    report["CT-ISO-04"] = { results, reached: reached(results) }
    if (!EGRESS)
      ctx.skip(`egress recorded only; reached: ${reached(results).join(", ") || "none"}`)
    expect(Object.keys(results).length).toBeGreaterThan(0)
    expect(reached(results)).toEqual([])
  }, 180_000)
})

describe.runIf(isolated)(
  `CT-ISO-05: the registries profile, and offline (${TARGET})`,
  () => {
    it("registries answer through the proxy; any other domain is refused, through the proxy or around it", async (ctx) => {
      if (!EGRESS) ctx.skip("egress recorded only")
      const { client } = inSandbox()
      const npm = await curl(client, "https://registry.npmjs.org/is-number")
      const pypi = await curl(client, "https://pypi.org/simple/pip/")
      const other = await curl(client, "https://example.com/")
      const around = await curl(client, "--noproxy '*' https://example.com/")
      // A public address by IP, around the proxy: the firewall refuses it
      const publicIp = await curl(client, "--noproxy '*' -k https://1.1.1.1/")
      const plainHttp = await curl(client, "http://registry.npmjs.org/")
      const npmCli = await sh(client, "npm view is-number name 2>&1 | tail -1", 60)
      report["CT-ISO-05"] = {
        npm,
        pypi,
        other,
        around,
        publicIp,
        plainHttp,
        npmCli: npmCli.stdout.trim(),
      }
      expect(npm).toMatchObject({ code: "200", exit: 0 })
      expect(pypi).toMatchObject({ code: "200", exit: 0 })
      expect(npmCli.stdout.trim()).toBe("is-number")
      expect(madeIt(other)).toBe(false)
      expect(madeIt(around)).toBe(false)
      expect(publicIp.exit).toBe(7)
      // A plain-HTTP request through the proxy is answered 403 by the proxy itself
      expect(plainHttp.code).toBe("403")
    }, 180_000)

    it("an offline workspace reaches nothing, registries included", async (ctx) => {
      if (!EGRESS) ctx.skip("egress recorded only")
      const p = provider!
      const spec = specFor(randomUUID(), 1, "offline")
      const { opened, client } = await open(p, spec)
      try {
        const npm = await curl(client, "https://registry.npmjs.org/is-number")
        const around = await curl(
          client,
          "--noproxy '*' https://registry.npmjs.org/is-number"
        )
        report["CT-ISO-05 offline"] = { npm, around }
        expect(madeIt(npm)).toBe(false)
        expect(madeIt(around)).toBe(false)
      } finally {
        await p.destroy(opened.ref)
      }
    }, 180_000)
  }
)

describe.runIf(isolated)(`CT-ISO-06: resource abuse is contained (${TARGET})`, () => {
  it("each command runs with the process cap (soft 256, hard 512)", async () => {
    const limits = await sh(inSandbox().client, "ulimit -Su; ulimit -Hu")
    report.nproc = limits.stdout.trim()
    expect(limits.stdout).toBe("256\n512\n")
  })

  it("a fork bomb hits the cap, is stopped at its timeout, and the runner keeps answering", async () => {
    const { client, spec } = inSandbox()
    const bomb = await sh(client, "bomb() { bomb | bomb & }; bomb; sleep 30", 10)
    report.forkBomb = {
      timedOut: bomb.timedOut,
      capped: /Resource temporarily unavailable|retry: /.test(bomb.stderr),
    }
    expect(bomb.timedOut).toBe(true)
    expect(bomb.stderr).toMatch(/Resource temporarily unavailable|retry: /)
    expect(await client.health()).toMatchObject({ ok: true, generation: spec.generation })
    // Its processes are gone; the next command starts normally
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const left = await sh(
      client,
      'n=0; for p in /proc/[0-9]*; do [ "$(stat -c %u "$p" 2>/dev/null)" = 1000 ] && n=$((n+1)); done; echo $n'
    )
    report.forkBombLeft = left.stdout.trim()
    expect(Number(left.stdout.trim())).toBeLessThan(10)
  }, 120_000)

  it("a CPU loop is stopped at its timeout and the runner keeps answering", async () => {
    const { client } = inSandbox()
    const loop = await sh(client, "while :; do :; done", 3)
    expect(loop.timedOut).toBe(true)
    expect((await sh(client, "echo alive")).stdout).toBe("alive\n")
  }, 60_000)
})

describe.runIf(TARGET === "docker")("CD-12 fails closed (docker)", () => {
  it("without the capability to install its firewall, the runner never starts", async () => {
    const bare = new DockerProvider(IMAGE, { netAdmin: false })
    const spec = specFor(randomUUID())
    const ref = `kriya-iso-${spec.workspaceId}-${spec.generation}`
    try {
      await expect(
        bare.create(spec).then(async (opened) => {
          const client = new RunnerClient(opened.runnerUrl, spec.runnerToken)
          await healthy(client, spec.generation, 15_000)
        })
      ).rejects.toThrow()
      expect(await bare.resume(ref)).toBeNull()
    } finally {
      await bare.destroy(ref)
    }
  }, 60_000)
})

describe.runIf(isolated)(
  `CT-ISO-07: the runner can't be stopped from a command (${TARGET})`,
  () => {
    it("kill -9 1 and signals to every root process are refused; the runner keeps answering with the same token", async () => {
      const { client, spec } = inSandbox()
      const pid1 = await sh(client, "kill -9 1 2>&1; echo exit=$?")
      report.killPid1 = pid1.stdout.trim()
      expect(pid1.stdout).toMatch(/Operation not permitted/)
      expect(pid1.stdout).toMatch(/exit=1/)
      const all = await sh(
        client,
        [
          "tried=0",
          "for p in /proc/[0-9]*; do",
          '  [ "$(stat -c %u "$p" 2>/dev/null)" = 0 ] || continue',
          "  tried=$((tried+1)); pid=${p#/proc/}",
          '  kill -9 "$pid" 2>/dev/null && echo "killed $pid"',
          '  kill -STOP "$pid" 2>/dev/null && echo "stopped $pid"',
          "done",
          'echo "tried=$tried"',
        ].join("\n")
      )
      report.killRoots = all.stdout.trim()
      expect(all.stdout).toMatch(/tried=[1-9]/)
      expect(all.stdout).not.toMatch(/killed|stopped/)
      expect(await client.health()).toMatchObject({
        ok: true,
        generation: spec.generation,
      })
      expect((await sh(client, "echo alive")).stdout).toBe("alive\n")
    })
  }
)

describe(`CT-ISO-08: a destroyed workspace stays gone (${TARGET})`, () => {
  it("after destroy, resume is null, the provider lists nothing, and the old token reaches nothing", async (ctx) => {
    if (!provider) ctx.skip(`target ${TARGET} isn't available here`)
    const p = provider!
    const spec = specFor(randomUUID())
    const { opened, client } = await open(p, spec)
    expect((await sh(client, "echo up")).stdout).toBe("up\n")
    await p.destroy(opened.ref)
    expect(await p.resume(opened.ref, spec)).toBeNull()
    expect((await p.list()).map((s) => s.ref)).not.toContain(opened.ref)
    await expect(sh(client, "echo still")).rejects.toThrow()
    // Destroy is idempotent
    await p.destroy(opened.ref)
    report["CT-ISO-08"] = "passed"
  }, 120_000)
})
