# Rippley Labs — Codex Instructions

## Purpose

This repository is part of the Rippley Labs application ecosystem.

Rippley Labs is a connected suite of developer tools, productivity products,
AI utilities, games, and learning applications. Each application should remain
useful on its own while integrating with the rest of the ecosystem through
shared authentication, analytics, events, APIs, and automation.

Before making an architectural change, adding a cross-application integration,
or changing an application's responsibilities, read:

- `docs/ECOSYSTEM.md`
- The repository `README.md`
- Existing architecture and configuration files
- Relevant tests and integration contracts

Do not assume two applications share a database or runtime merely because they
belong to the same ecosystem.

---

Never change the project level docs/ECOSYSTEM.md or AGENTS.md
Only modify the master ECOSYSTEM and AGENTS at ~/Code/2027/
If you make changes to the docs/ECOSYSTEM.md or AGENTS.md,
after all changes are complete, run sync-rippley-docs.sh

## Current Application

- **Application:** Black Box
- **Primary role:** Ecosystem integration, orchestration, and event-routing platform
- **Platforms:** Web, API, CLI
- **Production domain:** https://rippley-black-box-2027.azurewebsites.net
- **Primary stack:** Node.js, TypeScript, React, Vite, SQLite, Azure SQL
- **Deployment:** Azure App Service F1 with Azure SQL
- **Owned domain data:** Integration events, application registrations, commands, workflow state, incidents, and correlation records
- **Primary integrations:** All Rippley Labs applications, House Edge, local system adapters

Always inspect the existing repository before assuming the framework, package
manager, database, deployment target, or testing commands.

Use the repository's existing stack unless a migration is explicitly requested.

---

## Canonical Product Names

These are the current product names. Do not resurrect old names, silently rename
them, or invent substitutes.

- **Shipwreck**
- **Black Box**
- **House Edge**
- **Deck**
- **Running Tab**
- **Repo Reaper**
- **Port Authority**
- **Env Reaper**
- **Pit Boss**
- **README Roulette**
- **Save Scum**
- **Stacked Deck**
- **Diffusion**
- **Questbook** (working name; includes the **Algebra Quest** campaign)
- **Sudo Survive**
- **Shuffle**

Important naming corrections:

- Use **Running Tab**, never `Timewell`.
- Use **Sudo Survive**, never `Hacking Sim`.
- Use **Black Box** with a space.
- Use **Repo Reaper** with a space.
- Use **Env Reaper**, not `Environment Reaper`.
- Use **README Roulette**, preserving `README` capitalization.

---

## Ecosystem Roles

### Shipwreck — Portal and Launcher

Shipwreck is the user-facing front door to the ecosystem. It's main purpose is to check production readiness of applications.

It owns:

- Application discovery
- Unified navigation
- Application launching
- User-facing ecosystem settings
- Links to every product
- Product news and changelogs
- Potential ecosystem status summaries

Shipwreck is not the orchestration engine and should not absorb application business logic.

### Black Box — Integration and Orchestration

Black Box connects applications through:

- Domain events
- Webhooks
- Workflows
- Scheduled actions
- Cross-application commands
- Background jobs
- Integration adapters
- Shared automation

Black Box owns workflow definitions and workflow execution state.

Black Box does not own another application's domain records. For example, it may react to a Deck task event, but Deck remains the source of truth for the task.

### House Edge — Analytics Platform

House Edge provides ecosystem-wide:

- Event ingestion
- Usage analytics
- Product metrics
- Revenue metrics
- Conversion tracking
- Operational dashboards
- Custom reports
- Shared analytics APIs

House Edge owns analytics and telemetry records.

House Edge is not the source of truth for tasks, invoices, repositories, equipment, saves, or other application-domain objects.

---

## Application Catalog

| Application     | Responsibility                                                        | Important Relationships                                             |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Shipwreck       | Portal, discovery, navigation, and launcher                           | Links to all applications; may display House Edge summaries         |
| Black Box       | Integration, orchestration, workflows, and event routing              | Connects applications without taking ownership of their data        |
| House Edge      | Shared analytics and telemetry                                        | Receives product and operational events from all applications       |
| Deck            | Task and project management with templates and graph relationships    | Can provide project and task context to Running Tab                 |
| Running Tab     | Time tracking, clients, invoices, billing, retainers, and utilization | Uses project/task/repository context; integrates with Stripe        |
| Repo Reaper     | GitHub repository analysis and improvement recommendations            | Can provide repository findings to README Roulette                  |
| Port Authority  | Local port and process management                                     | Can expose process state to Pit Boss and identify project ownership |
| Env Reaper      | Environment file, configuration, and secret-management utility        | Can supply named environment profiles without exposing secrets      |
| Pit Boss        | Developer command center for run, build, deploy, and custom actions   | Can consume Port Authority state and Env Reaper profiles            |
| README Roulette | AI-assisted README and documentation generation                       | Can consume repository metadata and Repo Reaper findings            |
| Save Scum       | Local game-save version control                                       | Primarily local; emits optional telemetry to House Edge             |
| Stacked Deck    | Equipment tracking, scanning, valuation, and inventory                | Uses AI models and optional value-history analytics                 |
| Shelf Life      | Media tracking, scanning, valuation, and inventory                    | Uses AI models and optional value-history analytics                 |
| Diffusion       | Visual comparison tool for files, images, and code                    | May be opened by other developer tools for comparison workflows     |
| Questbook       | Subject-agnostic gamified learning; private content, homework capture, creator tools, and accepted learning relationships | Owns learner content, accounts, shared progress and friend challenges; includes Algebra Quest; optional House Edge telemetry |
| Algebra Quest   | Flagship Algebra I campaign within Questbook                          | Preserves existing local campaign progress and deterministic math engine |
| Sudo Survive    | Hacking simulation and PvP game                                       | Uses player profiles, progression, and game telemetry               |
| Shuffle         | Subscription management, household value tracking, and approved subscription rotations | Owns subscriptions, queues, plans, evidence, and savings; optional financial, catalog, and AI adapters |

---

## Standard Data Flow

Use this model unless the repository documents a deliberate exception:

1. The user discovers or launches an application through Shipwreck.
2. The application loads its own domain data.
3. The application emits analytics events to House Edge.
4. The application publishes integration events or commands through Black Box.
5. Black Box invokes the appropriate target application or external adapter.
6. The target application performs the action and remains responsible for its
   own domain data.
7. The result produces additional events, telemetry, or notifications.

Example:

```text
Deck task completed
        |
        v
Black Box receives deck.task.completed.v1
        |
        +--> Running Tab suggests stopping the active timer
        |
        +--> Pit Boss optionally runs a configured project action
        |
        +--> House Edge records completion and automation metrics

```

---

## Data Ownership Rules

Each application owns its own domain data.

Examples:

- Deck owns projects, tasks, templates, and task relationships.
- Running Tab owns time entries, clients, rates, retainers, and invoices.
- Repo Reaper owns repository scans and findings.
- Port Authority owns local process and port history.
- Env Reaper owns environment-profile metadata.
- Pit Boss owns action definitions and execution history.
- Save Scum owns save locations, snapshots, and restore history.
- Stacked Deck owns tech inventory, equipment, and valuations.
- Shelf life owns media inventory, equipment, and valuations.
- Black Box owns workflow definitions and workflow runs.
- House Edge owns analytics events and derived metrics.
- Shipwreck owns ecosystem navigation and launcher preferences.
- Shuffle owns household subscriptions, desire queues, usage reports, rotation plans, billing-action evidence, savings provenance, and encrypted provider connections. It never stores third-party subscription passwords. AI proposals cannot execute billing changes without deterministic validation and explicit user approval.

Applications must not directly write into another application's database.

### Prefer

- Versioned APIs
- Versioned events
- Webhooks
- Explicit integration adapters
- Free services

### Avoid

- Cross-application database joins
- Shared tables containing unrelated domain records
- Importing another application's internal implementation
- Hard-coded local paths
- Hard-coded production URLs

---

## Event Conventions

Use versioned event names:

```text
<application>.<entity>.<action>.v<version>
```

Examples:

```text
deck.task.created.v1
deck.task.completed.v1
running-tab.timer.started.v1
running-tab.invoice.paid.v1
repo-reaper.scan.completed.v1
pit-boss.action.failed.v1
stacked-deck.valuation.updated.v1
sudo-survive.match.completed.v1
```

Events should normally include:

```json
{
  "eventId": "unique-event-id",
  "eventType": "deck.task.completed.v1",
  "occurredAt": "ISO-8601 timestamp",
  "source": "deck",
  "userId": "shared-user-id-when-applicable",
  "correlationId": "workflow-or-request-id",
  "data": {}
}
```

### Integration Requirements

- Events must be safe to retry.
- Consumers should be idempotent.
- Breaking payload changes require a new event version.
- Never include passwords, access tokens, API keys, or complete environment files in events.
- Prefer IDs and stable references over duplicated complete objects.
- Log correlation IDs across application boundaries.
- A failed optional integration must not corrupt the source application's data.

---

## Shared Infrastructure

Likely shared infrastructure includes:

- Authentication through GitHub, Google, or email
- Azure SQL where relational persistence is appropriate
- Azure Blob Storage where object storage is appropriate
- Stripe for payments and subscriptions
- House Edge for analytics
- Black Box for orchestration
- Azure and Cloudflare for deployment, routing, DNS, or edge functionality
- GitHub for repository integrations
- OpenRouter or user-provided API keys for AI features
- Local system APIs for desktop utilities

Do not assume every application needs every shared service.

Prefer the simplest architecture that satisfies the application's actual requirements. Avoid introducing additional managed services, queues, databases, or cloud vendors without a concrete need.

---

## Authentication and Identity

Where applications share identity:

- Use a stable ecosystem user ID.
- Keep provider-specific IDs separate from the internal user ID.
- Do not use email addresses as permanent primary keys.
- Clearly distinguish local-only use from authenticated cloud functionality.
- Do not require login for local functionality unless authentication is necessary.
- Validate redirect URLs and trusted origins through environment configuration.
- Never hard-code OAuth client secrets.

---

## Visual Direction

Rippley Labs should feel like a premium suite of products built by one person with a strong point of view.

### Preferred Visual Characteristics

- Dark charcoal, black, deep green, cream, purple, copper, and muted gold
- Clean developer-tool interfaces
- Strong typography
- Subtle card-suit, odds, deck, table, or betting-language references
- One controlled accent color per application
- User-selected themes inside settings
- Crisp borders and useful information density
- Functional dashboards rather than decorative dashboards

### Avoid

- Rainbow application palettes
- Excessive neon
- Generic purple-to-blue AI gradients
- Giant glowing cards
- Fake glass everywhere
- Literal casino-floor imagery
- Poker chips scattered around interfaces
- Ornate gold frames
- Excessive gradients
- Overly glossy 3D icons
- Visual effects that make the interface harder to use
- Generic AI-generated marketing language

The goal is:

```text
Premium developer product with a subtle casino vocabulary.
```

Not:

```text
Las Vegas casino-themed dashboard.
```

---

## Voice and Product Copy

Copy should sound:

- Direct
- Confident
- Human
- Slightly playful
- Technically literate
- Understandable without marketing jargon

### Avoid Phrases Such As

- Revolutionary
- Game-changing
- Cutting-edge
- Seamlessly unlock
- Supercharge your workflow
- Harness the power of AI
- Next-generation platform

Prefer concrete descriptions of what the feature does.

### Bad

```text
Harness next-generation AI to revolutionize your development workflow.
```

### Better

```text
Scan a repository, find the ugly parts, and get a prioritized cleanup plan.
```

---

## Implementation Rules

### Before Changing Code

1. Inspect the repository structure.
2. Identify the existing stack and package manager.
3. Locate existing patterns before creating new abstractions.
4. Identify which application owns the affected data.
5. Identify whether the change affects Black Box, House Edge, Shipwreck, or another application.
6. Check for an existing API, event, command, or component before inventing one.

### While Changing Code

- Keep the change focused.
- Preserve existing behavior unless the task requires changing it.
- Avoid unrelated formatting churn.
- Avoid unnecessary dependencies.
- Reuse existing design-system components.
- Use typed interfaces at integration boundaries.
- Validate external input.
- Return actionable errors.
- Never commit credentials or generated secrets.
- Avoid placeholders presented as complete production functionality.

### After Changing Code

- Run the repository's formatter.
- Run linting.
- Run type checks.
- Run relevant tests.
- Run the production build when practical.
- Document new environment variables.
- Update `~/Code/2027/docs/ECOSYSTEM.md` when application relationships change.
- Update this file when names, boundaries, commands, or architecture change.

---

## Cross-Application Changes

For any task affecting more than one application, provide a brief impact summary before implementation:

```text
Applications affected:
Contracts affected:
Data ownership:
Events added or changed:
Migration required:
Backward-compatibility risk:
Deployment order:
```

Do not silently alter an integration contract.

When possible, make integration changes backward-compatible and deploy consumers before producers begin sending new required fields.

---

## Repository Commands

Fill this section in for the current repository:

```text
Install:
Development:
Format:
Lint:
Type check:
Unit tests:
Integration tests:
Build:
Desktop build:
Database migrations:
Deployment:
```

Codex must inspect the following before filling in or changing these commands:

- `package.json`
- `Cargo.toml`
- Workspace files
- Build scripts
- CI configuration
- Repository documentation

---

## Definition of Done

A task is complete when:

- The requested behavior works.
- Existing behavior has not been unintentionally broken.
- Relevant tests pass.
- Type checking and linting pass.
- The production build succeeds when applicable.
- Errors are handled clearly.
- No secrets were added.
- New configuration is documented.
- Cross-application contracts are versioned.
- Ecosystem documentation reflects architectural changes.
- Product names match the canonical names in this file.
