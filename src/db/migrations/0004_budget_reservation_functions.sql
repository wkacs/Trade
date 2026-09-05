-- T09 — atomi keretfoglalás.
--
-- MIÉRT: két egyidejű futó (cron + worker, vagy két worker) külön-külön átmehet a
-- kockázati kapun, mert mindkettő ugyanazt a szabad készpénzt látja. A foglalást ezért
-- a SZERVER dönti el: a beszúrás csak akkor sikerül, ha a már aktív foglalások és az új
-- igény együtt beleférnek a megadott fedezetbe. Egyetlen utasítás, egyetlen tranzakció.

CREATE OR REPLACE FUNCTION reserve_budget_v2(
  p_intent_id    text,
  p_portfolio_id text,
  p_mode         text,
  p_origin       text,
  p_symbol       text,
  p_quote        numeric,
  p_cash_cap     numeric,
  p_ttl_ms       bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_active numeric;
  v_id     uuid;
BEGIN
  IF p_quote <= 0 THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'non_positive_amount');
  END IF;

  -- A lejárt foglalások nem köthetik le a keretet.
  UPDATE budget_reservations
     SET state = 'released'
   WHERE portfolio_id = p_portfolio_id
     AND mode = p_mode
     AND state = 'active'
     AND expires_at <= now();

  SELECT COALESCE(sum(reserved_quote - consumed_quote), 0)
    INTO v_active
    FROM budget_reservations
   WHERE portfolio_id = p_portfolio_id AND mode = p_mode AND state = 'active';

  IF v_active + p_quote > p_cash_cap THEN
    RETURN jsonb_build_object(
      'reserved', false,
      'reason', 'cap_exceeded',
      'activeReserved', v_active::text,
      'cashCap', p_cash_cap::text
    );
  END IF;

  INSERT INTO budget_reservations
    (intent_id, portfolio_id, mode, origin, symbol, reserved_quote, expires_at)
  VALUES
    (p_intent_id, p_portfolio_id, p_mode, p_origin, p_symbol, p_quote,
     now() + make_interval(secs => p_ttl_ms / 1000.0))
  ON CONFLICT (intent_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Ugyanez az intent már foglalt: idempotens, nem hiba.
    RETURN jsonb_build_object('reserved', true, 'reason', 'already_reserved');
  END IF;

  RETURN jsonb_build_object('reserved', true, 'reason', 'ok', 'activeReserved', (v_active + p_quote)::text);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION release_budget_reservation(p_intent_id text)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH u AS (
    UPDATE budget_reservations
       SET state = 'released'
     WHERE intent_id = p_intent_id AND state = 'active'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;
--> statement-breakpoint

-- Lejárt foglalások takarítása (a worker indulásakor és periodikusan hívjuk).
CREATE OR REPLACE FUNCTION expire_stale_reservations(p_portfolio_id text, p_mode text)
RETURNS integer
LANGUAGE sql
AS $$
  WITH u AS (
    UPDATE budget_reservations
       SET state = 'released'
     WHERE portfolio_id = p_portfolio_id
       AND mode = p_mode
       AND state = 'active'
       AND expires_at <= now()
    RETURNING 1
  )
  SELECT count(*)::int FROM u;
$$;
