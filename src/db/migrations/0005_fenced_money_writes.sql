-- T10 completion: the fencing token now protects the money-moving DB operations,
-- rather than merely being returned to the caller.  FOR SHARE keeps the lease row
-- stable until the wrapped operation finishes in this transaction.

ALTER FUNCTION apply_fill_v2(jsonb, jsonb) RENAME TO apply_fill_v2_unfenced;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION apply_fill_v2(p_fill jsonb, p_deltas jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_fence jsonb := p_deltas -> 'fence';
  v_lease run_leases%ROWTYPE;
BEGIN
  IF v_fence IS NOT NULL AND v_fence <> 'null'::jsonb THEN
    SELECT * INTO v_lease
      FROM run_leases
     WHERE lease_key = v_fence ->> 'leaseKey'
     FOR SHARE;

    IF NOT FOUND
       OR v_lease.owner <> v_fence ->> 'owner'
       OR v_lease.fencing_token <> (v_fence ->> 'fencingToken')::bigint
       OR v_lease.expires_at <= now() THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'fenced');
    END IF;
  END IF;

  RETURN apply_fill_v2_unfenced(p_fill, p_deltas - 'fence');
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reserve_budget_v3(
  p_intent_id    text,
  p_portfolio_id text,
  p_mode         text,
  p_origin       text,
  p_symbol       text,
  p_quote        numeric,
  p_cash_cap     numeric,
  p_ttl_ms       bigint,
  p_lease_key    text,
  p_owner        text,
  p_fencing_token bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_lease run_leases%ROWTYPE;
BEGIN
  IF p_lease_key IS NOT NULL THEN
    SELECT * INTO v_lease
      FROM run_leases
     WHERE lease_key = p_lease_key
     FOR SHARE;

    IF NOT FOUND
       OR v_lease.owner <> p_owner
       OR v_lease.fencing_token <> p_fencing_token
       OR v_lease.expires_at <= now() THEN
      RETURN jsonb_build_object('reserved', false, 'reason', 'fenced');
    END IF;
  END IF;

  RETURN reserve_budget_v2(
    p_intent_id, p_portfolio_id, p_mode, p_origin, p_symbol,
    p_quote, p_cash_cap, p_ttl_ms
  );
END;
$$;
--> statement-breakpoint
