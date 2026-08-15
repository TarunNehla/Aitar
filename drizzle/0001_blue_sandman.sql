ALTER TABLE "context_snapshots" ADD COLUMN "first_preserved_message_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "previous_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "model" text NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "reason" text NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "prompt_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "tokens_before" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "tokens_after" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD COLUMN "cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_first_preserved_message_id_messages_id_fk" FOREIGN KEY ("first_preserved_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_snapshots_session_idx" ON "context_snapshots" USING btree ("session_id","created_at");