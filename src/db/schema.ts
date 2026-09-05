import {
  pgTable, text, timestamp, real, integer, boolean, uuid, jsonb, varchar,
  numeric, bigint, date, uniqueIndex, index,
} from "drizzle-orm/pg-core";

/** Gyűjtők nyers adatai — idősorozat. Lásd spec §5. */
export const rawEvents = pgTable("raw_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: varchar("source", { length: 32 }).notNull(), // coingecko|cryptopanic|whalealert|rss
  symbol: varchar("symbol", { length: 16 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull(), // price|news|whale|rss
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(), // a DataPoint tartalma
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** ML jelek időpontonként, coinonként. */
export const mlSignals = pgTable("ml_signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  direction1h: varchar("direction_1h", { length: 8 }).notNull(),
  confidence: real("confidence").notNull(),
  volatilityPct: real("volatility_pct").notNull(),
});

/** Portfólió: egyetlen sor (személyes használat). */
export const portfolios = pgTable("portfolios", {
  id: uuid("id").primaryKey().defaultRandom(),
  initialCapitalUsd: real("initial_capital_usd").notNull(),
  cashUsd: real("cash_usd").notNull(),
  mode: varchar("mode", { length: 8 }).notNull().default("paper"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Nyitott pozíciók. */
export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  qty: real("qty").notNull(),
  entryPrice: real("entry_price").notNull(),
  stopPrice: real("stop_price").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

/** Végrehajtott tranzakciók (több egy pozícióhoz). */
export const trades = pgTable("trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: uuid("position_id").references(() => positions.id),
  symbol: varchar("symbol", { length: 16 }).notNull(),
  side: varchar("side", { length: 4 }).notNull(), // BUY|SELL
  amountUsd: real("amount_usd").notNull(),
  price: real("price").notNull(),
  qty: real("qty").notNull(),
  feeUsd: real("fee_usd").notNull(),
  mode: varchar("mode", { length: 8 }).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }).defaultNow().notNull(),
  origin: varchar("origin", { length: 12 }), // dca|stop-loss|take-profit|ai|manual (nullable: régi sorok)
});

/** Tickenkénti teljes folyamat-napló (átláthatóság): inputok + lánc + akciók. */
export const tickRuns = pgTable("tick_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  tickId: varchar("tick_id", { length: 16 }).notNull(), // YYYY-MM-DD-HH
  process: jsonb("process").notNull(), // TickProcess (lásd src/lib/engine/tick-process.ts)
});

/** AI döntések + érvelés (a rendszer szíve). */
export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  tickId: varchar("tick_id", { length: 16 }).notNull(), // YYYY-MM-DD-HH
  action: varchar("action", { length: 4 }).notNull(), // BUY|SELL|HOLD
  symbol: varchar("symbol", { length: 16 }),
  amountPct: real("amount_pct"),
  confidence: real("confidence").notNull(),
  reasoning: text("reasoning").notNull(),
  model: varchar("model", { length: 32 }).notNull(),
  overridden: boolean("overridden").notNull().default(false),
  overrideReason: text("override_reason"),
  /** Döntéskori pillanatkép a kiértékeléshez: { prices, intent (rawAction), intentSymbol, intentAmountPct }. */
  ref: jsonb("ref"),
  /** ~1h múlva kitöltött kiértékelés: { horizonHours, changePct, hypotheticalPnlPct, wouldProfit, ... }. */
  outcome: jsonb("outcome"),
});

/** Amikor a Risk Manager módosított/elutasított egy döntést. */
export const riskOverrides = pgTable("risk_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionId: uuid("decision_id").references(() => decisions.id),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  originalAction: varchar("original_action", { length: 4 }).notNull(),
  originalAmountPct: real("original_amount_pct").notNull(),
  finalAction: varchar("final_action", { length: 4 }).notNull(),
  finalAmountPct: real("final_amount_pct").notNull(),
  reason: text("reason").notNull(),
});

/** Backtest futtatások. */
export const backtests = pgTable("backtests", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategy: varchar("strategy", { length: 64 }).notNull(),
  startTs: timestamp("start_ts", { withTimezone: true }).notNull(),
  endTs: timestamp("end_ts", { withTimezone: true }).notNull(),
  resultPnlPct: real("result_pnl_pct").notNull(),
  tradesCount: integer("trades_count").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Globális settings (mode, limitlek, coin kosár). */
export const settings = pgTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// V2 LEDGER (T03) — BŐVÍTŐ séma. A fenti v1 táblák (portfolios/positions/trades)
// VÁLTOZATLANOK maradnak: a régi olvasók (dashboard, analytics) tovább működnek, és
// a `real` oszlopok elveszett pontossága utólag amúgy sem állítható vissza.
//
// A v2 minden pénzügyi értéke `numeric` → a driver SZÖVEGKÉNT adja vissza, ez egyezik
// a money.ts `Dec` típusával. Nincs lebegőpontos konverzió a DB és a könyvelés között.
//
// Hatókör-határ: MINDEN v2 sor hordozza a (portfolio_id, mode) párt, és ahol értelmes,
// a strategy_version-t. Paper és live számla így soha nem oszt könyvelési sort.
// ─────────────────────────────────────────────────────────────────────────────

/** Egy végrehajtási szándék (ExecutionIntent). Az intent_id egyedi → nincs dupla megbízás. */
export const executionIntents = pgTable(
  "execution_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: text("intent_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    strategyVersion: text("strategy_version").notNull(),
    origin: varchar("origin", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    side: varchar("side", { length: 4 }).notNull(),
    /** BUY: legfeljebb ennyi quote-ot költünk. SELL-nél NULL. */
    maxQuoteSpend: numeric("max_quote_spend"),
    /** SELL: ennyi base-t adunk el. BUY-nál NULL. */
    baseQty: numeric("base_qty"),
    referencePrice: numeric("reference_price").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** pending|partially_filled|filled|canceled|rejected|expired|unknown */
    state: varchar("state", { length: 20 }).notNull().default("pending"),
    clientOrderId: text("client_order_id").notNull(),
    exchangeOrderId: text("exchange_order_id"),
    /** Strukturált hiba (code+message), ha az order elutasításra került. */
    lastError: jsonb("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    intentIdUnique: uniqueIndex("execution_intents_intent_id_key").on(t.intentId),
    clientOrderIdUnique: uniqueIndex("execution_intents_client_order_id_key").on(t.clientOrderId),
    scopeStateIdx: index("execution_intents_scope_state_idx").on(t.portfolioId, t.mode, t.state),
  }),
);

/** Egy TÉNYLEGES teljesülés. A fill_key (mode:orderId:tradeId) egyedi → egyszeri könyvelés. */
export const executionFills = pgTable(
  "execution_fills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fillKey: text("fill_key").notNull(),
    intentId: text("intent_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    side: varchar("side", { length: 4 }).notNull(),
    exchangeOrderId: text("exchange_order_id").notNull(),
    exchangeTradeId: text("exchange_trade_id").notNull(),
    filledBaseQty: numeric("filled_base_qty").notNull(),
    grossQuoteAmount: numeric("gross_quote_amount").notNull(),
    fillPrice: numeric("fill_price").notNull(),
    /** A díj a SAJÁT eszközében — nem USD-re átszámítva (kétszeres levonás ellen). */
    feeAmount: numeric("fee_amount").notNull(),
    feeAsset: varchar("fee_asset", { length: 16 }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    /** legacy-unverified: a T11 importból származó, bizonyíthatatlan régi sor. */
    provenance: varchar("provenance", { length: 20 }).notNull().default("live-v2"),
  },
  (t) => ({
    fillKeyUnique: uniqueIndex("execution_fills_fill_key_key").on(t.fillKey),
    scopeTimeIdx: index("execution_fills_scope_time_idx").on(t.portfolioId, t.mode, t.executedAt),
    originIdx: index("execution_fills_intent_idx").on(t.intentId),
  }),
);

/** Eszközönkénti egyenleg (quote USDT, de a harmadik eszközű díjhoz is kell sor). */
export const ledgerCash = pgTable(
  "ledger_cash",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    asset: varchar("asset", { length: 16 }).notNull(),
    amount: numeric("amount").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeAssetUnique: uniqueIndex("ledger_cash_scope_asset_key").on(t.portfolioId, t.mode, t.asset),
  }),
);

/** Nyitott/lezárt pozíció a v2 ledgerben, bekerülési értékkel (numeric). */
export const ledgerPositions = pgTable(
  "ledger_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    qty: numeric("qty").notNull().default("0"),
    /** A birtokolt mennyiség TELJES bekerülési értéke quote-ban (díjjal együtt). */
    costBasisQuote: numeric("cost_basis_quote").notNull().default("0"),
    stopPrice: numeric("stop_price"),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeSymbolUnique: uniqueIndex("ledger_positions_scope_symbol_key").on(t.portfolioId, t.mode, t.symbol),
  }),
);

/**
 * Keretfoglalás: a beküldött, még nem teljesült BUY lefoglalja a cash-t és a
 * 20%-os/heti keretet. Enélkül két párhuzamos BUY ugyanazt a keretet költené el.
 */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: text("intent_id").notNull(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    origin: varchar("origin", { length: 16 }).notNull(),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    reservedQuote: numeric("reserved_quote").notNull(),
    consumedQuote: numeric("consumed_quote").notNull().default("0"),
    /** active|released|consumed */
    state: varchar("state", { length: 12 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    intentUnique: uniqueIndex("budget_reservations_intent_key").on(t.intentId),
    scopeStateIdx: index("budget_reservations_scope_state_idx").on(t.portfolioId, t.mode, t.state),
  }),
);

/**
 * Napkezdő equity-referencia a VALÓDI napi veszteségkapuhoz (a régi kód az indulás óta
 * mért hozamot használta). A `source` megkülönbözteti a hiteles napnyitást a résznapos
 * indulástól és a hiányzó referenciától — utóbbinál nincs kitalált napi hozam.
 */
export const dailyEquity = pgTable(
  "daily_equity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    dayUtc: date("day_utc").notNull(),
    baselineEquity: numeric("baseline_equity").notNull(),
    /** A nap közbeni be- és kifizetések összege (a napi hozamot korrigálja). */
    cashFlowQuote: numeric("cash_flow_quote").notNull().default("0"),
    /** day-open | partial-day | missing */
    source: varchar("source", { length: 16 }).notNull(),
    /** Igaz, ha aznap már elérte a -3%-ot: a latch a nap végéig tiltja az új BUY-t. */
    lossLatched: boolean("loss_latched").notNull().default(false),
    latchedAt: timestamp("latched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeDayUnique: uniqueIndex("daily_equity_scope_day_key").on(t.portfolioId, t.mode, t.dayUtc),
  }),
);

/**
 * Futási lease + fencing token: egyszerre EGY írót engedünk. A régi „előbb SELECT,
 * később INSERT" órás dedup nem védett két egyidejű futótól.
 */
export const runLeases = pgTable("run_leases", {
  leaseKey: text("lease_key").primaryKey(),
  owner: text("owner").notNull(),
  /** Monoton növekvő token: a régi tulajdonos írásait el lehet utasítani. */
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(0),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Mérési epoch: a javított ledger új, verziózott nyitóállapottal indul. A régi
 * cash/positions/trades NEM törlődik — az epoch csak elválasztja a mérési szakaszokat.
 */
export const ledgerEpochs = pgTable(
  "ledger_epochs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: text("portfolio_id").notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    epochVersion: text("epoch_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    openingCashQuote: numeric("opening_cash_quote").notNull(),
    openingPositions: jsonb("opening_positions").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeVersionUnique: uniqueIndex("ledger_epochs_scope_version_key").on(
      t.portfolioId,
      t.mode,
      t.epochVersion,
    ),
  }),
);
