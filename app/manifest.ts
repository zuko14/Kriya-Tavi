import type { MetadataRoute } from "next"

// Lets Chrome on Android add Kriya Tavi to the home screen. Optional: everything
// works in the browser without installing anything.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kriya Tavi",
    short_name: "Tavi",
    description: "Your personal AI, with a team of agents behind it.",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#0a1213",
    theme_color: "#0a1213",
    lang: "en-IN",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/tavi/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  }
}
