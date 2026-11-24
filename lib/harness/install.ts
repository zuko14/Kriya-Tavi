import { INSTALL_SCRIPT } from "@/lib/harness/install-script"

// S-2 (docs/kriya-harness/INSTALLER.md): the installer with this Kriya's
// address filled in, so it opens the sign-in here. An address a shell could
// read as anything but a plain URL leaves the placeholder (no sign-in step).

const PLACEHOLDER = 'KRIYA_URL_DEFAULT="__KRIYA_URL__"'
const SAFE_URL =
  /^(https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1):\d{1,5})$/

export function installScript(url: string) {
  return SAFE_URL.test(url)
    ? INSTALL_SCRIPT.replace(PLACEHOLDER, `KRIYA_URL_DEFAULT="${url}"`)
    : INSTALL_SCRIPT
}

/** The one line the Harness page shows */
export const installLine = (url: string) => `curl -fsSL ${url}/install.sh | sh`
