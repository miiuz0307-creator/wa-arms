// GitHub REST API: pull requests only. Pushing is done with git (workspace.js).

function createGitHub(cfg, { fetchImpl = fetch } = {}) {
  const base = `https://api.github.com/repos/${cfg.repo}`;

  async function call(method, path, body) {
    if (!cfg.token) throw new Error('חסר GITHUB_TOKEN');
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'botix-repair',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || 'שגיאה'}`);
    return data;
  }

  return {
    ready: () => Boolean(cfg.token && cfg.repo),
    openPr: ({ head, title, body }) => call('POST', '/pulls', { head, base: cfg.baseBranch, title, body }),
    getPr: (n) => call('GET', `/pulls/${n}`),
    // sha: GitHub refuses the merge if the PR head moved since it was tested
    mergePr: (n, title, sha) => call('PUT', `/pulls/${n}/merge`, { merge_method: 'squash', commit_title: title, ...(sha ? { sha } : {}) }),
    comment: (n, body) => call('POST', `/issues/${n}/comments`, { body }),
    closePr: (n) => call('PATCH', `/pulls/${n}`, { state: 'closed' }),
  };
}

module.exports = { createGitHub };
