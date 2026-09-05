CREATE TABLE IF NOT EXISTS shadow_experiments (
  namespace text PRIMARY KEY,
  protocol_hash text NOT NULL,
  experiment_id text NOT NULL,
  candidate_id text NOT NULL,
  starting_capital numeric NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  target_days integer NOT NULL DEFAULT 30,
  target_round_trips integer NOT NULL DEFAULT 50
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shadow_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL REFERENCES shadow_experiments(namespace),
  cycle_id text NOT NULL,
  account_id text NOT NULL,
  portfolio_id text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  equity_quote numeric NOT NULL,
  actions integer NOT NULL DEFAULT 0,
  degraded boolean NOT NULL DEFAULT false,
  incident jsonb,
  UNIQUE(namespace, cycle_id, account_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shadow_cycles_namespace_time_idx ON shadow_cycles(namespace, executed_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bot_protection_orders (
  portfolio_id text NOT NULL,
  exchange_order_id text NOT NULL,
  symbol text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(portfolio_id, exchange_order_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION provision_shadow_experiment(
  p_namespace text, p_protocol_hash text, p_experiment_id text, p_candidate_id text,
  p_starting_capital numeric, p_accounts jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_account jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM shadow_experiments WHERE namespace = p_namespace) THEN
    RAISE EXCEPTION 'shadow namespace already exists: %', p_namespace;
  END IF;
  FOR v_account IN SELECT * FROM jsonb_array_elements(p_accounts) LOOP
    IF EXISTS (SELECT 1 FROM ledger_cash WHERE portfolio_id = v_account ->> 'portfolioId' AND mode = 'paper') THEN
      RAISE EXCEPTION 'shadow ledger already exists: %', v_account ->> 'portfolioId';
    END IF;
  END LOOP;
  INSERT INTO shadow_experiments(namespace, protocol_hash, experiment_id, candidate_id, starting_capital)
    VALUES (p_namespace, p_protocol_hash, p_experiment_id, p_candidate_id, p_starting_capital);
  FOR v_account IN SELECT * FROM jsonb_array_elements(p_accounts) LOOP
    INSERT INTO ledger_cash(portfolio_id, mode, asset, amount)
      VALUES (v_account ->> 'portfolioId', 'paper', 'USDT', p_starting_capital);
  END LOOP;
END;
$$;
--> statement-breakpoint
