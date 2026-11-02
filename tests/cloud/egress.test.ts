import net from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  applyFirewall,
  firewallRules,
  REGISTRIES,
  startRegistryProxy,
} from "@/runner/egress"
import { childEnv, commandFor, NPROC } from "@/runner/exec"
import type { Ctx } from "@/runner/paths"
import { limitsSchema } from "@/runner/protocol"

// CD-12 and CS-9 in the image (C9, CF-16/CF-17): the firewall the root
// runner installs for the command user, the registry proxy, and the
// process limit on every command, without root or the internet. The real
// rules and limits are probed in the image by tests/cloud/isolation.test.ts
// (KRIYA_ISO_TARGET=docker).

describe("the firewall rules (uid 1000)", () => {
  const { v4, v6 } = firewallRules(1000)
  const at = (rules: string[][], match: (r: string) => boolean) =>
    rules.findIndex((r) => match(r.join(" ")))

  it("loopback only: the resolver on loopback refused first, metadata and private ranges refused, then everything", () => {
    for (const family of [v4, v6]) {
      expect(family.rules[0]).toEqual(["-F", "KRIYA_EGRESS"])
      expect(family.rules.at(-1)).toEqual(["-A", "KRIYA_EGRESS", "-j", "REJECT"])
      expect(family.jump).toEqual([
        "OUTPUT",
        "-m",
        "owner",
        "--uid-owner",
        "1000",
        "-j",
        "KRIYA_EGRESS",
      ])
      // Nothing but loopback is accepted
      expect(family.rules.filter((r) => r.includes("ACCEPT"))).toEqual([
        ["-A", "KRIYA_EGRESS", "-o", "lo", "-j", "ACCEPT"],
      ])
    }
    expect(at(v4.rules, (r) => r.includes("-d 127.0.0.11"))).toBeLessThan(
      at(v4.rules, (r) => r.includes("-o lo"))
    )
    for (const range of [
      "169.254.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ])
      expect(
        at(v4.rules, (r) => r === `-A KRIYA_EGRESS -d ${range} -j REJECT`)
      ).toBeGreaterThan(0)
    expect(
      at(v6.rules, (r) => r === "-A KRIYA_EGRESS -d fd00:ec2::254 -j REJECT")
    ).toBeGreaterThan(0)
  })
})

describe("applyFirewall", () => {
  type Call = { command: string; args: string[] }
  const runner = (fail: (call: Call) => boolean = () => false) => {
    const calls: Call[] = []
    return {
      calls,
      run: async (command: string, args: string[]) => {
        calls.push({ command, args })
        return fail({ command, args })
          ? { code: 1, stderr: "nope" }
          : { code: 0, stderr: "" }
      },
    }
  }

  it("creates, flushes and fills the chain, and adds the jump once (a restart finds it)", async () => {
    const fresh = runner(({ args }) => args[0] === "-C")
    expect(await applyFirewall(1000, { run: fresh.run })).toEqual({ ipv6: true })
    expect(fresh.calls.filter((c) => c.args[0] === "-I")).toHaveLength(2)

    const restarted = runner(({ args }) => args[0] === "-N")
    await applyFirewall(1000, { run: restarted.run })
    expect(restarted.calls.filter((c) => c.args[0] === "-I")).toEqual([])
    expect(restarted.calls.filter((c) => c.args[0] === "-F")).toHaveLength(2)
  })

  it("fails closed: an IPv4 rule that doesn't apply, or IPv6 rules missing while IPv6 is up, throw", async () => {
    const v4 = runner(({ command, args }) => command === "iptables" && args[0] === "-A")
    await expect(applyFirewall(1000, { run: v4.run })).rejects.toThrow(/iptables -A/)
    const v6 = runner(({ command }) => command === "ip6tables")
    await expect(applyFirewall(1000, { run: v6.run, ipv6: () => true })).rejects.toThrow(
      /IPv6 is up/
    )
    expect(await applyFirewall(1000, { run: v6.run, ipv6: () => false })).toEqual({
      ipv6: false,
    })
  })
})

describe("the registry proxy", () => {
  let echo: net.Server
  let port = 0
  beforeAll(async () => {
    echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done))
    port = (echo.address() as net.AddressInfo).port
  })
  afterAll(() => new Promise<void>((done) => echo.close(() => done())))

  // Names resolve to these "public" addresses; the dial goes to the local echo
  const answers: Record<string, string[]> = {
    "registry.npmjs.org": ["104.16.0.34"],
    "pypi.org": ["151.101.0.223"],
    "example.com": ["93.184.215.14"],
    "files.pythonhosted.org": ["10.0.0.5"],
  }
  const dialed: string[] = []
  const proxy = (network: "registries" | "offline") =>
    startRegistryProxy({
      network,
      port: 0,
      lookup: async (host) => answers[host] ?? [],
      dial: (address) => {
        dialed.push(address)
        return net.connect({ host: "127.0.0.1", port })
      },
    })

  async function connect(url: string, target: string) {
    const { port: proxyPort } = new URL(url)
    const socket = net.connect({ host: "127.0.0.1", port: Number(proxyPort) })
    await new Promise((done) => socket.once("connect", done))
    socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`)
    const head = await new Promise<string>((done) =>
      socket.once("data", (data) => done(data.toString()))
    )
    return { socket, head }
  }

  it("tunnels an allow-listed registry on 443 to the address it checked", async () => {
    const p = await proxy("registries")
    try {
      const { socket, head } = await connect(p.url, "registry.npmjs.org:443")
      expect(head).toMatch(/^HTTP\/1\.1 200/)
      socket.write("ping")
      expect(
        await new Promise((done) => socket.once("data", (d) => done(d.toString())))
      ).toBe("ping")
      socket.destroy()
      expect(dialed.at(-1)).toBe("104.16.0.34")
    } finally {
      await p.close()
    }
  })

  it.each([
    ["a domain not on the list", "example.com:443"],
    ["a registry on another port", "registry.npmjs.org:80"],
    ["an IP literal", "104.16.0.34:443"],
    ["metadata", "169.254.169.254:443"],
    [
      "an allow-listed name that resolves to a private address",
      "files.pythonhosted.org:443",
    ],
    ["a name that doesn't resolve", "crates.io:443"],
  ])("refuses %s", async (_, target) => {
    const p = await proxy("registries")
    const before = dialed.length
    try {
      const { socket, head } = await connect(p.url, target)
      expect(head).toMatch(/^HTTP\/1\.1 403/)
      socket.destroy()
      expect(dialed.length).toBe(before)
    } finally {
      await p.close()
    }
  })

  it("an offline workspace gets nothing, and plain HTTP requests are refused on any profile", async () => {
    const offline = await proxy("offline")
    try {
      expect((await connect(offline.url, "registry.npmjs.org:443")).head).toMatch(
        /^HTTP\/1\.1 403/
      )
    } finally {
      await offline.close()
    }
    const p = await proxy("registries")
    try {
      const res = await fetch(`${p.url}/`, { headers: { host: "registry.npmjs.org" } })
      expect(res.status).toBe(403)
    } finally {
      await p.close()
    }
  })

  it("the allow-list is CD-12's registries and nothing else", () => {
    expect([...REGISTRIES].sort()).toEqual([
      "crates.io",
      "files.pythonhosted.org",
      "index.crates.io",
      "proxy.golang.org",
      "pypi.org",
      "registry.npmjs.org",
      "static.crates.io",
      "sum.golang.org",
    ])
  })
})

describe("commands in the image", () => {
  const ctx = (over: Partial<Ctx> = {}) =>
    ({ path: "/usr/bin:/bin", home: "/home/kriya", ...over }) as Ctx

  it("start under prlimit with the process cap when they switch user; not otherwise", () => {
    expect(
      commandFor({ runAs: { uid: 1000, gid: 1000 } }, "bash", ["-lc", "make"])
    ).toEqual(["prlimit", [`--nproc=${NPROC}`, "--", "bash", "-lc", "make"]])
    expect(NPROC).toBe("256:512")
    expect(commandFor({}, "bash", ["-lc", "make"])).toEqual(["bash", ["-lc", "make"]])
  })

  it("see the proxy in their environment only when the runner has one", () => {
    const env = childEnv(ctx({ proxyUrl: "http://127.0.0.1:10001" }))
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
      expect(env[name as keyof typeof env]).toBe("http://127.0.0.1:10001")
    expect((env as Record<string, string>).NO_PROXY).toBe("localhost,127.0.0.1,::1")
    expect(Object.keys(childEnv(ctx())).some((name) => /proxy/i.test(name))).toBe(false)
  })

  it("a worker that doesn't name a network profile gets offline", () => {
    expect(limitsSchema.parse({}).network).toBe("offline")
    expect(limitsSchema.parse({ network: "registries" }).network).toBe("registries")
  })
})
