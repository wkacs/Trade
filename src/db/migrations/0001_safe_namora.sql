CREATE TABLE IF NOT EXISTS "tick_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"tick_id" varchar(16) NOT NULL,
	"process" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "ref" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "origin" varchar(12);