# Capability packs (track E)

Advanced tools beyond the core editor, each an optional download, each usable by a
typed operation, none needed for the basics. The person installs what their machine
can run; the Studio offers a pack exactly when a request needs it.

Repository licences below were read from GitHub on 2026-11-07. **Model weights have
their own licences, and those are not settled here**: each is read before its pack
ships (SKILLS_AND_OPEN_SOURCE §2). Speeds are unknown until measured.

## 1. The packs

| Pack | What the person gets | Engine | Code licence | Tier | Phase |
| --- | --- | --- | --- | --- | --- |
| Core | Cut, captions, index, render | FFmpeg, faster-whisper, MediaPipe, PySceneDetect | See PERCEPTION_AND_INDEX §2 | Every machine | ED2 |
| **Sharper timing** | Tighter word edges | Forced alignment (WhisperX approach) | BSD-2 | Standard | ED5 |
| **Speakers** | Who said what | sherpa-onnx, or pyannote | Apache-2.0, MIT; weights EQ-05 | Standard | ED12 |
| **Smart search** | "Find the shot of the beach at sunset" | SigLIP-class embeddings | Per weight | Standard | ED12 |
| **Local eyes** | Footage described **without any frame leaving the machine** | A small vision model on `llama.cpp`: Moondream, SmolVLM or Qwen3-VL class | Apache-2.0 code; per weight | Standard | ED13 |
| **Cut-outs** | Text and cards behind the speaker | **Hybrid:** MediaPipe selfie segmenter for preview and drafts (2.1 ms a frame); BiRefNet only for final quality, on the windows that need it (5 s a frame on CPU, EX-05) | Apache-2.0, MIT | Standard | ED8 |
| **Track and mask** | Blur a face or a plate through a shot; colour one object | SAM 2 | Apache-2.0 | Pro | ED13 |
| **Clean voice** | Noise and room removal | DeepFilterNet, ClearerVoice | MIT or Apache-2.0 | Core add-on | ED9 |
| **Stems** | Separate voice from music | `python-audio-separator` | MIT; per model | Pro | ED13 |
| **Beats** | Cut to music | `beat_this`, librosa | MIT, ISC | Standard | ED9 |
| **Smooth cut** | Invisible jump cuts: frames synthesised across a cut in a talking head | RIFE | MIT | Pro | ED13 |
| **Slow motion** | Real slow motion from normal footage | RIFE | MIT | Pro | ED13 |
| **Upscale** | Lift low-resolution clips | Real-ESRGAN | BSD-3 | Pro | ED13 |
| **Remove object** | Paint out a logo or a mic | LaMa on frames, tracked by SAM 2 | Apache-2.0 | Pro | ED13 |
| **Depth motion** | Stills that move with parallax, depth-aware text | Depth Anything V2: only its permissively licensed sizes | Apache-2.0 code; per size | Pro | ED13 |
| **Math** | Equations and proofs | Manim | MIT | Pack | ED13 |
| **3D** | Device mockups, logo spins | three.js r186 | MIT | Standard | ED8 |
| **Voice** | A stock narrator for explainers | Chatterbox or ZipVoice | MIT, Apache-2.0 | `editing.generative` | ED13 |

## 2. Why these

| Capability | The editor's problem it solves |
| --- | --- |
| Smooth cut | Removing a stumble from one shot leaves a jump. Editors hide it with B-roll or a punch-in; this removes the need when the head barely moved |
| Local eyes | Answers the privacy question (EDD-14) without giving up vision: the cheap model reads local descriptions as text, so frames stay put |
| Track and mask | Consent problems in real footage: blur a bystander, or a screen with private data, across a whole shot |
| Remove object | The boom mic in frame, a logo with no clearance |
| Depth motion | Photos are the main B-roll people actually have |
| Stems | Music bleeding under speech in event footage |

## 3. Rules for every pack

1. **Optional.** Nothing in the core depends on a pack.
2. **Local.** A pack runs on the machine. Nothing is uploaded.
3. **Typed.** It's reached by an operation (`smooth_cut`, `mask_track`, `remove_object`, `parallax`), never a command.
4. **Honest.** Its cost in time is shown after it's measured on this machine. It says when it's slow here.
5. **Cached** by the graph runtime, like any node.
6. **Checked.** Generated frames get their own gate entry: Smooth cut must pass a flicker and identity check, or the cut stays a punch-in. It is marked in the receipt, because those frames were synthesised.
7. **Weights pinned** by hash in the manifest, with their licence recorded.

## 3a. As built in ED13

Client `src/edit/engine/packs.js` and `src/edit/runtime/setup.js`. A pack is data: its
title, what it does, the operations that need it, the FFmpeg filters and runtime
artifacts it needs, and their licences. Its files come from the signed manifest's
`platforms.<id>.packs.<pack>.artifacts`, each pinned by sha256 with its licence recorded
(ET-PK-03), and go to `<version>/packs/<pack>/` with `.complete` last; a failure removes
only that folder, and `--remove-pack` removes it again. `packStatus` says, per pack,
installed or why not; the Engine checks the packs a plan needs before rendering.
Three are known: **Colour** (FFmpeg's `lut3d`: LUTs and colour matching; nothing to
download), **Clean voice** (DeepFilterNet weights) and **Depth motion** (Depth Anything
V2 Small). The served runtime offers neither of the last two yet, and nothing uses
their weights: `clean_voice` runs FFmpeg's own filters (ED9), and no `parallax`
operation exists. They report that plainly; ED13 builds the mechanism, not their engines.

## 4. Considered and refused

| Idea | Why not |
| --- | --- |
| Lip-sync, face swap, eye-contact correction | Synthetic people (EDD-24). Too close to fabrication |
| Generative video from text | A different product; footage comes first. Revisit by decision |
| Voice cloning | Only ever the person's own voice, behind a consent record, and not in the first release |
| A cloud render farm | EDD-29 |
| Running a local LLM as the Director | Tempting: GBNF and prefix pinning would be real there. But quality is lower, and it's a heavy download. A later option if a person wants fully offline asking (EQ-14) |
| Face identification against any outside data | Never. Clusters are local and unnamed unless the person names them |
