import fs from "node:fs"
import path from "node:path"

// The highest fence each sandbox has been opened with (CD-31), kept on disk
// so a restarted agent still refuses an older holder. Written to a temporary
// file and renamed, so a crash leaves the previous or the new map, never a
// torn one. A fence only ever goes up.

export class FenceStore {
  private fences = new Map<string, number>()
  private readonly file: string

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = path.join(dir, "fences.json")
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<
        string,
        unknown
      >
      for (const [ref, fence] of Object.entries(saved))
        if (Number.isSafeInteger(fence)) this.fences.set(ref, fence as number)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  get(ref: string) {
    return this.fences.get(ref) ?? 0
  }

  // False when the fence is older than the one recorded
  advance(ref: string, fence: number) {
    if (fence < this.get(ref)) return false
    if (fence > this.get(ref)) {
      this.fences.set(ref, fence)
      this.save()
    }
    return true
  }

  delete(ref: string) {
    if (this.fences.delete(ref)) this.save()
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    // fsync before the rename: after a power cut the file is the old map or
    // the new one, never empty (an empty one would keep the agent down)
    const fd = fs.openSync(tmp, "w", 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(Object.fromEntries(this.fences)))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)
  }
}
