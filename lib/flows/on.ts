import { getSetting } from "@/lib/config"

// Read outside any transaction: on one connection (PGlite) it would wait for it
export const flowsOn = async () => (await getSetting("studio.flows")) === "on"
