Tested (testenv/run-tests.sh) but NOT applied to production yet – waiting for the owner's approval:
- 20261011_login_hardening.sql – station-code login limits by edge IP, system-wide brake, 30-day login expiry
- 20261014_balance_shared.sql – release 1.10: shared groups go to the less busy arm first
- 20261015_team_codes.sql – release 1.11: people with a personal 9-character code (station-manager rights).
  NOTE: once 1.11 is live, re-base 20261011_login_hardening.sql before applying it: its station_from_token
  has no member conditions and would sign out every person code.
- 20261011_temp_cleanup.sql – removes temporary rows (processed_messages > 1 hour, finished arm_commands > 7 days)
