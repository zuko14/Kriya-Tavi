// Runs once when the Kriya web server boots
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  process.env.KRIYA_SERVICE ??= "web"
  // Refuses to start in production with required settings missing
  const { checkEnvironment } = await import("./lib/env")
  checkEnvironment("web")
}
