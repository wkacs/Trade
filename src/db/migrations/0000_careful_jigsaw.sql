CREATE TABLE IF NOT EXISTS "backtests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy" varchar(64) NOT NULL,
	"start_ts" timestamp with time zone NOT NULL,
	"end_ts" timestamp with time zone NOT NULL,
	"result_pnl_pct" real NOT NULL,
	"trades_count" integer NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"tick_id" varchar(16) NOT NULL,
	"action" varchar(4) NOT NULL,
	"symbol" varchar(16),
	"amount_pct" real,
	"confidence" real NOT NULL,
	"reasoning" text NOT NULL,
	"model" varchar(32) NOT NULL,
	"overridden" boolean DEFAULT false NOT NULL,
	"override_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ml_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"direction_1h" varchar(8) NOT NULL,
	"confidence" real NOT NULL,
	"volatility_pct" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"initial_capital_usd" real NOT NULL,
	"cash_usd" real NOT NULL,
	"mode" varchar(8) DEFAULT 'paper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"qty" real NOT NULL,
	"entry_price" real NOT NULL,
	"stop_price" real NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(32) NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"original_action" varchar(4) NOT NULL,
	"original_amount_pct" real NOT NULL,
	"final_action" varchar(4) NOT NULL,
	"final_amount_pct" real NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid,
	"symbol" varchar(16) NOT NULL,
	"side" varchar(4) NOT NULL,
	"amount_usd" real NOT NULL,
	"price" real NOT NULL,
	"qty" real NOT NULL,
	"fee_usd" real NOT NULL,
	"mode" varchar(8) NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "risk_overrides" ADD CONSTRAINT "risk_overrides_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
