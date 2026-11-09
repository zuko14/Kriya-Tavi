import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  firstSentence,
  fromNasa,
  fromOpenverse,
  fromWikimedia,
  fromWikipedia,
  readLicence,
} from "@/lib/editing/media"

// ET-MD-* (DP4, DP6): only what can be read as public domain, CC0 or CC BY passes, and only from
// the hosts a computer may download from.

const commons = (over = {}, license = "CC BY 4.0") => ({
  query: {
    pages: {
      1: {
        pageid: 1,
        title: "File:Temple.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/o.jpg",
            thumburl: "https://upload.wikimedia.org/t.jpg",
            thumbwidth: 1920,
            thumbheight: 1080,
            mime: "image/jpeg",
            size: 100,
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Temple.jpg",
            extmetadata: {
              LicenseShortName: { value: license },
              Artist: { value: '<a href="x">Ravi</a>' },
            },
            ...over,
          },
        ],
      },
    },
  },
})

describe("licences", () => {
  it.each([
    ["CC0", "CC0"],
    ["CC0 1.0", "CC0"],
    ["Public domain", "Public domain"],
    ["PD-old", "Public domain"],
    ["CC BY 4.0", "CC BY 4.0"],
    ["CC BY 2.0", "CC BY 2.0"],
    ["cc by", "CC BY"],
  ])("allows %s", (raw, licence) => {
    expect(readLicence(raw)?.licence).toBe(licence)
  })
  it.each([
    "CC BY-SA 4.0",
    "CC BY-NC 2.0",
    "CC BY-ND 3.0",
    "CC BY-NC-SA",
    "GFDL",
    "Copyrighted",
    "All rights reserved",
    "Fair use",
    "",
    null,
    "Attribution",
    "CC SA 1.0",
  ])("refuses %s", (raw) => {
    expect(readLicence(raw)).toBeNull()
  })
})

describe("sources", () => {
  it("reads Commons, strips markup, keeps the credit", () => {
    const [item] = fromWikimedia(commons())
    expect(item).toMatchObject({
      id: "wikimedia:1",
      kind: "image",
      title: "Temple.jpg",
      url: "https://upload.wikimedia.org/t.jpg",
      licence: "CC BY 4.0",
      rights: "licensed",
      creator: "Ravi",
    })
  })
  it("drops share-alike, other hosts, other kinds and huge videos", () => {
    expect(fromWikimedia(commons({}, "CC BY-SA 4.0"))).toEqual([])
    expect(fromWikimedia(commons({ thumburl: "https://evil.example/t.jpg" }))).toEqual([])
    expect(
      fromWikimedia(commons({ thumburl: "http://upload.wikimedia.org/t.jpg" }))
    ).toEqual([])
    expect(fromWikimedia(commons({ mime: "application/pdf" }))).toEqual([])
    expect(
      fromWikimedia(commons({ mime: "video/webm", size: 900 * 1024 * 1024 }))
    ).toEqual([])
    expect(fromWikimedia({})).toEqual([])
    expect(
      fromWikimedia(commons({ thumburl: "https://upload.wikimedia.org/a.gif?utm=1" }))
    ).toEqual([])
    expect(
      fromWikimedia(commons({ thumburl: "https://thumb.wikimedia.org/t.jpg" }))[0].url
    ).toBe("https://thumb.wikimedia.org/t.jpg")
  })
  it("reads NASA as public domain, at a larger size", () => {
    const [item] = fromNasa({
      collection: {
        items: [
          {
            data: [{ nasa_id: "A1", title: "Moon", center: "JSC" }],
            links: [
              {
                render: "image",
                href: "https://images-assets.nasa.gov/image/A1/A1~thumb.jpg",
              },
            ],
          },
        ],
      },
    })
    expect(item).toMatchObject({
      id: "nasa:A1",
      url: "https://images-assets.nasa.gov/image/A1/A1~large.jpg",
      licence: "Public domain",
      creator: "JSC",
    })
    expect(
      fromNasa({
        collection: {
          items: [
            {
              data: [{ nasa_id: "A" }],
              links: [{ render: "image", href: "https://x.test/a.jpg" }],
            },
          ],
        },
      })
    ).toEqual([])
  })
  it("reads Openverse and keeps only allowed hosts and licences", () => {
    const row = {
      id: "o1",
      title: "T",
      url: "https://live.staticflickr.com/1/a.jpg",
      license: "by",
      license_version: "2.0",
      creator: "A",
      foreign_landing_url: "https://flickr.com/x",
    }
    expect(fromOpenverse({ results: [row] })[0]).toMatchObject({
      licence: "CC BY 2.0",
      rights: "licensed",
    })
    expect(
      fromOpenverse({ results: [{ ...row, license: "cc0", license_version: "1.0" }] })[0]
        .licence
    ).toBe("CC0")
    expect(fromOpenverse({ results: [{ ...row, license: "by-sa" }] })).toEqual([])
    expect(
      fromOpenverse({ results: [{ ...row, url: "https://other.test/a.jpg" }] })
    ).toEqual([])
  })
})

describe("definitions", () => {
  it("quotes the first sentence word for word, and marks a shortened one", () => {
    expect(firstSentence("Insulin is a peptide hormone. It does more.")).toBe(
      "Insulin is a peptide hormone."
    )
    const long = firstSentence(`${"word ".repeat(40)}end.`)
    expect(long?.endsWith("…")).toBe(true)
    expect(long!.length).toBeLessThanOrEqual(100)
    expect(firstSentence("Short.")).toBeNull()
  })
  it("cites only a plain English article", () => {
    const page = { desktop: { page: "https://en.wikipedia.org/wiki/Insulin" } }
    expect(
      fromWikipedia("insulin", {
        type: "standard",
        title: "Insulin",
        extract: "Insulin is a peptide hormone.",
        content_urls: page,
      })
    ).toMatchObject({
      source: "Wikipedia",
      quote: "Insulin is a peptide hormone.",
      page: page.desktop.page,
    })
    expect(
      fromWikipedia("x", {
        type: "disambiguation",
        extract: "X may refer to many things.",
        content_urls: page,
      })
    ).toBeNull()
    expect(
      fromWikipedia("x", {
        type: "standard",
        extract: "X is a long enough sentence.",
        content_urls: { desktop: { page: "https://evil.test/" } },
      })
    ).toBeNull()
  })
})
