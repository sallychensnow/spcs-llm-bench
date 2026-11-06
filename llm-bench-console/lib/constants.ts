/** App title — displayed in the nav header and browser tab */
export const APP_TITLE = "LLM Bench Console"

/** Path to the logo in /public (used in the header and as favicon) */
export const LOGO_SRC = "/icon.svg"

/** Pages listed under "Go to" in the ⌘K command palette. */
export const NAV_ITEMS: { label: string; href: string }[] = [
  { label: "Runs", href: "/" },
  { label: "New run", href: "/runs/new" },
  { label: "Targets", href: "/targets" },
  { label: "Monitor", href: "/monitor" },
]
