CREATE TABLE "action_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "action_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"principal" text NOT NULL,
	"action" text NOT NULL,
	"target" text
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"rate_limit_per_hour" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_clients_name_unique" UNIQUE("name"),
	CONSTRAINT "api_clients_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"page_url" text,
	"finding_id" uuid,
	"kind" text NOT NULL,
	"blob_key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artifacts_kind" CHECK ("artifacts"."kind" in ('report_html','report_md','report_pdf','report_verified_md','report_verified_pdf','content_research_md','content_research_pdf','teaser_md','teaser_pdf','screenshot','evidence','gate_evidence','raw_archive'))
);
--> statement-breakpoint
CREATE TABLE "audit_attempts" (
	"audit_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"dispatch_nonce" text NOT NULL,
	"gh_run_id" bigint,
	"gh_run_attempt" integer,
	"session_hash" text,
	"registered_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"status" text NOT NULL,
	CONSTRAINT "audit_attempts_audit_id_attempt_pk" PRIMARY KEY("audit_id","attempt"),
	CONSTRAINT "audit_attempts_gh_run" UNIQUE("gh_run_id","gh_run_attempt")
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legacy_run_id" text,
	"site_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"target_url" text NOT NULL,
	"preset" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile" text NOT NULL,
	"profile_hash" text NOT NULL,
	"comparable_key" text NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"load_blocked" text,
	"pages_processed" integer,
	"pages_total" integer,
	"progress_at" timestamp with time zone,
	"current_attempt" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"created_by_client_id" uuid,
	"external_ref" text,
	"idempotency_key" text,
	"tool_version" text,
	"model_version" text,
	"renderer_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "audits_legacy_run_id_unique" UNIQUE("legacy_run_id"),
	CONSTRAINT "audits_client_idempotency" UNIQUE("created_by_client_id","idempotency_key"),
	CONSTRAINT "audits_mode" CHECK ("audits"."mode" in ('full','quick','page')),
	CONSTRAINT "audits_profile" CHECK ("audits"."profile" in ('public','standard')),
	CONSTRAINT "audits_status" CHECK ("audits"."status" in ('queued','dispatched','running','built','loading','succeeded','failed','cancelled','stalled')),
	CONSTRAINT "audits_source" CHECK ("audits"."source" in ('public','internal','api','pipeline'))
);
--> statement-breakpoint
CREATE TABLE "rate_events" (
	"bucket" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_aliases" (
	"host" text PRIMARY KEY NOT NULL,
	"site_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "site_aliases_reason" CHECK ("site_aliases"."reason" in ('redirect','www','manual'))
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"registrable_domain" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deletion_pending_at" timestamp with time zone,
	CONSTRAINT "sites_host_unique" UNIQUE("host")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_attempts" ADD CONSTRAINT "audit_attempts_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_created_by_client_id_api_clients_id_fk" FOREIGN KEY ("created_by_client_id") REFERENCES "api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_aliases" ADD CONSTRAINT "site_aliases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_audit" ON "artifacts" USING btree ("audit_id","kind");--> statement-breakpoint
CREATE INDEX "artifacts_expires" ON "artifacts" USING btree ("expires_at") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "audits_active" ON "audits" USING btree ("created_by_client_id","site_id","profile_hash") WHERE status in ('queued','dispatched','running','built','loading');--> statement-breakpoint
CREATE INDEX "audits_site_status" ON "audits" USING btree ("site_id","status","finished_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audits_site_comparable" ON "audits" USING btree ("site_id","comparable_key","finished_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audits_client_ref" ON "audits" USING btree ("created_by_client_id","external_ref");--> statement-breakpoint
CREATE INDEX "audits_queue" ON "audits" USING btree ("source","created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "rate_events_bucket" ON "rate_events" USING btree ("bucket","at");--> statement-breakpoint
CREATE INDEX "sites_registrable_domain" ON "sites" USING btree ("registrable_domain");