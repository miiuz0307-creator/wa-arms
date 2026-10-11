// Which version of the app is running. Used by: the auto-update banner in the app, Railway's health check
// (a broken build never replaces the working one), and the release runner's health checks.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { sha: process.env.RAILWAY_GIT_COMMIT_SHA || 'dev', at: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
