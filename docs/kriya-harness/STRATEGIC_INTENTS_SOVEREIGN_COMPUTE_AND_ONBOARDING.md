# KRIYA HARNESS: MASTER STRATEGIC INTENTS

> **Document Version:** 1.0.0  
> **Target Products:** Kriya Harness (`kriya-harness`), Kriya Tavi (`Kriya-Tavi`), Kriya Control Center  
> **Strategic Focus:** Sovereign Compute Scaling (Mac Mini to Enterprise GPU) & Zero-CLI Friction Onboarding

> [!IMPORTANT]
> **Internal strategy, not a source of fact** (owner decision, 2026-11-24). The
> comparisons with Claude Code, Cursor and others, the prices, speeds and the
> "16 gates" count are unverified. None of them goes into the product, the
> website or a sales text before gate RG-9 (AGENTS.md track A rule 12).
> Owner decisions on the milestones: S-1 is **hybrid and signed in** (Kriya's
> head model plans and reviews, metered; a local model builds; behind a
> `harness.localModels` switch, off by default). A fully offline, signed-out
> mode is not planned. S-2 is the **one-line installer first**; the
> menu-bar app is a later phase. S-3 builds on the H10 relay that exists.

---

## EXECUTIVE SUMMARY: THE TWO STRATEGIC MOATS

The generative coding market is undergoing an inflection point. Cloud-bound coding agents (Claude Code, GitHub Copilot Workspace, Cursor Agent) have demonstrated high utility, but suffer from **two existential enterprise vulnerabilities**:
1. **The Cloud Extortion & IP Trap:** They force organizations into proprietary clouds, charging exorbitant per-token fees while exfiltrating sensitive intellectual property across corporate firewalls.
2. **Ungoverned Probabilistic Autonomy:** In tools like Claude Code, the LLM itself unilaterally decides when code is "done" without hard, non-probabilistic verification gates.

This document establishes two complementary architectural and commercial intents to secure Kriya Harness as the global leader in **Sovereign, Verified Autonomous Engineering**:

* **INTENT 1: THE DEMOCRATIZED COMPUTE ENGINE**  
  *How Kriya Harness scales from a \$599 Apple Silicon Mac Mini to an enterprise NVIDIA H100 cluster—eliminating API anxiety and beating Claude Code on cost, data sovereignty, and deterministic correctness.*
* **INTENT 2: ZERO-FRICTION SOVEREIGN ONBOARDING**  
  *How Kriya bridges the Web UI and the local terminal daemon so that any developer or company can sign up on the web and execute tasks locally with zero CLI configuration friction.*

---

# INTENT 1: THE DEMOCRATIZED COMPUTE ENGINE
### *From \$599 Mac Minis to Air-Gapped GPU Clusters: Beating the Cloud-Agent Extortion Model*

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             KRIYA ORCHESTRA RUNTIME                              │
└──────────────────────────────────────────────────────────────────────────────────┘
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
  ┌─────────────────────────┐                   ┌─────────────────────────┐
  │      ORCHESTRA HEAD     │                   │     WORKFORCE WORKER    │
  │   Architecture & State  │                   │   Cartridges & Tooling  │
  └─────────────────────────┘                   └─────────────────────────┘
               │                                             │
               ├──────────────────────┬──────────────────────┤
               ▼                      ▼                      ▼
    ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
    │     TIER 1: MINI   │ │    TIER 2: STUDIO  │ │    TIER 3: CLUSTER │
    │   $599-$1,999 CapEx│ │  $3,000-$8,000 CapEx│ │ $50k+ Air-Gapped GPU│
    │  Mac Mini / Laptop │ │  Mac Studio / 2x4090│ │  NVIDIA H100/A100  │
    │  (14B-32B Models)  │ │  (32B-70B Models)   │ │  (DeepSeek-V3/R1)  │
    └────────────────────┘ └────────────────────┘ └────────────────────┘
               │                      │                      │
               └──────────────────────┴──────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ 16 DETERMINISTIC GATES    │
                        │ Exit code 0, SAST, WebGL, │
                        │  A11y, DB Schema, Diffs   │
                        └───────────────────────────┘
```

### 1. The Market Flaw: The False Binary of Coding Agents
The current market presents developers and startups with a false binary:
* **Option A (The Cloud Trap — Claude Code / Cursor):** Convenient to start, but you pay continuous per-token tax (\$15–\$75/million tokens). As an agent executes 30+ iterative tool turns per task, token bills rapidly spiral to \$1,000s/developer/month. More crucially, corporate source code, internal schemas, and API secrets leave the premises.
* **Option B (The Enterprise Fallacy):** Pundits claim that running local models requires a \$300,000 NVIDIA DGX cluster with full-time MLOps, making private agents inaccessible to startups.

### 2. The Core Thesis: Apple Silicon Unified Memory & Commodity Compute
Kriya Harness shatters this false binary through **Asymmetric Compute Allocation**:
1. **Apple Silicon Unified Memory Architecture (UMA):** An off-the-shelf **Mac Mini (M2/M4 Pro, 32GB–64GB RAM)** costing \$1,299–\$1,999 shares its high-bandwidth memory pool (up to 273 GB/s) directly between CPU and GPU. It runs 4-bit and 8-bit quantized 14B to 32B coding models (such as `Qwen-2.5-Coder-32B-Instruct` or `DeepSeek-Coder-V2-Lite`) at **35–60 tokens/second**.
2. **Zero Marginal Token Cost:** Once the Mac Mini or RTX 4090 workstation is purchased, token cost is purely electricity (\$0.000000/token). Developers can run 24-hour overnight refactoring sweeps, exhaustive mutation testing, and thousands of exploratory variations without budget anxiety.
3. **The Orchestra Multiplier (Head + Worker Split):**
   * **Worker (75%–80% of token volume):** A local quantized model running on the Mac Mini handles high-frequency file reads, edits, bash commands, and syntax fixes.
   * **Head (15%–20% of token volume):** When a startup wants maximal intelligence on architecture decomposition, they can optionally route *only the initial plan and contract* to a low-cost cloud model or a central office Mac Studio, while 100% of code editing stays local.

### 3. Hardware Tiering Matrix

| Tier | Target User | Hardware Setup | Recommended Local Models | Monthly Marginal API Cost |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Sovereign Edge** | Solo Founder, Freelancer, Bootstrapped Dev | Apple Silicon Mac Mini / MacBook Pro (24GB–64GB Unified RAM) or single RTX 4080 (16GB) | `qwen2.5-coder:14b-instruct`<br>`deepseek-coder-v2:16b`<br>`llama3.1:8b` | **\$0.00** (Unlimited tokens) |
| **Tier 2: Studio Node** | 5–20 Person Startup, Agency | Mac Studio M2/M4 Max (64GB–128GB) or Dual RTX 3090/4090 PC (48GB VRAM) | `qwen2.5-coder:32b-instruct`<br>`deepseek-coder:33b`<br>`mistral-large-quant` | **\$0.00** (Internal LAN endpoint) |
| **Tier 3: Enterprise Air-Gap** | Bank, Defense, Healthcare, Enterprise SaaS | On-Prem NVIDIA H100 / A100 / L40S Cluster running vLLM / SGLang / LiteLLM | `DeepSeek-V3` (Full 671B)<br>`DeepSeek-R1`<br>`Qwen-2.5-Coder-70B` | **\$0.00** (Air-gapped) |

### 4. Competitive Moat: Kriya Harness vs. Claude Code

| Dimension | Anthropic Claude Code | Kriya Harness (Sovereign Engine) |
| :--- | :--- | :--- |
| **Model Lock-In** | Locked strictly to Anthropic Claude 3.5/3.7 | **Model-Agnostic:** Any Ollama, vLLM, OpenAI-compatible local server, or cloud model |
| **Decision Authority** | **Model decides when done:** The LLM hallucinates success and marks tasks finished | **Code decides when done:** 16 physical deterministic gates (exit code 0, compilers, SAST, DOM checks) |
| **Cost Scaling** | **Linear Tax:** Every turn, retry, and test run drains API balance | **Fixed CapEx:** Hardware purchase once, infinite free execution forever |
| **IP & Air-Gap** | Prompts and code snippets transmit to Anthropic | **Absolute Zero Egress:** Runs 100% disconnected from the internet if desired |
| **Domain Taste** | Generic prompts with zero enforced UI/system invariants | **16 Pre-Compiled Role Cartridges:** Embedded principal-level rubrics and anti-patterns |

---

# INTENT 2: ZERO-FRICTION SOVEREIGN ONBOARDING
### *Bridging the Web Control Center to Automated Terminal Execution*

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             KRIYA WEB CONTROL CENTER                             │
│       Sign up on Web · Project Dashboard · Gate Overview · Run Strip Monitor     │
└──────────────────────────────────────────────────────────────────────────────────┘
                                      │
                   1-Click Authenticate / Web Handshake
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           LOCAL SYSTEM ORCHESTRATOR                              │
│                                                                                  │
│   ┌───────────────────────────┐         ┌────────────────────────────────────┐   │
│   │   Option A: Zero-Config   │   OR    │   Option B: 1-Line Universal       │   │
│   │   Desktop Tray Daemon     │         │   Install Shell Script             │   │
│   │   (macOS .dmg / Windows)  │         │   curl -fsSL https://kriya.ai \| sh │   │
│   └───────────────────────────┘         └────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────┘
                                      │
               Auto-discovers local hardware (Mac Mini, Ollama, GPU)
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      BACKGROUND TERMINAL HARNESS RUNNER                          │
│                                                                                  │
│   • Spawns background worker process (no terminal friction)                      │
│   • Mounts local repository workspace                                            │
│   • Streams live telemetry (Run Strip, chips, elapsed, spend) back to Web UI     │
│   • Enforces local filesystem checkpoints (Undo / Checkpoint tree)               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 1. The Friction Dilemma
Currently, developer adoption of local harnesses is choked by terminal setup friction:
1. Installing Node 24.9+ (`nvm`, `fnm`, brew versions mismatch).
2. Running `npm i -g @kriya-ai/harness` with npm permission errors (`EACCES`).
3. Configuring environment variables (`.env`, paths, tokens).
4. Running terminal commands with long flags (`kriya --workforce --mode ask`).

*Engineers and founders want the speed of local execution without the headache of terminal maintenance.*

### 2. The Vision: "Sign Up on Web $\rightarrow$ Everything Runs Automatically"
Kriya’s onboarding must operate with the simplicity of modern developer tools (like Linear, Docker Desktop, or Raycast):

#### Step 1: Universal Web Sign-Up (`kriya.ai`)
* The developer visits `kriya.ai` and signs up via email or GitHub OAuth.
* The web dashboard presents their **Project Command Center**:
  * Connected Repositories
  * Gate matrices
  * Active tasks & proof receipts
  * Spend meters & model configuration

#### Step 2: Frictionless Local Pairing (Two Parallel Paths)
To accommodate both non-terminal users and CLI veterans, Kriya provides two frictionless onboarding bridges:

* **Path A: The 1-Line Universal Bootstrap (For Terminal Users)**
  ```bash
  curl -fsSL https://kriya.ai/install | sh
  ```
  * What it does automatically in under 15 seconds:
    1. Detects OS and architecture (macOS Apple Silicon, Linux x86_64, Windows WSL).
    2. Packages a self-contained, isolated Node runtime (no dependency on the user’s global node/npm).
    3. Links the `kriya` binary to `/usr/local/bin` or `~/.kriya/bin`.
    4. Automatically launches `kriya login` and pops a browser window to pair the machine with their web session instantly.

* **Path B: The Kriya Desktop Menu Bar Companion (Zero-Terminal Path)**
  * A lightweight macOS menu bar app (built on Tauri or Swift / Electron) distributed as a standard `.dmg`.
  * The user drags it to Applications and clicks **Open**.
  * The menu bar companion:
    * Manages the background `kriya daemon` process silently.
    * Auto-detects local Ollama / LM Studio instances running on the computer.
    * Auto-detects system RAM and GPU VRAM to suggest optimal local model sizes (e.g. *"M3 Pro detected: 36GB RAM — running Qwen 2.5 Coder 14B locally"*).
    * Streams terminal logs, task checkpoints, and verification chips directly to the Web UI or a floating native HUD.

#### Step 3: Web-Triggered Local Execution
* From the Web UI (`kriya.ai/projects/my-app`), the user clicks:
  > **"Fix Orders API timeout bug and verify against test suite"**
* The Web UI dispatches the task over the encrypted Kriya Relay WebSocket to their paired local machine.
* The background harness executes in their local directory:
  * Reads the code.
  * Spawns the local Mac Mini / Ollama model.
  * Runs tests and deterministic gates.
  * Streams real-time progress chips (`Worker`, `try 1/4`, `GATE-SAST: pass`) straight to the web browser.
* When finished, the Web UI presents the **Proof Card** and **Verified Git Diff** ready to commit or create a PR.

---

# COMMERCIALIZATION & BUSINESS MODEL BLUEPRINT

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         KRIYA COMMERCIALIZATION TIERS                            │
└──────────────────────────────────────────────────────────────────────────────────┘
                                      │
               ┌──────────────────────┼──────────────────────┐
               ▼                      ▼                      ▼
    ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
    │     COMMUNITY      │ │     TEAMS / PRO    │ │    ENTERPRISE      │
    │     (Free / OSS)   │ │  ($29-$49/seat/mo) │ │ ($499-$2,500/mo)   │
    ├────────────────────┤ ├────────────────────┤ ├────────────────────┤
    │ • Local CLI & tray │ │ • Web Mission Ctr  │ │ • Dedicated VPC    │
    │ • 100% offline BYO │ │ • Team mirror & sync││ • SSO / SAML / Okta│
    │   Ollama/Mac Mini  │ │ • Cloud Workspace  │ │ • Fleet GPU cluster│
    │ • Standard gates   │ │   Handoff          │ │   orchestration    │
    │ • Community roles  │ │ • Hosted Head Model│ │ • Custom Cartridges│
    │                    │ │   routing (hybrid) │ │ • Audit compliance │
    └────────────────────┘ └────────────────────┘ └────────────────────┘
```

### 1. Why Startups and Enterprises Will Pay for Kriya (Even With Local Hardware)
Companies do not pay for compute tokens—**they pay for governance, correctness, and developer velocity**.
1. **The Free Hook (Bottom-Up Developer Adoption):**
   * The local CLI harness and Mac Mini / Ollama pairing is 100% free and open-source.
   * Any developer can clone a repo, run `kriya --local-model ollama`, and experience verified coding with zero subscription.
2. **The Paid Expansion (Team & Enterprise Governance):**
   * **Centralized Gate Policy:** Engineering managers can enforce company-wide quality gates across all developers (e.g., *"No PR can be created unless G-A11Y, G-SAST, and G-TENANT pass"*).
   * **The Web Mission Control:** Multi-device session mirroring, mobile approval notifications, and project health history.
   * **Hybrid Routing License:** Small teams get managed access to Kriya's cloud Head model for architecture design while their local Mac Minis execute the workforce code changes for free.
   * **Enterprise On-Prem License:** Self-hosted Kriya-Tavi deployed inside their AWS VPC or bare-metal GPU clusters with SOC2, HIPAA, and ISO audit logging.

---

# SUMMARY OF IMMEDIATE TECHNICAL DELIVERABLES

To execute this vision, the engineering roadmap decomposes into three concrete milestones:

1. **Milestone S-1: Direct Local Model Driver in Kriya Harness**
   * Add `--local-model <url>` and `--model <name>` to `bin/kriya.js` and `src/launch.js`.
   * Allow zero-login standalone execution directly against local Ollama (`http://127.0.0.1:11434/v1`) or vLLM endpoints.
2. **Milestone S-2: Universal One-Line Installer (`install.sh`)**
   * Author a standalone POSIX shell script that fetches the bundled release, sets up paths, and triggers immediate browser pairing.
3. **Milestone S-3: Web Control Center Device Relay Bridge**
   * Complete the bidirectional task bridge between `kriya-web.onrender.com/harness` (Control Center) and local `kriya daemon`, allowing tasks queued in the browser to run seamlessly on the developer's computer.
