-- 2026-10-11 commercial-readiness fixes (applied to production via MCP; kept here for the record)

-- ח1/ח2: stale 'sending' is closed as uncertain (no duplicate re-send); stuck rides expire instead of going out late
-- (full body: see public.finalize_campaigns in the database)

-- when a number was linked (QR scanned): its first 24 hours it sends slowly (warm-up)
alter table public.arms add column if not exists linked_at timestamptz;
