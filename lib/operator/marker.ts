// What a crew's messages are marked with (track O, O11). Each member works in
// its own thread and passes on text, so privateContentSeen and untrustedSeen
// can't see what another thread read; these carry that across. Pure, so
// lib/agent/tools.ts can import it, as it does ROOM_CONTEXT. Text that merely
// quotes one only makes things stricter.

// May quote what another thread read: memory saved after it stays unconfirmed
export const CREW_CONTEXT = "Passed on within this crew"
// That thread saw private content: web reads wait for the person's approval
export const CREW_PRIVATE = "This crew read the person's private content"
