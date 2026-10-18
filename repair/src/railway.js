// Railway public GraphQL API: read logs, watch deployments, roll back.
// Uses project tokens (one per environment) – they cannot touch other projects.

const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createRailway(cfg, { fetchImpl = fetch, pollMs = 15_000 } = {}) {
  const envs = {
    production: { token: cfg.prodToken, envId: cfg.prodEnvId, projectId: cfg.projectId, services: cfg.services || {} },
    // staging may live in its own Railway project (a fully separate copy, no shared variables)
    staging: { token: cfg.stagingToken, envId: cfg.stagingEnvId, projectId: cfg.stagingProjectId || cfg.projectId, services: cfg.stagingServices || cfg.services || {} },
  };

  const ready = (name) => Boolean(envs[name].token && envs[name].envId && envs[name].projectId);

  async function gql(name, query, variables) {
    const e = envs[name];
    if (!e.token) throw new Error(`חסר טוקן Railway לסביבת ${name}`);
    const res = await fetchImpl(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Project-Access-Token': e.token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors?.length) {
      throw new Error(`Railway: ${body.errors?.[0]?.message || res.status}`);
    }
    return body.data;
  }

  const serviceId = (name, service) => envs[name].services[service];

  async function deployments(name, service, { first = 5, successfulOnly = false } = {}) {
    const sid = serviceId(name, service);
    if (!sid) throw new Error(`שירות לא מוכר: ${service}`);
    const input = { projectId: envs[name].projectId, serviceId: sid, environmentId: envs[name].envId };
    if (successfulOnly) input.status = { successfulOnly: true };
    const d = await gql(
      name,
      `query($input: DeploymentListInput!, $first: Int) { deployments(input: $input, first: $first) {
        edges { node { id status createdAt canRollback } } } }`,
      { input, first },
    );
    return d.deployments.edges.map((e) => e.node);
  }

  async function latest(name, service, opts) {
    return (await deployments(name, service, { first: 1, ...opts }))[0] || null;
  }

  async function logs(name, service, { limit = 300, filter = '' } = {}) {
    const dep = await latest(name, service);
    if (!dep) return [];
    const vars = { deploymentId: dep.id, limit };
    if (filter) vars.filter = filter;
    const d = await gql(
      name,
      `query($deploymentId: String!, $limit: Int${filter ? ', $filter: String' : ''}) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit${filter ? ', filter: $filter' : ''}) { timestamp message severity } }`,
      vars,
    );
    return d.deploymentLogs || [];
  }

  /** Wait until a deployment newer than `since` reaches a final status. */
  async function waitForNew(name, service, since, timeoutMin) {
    const until = Date.now() + timeoutMin * 60_000;
    while (Date.now() < until) {
      const list = await deployments(name, service, { first: 3 }).catch(() => []);
      const fresh = list.find((d) => new Date(d.createdAt) > since);
      if (fresh && TERMINAL.has(fresh.status)) {
        // a deployment can crash a little after it reports SUCCESS – look again once
        if (fresh.status === 'SUCCESS') {
          await sleep(Math.min(pollMs * 2, 60_000));
          const again = (await deployments(name, service, { first: 3 }).catch(() => [])).find((d) => d.id === fresh.id);
          return again || fresh;
        }
        return fresh;
      }
      await sleep(pollMs);
    }
    return { status: 'TIMEOUT' };
  }

  async function rollback(name, deploymentId) {
    const d = await gql(name, `mutation($id: String!) { deploymentRollback(id: $id) { id status } }`, { id: deploymentId });
    return d.deploymentRollback;
  }

  return { ready, deployments, latest, logs, waitForNew, rollback, serviceId };
}

/** Check that each URL answers with a non-5xx status (a few tries). */
async function healthCheck(urls, { fetchImpl = fetch, tries = 3, waitMs = 10_000 } = {}) {
  const results = [];
  for (const url of urls) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
        last = { url, status: r.status, ok: r.status < 500 };
        if (last.ok) break;
      } catch (e) {
        last = { url, ok: false, error: e.message };
      }
      if (i < tries - 1) await sleep(waitMs);
    }
    results.push(last);
  }
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { createRailway, healthCheck, TERMINAL };
