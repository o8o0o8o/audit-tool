ALTER TABLE "audits" ADD COLUMN "load_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "score_attempts" integer DEFAULT 0 NOT NULL;