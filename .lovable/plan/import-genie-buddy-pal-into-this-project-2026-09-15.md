# Import "genie-buddy-pal" into this project

The GitHub repo is public and was originally built with Lovable, so it lands here almost unchanged: same framework, same styling, same built-in backend.

## What the app is

A content studio for video channels:
- Sign-in page, then a protected app area
- Sources, Ideas/Chat, Channels, Studio (video editor) and a dashboard
- AI writing, image and voice generation
- A scheduled job endpoint that produces videos automatically

## What gets copied

- All pages and the shared layout, including the sign-in screen and the protected area
- All interface components, styles and theme
- Backend logic: chat/ideas, channels, studio, scheduling, AI calls, video assembly
- The database structure: profiles, projects, sources, ideas, scripts, videos, channels, posts, and the scheduling settings table, with their access rules
- The public endpoint used by the scheduler

## What I will set up

- Turn on the built-in backend (database, logins, server functions) in this project
- Apply the database structure as a fresh migration so everything exists here
- Keep AI features on the built-in AI service (no extra account needed)
- Generate a new scheduling secret for the automated job

## What will not come across

- Existing records (users, sources, ideas, videos). The copy starts with an empty database.
- The original sign-ins. People will need to register again on this app.

After the preview works, I can load your existing data if you export it from the original project's database as CSV or JSON.

## Technical notes

- Source stack matches this project: TanStack Start v1 + React 19 + Tailwind v4, Supabase-backed Lovable Cloud, server functions in `*.functions.ts` / `*.server.ts`.
- Migrations: 4 Supabase migrations plus a Drizzle schema; I will consolidate into migrations applied here, keeping GRANTs and RLS policies intact.
- Env/secrets used: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (provisioned by Cloud), `LOVABLE_API_KEY` (AI gateway), `LOVABLE_CRON_SECRET` (regenerated here).
- Dependency versions will follow this template's pinned TanStack versions; other packages copied from the source manifest.
- Public route `api/public/hooks/scheduled-videos` keeps its secret check; the cron target URL will point at this project.
- Verification: build, load each route, exercise one create/read flow, confirm sign-up and sign-in work.
