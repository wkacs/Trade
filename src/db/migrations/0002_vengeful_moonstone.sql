CREATE TABLE IF NOT EXISTS "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"origin" varchar(16) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"reserved_quote" numeric NOT NULL,
	"consumed_quote" numeric DEFAULT '0' NOT NULL,
	"state" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_equity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"day_utc" date NOT NULL,
	"baseline_equity" numeric NOT NULL,
	"cash_flow_quote" numeric DEFAULT '0' NOT NULL,
	"source" varchar(16) NOT NULL,
	"loss_latched" boolean DEFAULT false NOT NULL,
	"latched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fill_key" text NOT NULL,
	"intent_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"side" varchar(4) NOT NULL,
	"exchange_order_id" text NOT NULL,
	"exchange_trade_id" text NOT NULL,
	"filled_base_qty" numeric NOT NULL,
	"gross_quote_amount" numeric NOT NULL,
	"fill_price" numeric NOT NULL,
	"fee_amount" numeric NOT NULL,
	"fee_asset" varchar(16) NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provenance" varchar(20) DEFAULT 'live-v2' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"strategy_version" text NOT NULL,
	"origin" varchar(16) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"side" varchar(4) NOT NULL,
	"max_quote_spend" numeric,
	"base_qty" numeric,
	"reference_price" numeric NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"client_order_id" text NOT NULL,
	"exchange_order_id" text,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_cash" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"asset" varchar(16) NOT NULL,
	"amount" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_epochs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"epoch_version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"opening_cash_quote" numeric NOT NULL,
	"opening_positions" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" text NOT NULL,
	"mode" varchar(8) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"qty" numeric DEFAULT '0' NOT NULL,
	"cost_basis_quote" numeric DEFAULT '0' NOT NULL,
	"stop_price" numeric,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_leases" (
	"lease_key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_reservations_intent_key" ON "budget_reservations" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_reservations_scope_state_idx" ON "budget_reservations" USING btree ("portfolio_id","mode","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_equity_scope_day_key" ON "daily_equity" USING btree ("portfolio_id","mode","day_utc");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_fills_fill_key_key" ON "execution_fills" USING btree ("fill_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_fills_scope_time_idx" ON "execution_fills" USING btree ("portfolio_id","mode","executed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_fills_intent_idx" ON "execution_fills" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_intents_intent_id_key" ON "execution_intents" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_intents_client_order_id_key" ON "execution_intents" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_intents_scope_state_idx" ON "execution_intents" USING btree ("portfolio_id","mode","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_cash_scope_asset_key" ON "ledger_cash" USING btree ("portfolio_id","mode","asset");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_epochs_scope_version_key" ON "ledger_epochs" USING btree ("portfolio_id","mode","epoch_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_positions_scope_symbol_key" ON "ledger_positions" USING btree ("portfolio_id","mode","symbol");