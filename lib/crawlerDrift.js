import { publisherById } from './publisherRegistry.js';

export const LIVE_DRIFT_CONTRACTS = Object.freeze({
  abc1: { coverage: 'hero', top10: 'complete' },
  cbs1: { coverage: 'hero', top10: 'complete' },
  usat1: { coverage: 'hero', top10: 'complete' },
  nbc1: { coverage: 'hero', top10: 'complete' },
  cnn1: { coverage: 'hero', top10: 'complete' },
  guardian1: { coverage: 'hero', top10: 'partial' },
  apgoogle1: { coverage: 'discovery' },
  latimes1: { coverage: 'hero' },
  npr1: { coverage: 'hero' },
  bbc1: { coverage: 'hero' },
  fox1: { coverage: 'hero' },
  yahoo1: { coverage: 'hero', top10: 'partial' },
});

function validStory(item) {
  if (String(item?.title || '').trim().length < 12) return false;
  try { return new URL(item?.url).protocol === 'https:'; } catch { return false; }
}

export function evaluateLiveDrift(sourceId, result, thrownError = null) {
  const contract = LIVE_DRIFT_CONTRACTS[sourceId];
  const issues = [];
  if (!publisherById[sourceId] || !contract) issues.push('missing drift contract');
  if (thrownError) issues.push(`collector threw: ${String(thrownError.message || thrownError)}`);
  if (!result || result.ok === false) issues.push(String(result?.error || 'collector returned no result'));
  if (Number(result?.http_status) >= 400) issues.push(`upstream HTTP ${result.http_status}`);

  if (contract?.coverage === 'discovery') {
    if (!Array.isArray(result?.items) || result.items.length < 1) issues.push('no discovery items');
    if (result?.items?.some(item => !validStory(item))) issues.push('invalid discovery item');
  } else if (!validStory(result?.item)) {
    issues.push('invalid centerpiece');
  }

  if (contract?.top10) {
    const count = Array.isArray(result?.top10) ? result.top10.length : 0;
    const quality = result?.top10_quality;
    const agreement = result?.top10_diagnostics?.centerpiece_agreement;
    if (contract.top10 === 'complete' && (quality !== 'complete' || count !== 10)) {
      issues.push(`expected complete Top 10, got ${quality || 'missing'} (${count})`);
    }
    if (contract.top10 === 'partial' && !['complete', 'partial'].includes(quality)) {
      issues.push(`expected usable ranked coverage, got ${quality || 'missing'} (${count})`);
    }
    if (count < 1) issues.push('ranked coverage is empty');
    if (agreement !== true) issues.push('rank 1 disagrees with centerpiece');
  }

  return {
    source_id: sourceId,
    ok: issues.length === 0,
    issues,
    item: result?.item ? { title: result.item.title, url: result.item.url } : null,
    item_count: Array.isArray(result?.items) ? result.items.length : result?.item ? 1 : 0,
    top10_quality: result?.top10_quality ?? null,
    top10_count: Array.isArray(result?.top10) ? result.top10.length : null,
    selector: result?.selector || result?.meta?.selector_used || null,
    http_status: result?.http_status ?? result?.meta?.http_status ?? null,
  };
}

