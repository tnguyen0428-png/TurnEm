# TurnEmApp — Project Context
_Last updated: 2026-04-23_

## Stack
- React + TypeScript + Vite (dual entry: index.html + staff.html)
- Supabase (Postgres) for real-time state sync
- Tailwind CSS, Lucide icons, font-bebas for headings
- Deployed on Vercel at turnem.io

## Key Files
- `src/state/AppContext.tsx` — central state, Supabase sync functions (frequently corrupted by null bytes — check with `grep -c "" file` if sync breaks)
- `src/state/reducer.ts` — all app actions
- `src/components/queue/ManicuristCard.tsx` — main queue card
- `src/components/staff/StaffPortalScreen.tsx` — staff-facing portal (polls DB every 3s)
- `public/lunch-break.webp` — break animation shown on staff portal
- `vercel.json` — SPA rewrite rules (must exclude static assets like .webp, .gif, .png)

## Architecture Notes
- Staff portal is read-only (isStaffMode blocks sync-back to DB), polls Supabase independently
- Manicurists synced as a single batch upsert (not per-row) to avoid 20+ individual calls
- `withRetry` wrapper on all Supabase writes (3 retries, 2s delay)
- `break_start_time` stored as bigint (milliseconds) in DB — send as Number(), not ISO string
- Git has a stale index.lock issue; use `GIT_INDEX_FILE=/tmp/alt-index` workaround if needed

## Supabase Schema Notes
- `manicurists.break_start_time` = bigint (milliseconds), NOT timestamptz
- `queue_entries.extra_time_ms` = integer
- RLS: permissive policies for both anon and authenticated roles on all tables

## Deployment
- GitHub repo: https://github.com/tnguyen0428-png/TurnEm.git (HTTPS, uses stored credentials)
- Vercel auto-deploys on push to main
- vercel.json rewrites: static files (.webp, .gif, .png, .jpg, assets) must be excluded from SPA rewrite

## Staff
- Manicurists have IDs like `mani-1` through `mani-18` (pre-seeded) 
- Kayla has UUID id `082bac58-fa58-41dd-87ca-094ee095836b` (added via app)
