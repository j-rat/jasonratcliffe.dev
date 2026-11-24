// Cost overview from Cost Explorer, filtered to the application = resume cost allocation tag only.
// Cost Explorer charges $0.01 per API request, so results are cached in memory (one refresh = 3 requests).
import {
  CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand, ListCostAllocationTagsCommand,
} from '@aws-sdk/client-cost-explorer';

export const TAG = { key: 'application', value: 'resume' };
const MONTHS = 6;
const CACHE_MS = 6 * 3600_000;
const MIN_REFRESH_MS = 10 * 60_000;
const client = new CostExplorerClient({ region: 'us-east-1' }); // Cost Explorer's only endpoint

const FILTER = { Tags: { Key: TAG.key, Values: [TAG.value], MatchOptions: ['EQUALS'] } };

// Cost Explorer service names -> the architecture's components (as on the /architecture/ page).
const COMPONENTS = {
  'Amazon CloudFront': 'CDN and edge (CloudFront)',
  'Amazon Simple Storage Service': 'Storage (site and state buckets)',
  'AWS Lambda': 'Functions (contact, edge report)',
  'Amazon API Gateway': 'Contact API (API Gateway)',
  AmazonCloudWatch: 'Logs and telemetry (CloudWatch)',
  'Amazon Route 53': 'DNS (Route 53)',
  'Amazon Simple Email Service': 'Email (SES)',
  'AWS Certificate Manager': 'TLS certificate (ACM)',
  'Amazon EventBridge': 'Daily schedule (EventBridge)',
  CloudWatch: 'Logs and telemetry (CloudWatch)',
};
export const componentOf = (service) => COMPONENTS[service] ?? service;

const ymd = (d) => d.toISOString().slice(0, 10);
const NO_CREDS = new Set(['CredentialsProviderError', 'ExpiredTokenException', 'UnrecognizedClientException', 'InvalidSignatureException', 'TokenRefreshRequired']);

let cache = null; // { at, data }

function shape({ resultsByTime, forecast, tagStatus, source, reason }) {
  const months = resultsByTime.map((r) => {
    const byComponent = {};
    for (const g of r.Groups ?? []) {
      const c = componentOf(g.Keys[0]);
      byComponent[c] = (byComponent[c] ?? 0) + Number(g.Metrics.UnblendedCost.Amount);
    }
    const total = Object.values(byComponent).reduce((a, b) => a + b, 0);
    return { month: r.TimePeriod.Start.slice(0, 7), total, byComponent };
  });
  const current = months.at(-1) ?? { total: 0, byComponent: {} };
  const previous = months.at(-2) ?? { total: 0, byComponent: {} };
  const names = [...new Set(months.flatMap((m) => Object.keys(m.byComponent)))];
  const components = names.map((component) => ({
    component,
    monthToDate: current.byComponent[component] ?? 0,
    lastMonth: previous.byComponent[component] ?? 0,
    sixMonths: months.reduce((a, m) => a + (m.byComponent[component] ?? 0), 0),
  })).sort((a, b) => b.sixMonths - a.sixMonths);
  return {
    source, reason, asOf: new Date().toISOString(), currency: 'USD', tag: { ...TAG, status: tagStatus },
    totals: {
      monthToDate: current.total, lastMonth: previous.total, forecastMonthEnd: forecast,
      sixMonths: months.reduce((a, m) => a + m.total, 0),
    },
    months, components,
  };
}

async function fetchFromAws(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)); // exclusive
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const resultsByTime = [];
  let token;
  do {
    const res = await client.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: ymd(start), End: ymd(end) }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'],
      Filter: FILTER, GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }], NextPageToken: token,
    }));
    for (const r of res.ResultsByTime ?? []) {
      const existing = resultsByTime.find((x) => x.TimePeriod.Start === r.TimePeriod.Start);
      if (existing) existing.Groups.push(...(r.Groups ?? []));
      else resultsByTime.push({ ...r, Groups: [...(r.Groups ?? [])] });
    }
    token = res.NextPageToken;
  } while (token);

  let forecast = null;
  try {
    const f = await client.send(new GetCostForecastCommand({
      TimePeriod: { Start: ymd(end), End: ymd(nextMonth) }, Metric: 'UNBLENDED_COST', Granularity: 'MONTHLY', Filter: FILTER,
    }));
    // The forecast covers the rest of the month; add what's already been spent.
    const spent = resultsByTime.at(-1)?.Groups?.reduce((a, g) => a + Number(g.Metrics.UnblendedCost.Amount), 0) ?? 0;
    forecast = spent + Number(f.Total?.Amount ?? 0);
  } catch {
    forecast = null; // not enough history yet, or the last day of the month
  }

  let tagStatus = 'unknown';
  try {
    const t = await client.send(new ListCostAllocationTagsCommand({ TagKeys: [TAG.key] }));
    tagStatus = t.CostAllocationTags?.[0]?.Status ?? 'not seen by Billing yet';
  } catch {
    tagStatus = 'unknown';
  }
  return shape({ resultsByTime, forecast, tagStatus, source: 'aws' });
}

export function sampleCosts(now = new Date()) {
  const base = { 'CDN and edge (CloudFront)': 0.42, 'Storage (site and state buckets)': 0.08, 'DNS (Route 53)': 0.5,
    'Logs and telemetry (CloudWatch)': 0.21, 'Functions (contact, edge report)': 0, 'Contact API (API Gateway)': 0.01, 'Email (SES)': 0 };
  const resultsByTime = Array.from({ length: MONTHS }, (_, k) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1 - k), 1));
    const scale = k === MONTHS - 1 ? now.getUTCDate() / 30 : 0.8 + 0.08 * k;
    return {
      TimePeriod: { Start: ymd(d) },
      Groups: Object.entries(base).map(([c, v]) => ({ Keys: [c], Metrics: { UnblendedCost: { Amount: String(v * scale) } } })),
    };
  });
  const spent = Object.values(base).reduce((a, b) => a + b, 0) * (now.getUTCDate() / 30);
  return { resultsByTime, forecast: spent * (30 / Math.max(1, now.getUTCDate())), tagStatus: 'Active (sample)' };
}

/** Cached cost overview. `refresh` re-queries at most every 10 minutes (each refresh costs about $0.03). */
export async function costOverview({ refresh = false, forceSample = false } = {}) {
  if (forceSample) return shape({ ...sampleCosts(), source: 'sample', reason: 'sample mode' });
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && (age < CACHE_MS && !(refresh && age > MIN_REFRESH_MS))) return { ...cache.data, cached: true };
  try {
    const data = await fetchFromAws();
    cache = { at: Date.now(), data };
    return { ...data, cached: false };
  } catch (err) {
    if (NO_CREDS.has(err.name) || /credential/i.test(err.message)) {
      return shape({ ...sampleCosts(), source: 'sample', reason: 'no usable AWS credentials (run `aws login`, or set AWS_PROFILE)' });
    }
    throw err;
  }
}
