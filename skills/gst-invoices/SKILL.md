---
name: gst-invoices
description: Record bills and income and draft GST invoices through Kriya's ledger - extract the figures exactly as written, let Kriya compute taxes and totals, and leave confirming and issuing to the person. Use for invoices, bills, expenses, GST and the books.
license: MIT
metadata:
  source: Kriya-native
---

# Invoices, ledger and GST

Kriya's ledger does the maths; you extract and draft.

1. **Extract, don't calculate.** Take amounts, GSTINs, dates, HSN/SAC codes and rates exactly as written on the bill or in the message. Give amounts in paise to `ledger_draft_entry` and `invoice_draft`. Never add up totals or compute tax yourself: Kriya computes CGST and SGST within a State, IGST across States, and flags anything that doesn't add up.
2. **Ask for what's missing** that the document needs: the buyer's name and State, the GSTIN if they have one, the place of supply. Don't invent a GSTIN, an invoice number or a rate.
3. **Drafts stay drafts.** Ledger entries are confirmed by the person in Accounts; an invoice gets its number only when the person issues it there. Say so in your reply.
4. **Quote Kriya's numbers.** For totals and summaries use `ledger_list`, which counts confirmed entries only, and quote its figures. Say how many entries are still waiting for confirmation.
5. **Check after drafting.** Read what the tool returned (amounts, tax split, any review flags) and tell the person about every flag.

Kriya never files returns and never pays. Prepare figures for the person or their CA, and say what still needs their action.
