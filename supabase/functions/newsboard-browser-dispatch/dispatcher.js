// Fixed target: request input cannot select another repository, workflow or branch.
export const DISPATCH_URL = 'https://api.github.com/repos/mattwilhalme/newsboard/actions/workflows/browser-gap-fill.yml/dispatches';
export async function dispatchTick({ rpc, token, fetchImpl = fetch }) {
  const claim = await rpc('newsboard_browser_claim', { p_has_credential: Boolean(token) });
  if (claim.decision !== 'dispatch') return claim;
  if (!await rpc('newsboard_browser_mark_sent', { p_attempt: claim.attempt_id })) return { ...claim, outcome: 'claim_expired' };
  let response;
  try {
    response = await fetchImpl(DISPATCH_URL, {
      method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { dispatch_id: claim.attempt_id } }),
    });
  } catch {
    // A timeout can occur after GitHub accepted the request. Hold the lease;
    // never immediately repeat a potentially accepted workflow dispatch.
    await rpc('newsboard_browser_dispatch_result', { p_attempt: claim.attempt_id, p_status: null });
    return { ...claim, outcome: 'uncertain' };
  }
  let runId = null;
  if (response.status === 200) {
    const body = await response.json().catch(() => null);
    if (Number.isSafeInteger(body?.workflow_run_id)) runId = body.workflow_run_id;
  }
  // Persist only allowlisted response metadata, not raw GitHub messages or headers.
  await rpc('newsboard_browser_dispatch_result', {
    p_attempt: claim.attempt_id, p_status: response.status,
    p_request_id: response.headers.get('x-github-request-id'), p_run_id: runId,
    p_retry_seconds: Math.max(120, Math.min(3600, Number(response.headers.get('retry-after')) || 120)),
  });
  return { ...claim, outcome: [200, 204].includes(response.status) ? 'accepted' : 'rejected' };
}

export function createHandler({ db, token, fetchImpl = fetch }) {
  const rpc = async (name, args) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error('Scheduler persistence unavailable');
    return data;
  };
  return async req => {
    const json = (body, status=200) => new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json'}});
    if (req.method !== 'POST') return json({error:'POST required'},405);
    const secret = req.headers.get('x-newsboard-token') || '';
    if (!secret) return json({error:'Unauthorized'},401);
    try {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const {data,error} = await db.from('browser_scheduler_settings').select('token_hash').eq('id',true).single();
      if (error || !data) return json({error:'Authentication unavailable'},503);
      if (hash !== data.token_hash) return json({error:'Unauthorized'},401);
      return json(await dispatchTick({rpc,token,fetchImpl}));
    } catch {
      // No credentials, request bodies, provider responses or exception strings in logs.
      return json({error:'Scheduler unavailable; inspect private scheduling state'},503);
    }
  };
}
