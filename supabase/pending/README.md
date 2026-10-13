Tested (testenv/run-tests.sh) but NOT applied to production yet – waiting for the owner's approval:
- 20261011_login_hardening.sql – station-code login limits by edge IP, system-wide brake, 30-day login expiry
- 20261011_temp_cleanup.sql – removes temporary rows (processed_messages > 1 hour, finished arm_commands > 7 days)
- 20261013_v2.sql – BotiX v2: station logo/plan, group flags + group_problems, payment requests with owner approval
  (WhatsApp to the owner with an approve link), station_active, subscription alerts, support tickets, engine helpers.
  Undo: 20261013_v2_rollback.sql (removes only the new objects). Daily job: 20261013_v2_cron.sql (apply after).
