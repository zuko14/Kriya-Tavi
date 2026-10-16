import { redirect } from "next/navigation"

// Settings became Account: models, keys and machines are Kriya's to run now
export default function Page() {
  redirect("/account")
}
