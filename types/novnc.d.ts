// The DefinitelyTyped package still describes noVNC's old `lib/` entry
// points; 1.7 exports the client from the package root.
declare module "@novnc/novnc" {
  import RFB from "@novnc/novnc/lib/rfb"

  export default RFB
}
