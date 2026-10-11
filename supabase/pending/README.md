Tested (testenv/run-tests.sh) but NOT applied to production yet – waiting for the owner's approval:
- 20261011_login_hardening.sql – station-code login limits by edge IP, system-wide brake, 30-day login expiry
- 20261011_temp_cleanup.sql – removes temporary rows (processed_messages > 1 hour, finished arm_commands > 7 days)
