import { describe, expect, it } from "vitest"

import {
  answerNumberRequest,
  giveNumber,
  groups,
  nationalDigits,
  parseNumberRequest,
  spoken,
  type NumberRequest,
} from "@/lib/voice/dictation"

// Number dictation (owner scenario 2): requests in English, Hindi, Telugu
// and Hinglish map to one deterministic answer built from the stored
// digits. The number is synthetic.

const NUMBER = "9876543210"
const WORD = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
]
// The digits in what Tavi says, in order
const digitsIn = (text: string) =>
  text
    .toLowerCase()
    // "the last four digits": a count, not a digit said
    .replace(/\b[a-z]+ digits?\b/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => WORD.includes(w))
    .map((w) => WORD.indexOf(w))
    .join("")
// Each stretch of digit words, pauses included ("nine, eight. seven")
const runsIn = (text: string) =>
  text
    .toLowerCase()
    .replace(/\b[a-z]+ digits?\b/g, " ")
    .split(new RegExp(`\\b(?!(?:${WORD.join("|")})\\b)[a-z']+\\b`))
    .map(digitsIn)
    .filter(Boolean)
const say = (request: NumberRequest, options = {}) =>
  answerNumberRequest(NUMBER, "Ravi", request, options)

describe("how the number is said", () => {
  it("drops +91 or a leading 0 from an Indian mobile, keeps anything else", () => {
    expect(nationalDigits("+91 98765 43210")).toBe(NUMBER)
    expect(nationalDigits("09876543210")).toBe(NUMBER)
    expect(nationalDigits("040-2345 6789")).toBe("04023456789")
  })

  it("groups a mobile 5 + 5 and other numbers in fours from the end", () => {
    expect(groups(NUMBER)).toEqual(["98765", "43210"])
    expect(groups("04023456789")).toEqual(["040", "2345", "6789"])
    expect(groups("123456789")).toEqual(["12345", "6789"])
    expect(groups("1234")).toEqual(["1234"])
  })

  it("speaks every digit as a word, slow with a pause after each", () => {
    expect(spoken(NUMBER)).toBe("nine eight seven six five, four three two one zero")
    expect(spoken(NUMBER, true)).toBe(
      "nine, eight, seven, six, five. four, three, two, one, zero"
    )
  })

  it("gives the number once and stores it withheld", () => {
    const a = giveNumber("Asha", "Ravi", NUMBER)
    expect(a.text).toBe(
      "Asha asked me to give you Ravi's number. It's nine eight seven six five, four three two one zero. Shall I repeat it?"
    )
    expect(a.stored).toBe(
      "Asha asked me to give you Ravi's number. It's [number withheld]. Shall I repeat it?"
    )
  })
})

describe("requests, in many phrasings", () => {
  const cases: [string, NumberRequest][] = [
    // repeat
    ["Can you repeat the number?", { kind: "repeat", slow: false }],
    ["Sorry?", { kind: "repeat", slow: false }],
    ["What?", { kind: "repeat", slow: false }],
    ["Once more please", { kind: "repeat", slow: false }],
    ["Say it again", { kind: "repeat", slow: false }],
    ["I didn't get that", { kind: "repeat", slow: false }],
    ["Phir se bolo", { kind: "repeat", slow: false }],
    ["Number dobara bataiye", { kind: "repeat", slow: false }],
    ["Ek baar aur boliye", { kind: "repeat", slow: false }],
    ["फिर से बोलिए", { kind: "repeat", slow: false }],
    ["Malli cheppandi", { kind: "repeat", slow: false }],
    ["Inkosari cheppandi number", { kind: "repeat", slow: false }],
    ["మళ్ళీ చెప్పండి", { kind: "repeat", slow: false }],
    // slower
    ["Slower please", { kind: "repeat", slow: true }],
    ["Can you say it slowly?", { kind: "repeat", slow: true }],
    ["Thoda dheere boliye", { kind: "repeat", slow: true }],
    ["धीरे बोलिए", { kind: "repeat", slow: true }],
    ["Nemmadiga cheppandi", { kind: "repeat", slow: true }],
    ["నెమ్మదిగా చెప్పండి", { kind: "repeat", slow: true }],
    // last n
    ["What were the last four digits?", { kind: "last", n: 4 }],
    ["last 4?", { kind: "last", n: 4 }],
    ["The last two digits again", { kind: "last", n: 2 }],
    ["Aakhri chaar digit kya the?", { kind: "last", n: 4 }],
    ["Last ke teen number?", { kind: "last", n: 3 }],
    ["आखिरी चार अंक", { kind: "last", n: 4 }],
    ["Chivari naalugu ankelu enti?", { kind: "last", n: 4 }],
    ["చివరి నాలుగు అంకెలు", { kind: "last", n: 4 }],
    ["What were the last digits?", { kind: "last", n: null }],
    // first n
    ["What were the first five digits?", { kind: "first", n: 5 }],
    ["Pehle teen digit?", { kind: "first", n: 3 }],
    ["Modati rendu ankelu", { kind: "first", n: 2 }],
    // after
    ["After 98 what came?", { kind: "after", digits: "98" }],
    ["What comes after nine eight?", { kind: "after", digits: "98" }],
    ["after ninety eight?", { kind: "after", digits: "98" }],
    ["98 ke baad kya tha?", { kind: "after", digits: "98" }],
    ["Nau aath ke baad kya aaya?", { kind: "after", digits: "98" }],
    ["98 के बाद क्या था?", { kind: "after", digits: "98" }],
    ["98 tarvata enti?", { kind: "after", digits: "98" }],
    ["తొమ్మిది ఎనిమిది తర్వాత ఏంటి?", { kind: "after", digits: "98" }],
    ["After 98765?", { kind: "after", digits: "98765" }],
    ["after double nine", { kind: "after", digits: "99" }],
    // before
    ["What comes before 3210?", { kind: "before", digits: "3210" }],
    ["3210 se pehle kya hai?", { kind: "before", digits: "3210" }],
    ["3210 mundu enti?", { kind: "before", digits: "3210" }],
    // wait
    ["Wait, let me get a pen", { kind: "wait" }],
    ["Hold on", { kind: "wait" }],
    ["Ek minute ruko", { kind: "wait" }],
    ["Oka nimisham aagandi", { kind: "wait" }],
    ["ఒక్క నిమిషం", { kind: "wait" }],
    // read-back
    ["9876543210", { kind: "check", digits: NUMBER }],
    ["98765 43210?", { kind: "check", digits: NUMBER }],
    [
      "nine eight seven six five four three two one zero",
      { kind: "check", digits: NUMBER },
    ],
    ["Is it plus 91 98765 43210?", { kind: "check", digits: "919876543210" }],
    ["nau aath saat chhah paanch", { kind: "check", digits: "98765" }],
    ["తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు", { kind: "check", digits: "98765" }],
    ["९८७६५ ४३२१०", { kind: "check", digits: NUMBER }],
    ["nine double eight seven", { kind: "check", digits: "9887" }],
  ]
  it.each(cases)("%s", (text, want) => {
    expect(parseNumberRequest(text)).toEqual(want)
  })

  it("leaves everyday talk alone", () => {
    for (const text of [
      "Okay, got it.",
      "Thank you",
      "Haan theek hai",
      "Do you need anything else?",
      "Sari",
    ]) {
      expect(parseNumberRequest(text)).toBeNull()
    }
  })

  it("outside the number's turn, needs the number named: 'after 3' is a meeting time", () => {
    expect(parseNumberRequest("Can we do it after 3?", { explicit: true })).toBeNull()
    expect(parseNumberRequest("Sorry?", { explicit: true })).toBeNull()
    expect(parseNumberRequest("4 30 works", { explicit: true })).toBeNull()
    expect(parseNumberRequest("What was the number again?", { explicit: true })).toEqual({
      kind: "repeat",
      slow: false,
    })
    expect(parseNumberRequest("Number ke last chaar digit?", { explicit: true })).toEqual(
      {
        kind: "last",
        n: 4,
      }
    )
  })
})

describe("answers come from the stored digits only", () => {
  it("repeats in full, or slowly", () => {
    expect(say({ kind: "repeat", slow: false }).text).toBe(
      "Ravi's number is nine eight seven six five, four three two one zero."
    )
    expect(digitsIn(say({ kind: "repeat", slow: true }).text)).toBe(NUMBER)
  })

  it("gives the last or first n, a missing n meaning the last group", () => {
    expect(say({ kind: "last", n: 4 }).text).toBe(
      "The last four digits are three two one zero."
    )
    expect(say({ kind: "first", n: 2 }).text).toBe("The first two digits are nine eight.")
    expect(say({ kind: "last", n: 1 }).text).toBe("The last digit is zero.")
    expect(digitsIn(say({ kind: "last", n: null }).text)).toBe("43210")
    expect(digitsIn(say({ kind: "last", n: 15 }).text)).toBe(NUMBER)
  })

  it("says what comes after or before a part", () => {
    expect(say({ kind: "after", digits: "98" }).text).toBe(
      "After nine eight comes seven six five four three two one zero."
    )
    expect(say({ kind: "after", digits: "3210" }).text).toBe(
      "Three two one zero is the end of the number."
    )
    expect(say({ kind: "before", digits: "3210" }).text).toBe(
      "Before three two one zero comes nine eight seven six five four."
    )
    expect(say({ kind: "before", digits: "98" }).text).toBe(
      "The number starts with nine eight."
    )
  })

  it("never guesses: a part that isn't there, or is there twice, gets the whole number", () => {
    expect(say({ kind: "after", digits: "55" }).text).toBe(
      "The number doesn't have five five in it. It's nine eight seven six five, four three two one zero."
    )
    const twice = answerNumberRequest("9898012345", "Ravi", {
      kind: "after",
      digits: "98",
    })
    expect(twice.text).toBe(
      "Nine eight comes more than once. The whole number is nine eight nine eight zero, one two three four five."
    )
  })

  it("checks a read-back: right, right so far, or exactly where it's wrong", () => {
    expect(say({ kind: "check", digits: NUMBER })).toMatchObject({
      text: "Yes, that's correct.",
      readBack: "correct",
    })
    expect(say({ kind: "check", digits: "919876543210" }).readBack).toBe("correct")
    expect(say({ kind: "check", digits: "98765" }).text).toBe(
      "Yes, that's right so far. Then four three two one zero."
    )
    expect(say({ kind: "check", digits: "3210" }).text).toBe(
      "Yes, the number ends with three two one zero."
    )
    expect(say({ kind: "check", digits: "6543" }).text).toBe("Yes, that part is right.")
    expect(say({ kind: "check", digits: "9876443210" })).toMatchObject({
      text: "Not quite, after nine eight seven six it's five, not four. The number is nine eight seven six five, four three two one zero.",
      readBack: "wrong",
    })
    expect(say({ kind: "check", digits: "8876543210" }).text).toMatch(
      /^Not quite, it starts with nine, not eight\./
    )
    expect(say({ kind: "check", digits: "98765432100" }).text).toMatch(
      /^Not quite, there are too many digits\./
    )
  })

  it("on a low-confidence read-back that doesn't match, repeats instead of saying 'wrong'", () => {
    const a = say({ kind: "check", digits: "9876443210" }, { unsure: true })
    expect(a.text).toBe(
      "Sorry, I didn't catch that clearly. The number is nine eight seven six five, four three two one zero."
    )
    expect(a.readBack).toBeUndefined()
  })

  // Over every request on many numbers: each digit Tavi says is in the
  // number, in order, and the stored turn has no digit word at all
  it("never invents a digit, and never stores one", () => {
    const numbers = [
      "9876543210",
      "9000000009",
      "6123456789",
      "04023456789",
      "7777712345",
    ]
    for (const digits of numbers) {
      const requests: NumberRequest[] = [
        { kind: "repeat", slow: false },
        { kind: "repeat", slow: true },
        ...[1, 2, 3, 4, 5, 9, null].flatMap((n) => [
          { kind: "last" as const, n },
          { kind: "first" as const, n },
        ]),
        ...[0, 1, 2, 4, 6]
          .flatMap((at) => [1, 2, 3].map((len) => digits.slice(at, at + len)))
          .flatMap((part) => [
            { kind: "after" as const, digits: part },
            { kind: "before" as const, digits: part },
          ]),
        { kind: "check", digits },
        { kind: "check", digits: digits.slice(0, 5) },
        { kind: "check", digits: "1".repeat(digits.length) },
      ]
      for (const request of requests) {
        const a = answerNumberRequest(digits, "Ravi", request)
        const own = "digits" in request ? request.digits : ""
        for (const run of runsIn(a.text)) {
          expect(
            digits.includes(run) || own.includes(run),
            `${digits} ${JSON.stringify(request)} → ${a.text}`
          ).toBe(true)
        }
        expect(digitsIn(a.stored)).toBe("")
      }
    }
  })
})
