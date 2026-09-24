# Kleisli v1 Roadmap & Repo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle the repo/domain/auth structure for Kleisli (the hosted platform for weir) and scaffold the one subsystem that's concrete enough to build today — the web app repo itself — while leaving every subsystem that isn't designed yet as an explicit, separately-planned phase rather than guessed-at implementation.

**Architecture:** Two repos, not a monorepo. `weir` (this repo) stays the language/compiler — no hosting, no UI, no auth, publishable as clean OSS. A new sibling repo, `kleisli`, is the hosted platform: the web UI, auth, and (in later phases) the Inngest-orchestrated, Lambda/Deno-Sandbox-executed automation runtime. `kleisli` depends on `weir` as a package once weir has one to depend on; nothing does yet (weir has no root `package.json` — only `spikes/ts-prototype` does), so Phase 0 below scaffolds `kleisli` standalone and defers the dependency wiring to whichever phase actually needs to call weir's compiler.

**Tech Stack:** Next.js (web UI) + Clerk (auth) + Vercel (UI hosting) for the platform frontend; Inngest (durable orchestration) + AWS Lambda or Deno Sandbox (isolated custom-code execution) for the automation runtime, per the 2026-09-10 hosting discussion — not built in this plan, listed here so Phase 0's stack choices don't contradict them later.

**Spec:** No standalone spec doc exists for Kleisli yet — the effective spec is this session's conversation, recorded in `/Users/jordan/.claude/projects/-Users-jordan-code-weir/memory/project_getkleisli_hosted_platform.md` (market thesis, custom-code-first, durable execution as the moat) and `docs/open-questions.md`'s "Nodes as compiled, distributable units" / client-server bullets (zones, isolation). Phases 1+ below each need their own spec before their own plan, per this skill's scope-check rule — bundling them into TDD tasks now would mean inventing implementation detail nobody has decided yet.

## Global Constraints

- weir stays dependency-light and hosting-agnostic; nothing in Phase 0+ may add a hosting/UI/auth dependency to the `weir` repo itself.
- Domains: `getkleisli.com` (marketing/docs) and `app.getkleisli.com` (the product) — not `kleisli.com` or `klesli.com`/`klesli.com` (both typo'd in conversation; bare `kleisli.com` was already confirmed unavailable in every registry per the 2026-09-10 naming memory).
- No EC2/single-box hosting anywhere in the stack (stated preference) — every piece below is serverless or a managed platform.
- Package namespace: anything published from `kleisli` publishing weir-adjacent code uses the `@getkleisli` npm scope already reserved (per existing memory), not a new one.

---

## Roadmap (phases, most not yet planned in detail)

**Phase 0 — Repo scaffold (this plan, full detail below).** New `kleisli` repo, Next.js app, deployed to Vercel at a placeholder `app.getkleisli.com`, Clerk wired for auth with no product behind it yet. Proves the domains/hosting/auth choices actually work end-to-end before anything else is built on top.

**Phase 1 — Auth & tenancy model (needs its own spec).** Not just "Clerk is installed" (Phase 0 covers that) — deciding what a tenant/org *means* for Kleisli: is a Kleisli account one org (Clerk's org primitive) that owns some number of automations, do automations get their own scoping beyond the account, how does this map onto weir's existing `scope`/permission model (`docs/design.md`, the `verb:edge:field` shape referenced in `open-questions.md`'s "Does `scope` subsume `allOf:`" bullet). This is a real design question, not a wiring task — plan it separately once weir's own scope semantics are settled enough to build on.

**Phase 2 — Node/edge web forms (needs its own spec).** The "simple forms for nodes/edges" UI Jordan wants — CRUD over `.node`/`.edge` declarations per tenant. Depends on Phase 1's tenancy model existing, and on weir having a stable enough declaration format to round-trip through a form (JSON Schema generation already exists per `design.md` §10 — that's the natural form-generation source, worth checking before building a bespoke form builder).

**Phase 3 — `Effect` type + execution pipeline (needs its own spec).** Two things bundled because they're each half-finished without the other: (a) weir needs an actual `Effect` union type in code — currently `{fetch, url}` / `{sleep, duration}` / the LLM-call case from this conversation are all just prose examples in `design.md`, nothing typed exists in `spikes/ts-prototype`; (b) the runtime that performs effects and replays recorded results needs to actually exist, orchestrated by Inngest, calling out to Lambda or Deno Sandbox per node invocation. This is the actual technical moat from the 2026-09-10 memory — give it real design time, not a rushed bolt-on.

**Phase 4 — First connector, talk to users.** Explicitly *not* about integration breadth (clarified this session) — pick one connector as a wedge into one class of user and go find out if the pitch lands. No implementation plan needed until a specific connector is chosen.

---

## Task 0: Scaffold the `kleisli` repo

> **Status 2026-09-24: Steps 1-8 complete**, executed by the separate `klelsi-project` session, not from weir. `/Users/jordan/code/kleisli` is a standalone git repo. Verified independently from a weir session: production build passes, and `/`, `/sign-in`, `/sign-up` all return 200 with clerk-js loading against a real `clerk.accounts.dev` instance. Installed stack is Next.js 16.3.6, React 19.2.8, Tailwind 4, `@clerk/nextjs` 7.9.5. A post-review fix wave was still landing when this note was written, so commit hashes are deliberately not pinned here.
>
> **Steps 9-10 remain.** Step 9 is unstarted and is Jordan's — there is no git remote, nothing is pushed to the `getkleisli` org, and no Vercel project exists; it needs his Vercel account, org push rights and Namecheap DNS. Both sessions have explicitly scoped it out rather than acting unilaterally. Step 10 (the memory note) is being held until the fix wave closes, so it records the final state and the real deferred list — including `authorizedParties` on the Clerk middleware, intentionally left until Step 9 puts a real domain behind it.
>
> **One deviation, and it's the intended kind.** Clerk's middleware is at `src/proxy.ts`, not the `src/middleware.ts` this plan names: Next.js 16 renamed it. Step 6 told the executor to pull Clerk's live quickstart rather than trust a snapshot in this file, precisely so this wouldn't go stale — so the file on disk is right and the plan text below is the stale half.

**Files:**
- Create: `/Users/jordan/code/kleisli/` (new sibling directory to `weir`, new git repo)
- Create: `/Users/jordan/code/kleisli/package.json`
- Create: `/Users/jordan/code/kleisli/app/` (Next.js App Router structure, via `create-next-app`)
- Create: `/Users/jordan/code/kleisli/.env.local.example`
- Create: `/Users/jordan/code/kleisli/README.md`

**Interfaces:**
- Consumes: nothing (first task in a new repo)
- Produces: a deployed Next.js app at a real URL, with Clerk auth wired (sign-in works, no protected content behind it yet) — later phases build on this scaffold and its Clerk session object, not on any specific page/route added here.

- [x] **Step 1: Create the repo**

```bash
mkdir -p /Users/jordan/code/kleisli
cd /Users/jordan/code/kleisli
git init
```

- [x] **Step 2: Scaffold Next.js (TypeScript, App Router, Tailwind — matches weir's own TS-first lean)**

```bash
cd /Users/jordan/code/kleisli
npx create-next-app@latest . --typescript --app --tailwind --eslint --src-dir --import-alias "@/*" --use-npm --yes
```

- [x] **Step 3: Verify the default app builds and runs**

```bash
npm run build
npm run dev &
sleep 3
curl -sf http://localhost:3000 > /dev/null && echo "OK: app responds" || echo "FAIL: app did not respond"
kill %1
```

Expected: `OK: app responds`

- [x] **Step 4: Commit the scaffold**

```bash
cd /Users/jordan/code/kleisli
git add -A
git commit -m "Scaffold kleisli Next.js app"
```

- [x] **Step 5: Add Clerk**

```bash
cd /Users/jordan/code/kleisli
npm install @clerk/nextjs
```

Create `/Users/jordan/code/kleisli/.env.local.example`:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
```

- [x] **Step 6: Wire Clerk's provider and middleware**

Modify `/Users/jordan/code/kleisli/src/app/layout.tsx` to wrap the app in `<ClerkProvider>`, following Clerk's current Next.js App Router quickstart (`npx clerk-quickstart` or the docs at the time this is executed — Clerk's exact API surface changes often enough that hand-copying steps into this plan would go stale; the executor should pull the live quickstart rather than trust a snapshot here).

Create `/Users/jordan/code/kleisli/src/middleware.ts` per the same quickstart, protecting no routes yet (auth wired, nothing gated).

- [x] **Step 7: Verify sign-in works locally**

```bash
cd /Users/jordan/code/kleisli
npm run dev &
sleep 3
curl -sf http://localhost:3000/sign-in > /dev/null && echo "OK: sign-in route responds" || echo "FAIL"
kill %1
```

Expected: `OK: sign-in route responds`

- [x] **Step 8: Commit Clerk integration**

```bash
cd /Users/jordan/code/kleisli
git add -A
git commit -m "Wire Clerk auth, no protected routes yet"
```

- [ ] **Step 9: Connect `app.getkleisli.com`**

Manual step (not scriptable from here — requires Vercel account + DNS access):
1. Push `kleisli` to a new `getkleisli` GitHub org repo (org already exists per 2026-09-10 registration).
2. Import the repo into Vercel, set the production domain to `app.getkleisli.com`.
3. Add the CNAME Vercel provides to the `getkleisli.com` DNS zone (Namecheap, per the 2026-09-10 registration memory).
4. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` in Vercel's environment variables from a real Clerk project (not the `.example` placeholder).

Expected: `https://app.getkleisli.com` loads the default Next.js/Clerk scaffold over HTTPS with working sign-in.

- [ ] **Step 10: Record the decision in weir's memory**

No code change — this step is a note to update `/Users/jordan/.claude/projects/-Users-jordan-code-weir/memory/project_getkleisli_hosted_platform.md` once Phase 0 is live, so future sessions know the scaffold exists and where (`/Users/jordan/code/kleisli`, `app.getkleisli.com`, Clerk) rather than re-deciding it.

---

## Self-Review

**Spec coverage:** "do we need monorepo soon" → answered in Architecture (no, two repos). "should I make a new dir" → Task 0 Step 1. "web-ui going, simple forms for nodes/edges" → deferred to Phase 2 with a named reason (needs tenancy model + a spec, not guessable now). "expose getkleisli.com / app.kleisli.com" → Task 0 Step 9, with the domain typo corrected and flagged in Global Constraints. "what about auth" → Task 0 Steps 5-8 (Clerk), Phase 1 for the deeper tenancy-model question.

**Placeholder scan:** Step 6 deliberately defers to Clerk's live quickstart instead of hand-copying their API, with the reason stated inline — that's a scoped judgment call about a fast-moving third-party API, not a "TBD"; every other step has real commands or real file paths.

**Type consistency:** N/A — no cross-task function signatures in this plan (Task 0 is the only fully-detailed task; Phases 1-4 are intentionally scoped as future planning work, not implementation).
