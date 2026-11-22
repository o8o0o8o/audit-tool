CREATE INDEX "artifacts_finding" ON "artifacts" USING btree ("finding_id") WHERE finding_id is not null;--> statement-breakpoint
CREATE INDEX "audits_created" ON "audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "disclosures_first_audit" ON "disclosures" USING btree ("first_audit_id") WHERE first_audit_id is not null;--> statement-breakpoint
CREATE INDEX "disclosures_last_seen_audit" ON "disclosures" USING btree ("last_seen_audit_id") WHERE last_seen_audit_id is not null;--> statement-breakpoint
CREATE INDEX "jobs_audit" ON "jobs" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_audit" ON "webhook_deliveries" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_client" ON "webhook_deliveries" USING btree ("client_id");