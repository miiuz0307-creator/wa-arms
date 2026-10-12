# BotiX – external encrypted database backup

Every night GitHub (separate from Supabase and from Railway) makes a full copy of the database
(schemas `public`, `ops`, `auth`). It restores the copy into an empty PostgreSQL to prove it is complete,
encrypts it, and stores it in Cloudflare R2, a third place. Production is only read, never written.

| Layer | Where | Kept |
|---|---|---|
| Supabase Pro daily backup | Supabase | 7 days |
| This job (encrypted) | Cloudflare R2 | 30 days (bucket rule) |
| Engine daily file (settings, groups, logins) | Railway disk | 14 days |

## One-time setup (owner, ~20 minutes). Secrets are typed only into the services, never into a chat.

### 1. Encryption key (on your own computer)
Install `age` (https://age-encryption.org), then:
```
age-keygen -o botix-backup.key
```
- The file `botix-backup.key` is the **private key**. Keep it in two places that are not this
  project, for example a password manager and a USB drive. Without it, no backup can be opened.
  It never goes to GitHub, Railway, Supabase or a chat.
- The line `# public key: age1...` is the **public key**. It can only lock files, not open them.

### 2. Cloudflare R2 bucket
1. Cloudflare dashboard → R2 → Create bucket → name `botix-backups`.
2. Bucket → Settings → Object lifecycle rules → add a rule: delete objects older than 30 days.
3. Optional but recommended: Settings → Bucket lock → a rule for prefix `daily/`, retention 7 days.
   This way even someone who steals the key cannot delete the last week.
4. R2 → Manage API tokens → Create token → permission **Object Read & Write**, applies to
   **only** `botix-backups`. Copy the Access Key ID, the Secret Access Key, and your Account ID.

### 3. Supabase connection string
Supabase → project wa-arms → Connect → **Session pooler**. Copy the URI. It contains the database
password; if you don't know it: Project Settings → Database → Reset database password. Nothing in
BotiX uses the database password (the engine and the app use API keys), so resetting it does not
affect the arms.

### 4. Put them in GitHub (Settings → Secrets and variables → Actions)
Tab **Secrets** → New repository secret:

| Name | Value |
|---|---|
| `SUPABASE_DB_URL` | the Session pooler URI from step 3 |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | from step 2.4 |
| `R2_SECRET_ACCESS_KEY` | from step 2.4 |

Tab **Variables** → New repository variable (these are not secret):

| Name | Value |
|---|---|
| `BACKUP_AGE_PUBLIC_KEY` | the `age1...` public key from step 1 |
| `R2_BUCKET` | `botix-backups` |

GitHub keeps secrets encrypted, hides them in logs, and nobody can read them back – not even you.

### 5. First run
GitHub → Actions → db-backup → Run workflow. In the log the five steps must end with
`restore test passed` and `checksum verified after upload`. After that the job runs every night,
and GitHub e-mails you if a run fails.

## Monthly restore drill (owner, ~10 minutes)
1. Download from R2 the three files of one night: `.dump.age`, `.manifest.tsv`, `.sha256`.
2. Start an empty PostgreSQL 17:
   `docker run -d --name drill -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:17`
3. Run: `bash ops/backup/restore-drill.sh botix-db-....dump.age botix-backup.key postgresql://postgres:x@localhost:55432/postgres`
4. Expected result: `checksum OK` … `RESTORE OK – every table matches the backup`.

In a real disaster, use the same command with an empty **new** Supabase project instead of docker.
Never run it against the running production database.
