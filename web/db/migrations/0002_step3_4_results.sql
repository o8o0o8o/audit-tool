CREATE TABLE "audit_documents" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"model_version" text NOT NULL,
	"document" jsonb NOT NULL,
	"bytes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_type_aliases" (
	"old_code" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_types" (
	"code" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"family" text,
	"category" text,
	"tier" text,
	"default_severity" text,
	"description" text,
	"fix" text,
	"lead_fact_type" text,
	"derived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disclosures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"code" text NOT NULL,
	"target" text NOT NULL,
	"first_audit_id" uuid,
	"last_seen_audit_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"owner" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "disclosures_site_code_target" UNIQUE("site_id","code","target"),
	CONSTRAINT "disclosures_status" CHECK ("disclosures"."status" in ('open','sent','resolved','dropped'))
);
--> statement-breakpoint
CREATE TABLE "field_metrics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "field_metrics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"audit_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"url" text,
	"form_factor" text NOT NULL,
	"lcp_p75" integer,
	"cls_p75" real,
	"inp_p75" integer,
	"ttfb_p75" integer,
	"fcp_p75" integer,
	CONSTRAINT "field_metrics_scope" CHECK ("field_metrics"."scope" in ('origin','url'))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"audit_id" uuid NOT NULL,
	"code" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"scope" text NOT NULL,
	"occurrences" integer NOT NULL,
	"pages_total" integer,
	CONSTRAINT "findings_severity" CHECK ("findings"."severity" in ('critical','high','medium','low')),
	CONSTRAINT "findings_scope" CHECK ("findings"."scope" in ('page','site'))
);
--> statement-breakpoint
CREATE TABLE "lead_facts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lead_facts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"gate_run_id" bigint NOT NULL,
	"type" text NOT NULL,
	"root_cause" text NOT NULL,
	"weight" text NOT NULL,
	"fact" text NOT NULL,
	"url" text,
	"gate" text NOT NULL,
	"depends_on" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lead_facts_weight" CHECK ("lead_facts"."weight" in ('heavy','medium','light')),
	CONSTRAINT "lead_facts_gate" CHECK ("lead_facts"."gate" in ('pass','fail')),
	CONSTRAINT "lead_facts_depends_on" CHECK ("lead_facts"."depends_on" in ('pages','homepage','dns'))
);
--> statement-breakpoint
CREATE TABLE "lead_gate_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lead_gate_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"audit_id" uuid NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"teaser_ready" boolean NOT NULL,
	"candidates_dropped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous" jsonb,
	CONSTRAINT "lead_gate_runs_audit_run_at" UNIQUE("audit_id","run_at"),
	CONSTRAINT "lead_gate_runs_source" CHECK ("lead_gate_runs"."source" in ('workflow','pipeline'))
);
--> statement-breakpoint
CREATE TABLE "load_progress" (
	"audit_id" uuid NOT NULL,
	"chunk" text NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "load_progress_audit_id_chunk_pk" PRIMARY KEY("audit_id","chunk")
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"audit_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"title" text NOT NULL,
	"codes" text[] NOT NULL,
	"impact" text,
	"effort" text,
	"quick_win" boolean DEFAULT false NOT NULL,
	"fix" text,
	"pages_affected" integer,
	CONSTRAINT "recommendations_audit_id_rank_pk" PRIMARY KEY("audit_id","rank")
);
--> statement-breakpoint
CREATE TABLE "scan_quality" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"homepage_read" boolean NOT NULL,
	"pages_requested" integer NOT NULL,
	"pages_ok" integer NOT NULL,
	"pages_blocked" integer NOT NULL,
	"pages_failed" integer NOT NULL,
	"errors_by_type" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bot_protection" text,
	"sitemap_total" integer,
	"sitemap_crawled" integer,
	"probes_blocked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "scan_quality_state" CHECK ("scan_quality"."state" in ('ok','partial','blocked'))
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"audit_id" uuid NOT NULL,
	"category" text NOT NULL,
	"score" integer,
	"source" text,
	CONSTRAINT "scores_audit_id_category_pk" PRIMARY KEY("audit_id","category"),
	CONSTRAINT "scores_source" CHECK ("scores"."source" in ('lab','field','findings'))
);
--> statement-breakpoint
CREATE TABLE "site_checks" (
	"audit_id" uuid NOT NULL,
	"check_id" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"details" jsonb,
	CONSTRAINT "site_checks_audit_id_check_id_pk" PRIMARY KEY("audit_id","check_id")
);
--> statement-breakpoint
CREATE TABLE "site_profiles" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"multilang" boolean,
	"ai_crawler_rules" jsonb,
	"llms_txt" text,
	"schema_types" text[] DEFAULT '{}' NOT NULL,
	"http_version" text,
	"cdn" text,
	"security_headers" text[] DEFAULT '{}' NOT NULL,
	"has_contact_form" boolean,
	"form_providers" text[] DEFAULT '{}' NOT NULL,
	"ctas" jsonb,
	"booking_links" text[] DEFAULT '{}' NOT NULL,
	"homepage_screenshot_artifact_id" uuid,
	CONSTRAINT "site_profiles_llms_txt" CHECK ("site_profiles"."llms_txt" in ('valid','invalid','missing'))
);
--> statement-breakpoint
CREATE TABLE "technologies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "technologies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"audit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"version" text,
	"confidence" text,
	"eol_date" date,
	"evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE "tracking_ids" (
	"audit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"pages_seen" integer,
	"sends_hits" boolean,
	CONSTRAINT "tracking_ids_audit_id_kind_value_pk" PRIMARY KEY("audit_id","kind","value"),
	CONSTRAINT "tracking_ids_kind" CHECK ("tracking_ids"."kind" in ('ga4','gtm','meta_pixel','ua','ads','other'))
);
--> statement-breakpoint
ALTER TABLE "audit_documents" ADD CONSTRAINT "audit_documents_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_type_aliases" ADD CONSTRAINT "check_type_aliases_code_check_types_code_fk" FOREIGN KEY ("code") REFERENCES "check_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_first_audit_id_audits_id_fk" FOREIGN KEY ("first_audit_id") REFERENCES "audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_last_seen_audit_id_audits_id_fk" FOREIGN KEY ("last_seen_audit_id") REFERENCES "audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_metrics" ADD CONSTRAINT "field_metrics_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_code_check_types_code_fk" FOREIGN KEY ("code") REFERENCES "check_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_gate_run_id_lead_gate_runs_id_fk" FOREIGN KEY ("gate_run_id") REFERENCES "lead_gate_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_gate_runs" ADD CONSTRAINT "lead_gate_runs_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_progress" ADD CONSTRAINT "load_progress_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_quality" ADD CONSTRAINT "scan_quality_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_checks" ADD CONSTRAINT "site_checks_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_profiles" ADD CONSTRAINT "site_profiles_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_profiles" ADD CONSTRAINT "site_profiles_homepage_screenshot_artifact_id_artifacts_id_fk" FOREIGN KEY ("homepage_screenshot_artifact_id") REFERENCES "artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technologies" ADD CONSTRAINT "technologies_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_ids" ADD CONSTRAINT "tracking_ids_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disclosures_open" ON "disclosures" USING btree ("site_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "field_metrics_audit" ON "field_metrics" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "findings_code" ON "findings" USING btree ("code","audit_id");--> statement-breakpoint
CREATE INDEX "findings_severity_idx" ON "findings" USING btree ("audit_id","severity");--> statement-breakpoint
CREATE INDEX "lead_facts_run" ON "lead_facts" USING btree ("gate_run_id");--> statement-breakpoint
CREATE INDEX "technologies_audit" ON "technologies" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "technologies_version" ON "technologies" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "technologies_kind" ON "technologies" USING btree ("kind","name");--> statement-breakpoint
CREATE INDEX "tracking_ids_value" ON "tracking_ids" USING btree ("kind","value");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE set null ON UPDATE no action;