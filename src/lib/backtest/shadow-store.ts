import { getSql } from "@/db/client";

function sqlOrThrow() {
  const sql = getSql();
  if (!sql) throw new Error("A shadow méréshez DATABASE_URL és migrált adatbázis kell.");
  return sql;
}

export async function provisionShadowExperiment(input: {
  namespace: string; protocolHash: string; experimentId: string; candidateId: string; startingCapital: number;
  accounts: { portfolioId: string }[];
}) {
  const sql = sqlOrThrow();
  await sql`SELECT provision_shadow_experiment(${input.namespace}, ${input.protocolHash}, ${input.experimentId},
    ${input.candidateId}, ${input.startingCapital}::numeric, ${JSON.stringify(input.accounts)}::jsonb)`;
}

export async function recordShadowCycle(input: {
  namespace: string; cycleId: string; accountId: string; portfolioId: string; equityQuote: string;
  actions: number; degraded: boolean; incident?: unknown;
}) {
  const sql = sqlOrThrow();
  await sql`INSERT INTO shadow_cycles(namespace, cycle_id, account_id, portfolio_id, equity_quote, actions, degraded, incident)
    VALUES (${input.namespace}, ${input.cycleId}, ${input.accountId}, ${input.portfolioId}, ${input.equityQuote}::numeric,
      ${input.actions}, ${input.degraded}, ${input.incident ? JSON.stringify(input.incident) : null}::jsonb)`;
}

export interface ShadowReportRow {
  accountId: string; cycles: number; days: number; equity: number; netReturnPct: number;
  maxDrawdownPct: number; roundTrips: number; feesQuote: number; degradedCycles: number;
}

export async function shadowReport(namespace: string): Promise<{
  protocolHash: string; experimentId: string; candidateId: string; startedAt: string;
  targetDays: number; targetRoundTrips: number; rows: ShadowReportRow[];
}> {
  const sql = sqlOrThrow();
  const experiments = await sql`SELECT protocol_hash, experiment_id, candidate_id, started_at, target_days, target_round_trips, starting_capital
    FROM shadow_experiments WHERE namespace = ${namespace}` as { protocol_hash: string; experiment_id: string; candidate_id: string; started_at: string; target_days: number; target_round_trips: number; starting_capital: string }[];
  const experiment = experiments[0];
  if (!experiment) throw new Error(`Nincs provisionált shadow mérés: ${namespace}.`);
  const cycles = await sql`SELECT account_id, equity_quote, degraded, executed_at
    FROM shadow_cycles WHERE namespace = ${namespace} ORDER BY account_id, executed_at` as { account_id: string; equity_quote: string; degraded: boolean; executed_at: string }[];
  const fills = await sql`SELECT portfolio_id, symbol, side, filled_base_qty, fee_amount, fee_asset
    FROM execution_fills WHERE mode = 'paper' AND portfolio_id LIKE ${`${namespace}:%`} ORDER BY executed_at` as {
      portfolio_id: string; symbol: string; side: string; filled_base_qty: string; fee_amount: string; fee_asset: string;
    }[];
  const accountIds = [...new Set(cycles.map((c) => c.account_id))];
  const rows = accountIds.map((accountId) => {
    const series = cycles.filter((c) => c.account_id === accountId);
    let peak = Number(experiment.starting_capital), maxDd = 0;
    for (const point of series) { const v = Number(point.equity_quote); peak = Math.max(peak, v); if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak); }
    const accountFills = fills.filter((f) => f.portfolio_id === `${namespace}:${accountId}`);
    const qty: Record<string, number> = {}; let roundTrips = 0;
    for (const f of accountFills) { const before = qty[f.symbol] ?? 0; qty[f.symbol] = before + (f.side === "BUY" ? 1 : -1) * Number(f.filled_base_qty); if (before > 1e-12 && qty[f.symbol] <= 1e-12) roundTrips++; }
    const equity = Number(series.at(-1)?.equity_quote ?? experiment.starting_capital);
    return { accountId, cycles: series.length, days: Math.floor((Date.now() - new Date(experiment.started_at).getTime()) / 86_400_000),
      equity, netReturnPct: equity / Number(experiment.starting_capital) - 1, maxDrawdownPct: maxDd, roundTrips,
      feesQuote: accountFills.filter((f) => f.fee_asset === "USDT").reduce((s, f) => s + Number(f.fee_amount), 0),
      degradedCycles: series.filter((c) => c.degraded).length };
  });
  return { protocolHash: experiment.protocol_hash, experimentId: experiment.experiment_id, candidateId: experiment.candidate_id,
    startedAt: experiment.started_at, targetDays: Number(experiment.target_days), targetRoundTrips: Number(experiment.target_round_trips), rows };
}
