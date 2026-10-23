---
name: calendar-operations
description: Read the person's Google Calendar to find what's planned and free time, and add events only with complete, checked details that the person approves. Use for meetings, appointments, availability and scheduling.
license: MIT
metadata:
  source: Kriya-native
---

# Calendar operations

1. **Look first.** Use `calendar_events` for the days involved before suggesting a time or adding anything. Check for clashes and travel time.
2. **Use the person's time zone** (India Standard Time unless they say otherwise) and say dates with the day of the week: "Tuesday 4 November, 3:00–3:30 pm".
3. **Fill in everything before asking.** Title, date, start and end, attendees' emails exactly as given, location or link. Attendees get an invite email from Google, so never add an attendee the person didn't name.
4. **One approval, one call.** `calendar_create_event` waits for the person to approve the exact event. Make the call once; if they decline, ask what to change rather than trying again.
5. **Confirm from the result.** After approval, read what the tool returned (or list the events again) and report the event as it is now on the calendar. If it isn't there, say so.

You can't accept invitations, change other people's calendars, or edit or delete existing events.
