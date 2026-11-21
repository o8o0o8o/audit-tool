CREATE TABLE "audit_run_data" (
	"audit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "audit_run_data_audit_id_name_pk" PRIMARY KEY("audit_id","name"),
	CONSTRAINT "audit_run_data_name" CHECK ("audit_run_data"."name" in ('manifest','metadata','analysis','incoming-links'))
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"audit_id" uuid NOT NULL,
	"chunk" integer NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"status_code" integer,
	"blocked" boolean DEFAULT false NOT NULL,
	"template" text,
	"segment" text,
	"title" text,
	"meta_description" text,
	"canonical" text,
	"h1" text[] DEFAULT '{}' NOT NULL,
	"lang" text,
	"indexable" boolean,
	"in_sitemap" boolean,
	"depth" integer,
	"word_count" integer,
	"schema_types" text[] DEFAULT '{}' NOT NULL,
	"ttfb_ms" integer,
	"lcp_ms" integer,
	"cls" real,
	"fcp_ms" integer,
	"inp_ms" integer,
	"tbt_ms" integer,
	"speed_index_ms" integer,
	"lcp_element" text,
	"bytes" bigint,
	"weight" jsonb,
	"requests" integer,
	"selection_reason" text,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_run_data" ADD CONSTRAINT "audit_run_data_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_audit_url" ON "pages" USING btree ("audit_id",md5("url"));--> statement-breakpoint
CREATE INDEX "pages_audit_chunk" ON "pages" USING btree ("audit_id","chunk");