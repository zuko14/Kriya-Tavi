---
name: kriya-browser-test
description: Use when building or fixing a web app: run it locally and check it in the agent's browser (browser_open, browser_read, browser_click, browser_console) instead of assuming the UI works.
license: MIT
metadata:
  source: Written for Kriya Harness, based on ECC browser-qa (MIT); ECC e2e-testing (MIT)
  default: Kriya default skill
---

# Test the app in the browser

Tests can pass while the page is broken. When the work is a web app, look at it. Kriya Harness's browser opens apps on this computer only (localhost); it needs `--browser-tools`.

1. **Start the app** with its own dev command, in the background, and note its local address.
2. **`browser_open`** that address. Nothing listening? The app didn't start: read its output.
3. **`browser_read`** for the text and the elements (each with a ref). **`browser_screenshot`** when layout matters and the model can see images.
4. **Act like the person would:** `browser_click`, `browser_type`, `browser_press` with refs from the last read; read again after each action.
5. **Check the plumbing:** `browser_console` for errors, `browser_network` for failed requests.
6. **Report what you saw**, not what you expected: the steps, the result, and any errors.

Never type passwords, codes or payment details, even into a local app; use test data the project provides. Other sites can't be opened, and a link out of localhost is refused.
