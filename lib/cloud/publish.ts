import { RunnerRequestError } from "@/lib/cloud/client"
import type { TaskWorkspace } from "@/lib/cloud/session"
import { githubCommitTree, githubOpenDraftPr } from "@/lib/connectors/github"

// workspace_publish (CD-10): exactly the change set the person approved,
// into the workspace's own repository, as one commit on a new kriya/ branch
// and a draft pull request. The destination and the change set are checked
// before GitHub is asked anything.

export type PublishInput = {
  repo: string
  changeSetId: string
  branch: string
  title: string
  body: string
}

const CHANGED = "The workspace changed after you approved; review the new changes."

export async function publishChanges(workspace: TaskWorkspace, input: PublishInput) {
  const target = await workspace.target()
  if (!target?.repo) {
    throw new Error("Publishing needs a workspace opened from a GitHub repository.")
  }
  if (target.repo !== input.repo) {
    throw new Error(`This workspace is for ${target.repo}; it can only publish there.`)
  }
  if (!target.baseSha || !target.baseRef) {
    throw new Error("The workspace has no base commit yet; open it again first.")
  }
  const client = await workspace.client()
  if ((await client.changes()).changeSetId !== input.changeSetId) throw new Error(CHANGED)
  const { files } = await client.files(input.changeSetId).catch((error) => {
    throw error instanceof RunnerRequestError && error.status === 409
      ? new Error(CHANGED)
      : error
  })
  // What goes to GitHub is kept in storage too (CD-13); without that copy
  // nothing is sent
  if (!(await workspace.checkpointNow())) {
    throw new Error(
      "The workspace couldn't be saved before publishing, so nothing was sent to GitHub. Your changes are still in the workspace; try the publish again in a few minutes."
    )
  }
  const commit = await githubCommitTree(workspace.userId, {
    repo: target.repo,
    base: target.baseRef,
    baseSha: target.baseSha,
    branch: input.branch,
    message: input.title,
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      content:
        file.status === "deleted"
          ? null
          : Buffer.from(file.contentBase64 ?? "", "base64"),
    })),
  })
  return githubOpenDraftPr(workspace.userId, {
    repo: target.repo,
    branch: commit.branch,
    base: target.baseRef,
    title: input.title,
    body: input.body,
    commitSha: commit.commitSha,
  })
}
