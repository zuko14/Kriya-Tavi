// Kriya default skills for Kriya Harness (docs/kriya-harness/WORKSPACE_PANEL_SKILLS_PLUGINS.md §4):
// coding guidance written for the harness's own tools, served to every
// device with harness.defaultSkills on (lib/harness/default-skills.ts).
// Kept apart from skills/ so the cloud catalogue (and its tests) is unchanged.
// Sources and licences: NOTICES.md and each kriya.json `source`.

import kriyaBrainstorm from "./kriya-brainstorm/kriya.json"
import kriyaBrowserTest from "./kriya-browser-test/kriya.json"
import kriyaDebug from "./kriya-debug/kriya.json"
import kriyaGit from "./kriya-git/kriya.json"
import kriyaLean from "./kriya-lean/kriya.json"
import kriyaPlan from "./kriya-plan/kriya.json"
import kriyaReview from "./kriya-review/kriya.json"
import kriyaSecurity from "./kriya-security/kriya.json"
import kriyaTdd from "./kriya-tdd/kriya.json"
import kriyaVerify from "./kriya-verify/kriya.json"

export const HARNESS_SKILL_MANIFESTS: unknown[] = [
  kriyaBrainstorm,
  kriyaBrowserTest,
  kriyaDebug,
  kriyaGit,
  kriyaLean,
  kriyaPlan,
  kriyaReview,
  kriyaSecurity,
  kriyaTdd,
  kriyaVerify,
]
