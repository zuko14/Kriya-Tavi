// Shown the moment a workspace link is tapped, while the server renders the
// page: soft glass placeholders, so a tap always answers at once
export default function WorkspaceLoading() {
  return (
    <div aria-busy className="relative min-h-0 flex-1 overflow-hidden">
      <span className="sr-only">Loading…</span>
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-6 sm:px-6 sm:pt-14">
        <div className="flex items-center gap-4">
          <span className="glass size-14 shrink-0 animate-pulse rounded-full" />
          <span className="glass h-8 w-2/3 animate-pulse rounded-xl" />
        </div>
        <span className="glass h-32 animate-pulse rounded-[28px]" />
        <div className="flex gap-3">
          {[0, 1, 2].map((i) => (
            <span key={i} className="glass size-14 animate-pulse rounded-[30%]" />
          ))}
        </div>
        <span className="glass h-24 animate-pulse rounded-[20px]" />
      </div>
    </div>
  )
}
