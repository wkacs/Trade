-- T03 — atomi ledger-műveletek és védő megszorítások.
--
-- MIÉRT SQL-FÜGGVÉNY: a Neon HTTP-driver nem ad interaktív tranzakciót (nem lehet
-- ugyanabban a tranzakcióban olvasni, dönteni, majd írni). Egyetlen függvényhívás
-- viszont EGY szerveroldali tranzakcióban fut, így a fill + cash + pozíció + foglalás
-- együtt commitol vagy együtt bukik.
--
-- A DÖNTÉS (mennyit, szabad-e) TypeScriptben marad (ledger.ts + risk-manager.ts): a
-- függvény csak a TS által kiszámolt, explicit deltákat alkalmazza. Így nincs két,
-- egymástól elcsúszó könyvelési logika.

-- ── Védő megszorítások: tiltott negatív készlet és egyenleg ──────────────────
ALTER TABLE "ledger_cash"
  ADD CONSTRAINT "ledger_cash_amount_non_negative" CHECK ("amount" >= 0);
--> statement-breakpoint
ALTER TABLE "ledger_positions"
  ADD CONSTRAINT "ledger_positions_qty_non_negative" CHECK ("qty" >= 0);
--> statement-breakpoint
ALTER TABLE "ledger_positions"
  ADD CONSTRAINT "ledger_positions_cost_non_negative" CHECK ("cost_basis_quote" >= 0);
--> statement-breakpoint
ALTER TABLE "execution_fills"
  ADD CONSTRAINT "execution_fills_positive" CHECK ("filled_base_qty" > 0 AND "gross_quote_amount" > 0 AND "fee_amount" >= 0);
--> statement-breakpoint
ALTER TABLE "execution_intents"
  ADD CONSTRAINT "execution_intents_side_amount" CHECK (
    ("side" = 'BUY' AND "max_quote_spend" IS NOT NULL AND "base_qty" IS NULL AND "max_quote_spend" > 0)
    OR ("side" = 'SELL' AND "base_qty" IS NOT NULL AND "max_quote_spend" IS NULL AND "base_qty" > 0)
  );
--> statement-breakpoint
ALTER TABLE "execution_intents"
  ADD CONSTRAINT "execution_intents_mode" CHECK ("mode" IN ('paper', 'live'));
--> statement-breakpoint
ALTER TABLE "execution_fills"
  ADD CONSTRAINT "execution_fills_mode" CHECK ("mode" IN ('paper', 'live'));
--> statement-breakpoint
ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_amounts" CHECK ("reserved_quote" >= 0 AND "consumed_quote" >= 0);
--> statement-breakpoint
ALTER TABLE "daily_equity"
  ADD CONSTRAINT "daily_equity_source" CHECK ("source" IN ('day-open', 'partial-day', 'missing'));
--> statement-breakpoint

-- ── apply_fill_v2: EGY tranzakcióban könyvel egy teljesülést, pontosan egyszer ──
--
-- p_fill      : a fill sor mezői jsonb-ben (a contracts.ts Fill alakja).
-- p_deltas    : { "cash": [{"asset":"USDT","delta":"-2.002"}, ...],
--                 "position": {"symbol":"BTC","qtyDelta":"0.00003","costDelta":"2.002",
--                              "stopPrice":"57000"|null},
--                 "reservation": {"intentId":"...","consumeQuote":"2.002"}|null }
--
-- Visszatérés: { "applied": true|false, "reason": "...", "cash": {...}, "position": {...} }
-- A duplikált fill_key NEM hiba: applied=false, és semmilyen egyenleg nem mozdul.
CREATE OR REPLACE FUNCTION apply_fill_v2(p_fill jsonb, p_deltas jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted   uuid;
  v_pf         text := p_fill ->> 'portfolioId';
  v_mode       text := p_fill ->> 'mode';
  v_cash       jsonb;
  v_pos        jsonb;
  v_res        jsonb;
  v_item       jsonb;
  v_qty        numeric;
  v_cost       numeric;
  v_result     jsonb;
BEGIN
  INSERT INTO execution_fills (
    fill_key, intent_id, portfolio_id, mode, symbol, side,
    exchange_order_id, exchange_trade_id, filled_base_qty, gross_quote_amount,
    fill_price, fee_amount, fee_asset, executed_at, provenance
  ) VALUES (
    p_fill ->> 'fillId',
    p_fill ->> 'intentId',
    v_pf,
    v_mode,
    p_fill ->> 'symbol',
    p_fill ->> 'side',
    p_fill ->> 'exchangeOrderId',
    p_fill ->> 'exchangeTradeId',
    (p_fill ->> 'filledBaseQty')::numeric,
    (p_fill ->> 'grossQuoteAmount')::numeric,
    (p_fill ->> 'fillPrice')::numeric,
    (p_fill ->> 'feeAmount')::numeric,
    p_fill ->> 'feeAsset',
    to_timestamp((p_fill ->> 'executedAt')::bigint / 1000.0),
    COALESCE(p_fill ->> 'provenance', 'live-v2')
  )
  ON CONFLICT (fill_key) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NULL THEN
    -- Már könyveltük ezt a teljesülést. Idempotens: nincs második egyenleg-mozgás.
    RETURN jsonb_build_object('applied', false, 'reason', 'duplicate_fill');
  END IF;

  -- Eszközönkénti egyenleg-deltak.
  v_cash := COALESCE(p_deltas -> 'cash', '[]'::jsonb);
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_cash) LOOP
    INSERT INTO ledger_cash (portfolio_id, mode, asset, amount, updated_at)
    VALUES (v_pf, v_mode, v_item ->> 'asset', (v_item ->> 'delta')::numeric, now())
    ON CONFLICT (portfolio_id, mode, asset)
    DO UPDATE SET amount = ledger_cash.amount + (v_item ->> 'delta')::numeric, updated_at = now();
  END LOOP;

  -- Pozíció-delta (mennyiség + bekerülési érték + opcionális stop).
  v_pos := p_deltas -> 'position';
  IF v_pos IS NOT NULL AND v_pos <> 'null'::jsonb THEN
    v_qty  := (v_pos ->> 'qtyDelta')::numeric;
    v_cost := (v_pos ->> 'costDelta')::numeric;
    INSERT INTO ledger_positions (portfolio_id, mode, symbol, qty, cost_basis_quote, stop_price, updated_at)
    VALUES (
      v_pf, v_mode, v_pos ->> 'symbol', v_qty, v_cost,
      NULLIF(v_pos ->> 'stopPrice', '')::numeric, now()
    )
    ON CONFLICT (portfolio_id, mode, symbol) DO UPDATE SET
      qty              = ledger_positions.qty + v_qty,
      cost_basis_quote = GREATEST(0, ledger_positions.cost_basis_quote + v_cost),
      stop_price       = COALESCE(NULLIF(v_pos ->> 'stopPrice', '')::numeric, ledger_positions.stop_price),
      closed_at        = CASE WHEN ledger_positions.qty + v_qty <= 0 THEN now() ELSE NULL END,
      opened_at        = CASE WHEN ledger_positions.qty <= 0 AND v_qty > 0 THEN now() ELSE ledger_positions.opened_at END,
      updated_at       = now();
  END IF;

  -- Foglalás elszámolása (a beküldött BUY lefoglalt kerete a teljesüléssel fogy).
  v_res := p_deltas -> 'reservation';
  IF v_res IS NOT NULL AND v_res <> 'null'::jsonb THEN
    UPDATE budget_reservations
       SET consumed_quote = consumed_quote + (v_res ->> 'consumeQuote')::numeric,
           state = CASE
             WHEN consumed_quote + (v_res ->> 'consumeQuote')::numeric >= reserved_quote THEN 'consumed'
             ELSE state
           END
     WHERE intent_id = v_res ->> 'intentId';
  END IF;

  SELECT jsonb_build_object(
           'applied', true,
           'fillRowId', v_inserted,
           'cash', COALESCE((
             SELECT jsonb_object_agg(asset, amount::text)
               FROM ledger_cash WHERE portfolio_id = v_pf AND mode = v_mode
           ), '{}'::jsonb),
           'positions', COALESCE((
             SELECT jsonb_object_agg(symbol, jsonb_build_object('qty', qty::text, 'costBasisQuote', cost_basis_quote::text))
               FROM ledger_positions WHERE portfolio_id = v_pf AND mode = v_mode AND qty > 0
           ), '{}'::jsonb)
         )
    INTO v_result;
  RETURN v_result;
END;
$$;
--> statement-breakpoint

-- ── acquire_run_lease: egy író, monoton fencing tokennel ─────────────────────
-- Új tulajdonos csak akkor kap lease-t, ha nincs érvényes lease vagy az lejárt.
-- Az azonos tulajdonos MEGÚJÍTJA (token nem nő), így a saját heartbeat nem fence-eli ki magát.
CREATE OR REPLACE FUNCTION acquire_run_lease(p_key text, p_owner text, p_ttl_ms bigint)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row run_leases%ROWTYPE;
BEGIN
  INSERT INTO run_leases (lease_key, owner, fencing_token, acquired_at, expires_at)
  VALUES (p_key, p_owner, 1, now(), now() + make_interval(secs => p_ttl_ms / 1000.0))
  ON CONFLICT (lease_key) DO UPDATE SET
    owner = CASE
      WHEN run_leases.expires_at <= now() OR run_leases.owner = p_owner THEN p_owner
      ELSE run_leases.owner
    END,
    fencing_token = CASE
      WHEN run_leases.expires_at <= now() AND run_leases.owner <> p_owner THEN run_leases.fencing_token + 1
      ELSE run_leases.fencing_token
    END,
    acquired_at = CASE
      WHEN run_leases.expires_at <= now() OR run_leases.owner = p_owner THEN now()
      ELSE run_leases.acquired_at
    END,
    expires_at = CASE
      WHEN run_leases.expires_at <= now() OR run_leases.owner = p_owner
        THEN now() + make_interval(secs => p_ttl_ms / 1000.0)
      ELSE run_leases.expires_at
    END
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'acquired', v_row.owner = p_owner,
    'owner', v_row.owner,
    'fencingToken', v_row.fencing_token,
    'expiresAt', (extract(epoch FROM v_row.expires_at) * 1000)::bigint
  );
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION release_run_lease(p_key text, p_owner text)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH d AS (
    DELETE FROM run_leases WHERE lease_key = p_key AND owner = p_owner RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM d);
$$;
