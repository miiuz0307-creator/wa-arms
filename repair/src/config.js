// All settings come from environment variables. Secrets are read here once and never logged,
// never sent to WhatsApp, never shown in the admin screen (it only shows whether each one is set).

const env = (name, def = '') => (process.env[name] ?? def).toString().trim();
const list = (name) => env(name).split(',').map((s) => s.trim()).filter(Boolean);
const num = (name, def) => {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : def;
};
const bool = (name, def) => {
  const v = env(name).toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

function json(name, def) {
  const v = env(name);
  if (!v) return def;
  try {
    return JSON.parse(v);
  } catch {
    console.error(`משתנה הסביבה ${name} אינו JSON תקין – משתמש בברירת המחדל`);
    return def;
  }
}

// BotiX (wa-arms) services on Railway, as they exist today
const DEFAULT_SERVICES = {
  engine: 'babbcc28-cc69-418b-856e-c82124d11984',
  web: '00319a87-212b-4691-9f3f-7e0f117948ac',
};

function load() {
  return {
    port: num('PORT', 3000),
    dataDir: env('DATA_DIR', '/data'),
    databaseUrl: env('DATABASE_URL'),

    adminPassword: env('ADMIN_PASSWORD'),
    sessionSecret: env('SESSION_SECRET'), // encrypts the WhatsApp session and signs admin cookies

    // Claude Code: a subscription token from `claude setup-token`, or an API key
    claudeOauthToken: env('CLAUDE_CODE_OAUTH_TOKEN'),
    anthropicApiKey: env('ANTHROPIC_API_KEY'),
    claudeModel: env('CLAUDE_MODEL'),
    claudeMaxTurns: num('CLAUDE_MAX_TURNS', 60),
    claudeTimeoutMin: num('CLAUDE_TIMEOUT_MIN', 30),

    // The project being repaired
    github: {
      token: env('GITHUB_TOKEN'), // fine-grained: this one repo, Contents + Pull requests only
      repo: env('GITHUB_REPO', 'miiuz0307-creator/wa-arms'),
      baseBranch: env('GITHUB_BASE_BRANCH', 'main'),
      stagingBranch: env('STAGING_BRANCH', 'staging'),
    },

    railway: {
      api: env('RAILWAY_API_URL', 'https://backboard.railway.com/graphql/v2'),
      projectId: env('RAILWAY_PROJECT_ID', '4cc8f773-1f5c-40a1-b593-2d985e10ffb1'),
      prodEnvId: env('RAILWAY_PROD_ENV_ID', 'b8a4493e-241e-443a-96c4-9ce5afea5729'),
      stagingEnvId: env('RAILWAY_STAGING_ENV_ID'),
      // project tokens are per environment – one for production, one for staging
      prodToken: env('RAILWAY_PROD_TOKEN'),
      stagingToken: env('RAILWAY_STAGING_TOKEN'),
      services: json('RAILWAY_SERVICES', DEFAULT_SERVICES), // production service ids by name
      stagingServices: json('RAILWAY_STAGING_SERVICES', null), // same names, staging ids (often identical)
    },

    prodHealthUrls: list('PROD_HEALTH_URLS'),
    stagingHealthUrls: list('STAGING_HEALTH_URLS'),

    approvalMinutes: num('APPROVAL_MINUTES', 30),
    deployWaitMin: num('DEPLOY_WAIT_MIN', 15),
    autoRollback: bool('AUTO_ROLLBACK', true),

    // collect screenshots sent right after a description before starting work
    intakeGraceSec: num('INTAKE_GRACE_SEC', 20),

    // children (Claude Code, tests) run as this unprivileged user so they cannot read our secrets
    runnerUser: env('RUNNER_USER', 'runner'),
  };
}

module.exports = { load, DEFAULT_SERVICES };
