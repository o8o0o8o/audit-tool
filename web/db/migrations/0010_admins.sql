CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "created_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audits_admin" ON "audits" USING btree ("created_by_admin_id","created_at") WHERE created_by_admin_id is not null;