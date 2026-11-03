import type { BenchTask } from "./task"

// KriyaBench multi-part tasks (H14c: KRIYA_LOOP.md §5). Each asks for
// several distinct parts, so planning, a builder per step and retries with
// the error have something to do; each has visible tests that fail as given
// (the loop's own check, `node --test`, means something) and a hidden
// grader with more cases (passing the visible tests isn't passing the task).

const js = String.raw
const PKG = '{\n  "type": "module",\n  "private": true\n}\n'
// The visible tests and the hidden grader together
const NODE_TEST = { command: ["node", "--test"], timeoutSeconds: 60 }

export const MULTI: BenchTask[] = [
  {
    id: "multi-gst-invoice",
    kind: "feature",
    level: "multi",
    prompt:
      'Build the invoice module in src/invoice.js, in three parts. 1) parseLine(text) reads a line like "2 x Notebook @ 45.50 @ 12%" (quantity, name, rate in rupees with up to 2 decimals, GST of 5, 12, 18 or 28 percent; spaces around parts may vary) into { qty, name, ratePaise, gstPercent }, and throws on anything else. 2) lineTotals(line) gives { netPaise, gstPaise }: net is qty × rate, GST is net × percent / 100 rounded half up to the paise. 3) invoice(lines, { intraState }) gives { netPaise, cgstPaise, sgstPaise, igstPaise, totalPaise }: within a state each line\'s GST is split into CGST (half, rounded down) and SGST (the rest); between states it is all IGST. Money is integer paise throughout. invoice.test.js covers part of it.',
    files: {
      "package.json": PKG,
      "src/invoice.js": js`// Invoices with GST, in integer paise

export function parseLine(text) {
  throw new Error("not implemented")
}

export function lineTotals(line) {
  throw new Error("not implemented")
}

export function invoice(lines, { intraState }) {
  throw new Error("not implemented")
}
`,
      "invoice.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { invoice, parseLine } from "./src/invoice.js"

test("a line is parsed into paise", () => {
  assert.deepEqual(parseLine("2 x Notebook @ 45.50 @ 12%"), { qty: 2, name: "Notebook", ratePaise: 4550, gstPercent: 12 })
})

test("an invoice within a state splits GST into CGST and SGST", () => {
  const lines = [parseLine("2 x Notebook @ 45.50 @ 12%"), parseLine("1 x Pen @ 10 @ 18%")]
  assert.deepEqual(invoice(lines, { intraState: true }), { netPaise: 10100, cgstPaise: 636, sgstPaise: 636, igstPaise: 0, totalPaise: 11372 })
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { invoice, lineTotals, parseLine } from "./src/invoice.js"

test("GST rounds half up to the paise", () => {
  assert.deepEqual(lineTotals(parseLine("3 x Tea @ 12.25 @ 5%")), { netPaise: 3675, gstPaise: 184 })
  assert.deepEqual(lineTotals(parseLine("1 x Cup @ 0.10 @ 5%")), { netPaise: 10, gstPaise: 1 })
})

test("an odd GST paise goes to SGST", () => {
  assert.deepEqual(invoice([parseLine("1 x Cup @ 0.10 @ 5%")], { intraState: true }), { netPaise: 10, cgstPaise: 0, sgstPaise: 1, igstPaise: 0, totalPaise: 11 })
})

test("between states it is all IGST", () => {
  const lines = [parseLine("2 x Notebook @ 45.50 @ 12%"), parseLine("1 x Pen @ 10 @ 18%")]
  assert.deepEqual(invoice(lines, { intraState: false }), { netPaise: 10100, cgstPaise: 0, sgstPaise: 0, igstPaise: 1272, totalPaise: 11372 })
})

test("names with spaces, uneven spacing, one decimal", () => {
  assert.deepEqual(parseLine("  10 x  Blue Gel Pen  @ 7.5 @ 28% "), { qty: 10, name: "Blue Gel Pen", ratePaise: 750, gstPercent: 28 })
})

test("anything else is refused", () => {
  assert.throws(() => parseLine("two x Pen @ 5 @ 12%"))
  assert.throws(() => parseLine("1 x Pen @ 5 @ 7%"))
  assert.throws(() => parseLine("1 x Pen @ 5.123 @ 12%"))
})
`,
    },
    solution: {
      "src/invoice.js": js`// Invoices with GST, in integer paise

const LINE = /^\s*(\d+)\s*x\s*(.+?)\s*@\s*(\d+(?:\.\d{1,2})?)\s*@\s*(5|12|18|28)%\s*$/

export function parseLine(text) {
  const m = LINE.exec(text)
  if (!m) throw new Error("not an invoice line: " + text)
  const [whole, frac = ""] = m[3].split(".")
  return { qty: Number(m[1]), name: m[2], ratePaise: Number(whole) * 100 + Number(frac.padEnd(2, "0")), gstPercent: Number(m[4]) }
}

export function lineTotals(line) {
  const netPaise = line.qty * line.ratePaise
  return { netPaise, gstPaise: Math.floor((netPaise * line.gstPercent + 50) / 100) }
}

export function invoice(lines, { intraState }) {
  let net = 0
  let cgst = 0
  let sgst = 0
  let igst = 0
  for (const line of lines) {
    const t = lineTotals(line)
    net += t.netPaise
    if (intraState) {
      const half = Math.floor(t.gstPaise / 2)
      cgst += half
      sgst += t.gstPaise - half
    } else igst += t.gstPaise
  }
  return { netPaise: net, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, totalPaise: net + cgst + sgst + igst }
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "multi-rate-limiter",
    kind: "feature",
    level: "multi",
    prompt:
      "Build createLimiter({ capacity, refillPerSecond, now = Date.now }) in src/limiter.js: a token bucket per key. Each key starts full; tokens refill continuously with elapsed time, never above capacity. It returns: take(key, cost = 1), true and spending the tokens when the key has at least cost, false and spending nothing otherwise (a cost above capacity is always false); remaining(key), the whole tokens left (rounded down); and sweep(idleMs), which forgets keys that are full again and untouched by take for at least idleMs, and returns how many it forgot. limiter.test.js covers part of it.",
    files: {
      "package.json": PKG,
      "src/limiter.js": js`// A token bucket per key

export function createLimiter({ capacity, refillPerSecond, now = Date.now }) {
  throw new Error("not implemented")
}
`,
      "limiter.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { createLimiter } from "./src/limiter.js"

test("a key spends its tokens, then refills over time", () => {
  let t = 0
  const limiter = createLimiter({ capacity: 2, refillPerSecond: 1, now: () => t })
  assert.equal(limiter.take("a"), true)
  assert.equal(limiter.take("a"), true)
  assert.equal(limiter.take("a"), false)
  t = 1000
  assert.equal(limiter.take("a"), true)
  assert.equal(limiter.remaining("a"), 0)
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { createLimiter } from "./src/limiter.js"

test("keys are independent", () => {
  const limiter = createLimiter({ capacity: 1, refillPerSecond: 1, now: () => 0 })
  assert.equal(limiter.take("a"), true)
  assert.equal(limiter.take("a"), false)
  assert.equal(limiter.take("b"), true)
})

test("refill is continuous and a refused take spends nothing", () => {
  let t = 0
  const limiter = createLimiter({ capacity: 1, refillPerSecond: 0.5, now: () => t })
  assert.equal(limiter.take("x"), true)
  t = 1000
  assert.equal(limiter.remaining("x"), 0)
  assert.equal(limiter.take("x"), false)
  t = 2000
  assert.equal(limiter.remaining("x"), 1)
  assert.equal(limiter.take("x"), true)
})

test("never above capacity", () => {
  let t = 0
  const limiter = createLimiter({ capacity: 2, refillPerSecond: 10, now: () => t })
  limiter.take("a")
  t = 10_000
  assert.equal(limiter.remaining("a"), 2)
})

test("a cost above capacity is refused without spending", () => {
  const limiter = createLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 })
  assert.equal(limiter.take("k", 5), false)
  assert.equal(limiter.remaining("k"), 3)
  assert.equal(limiter.take("k", 3), true)
})

test("sweep forgets keys that are full and idle", () => {
  let t = 0
  const limiter = createLimiter({ capacity: 2, refillPerSecond: 1, now: () => t })
  limiter.take("a")
  limiter.take("b")
  limiter.take("b")
  t = 1000
  assert.equal(limiter.sweep(1000), 1)
  t = 3000
  assert.equal(limiter.sweep(1000), 1)
  assert.equal(limiter.sweep(1000), 0)
})
`,
    },
    solution: {
      "src/limiter.js": js`// A token bucket per key

export function createLimiter({ capacity, refillPerSecond, now = Date.now }) {
  const buckets = new Map()
  const bucket = (key) => {
    const t = now()
    let b = buckets.get(key)
    if (!b) {
      b = { tokens: capacity, at: t, used: t }
      buckets.set(key, b)
    }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 1000) * refillPerSecond)
    b.at = t
    return b
  }
  return {
    take(key, cost = 1) {
      const b = bucket(key)
      b.used = now()
      if (cost > capacity || b.tokens < cost) return false
      b.tokens -= cost
      return true
    },
    remaining(key) {
      return Math.floor(bucket(key).tokens + 1e-9)
    },
    sweep(idleMs) {
      let removed = 0
      for (const key of [...buckets.keys()]) {
        const b = bucket(key)
        if (b.tokens >= capacity && now() - b.used >= idleMs) {
          buckets.delete(key)
          removed++
        }
      }
      return removed
    },
  }
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "multi-rename-validate",
    kind: "refactor",
    level: "multi",
    prompt:
      'Four changes across src/: 1) rename getUser to findUser in every file; nothing may export or call getUser any more. 2) findUser(id) returns null for an unknown id instead of throwing. 3) handle("GET /users/<id>") in src/api.js answers { status: 404, body: { error: "not found" } } for an unknown id, and greeting(id) in src/report.js says "Hello, guest" for one. 4) Add createUser({ name, email }) to src/users.js: the name is trimmed and must be 1 to 60 characters, otherwise it throws Error("invalid name"); the email must have exactly one @, a dot after the @, and no spaces, otherwise it throws Error("invalid email"); the user gets the next id (the highest so far plus one), is stored, and is returned. users.test.js covers part of it.',
    files: {
      "package.json": PKG,
      "src/users.js": js`const USERS = [
  { id: 1, name: "Asha", email: "asha@example.in" },
  { id: 2, name: "Ravi", email: "ravi@example.in" },
]

export function getUser(id) {
  const user = USERS.find((u) => u.id === id)
  if (!user) throw new Error("no user " + id)
  return user
}

export function listUsers() {
  return [...USERS]
}
`,
      "src/api.js": js`import { getUser } from "./users.js"

// handle("GET /users/2") gives { status, body }
export function handle(request) {
  const m = /^GET \/users\/(\d+)$/.exec(request)
  if (!m) return { status: 400, body: { error: "bad request" } }
  return { status: 200, body: getUser(Number(m[1])) }
}
`,
      "src/report.js": js`import { getUser } from "./users.js"

export function greeting(id) {
  return "Hello, " + getUser(id).name
}
`,
      "users.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import * as users from "./src/users.js"

test("findUser finds a user", () => {
  assert.equal(users.findUser(1).name, "Asha")
})

test("createUser stores a valid user with the next id", () => {
  assert.deepEqual(users.createUser({ name: "Meera", email: "meera@example.in" }), { id: 3, name: "Meera", email: "meera@example.in" })
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as users from "./src/users.js"
import { handle } from "./src/api.js"
import { greeting } from "./src/report.js"

test("getUser is gone everywhere", () => {
  assert.equal(users.getUser, undefined)
  for (const file of readdirSync("src")) assert.doesNotMatch(readFileSync("src/" + file, "utf8"), /getUser/, file)
})

test("unknown ids are null, 404 and a guest", () => {
  assert.equal(users.findUser(99), null)
  assert.deepEqual(handle("GET /users/99"), { status: 404, body: { error: "not found" } })
  assert.equal(handle("GET /users/2").body.name, "Ravi")
  assert.equal(greeting(1), "Hello, Asha")
  assert.equal(greeting(42), "Hello, guest")
})

test("createUser trims, numbers and stores", () => {
  const meera = users.createUser({ name: "  Meera ", email: "meera@example.in" })
  assert.deepEqual(meera, { id: 3, name: "Meera", email: "meera@example.in" })
  assert.equal(users.createUser({ name: "Kabir", email: "k@x.in" }).id, 4)
  assert.equal(users.findUser(4).name, "Kabir")
})

test("createUser refuses bad names and emails", () => {
  for (const email of ["a@b", "a b@c.in", "ab.in", "a@@b.in", "a@b@c.in"])
    assert.throws(() => users.createUser({ name: "X", email }), /invalid email/, email)
  for (const name of ["", "   ", "y".repeat(61)])
    assert.throws(() => users.createUser({ name, email: "ok@x.in" }), /invalid name/)
})
`,
    },
    solution: {
      "src/users.js": js`const USERS = [
  { id: 1, name: "Asha", email: "asha@example.in" },
  { id: 2, name: "Ravi", email: "ravi@example.in" },
]

export function findUser(id) {
  return USERS.find((u) => u.id === id) ?? null
}

export function listUsers() {
  return [...USERS]
}

const EMAIL = /^[^\s@]+@[^\s@]*\.[^\s@]*$/

export function createUser({ name, email }) {
  const clean = typeof name === "string" ? name.trim() : ""
  if (clean.length < 1 || clean.length > 60) throw new Error("invalid name")
  if (typeof email !== "string" || !EMAIL.test(email)) throw new Error("invalid email")
  const user = { id: Math.max(0, ...USERS.map((u) => u.id)) + 1, name: clean, email }
  USERS.push(user)
  return user
}
`,
      "src/api.js": js`import { findUser } from "./users.js"

// handle("GET /users/2") gives { status, body }
export function handle(request) {
  const m = /^GET \/users\/(\d+)$/.exec(request)
  if (!m) return { status: 400, body: { error: "bad request" } }
  const user = findUser(Number(m[1]))
  return user ? { status: 200, body: user } : { status: 404, body: { error: "not found" } }
}
`,
      "src/report.js": js`import { findUser } from "./users.js"

export function greeting(id) {
  return "Hello, " + (findUser(id)?.name ?? "guest")
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "multi-csv-report",
    kind: "feature",
    level: "multi",
    prompt:
      'Build the spending report in src/report.js, in three parts. 1) parseCsv(text): the first row is the header; fields may be quoted (a quoted field can hold commas and doubled quotes "" for a quote); lines end in \\n or \\r\\n; blank lines are skipped; returns one object per row. 2) totals(rows): the sum of each category\'s amount column (rupees with up to 2 decimals, added exactly in paise), as [{ category, paise }] sorted by amount, largest first, then by category name. 3) renderTable(totals): a Markdown table with the header "| Category | Amount |", the row "| --- | ---: |", then one row per category with the amount in Indian digit grouping, like ₹1,23,456.78; lines joined by \\n, no trailing newline. report.test.js covers part of it.',
    files: {
      "package.json": PKG,
      "src/report.js": js`// A spending report from a CSV export

export function parseCsv(text) {
  throw new Error("not implemented")
}

export function totals(rows) {
  throw new Error("not implemented")
}

export function renderTable(totals) {
  throw new Error("not implemented")
}
`,
      "report.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCsv, renderTable, totals } from "./src/report.js"

test("a simple export becomes a table", () => {
  const rows = parseCsv("name,category,amount\nTea,Food,20\nBus,Travel,15.5\nRice,Food,100")
  assert.equal(renderTable(totals(rows)), "| Category | Amount |\n| --- | ---: |\n| Food | ₹120.00 |\n| Travel | ₹15.50 |")
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCsv, renderTable, totals } from "./src/report.js"

test("quotes, commas inside quotes, doubled quotes, CRLF and blank lines", () => {
  assert.deepEqual(parseCsv('name,category,amount\r\n"Rice, 5kg",Food,450\r\n"He said ""hi""",Misc,10.5\r\n\r\n'), [
    { name: "Rice, 5kg", category: "Food", amount: "450" },
    { name: 'He said "hi"', category: "Misc", amount: "10.5" },
  ])
})

test("amounts add exactly in paise; ties sort by name", () => {
  const rows = [
    { category: "B", amount: "0.10" },
    { category: "B", amount: "0.20" },
    { category: "A", amount: "0.3" },
  ]
  assert.deepEqual(totals(rows), [{ category: "A", paise: 30 }, { category: "B", paise: 30 }])
})

test("Indian digit grouping", () => {
  const table = renderTable([
    { category: "Rent", paise: 1234567890 },
    { category: "Fees", paise: 100000 },
    { category: "Tips", paise: 5 },
  ])
  assert.equal(table, "| Category | Amount |\n| --- | ---: |\n| Rent | ₹1,23,45,678.90 |\n| Fees | ₹1,000.00 |\n| Tips | ₹0.05 |")
})
`,
    },
    solution: {
      "src/report.js": js`// A spending report from a CSV export

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += c
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ""))
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])))
}

const toPaise = (text) => {
  const [whole, frac = ""] = text.trim().split(".")
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2))
}

export function totals(rows) {
  const by = new Map()
  for (const r of rows) by.set(r.category, (by.get(r.category) ?? 0) + toPaise(r.amount))
  return [...by]
    .map(([category, paise]) => ({ category, paise }))
    .sort((a, b) => b.paise - a.paise || a.category.localeCompare(b.category))
}

function rupees(paise) {
  const whole = String(Math.floor(paise / 100))
  const frac = String(paise % 100).padStart(2, "0")
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3
  return "₹" + grouped + "." + frac
}

export function renderTable(list) {
  return ["| Category | Amount |", "| --- | ---: |", ...list.map((t) => "| " + t.category + " | " + rupees(t.paise) + " |")].join("\n")
}
`,
    },
    verify: NODE_TEST,
  },
  {
    id: "multi-checkout-bugs",
    kind: "fix",
    level: "multi",
    prompt:
      "Checkout totals are wrong in four ways: quantities are ignored in the subtotal, an unknown discount code makes the total NaN instead of giving no discount, discounts round up instead of down to the paise, and an order of exactly ₹500 after the discount still pays shipping (₹500 and above ships free). The cause is spread over src/cart.js, src/discount.js and src/shipping.js. Fix all of it. checkout.test.js covers part of it.",
    files: {
      "package.json": PKG,
      "src/cart.js": js`// The subtotal of a cart, in paise
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.pricePaise, 0)
}
`,
      "src/discount.js": js`const CODES = { SAVE10: 10, SAVE25: 25 }

// The discount for a subtotal, in paise
export function discount(subtotalPaise, code) {
  return Math.ceil((subtotalPaise * CODES[code]) / 100)
}
`,
      "src/shipping.js": js`// Shipping for an order after its discount, in paise: free from ₹500
export function shipping(paise) {
  return paise > 50000 ? 0 : 4000
}
`,
      "src/checkout.js": js`import { subtotal } from "./cart.js"
import { discount } from "./discount.js"
import { shipping } from "./shipping.js"

export function checkout(items, code) {
  const subtotalPaise = subtotal(items)
  const discountPaise = discount(subtotalPaise, code)
  const shippingPaise = shipping(subtotalPaise - discountPaise)
  return { subtotalPaise, discountPaise, shippingPaise, totalPaise: subtotalPaise - discountPaise + shippingPaise }
}
`,
      "checkout.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { checkout } from "./src/checkout.js"

test("quantities count", () => {
  assert.equal(checkout([{ pricePaise: 25000, qty: 2 }], "SAVE10").subtotalPaise, 50000)
})
`,
    },
    hidden: {
      "grader.test.js": js`import { test } from "node:test"
import assert from "node:assert/strict"
import { checkout } from "./src/checkout.js"

test("discounts round down to the paise", () => {
  assert.deepEqual(checkout([{ pricePaise: 999, qty: 1 }], "SAVE10"), { subtotalPaise: 999, discountPaise: 99, shippingPaise: 4000, totalPaise: 4900 })
})

test("an unknown code gives no discount", () => {
  assert.deepEqual(checkout([{ pricePaise: 1000, qty: 3 }], "NOPE"), { subtotalPaise: 3000, discountPaise: 0, shippingPaise: 4000, totalPaise: 7000 })
  assert.equal(checkout([{ pricePaise: 1000, qty: 1 }]).discountPaise, 0)
})

test("exactly ₹500 after the discount ships free", () => {
  assert.deepEqual(checkout([{ pricePaise: 55555, qty: 1 }], "SAVE10"), { subtotalPaise: 55555, discountPaise: 5555, shippingPaise: 0, totalPaise: 50000 })
  assert.equal(checkout([{ pricePaise: 25000, qty: 2 }]).shippingPaise, 0)
})
`,
    },
    solution: {
      "src/cart.js": js`// The subtotal of a cart, in paise
export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.pricePaise * item.qty, 0)
}
`,
      "src/discount.js": js`const CODES = { SAVE10: 10, SAVE25: 25 }

// The discount for a subtotal, in paise, rounded down
export function discount(subtotalPaise, code) {
  return Math.floor((subtotalPaise * (CODES[code] ?? 0)) / 100)
}
`,
      "src/shipping.js": js`// Shipping for an order after its discount, in paise: free from ₹500
export function shipping(paise) {
  return paise >= 50000 ? 0 : 4000
}
`,
    },
    verify: NODE_TEST,
  },
]
