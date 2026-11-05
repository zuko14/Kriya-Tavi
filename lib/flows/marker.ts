// What a flow step's brief is marked with (SD-11). A step works in its own
// thread, so privateContentSeen and untrustedSeen can't see what earlier
// steps read; these carry that across. Pure, so lib/agent/tools.ts can import
// it, as it does ROOM_CONTEXT. A person typing one only makes things stricter.

// Quotes earlier steps: untrusted, so what follows is memory-quarantined
export const FLOW_CONTEXT = "From earlier steps of this flow"
// An earlier step read private content: web reads wait for approval
export const FLOW_PRIVATE = "Earlier steps read the person's private content"
