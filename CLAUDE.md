# BotiX / wa-arms – rules for changing production

The owner requires: **nothing reaches production without his explicit approval in the app ("ניהול עדכונים").**

- Pushing to `main` deploys nothing. Railway watch paths of both services (`engine`, `web`) are set to
  `/deploy-only-after-owner-approval/**`, so pushes are SKIPPED. Do not change this.
- Do not deploy with Railway tools (`connect-service-source`, `redeploy`, `create-deployment`) and do not apply
  DB migrations directly to production. Exception: an emergency restore the owner asked for in this conversation.
- To ship a change:
  1. Run `sudo testenv/run-tests.sh` (DB) and `cd engine && npm test` (engine). All must pass.
  2. Commit and push to `main`.
  3. Register a release (one SQL insert into `public.releases`, status `pending`), in Hebrew:
     `version`, `title`, `changes[]`, `components` (web / engine / db), `affects_arms`,
     `disconnect_risk` (none / short / high), `restart_engine`, `risk_notes`, `commit_sha` (full),
     `migration_sql` + `rollback_sql` for DB changes (additive; never delete user data, connections or groups).
  4. Tell the owner what is waiting and whether it disconnects the arms. He approves now / tonight 03:00.
- The `release-runner` edge function (pg_cron every minute) then: snapshots data, applies the DB change,
  deploys the exact commit via the Railway API, watches health (arms online, engine heartbeat, `/api/version`)
  and redeploys the previous commit automatically if health is bad.
- Any engine deploy restarts WhatsApp connections (~30s, no QR). Say so in the release.
- Never write that something works without checking it in production logs/data.
