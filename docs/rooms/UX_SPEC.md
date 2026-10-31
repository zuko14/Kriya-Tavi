# UX spec (track R: Rooms)

Mobile first (360 px, 44 px targets), existing tokens and `components/ui`,
track U copy rules. Agents are always labelled as AI and as someone's.

## 1. Where Rooms appear

| Surface | File (phase) |
| --- | --- |
| Home: "Rooms" section (last 3 active rooms with unread counts, **New room**) | `app/(workspace)/home/page.tsx` (R3) |
| Sidebar item and command palette entry "Rooms" | `components/workspace/sidebar.tsx`, `command-palette.tsx` (R3) |
| Rooms list `/rooms` | `app/(workspace)/rooms/page.tsx` (R3) |
| Room `/rooms/[roomId]` | `app/(workspace)/rooms/[roomId]/page.tsx`, `components/rooms/*` (R3, R4) |
| Join `/rooms/join/[token]` | `app/(workspace)/rooms/join/[token]/page.tsx` (R2) |
| Inbox: "Share in room?" items | `queries/inbox.ts`, `components/inbox/room-disclosure.tsx` (R4) |

No new bottom-nav tab (five tabs today, RD-15).

## 2. Room page

- **Header:** title, topic (one line), member avatars (people round, agents
  with the agent glyph and a small "AI" mark), **⋯** menu (Room info,
  Invite, Agents, Notes (R8), Goal (R7), Leave / Archive).
- **Messages:** people's messages left/right as in common chat apps; agent
  messages with the agent's name, "AI · <owner's name>'s agent", the text,
  and a **proof card** when present; system lines small and centred
  ("Arjun's agent is working…", "waiting for Arjun to share", "Stopped").
- **Proof card (collapsed):** "✓ 2 actions verified · 1 claim not
  verified" and "Independently verified by Meera's agent" when set.
  **Expanded:** each verified action with method in words ("checked on
  GitHub", "checked on the page") and links; claims without proof listed
  as "not verified"; citation checks count. Owner-only line: "Cost ₹3.20".
  Actions: **Ask an agent to verify** (picker of room agents the person may
  invoke).
- **Composer:** text, `@` picker (people and agents; agents the person can't
  invoke appear greyed with "answers only to <owner>"), send. While agents
  are working: **Stop agents** button for any member.
- **Agents sheet:** each agent with owner, who can invoke it, today's cap
  (owner sees spend; others see "limit reached" only); the owner's own
  agents show **Add to room / Remove**, the invoke policy, daily cap,
  "Allow my connected accounts in this room" (off; with a warning line).
- **Room info:** members, roles, "Agents in this room read its messages.
  Rooms aren't end-to-end encrypted." Invite link creation (expiry, uses).

## 3. Disclosure in the Inbox

"Arjun's agent has a reply for **Launch room** that used your private
data:" · the exact text and card that would be posted · **Share in room** /
**Discard**. Shared → the room's "waiting" line is replaced by the message.

## 4. Empty and error states

No rooms: "Rooms are for working with people and their agents. Start one
and invite someone." Join with an expired link: "This invite has expired.
Ask for a new one." Busy agent: system line. Limit reached: system line
with the reason. Realtime down: no banner; messages arrive within 10 s
(polling).

## 5. Browser checks (R2–R4, R7, R8)

Isolated stack, 360×800 and 1280×800, light and dark, two test accounts in
two browser profiles: create, invite, join, post, mention, agent reply with
card, disclosure path, Stop agents, leave/remove, unread counts.
Screenshots in `screenshots/rooms/<phase>/`.
