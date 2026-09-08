-- ─────────────────────────────────────────────────────────────────────────────
-- 0008 — a fill-könyvelés nem bukhat el a "javasolt sor" CHECK-jén
--
-- HIBA: az `apply_fill_v2_unfenced` az egyenleg- és pozíció-deltát
-- `INSERT ... ON CONFLICT DO UPDATE`-tel írta. A PostgreSQL a CHECK constraintet a
-- JAVASOLT beszúrandó soron is kiértékeli, MIELŐTT a konfliktust észlelné — így a
-- `ledger_cash_amount_non_negative` (amount >= 0) minden NEGATÍV cash-deltát elutasított,
-- akkor is, ha a meglévő sor egyenlege bőven fedezte. Ugyanez a
-- `ledger_positions_qty_non_negative` miatt minden ELADÁS-deltára.
--
-- Következmény: egyetlen BUY vagy SELL sem tudott elkönyvelődni (execution_fills és
-- trades üres maradt, a paper-egyenleg sosem mozdult) — a bot "döntött", de a
-- perzisztencia mindig `write_failed`-del halt el.
--
-- JAVÍTÁS: előbb egy NULLA soros `INSERT ... ON CONFLICT DO NOTHING` (a sor létezését
-- biztosítja), majd `UPDATE ... SET amount = amount + delta`. Az UPDATE-et a CHECK a
-- VÉGEREDMÉNYEN ellenőrzi, tehát a fedezet-védelem megmarad: valódi fedezethiánynál
-- továbbra is hibát dob, de a fedezett mozgás átmegy.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION apply_fill_v2_unfenced(p_fill jsonb, p_deltas jsonb)
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
  v_asset      text;
  v_delta      numeric;
  v_symbol     text;
  v_qty        numeric;
  v_cost       numeric;
  v_stop       numeric;
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

  -- Eszközönkénti egyenleg-deltak. Előbb a sor LÉTEZÉSE (nullával), utána a mozgás —
  -- így a CHECK a végeredményt nézi, nem a javasolt (nyers delta) sort.
  v_cash := COALESCE(p_deltas -> 'cash', '[]'::jsonb);
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_cash) LOOP
    v_asset := v_item ->> 'asset';
    v_delta := (v_item ->> 'delta')::numeric;

    INSERT INTO ledger_cash (portfolio_id, mode, asset, amount, updated_at)
    VALUES (v_pf, v_mode, v_asset, 0, now())
    ON CONFLICT (portfolio_id, mode, asset) DO NOTHING;

    UPDATE ledger_cash
       SET amount = amount + v_delta,
           updated_at = now()
     WHERE portfolio_id = v_pf AND mode = v_mode AND asset = v_asset;
  END LOOP;

  -- Pozíció-delta (mennyiség + bekerülési érték + opcionális stop), ugyanazzal a
  -- "előbb létezzen, utána mozogjon" mintával.
  v_pos := p_deltas -> 'position';
  IF v_pos IS NOT NULL AND v_pos <> 'null'::jsonb THEN
    v_symbol := v_pos ->> 'symbol';
    v_qty    := (v_pos ->> 'qtyDelta')::numeric;
    v_cost   := (v_pos ->> 'costDelta')::numeric;
    v_stop   := NULLIF(v_pos ->> 'stopPrice', '')::numeric;

    INSERT INTO ledger_positions (portfolio_id, mode, symbol, qty, cost_basis_quote, stop_price, updated_at)
    VALUES (v_pf, v_mode, v_symbol, 0, 0, NULL, now())
    ON CONFLICT (portfolio_id, mode, symbol) DO NOTHING;

    UPDATE ledger_positions
       SET qty              = qty + v_qty,
           cost_basis_quote = GREATEST(0, cost_basis_quote + v_cost),
           stop_price       = COALESCE(v_stop, stop_price),
           closed_at        = CASE WHEN qty + v_qty <= 0 THEN now() ELSE NULL END,
           opened_at        = CASE WHEN qty <= 0 AND v_qty > 0 THEN now() ELSE opened_at END,
           updated_at       = now()
     WHERE portfolio_id = v_pf AND mode = v_mode AND symbol = v_symbol;
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
