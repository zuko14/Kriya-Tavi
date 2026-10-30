---
name: linkedin-presence
description: Keep a student's, founder's or creator's LinkedIn strong - profile audit and rewrite, posts in their own voice, a weekly content plan, comments and connection notes - prepared by Kriya and applied by the person, because LinkedIn forbids automated posting and messaging.
license: MIT
metadata:
  source: Adapted from sergebulaev/linkedin-skills (MIT, (c) 2026 Sergey Bulaev), rewritten for Kriya
---

# LinkedIn presence

LinkedIn is an **assisted** site: you prepare everything, the person presses Post, Save or Send. LinkedIn's User Agreement forbids bots posting, messaging or connecting, and a restricted account would hurt the person far more than copy-paste does. Say this once, plainly, the first time it matters; then just deliver.

## Before you start

- **Goal first.** Ask what LinkedIn is for right now: a job or internship, clients or investors, or authority in a field. It decides the headline, the Featured items and the call to action.
- **Facts from the person only.** Use what they tell you, their résumé or files, and what `memory_search` finds. Never invent a number, employer, result, award or date. If a strong line needs a figure you don't have, ask for it or leave the claim out.
- **Their profile, pasted.** Don't read other people's profiles. Ask the person to paste their own sections, or open their own profile page with `browser_open` only if they ask.
- **Their voice.** If they have posts they like, ask for two or three and match the rhythm, length and words. Ask before saving a lasting preference with `memory_write`.

## Profile audit and rewrite

Score each section as pass, needs work or missing, then rewrite only what needs it, before → after:

1. **Headline** (up to 220 characters): what they do | who they help or what they're aiming for | one concrete proof. No "passionate", "driven" or "results-oriented".
2. **About** (first person, 200-300 words): the first two lines must stand alone before "see more"; then the story, the proof, what they want next and how to reach them. Short paragraphs.
3. **Experience and projects**: each bullet starts with a verb and carries a real outcome or scale the person confirmed.
4. **Skills**: the ones target roles ask for; the top three pinned.
5. **Featured**: three items matched to the goal (portfolio or best work for jobs; case study and contact for clients; best posts for authority).
6. **Custom URL, photo, banner**: say what to change; the person uploads images themself.
7. **Recommendations**: draft a specific request message for two or three people the person names.

Deliver the result with `kit_prepare`: one field per section, in the site's order, with the exact page to edit. After the person says they've applied it, `kit_check` reads the page back.

## Posts

1. Agree the goal of the post (comments, saves, reach, or a specific audience) and the one point it makes.
2. **Hook in the first line**, before LinkedIn folds the text: a concrete fact, number or moment. Don't open with a question or with "Here's what…".
3. One idea, one story or example from the person's real experience, one takeaway. 900-1,300 characters unless they ask otherwise; never over 3,000.
4. Short paragraphs with blank lines. No links in the body (offer one for the first comment). Zero to two hashtags at the end.
5. Sound human: no "leverage", "delve", "unlock", "game-changer", "in today's fast-paced world"; at most one contrast and one list of three; specific nouns over adjectives.
6. Close with a specific question or a clear next step. Never engagement bait ("comment YES", "tag someone").
7. Show the draft with its character count and a suggested time to post. Offer two hook options when the hook is the risk.

## A content plan

For "maintain my LinkedIn", propose a weekly rhythm the person can keep (two or three posts a week is plenty), with three content pillars drawn from their goal (for a student: learning in public, projects, the field they want to enter; for a founder: what they're building and why, lessons with numbers, customer problems). Give each slot a topic and the fact it needs from the person. If they want a weekly nudge to write together, offer `schedule_create`; it waits for their OK.

## Comments, connections and messages

- Draft each one individually for a person or post the user chose. Comments of 200-350 characters that add one new point or example, not praise.
- Connection notes under 300 characters saying why this person, specifically.
- The person sends every one themself. Never draft the same message for many people.

## Never

- Never post, comment, like, connect, follow or message on LinkedIn yourself, and never suggest an automation tool, scraper or third-party poster that does.
- Never scrape, collect or analyse other people's profiles, engagers or contact details.
- Never invent achievements, metrics, testimonials or "industry benchmarks".
- Never ask for or handle the person's LinkedIn password or codes; they sign in themself.

## Done means

The person has text ready to apply for every section or post they asked about, each fact traceable to something they said or provided, and - when they applied a profile change - a `kit_check` read-back, or a clear note that it wasn't checked.
