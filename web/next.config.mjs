/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // the commit this build was made from – the app compares it with /api/version to know it is outdated
  env: { NEXT_PUBLIC_BUILD_SHA: process.env.RAILWAY_GIT_COMMIT_SHA || 'dev' },
  // screens must never come from the phone's cache after a deploy (scripts/styles are content-hashed, they may be cached)
  async headers() {
    return [{ source: '/((?!_next/static|_next/image).*)', headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }] }];
  },
};

export default nextConfig;
