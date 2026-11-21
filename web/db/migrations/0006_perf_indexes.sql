CREATE INDEX "artifacts_audit_key" ON "artifacts" USING btree ("audit_id","blob_key");--> statement-breakpoint
CREATE INDEX "audit_attempts_session" ON "audit_attempts" USING btree ("session_hash") WHERE session_hash is not null;--> statement-breakpoint
CREATE INDEX "jobs_session" ON "jobs" USING btree ("session_hash") WHERE session_hash is not null;