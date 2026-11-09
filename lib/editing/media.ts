// Track E, EDD-52, EDD-57 (DIRECTOR_PLAYBOOKS.md DP4, DP6): openly licensed pictures and cited
// definitions, from official APIs only. No key, no person's data: a device sends search words and
// gets back metadata; it downloads the file itself. Only what this file can read as public
// domain, CC0 or CC BY passes: share-alike, non-commercial and unknown are dropped, never guessed.

const AGENT = "KriyaEditingStudio/1.0 (https://github.com/zuko14/kriya-harness)"
const TIMEOUT_MS = 8_000
const PER_SOURCE = 6
// A device only downloads from these; a result on any other host is dropped here too
export const MEDIA_HOSTS = [
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
  "images-assets.nasa.gov",
  "live.staticflickr.com",
]
const MAX_VIDEO_BYTES = 80 * 1024 * 1024
const MAX_QUOTE = 100

export type MediaItem = {
  id: string
  source: "wikimedia" | "nasa" | "openverse"
  kind: "image" | "video"
  title: string
  url: string
  thumb: string
  width: number | null
  height: number | null
  licence: string
  rights: "public_domain" | "licensed"
  creator: string
  page: string
}

const clean = (text: unknown, max = 160) =>
  String(text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)

/** A licence's rights, or null when it isn't one EDD-52 allows. Reads the words, refuses anything else. */
export function readLicence(raw: unknown) {
  const text = clean(raw, 60).toLowerCase()
  if (
    !text ||
    /\b(?:sa|nc|nd)\b|share|non-?commercial|no ?deriv|gfdl|fair use|copyright|all rights/.test(
      text
    )
  )
    return null
  if (/^(?:cc0|cc-zero|cc zero)\b/.test(text))
    return { licence: "CC0", rights: "public_domain" as const }
  if (/^(?:public domain|pd\b|pdm\b|pd-)/.test(text))
    return { licence: "Public domain", rights: "public_domain" as const }
  const by = /^cc[ -]by(?:[ -](\d(?:\.\d)?))?$/.exec(text)
  return by
    ? { licence: `CC BY${by[1] ? ` ${by[1]}` : ""}`, rights: "licensed" as const }
    : null
}

const onAllowedHost = (url: unknown) => {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === "https:" && MEDIA_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

async function getJson(url: string, signal?: AbortSignal) {
  const limit = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    headers: { "user-agent": AGENT, accept: "application/json" },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, limit]) : limit,
  })
  if (!response.ok) throw new Error(`answered ${response.status}`)
  return (await response.json()) as Record<string, unknown>
}

/* eslint-disable @typescript-eslint/no-explicit-any -- third-party JSON, read defensively field by field */
export function fromWikimedia(data: any): MediaItem[] {
  const pages: any[] = Object.values(data?.query?.pages ?? {})
  return pages.flatMap((page) => {
    const info = page?.imageinfo?.[0]
    const rights = readLicence(info?.extmetadata?.LicenseShortName?.value)
    const mime = String(info?.mime ?? "")
    const kind = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : null
    if (!info || !rights || !kind) return []
    if (
      kind === "video" &&
      !(Number(info.size) > 0 && Number(info.size) <= MAX_VIDEO_BYTES)
    )
      return []
    const url = kind === "image" ? (info.thumburl ?? info.url) : info.url
    const thumb = info.thumburl ?? info.url
    if (!onAllowedHost(url) || !onAllowedHost(thumb)) return []
    // A GIF moves on its own and can't take a slow move; a computer only accepts stills it can read
    if (kind === "image" && /\.gif(?:$|\?|\/)/i.test(String(url))) return []
    return [
      {
        id: `wikimedia:${page.pageid}`,
        source: "wikimedia" as const,
        kind: kind as "image" | "video",
        title: clean(String(page.title ?? "").replace(/^File:/, "")),
        url,
        thumb,
        width: Number(info.thumbwidth ?? info.width) || null,
        height: Number(info.thumbheight ?? info.height) || null,
        ...rights,
        creator: clean(info.extmetadata?.Artist?.value) || "Unknown",
        page: String(info.descriptionurl ?? ""),
      },
    ]
  })
}

export function fromNasa(data: any): MediaItem[] {
  const items: any[] = data?.collection?.items ?? []
  return items.flatMap((item) => {
    const meta = item?.data?.[0]
    const thumb = item?.links?.find((l: any) => l?.render === "image")?.href
    if (!meta?.nasa_id || !onAllowedHost(thumb)) return []
    const url = String(thumb).replace(/~thumb\.(jpg|png)$/i, "~large.$1")
    return [
      {
        id: `nasa:${meta.nasa_id}`,
        source: "nasa" as const,
        kind: "image" as const,
        title: clean(meta.title),
        url,
        thumb,
        width: null,
        height: null,
        licence: "Public domain",
        rights: "public_domain" as const,
        creator: clean(meta.secondary_creator ?? meta.center) || "NASA",
        page: `https://images.nasa.gov/details/${encodeURIComponent(meta.nasa_id)}`,
      },
    ]
  })
}

export function fromOpenverse(data: any): MediaItem[] {
  const items: any[] = data?.results ?? []
  return items.flatMap((item) => {
    const rights = readLicence(
      `${item?.license === "by" ? "cc by" : item?.license === "pdm" ? "pdm" : item?.license} ${item?.license_version ?? ""}`.trim()
    )
    if (!rights || !onAllowedHost(item?.url)) return []
    return [
      {
        id: `openverse:${item.id}`,
        source: "openverse" as const,
        kind: "image" as const,
        title: clean(item.title),
        url: item.url,
        thumb: item.url,
        width: Number(item.width) || null,
        height: Number(item.height) || null,
        ...rights,
        creator: clean(item.creator) || "Unknown",
        page: String(item.foreign_landing_url ?? ""),
      },
    ]
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** One query across the three sources. A source that fails or is slow is left out, never fatal. */
async function searchOne(query: string, signal?: AbortSignal) {
  const q = encodeURIComponent(query)
  const sources = [
    getJson(
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=50&gsrsearch=${q}&prop=imageinfo&iiprop=url%7Cmime%7Csize%7Cextmetadata&iiurlwidth=1920&iiextmetadatafilter=LicenseShortName%7CArtist`,
      signal
    ).then(fromWikimedia),
    getJson(
      `https://images-api.nasa.gov/search?media_type=image&page_size=${PER_SOURCE}&q=${q}`,
      signal
    ).then(fromNasa),
    getJson(
      `https://api.openverse.org/v1/images/?page_size=${PER_SOURCE}&license=cc0,pdm,by&q=${q}`,
      signal
    ).then(fromOpenverse),
  ]
  const settled = await Promise.allSettled(sources)
  const items = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []))
  return { query, items: items.slice(0, PER_SOURCE * 2) }
}

export async function searchMedia(queries: string[], signal?: AbortSignal) {
  return { results: await Promise.all(queries.map((query) => searchOne(query, signal))) }
}

/** Its opening sentence, word for word, or a shortened quote that says so. Null when there's no plain sentence. */
export function firstSentence(extract: unknown) {
  const text = clean(extract, 600)
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? ""
  if (sentence.length < 12) return null
  if (sentence.length <= MAX_QUOTE) return sentence
  const cut = sentence.slice(0, MAX_QUOTE - 1)
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- third-party JSON */
export function fromWikipedia(term: string, data: any) {
  if (data?.type !== "standard") return null
  const quote = firstSentence(data.extract)
  const page = data?.content_urls?.desktop?.page
  if (!quote || typeof page !== "string" || !page.startsWith("https://en.wikipedia.org/"))
    return null
  return {
    term,
    title: clean(data.title, 80),
    quote,
    source: "Wikipedia",
    page,
    licence: "CC BY-SA 4.0",
  }
}

/** Definitions of terms, each quoted and cited (EDD-57). A term with no clear article is left out. */
export async function defineTerms(terms: string[], signal?: AbortSignal) {
  const settled = await Promise.allSettled(
    terms.map((term) =>
      getJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, "_"))}`,
        signal
      ).then((data) => fromWikipedia(term, data))
    )
  )
  return {
    definitions: settled.flatMap((s) =>
      s.status === "fulfilled" && s.value ? [s.value] : []
    ),
  }
}
