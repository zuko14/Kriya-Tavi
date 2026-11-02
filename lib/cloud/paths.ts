// Pure naming helpers, no environment and no provider: the one lib/cloud
// module the web side may import (track H's handoff routes, PX-02, CD-27).

// A checkpoint in kriya-files (CD-13)
export const checkpointPath = (
  userId: string,
  workspaceId: string,
  generation: number,
  seq: number
) => `workspaces/${userId}/${workspaceId}/${generation}-${seq}.patch`
