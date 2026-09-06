CREATE TABLE IF NOT EXISTS "market_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"funding_rate_pct" real,
	"open_interest_base" real,
	"open_interest_usd" real,
	"open_interest_change_1h_pct" real,
	"taker_buy_sell_ratio" real,
	"long_short_account_ratio" real,
	"premium_pct" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "market_context_ts_symbol_idx" ON "market_context" USING btree ("ts","symbol");