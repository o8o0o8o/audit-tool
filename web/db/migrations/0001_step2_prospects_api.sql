CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"audit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requested_by" uuid[] DEFAULT '{}' NOT NULL,
	"status" text NOT NULL,
	"dispatch_nonce" text,
	"gh_run_id" bigint,
	"gh_run_attempt" integer,
	"session_hash" text,
	"heartbeat_at" timestamp with time zone,
	"tries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_type" CHECK ("jobs"."type" in ('render-pdf')),
	CONSTRAINT "jobs_status" CHECK ("jobs"."status" in ('queued','dispatched','running','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company" text NOT NULL,
	"website" text,
	"registrable_domains" text[] NOT NULL,
	"fit_score" integer,
	"stage" text NOT NULL,
	"stage_at" timestamp with time zone DEFAULT now() NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"has_audit" text,
	"owner" text,
	"notes" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "prospects_has_audit" CHECK ("prospects"."has_audit" in ('yes','failed'))
);
--> statement-breakpoint
CREATE TABLE "suppressed_domains" (
	"registrable_domain" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressed_domains_reason" CHECK ("suppressed_domains"."reason" in ('owner_request','legal'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"event" text NOT NULL,
	"kind" text,
	"external_ref" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status_code" integer,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "api_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active" ON "jobs" USING btree ("type","audit_id","kind") WHERE status in ('queued','dispatched','running');--> statement-breakpoint
CREATE INDEX "prospects_domains" ON "prospects" USING gin ("registrable_domains");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_website" ON "prospects" USING btree ("website");--> statement-breakpoint
CREATE INDEX "webhook_due" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE delivered_at is null;