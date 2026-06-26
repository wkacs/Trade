import {
  pgTable, text, timestamp, real, integer, boolean, uuid, jsonb, varchar,
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
