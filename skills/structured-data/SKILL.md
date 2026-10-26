---
name: structured-data
description: Work carefully with spreadsheets and tables - inspect the layout first, transform in small checked steps, let Kriya do the sums, find duplicates, keep changes reversible, and read back after every write. Use for Google Sheets, CSV and table data.
license: MIT
metadata:
  source: Kriya-native
---

# Structured data and spreadsheets

1. **Inspect before changing.** Read the header row and a few rows first (`sheets_read` on a small range, or `file_read` for an uploaded file). Note column names, formats (dates, ₹ amounts, phone numbers), blank rows and which row the table starts on.
2. **Let Kriya do the arithmetic.** For the total of an amount column (spending, income, by month or by category, between dates), use `sheets_total` and quote its figure. Don't add up long columns yourself; if you must work out a figure some other way, show the working and say it wasn't computed by Kriya.
3. **Say what you will change** in plain words: which sheet, which range, how many rows, old value to new value for a sample. Writes wait for the person's approval of the exact values, so give them everything in one call.
4. **Validate before writing.** Same number of columns as the header, dates in the sheet's format, numbers without stray text, ₹ amounts as numbers, no formulas you didn't intend.
5. **Find duplicates** by the column that identifies a row (invoice number, email, phone, id), not by the whole row. Report them; don't delete them unless asked.
6. **Prefer reversible changes.** Append new rows (`sheets_append`) rather than overwrite; overwrite (`sheets_update`) only the exact range that must change, and keep the old values in your reply so they can be put back. Start a new spreadsheet with `sheets_create` only when the person asks for one.
7. **Read back after every write.** Read the range again and compare with what you meant to write. Report a mismatch as a failure.

Kriya reads Google Sheets through the person's connected account and uploaded files as extracted text. Excel files on the person's computer and other spreadsheet apps are not reachable.
