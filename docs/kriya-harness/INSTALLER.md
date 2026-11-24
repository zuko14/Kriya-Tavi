# S-2 The one-line installer

The owner's decision is SI-02 (2026-11-24, `status.md`): the one-line
installer first; the menu-bar app is a later phase. The source is
`STRATEGIC_INTENTS_SOVEREIGN_COMPUTE_AND_ONBOARDING.md` milestone S-2, which
is internal.

## What the person does

```bash
curl -fsSL https://<your Kriya>/install.sh | sh
```

The Harness page shows this line, with Kriya's own address, when
`harness.installScript` is on. The script then:

1. Checks the computer: macOS or Linux, arm64 or x64. On Windows it says to
   run it inside WSL.
2. Downloads Node 24.22.0 from nodejs.org into
   `~/.kriya/runtime/node-v24.22.0-<platform>`. It checks the download
   against the sha256 written in the script; a mismatch installs nothing.
   It skips the download if that Node is already there.
3. Installs `@kriya-ai/harness@<pinned version>` with that Node's own npm,
   into `~/.kriya/npm`. The person's own Node, npm, nvm and `/usr/local` are
   never touched, so there are no EACCES errors or version clashes.
4. Writes `~/.kriya/bin/kriya`, a wrapper that runs Kriya Harness on the
   private Node. It adds `~/.kriya/bin` to PATH once, in the shell's startup
   file. `KRIYA_NO_MODIFY_PATH=1` prints the line instead.
5. Runs `kriya login` against the Kriya that served the script, unless the
   computer is already signed in or `KRIYA_NO_LOGIN=1` is set.

Running the script again repairs or updates. `~/.kriya` (sign-in, sessions,
settings) stays, and is kept at mode 700.

## Rules

1. **Off by default.** `harness.installScript` is off unless the owner turns
   it on, and it needs `harness.api`. Off: `/install.sh` answers 404 and the
   page shows `harness.installCommand` as before.
2. **One owner of the script.** `install.sh` lives in kriya-harness. Kriya
   serves a generated copy (`lib/harness/install-script.ts`, from
   `scripts/harness-install-script.ts`, then `npx prettier --write` on it)
   with its sha256. `tests/harness/install-script.test.ts` fails if the copy
   is hand-edited or differs from the sibling repository's file.
3. **The address comes from configuration only.** The sign-in address is
   `KRIYA_APP_URL`, never the request's Host header, so a cached copy can't
   carry someone else's. It's filled in only when it is a plain https (or
   localhost) URL; otherwise the script skips the sign-in step.
4. **A partial download runs nothing.** Everything runs inside `main`,
   called on the last line.
5. **Pinned versions.** `KRIYA_VERSION` must equal the package version
   (test IN-06). A release bumps it, regenerates the copy here and redeploys.
   Node's four checksums come from nodejs.org's `SHASUMS256.txt` for the
   pinned version.

## Not done, or unknown

- **A real install** (a real Node download and `npm install` from the
  registry) has not been run. **Check:**
  `KRIYA_HOME=$(mktemp -d)/k sh install.sh` with `KRIYA_NO_MODIFY_PATH=1`.
- **Windows outside WSL** (a PowerShell script) and the menu-bar app are
  later phases.
- **Node isn't GPG-verified.** Node's GPG signature on `SHASUMS256.txt` isn't
  checked: the hashes are embedded at release time instead.

## Tests

- **Client:** `tests/install-script.test.js` IN-01…06 (the real script with
  fake curl, uname and npm).
- **Server:** `tests/harness/install-script.test.ts` HT-INS-01…03, and
  HT-REG-01.
