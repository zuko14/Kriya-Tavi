import type { deliveryView } from "@/lib/delivery/status"

// The delivery line at the top of a "What I did" card (N2, UX_SPEC §1): one
// answer, computed by code (lib/delivery/status.ts), in words and not colour
// alone. Nothing to deliver, or no status at all, draws no line.

type Status = ReturnType<typeof deliveryView>["status"]

const LINES: { [K in Exclude<Status, "nothing_to_deliver">]: [string, string, string] } =
  {
    delivered: ["Delivered · checked by Kriya", "●", "text-rigel"],
    partly: ["Partly delivered", "◐", "text-betelgeuse"],
    not_confirmed: ["Not confirmed", "○", "text-betelgeuse"],
  }

export function DeliveryStatus({ status }: { status: Status }) {
  if (status === "nothing_to_deliver") return null
  const [label, mark, tone] = LINES[status]
  return (
    <p className="flex items-center gap-2">
      <span role="img" aria-label={label} className={`text-[13px] leading-none ${tone}`}>
        {mark}
      </span>
      <span className={`label-mono ${tone}`}>{label}</span>
    </p>
  )
}
