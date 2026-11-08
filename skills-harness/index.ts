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
import kriyaMigrate from "./kriya-migrate/kriya.json"
import kriyaPlan from "./kriya-plan/kriya.json"
import kriyaResearch from "./kriya-research/kriya.json"
import kriyaReview from "./kriya-review/kriya.json"
import kriyaSecurity from "./kriya-security/kriya.json"
import kriyaTdd from "./kriya-tdd/kriya.json"
import kriyaVerify from "./kriya-verify/kriya.json"
import kriyaVisual from "./kriya-visual/kriya.json"

export const HARNESS_SKILL_MANIFESTS: unknown[] = [
  kriyaBrainstorm,
  kriyaBrowserTest,
  kriyaDebug,
  kriyaGit,
  kriyaLean,
  kriyaMigrate,
  kriyaPlan,
  kriyaResearch,
  kriyaReview,
  kriyaSecurity,
  kriyaTdd,
  kriyaVerify,
  kriyaVisual,
]

// The Editing Studio's skills (track E, SKILLS_AND_OPEN_SOURCE §4): a separate
// export, so the default set above is unchanged. Served only with editing.skills
// on (lib/harness/default-skills.ts). Kriya-native: no third-party wording.
import kriyaEditCore from "./kriya-edit-core/kriya.json"
import kriyaEditTalkingHead from "./kriya-edit-talking-head/kriya.json"
import kriyaEditShorts from "./kriya-edit-shorts/kriya.json"
import kriyaEditLongform from "./kriya-edit-longform/kriya.json"
import kriyaEditPodcast from "./kriya-edit-podcast/kriya.json"
import kriyaEditTutorial from "./kriya-edit-tutorial/kriya.json"
import kriyaEditMontage from "./kriya-edit-montage/kriya.json"
import kriyaEditAd from "./kriya-edit-ad/kriya.json"
import kriyaEditCaptions from "./kriya-edit-captions/kriya.json"
import kriyaEditSound from "./kriya-edit-sound/kriya.json"
import kriyaEditColor from "./kriya-edit-color/kriya.json"
import kriyaEditMotion from "./kriya-edit-motion/kriya.json"
import kriyaEditThreeD from "./kriya-edit-3d/kriya.json"
import kriyaEditData from "./kriya-edit-data/kriya.json"
import kriyaEditReference from "./kriya-edit-reference/kriya.json"
import kriyaEditHandoff from "./kriya-edit-handoff/kriya.json"
import kriyaEditStory from "./kriya-edit-story/kriya.json"
import kriyaEditReview from "./kriya-edit-review/kriya.json"

export const HARNESS_EDIT_SKILL_MANIFESTS: unknown[] = [
  kriyaEditCore,
  kriyaEditTalkingHead,
  kriyaEditShorts,
  kriyaEditLongform,
  kriyaEditPodcast,
  kriyaEditTutorial,
  kriyaEditMontage,
  kriyaEditAd,
  kriyaEditCaptions,
  kriyaEditSound,
  kriyaEditColor,
  kriyaEditMotion,
  kriyaEditThreeD,
  kriyaEditData,
  kriyaEditReference,
  kriyaEditHandoff,
  kriyaEditStory,
  kriyaEditReview,
]
