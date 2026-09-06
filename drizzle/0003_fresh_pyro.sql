ALTER TABLE "chat_sessions" ADD COLUMN "default_thinking_level" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "thinking_level" text DEFAULT 'medium' NOT NULL;