CREATE TABLE "conversation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text,
	"actor_type" text DEFAULT 'admin' NOT NULL,
	"from_state" text,
	"to_state" text,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_state" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_to" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_reason" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "human_summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_state_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_events_conversation_id_idx" ON "conversation_events" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_ai_state_idx" ON "conversations" USING btree ("ai_state");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ai_state_check" CHECK ("conversations"."ai_state" in ('bot', 'human', 'paused'));
--> statement-breakpoint
UPDATE "conversations" SET "ai_state" = 'human' WHERE "state"->>'stage' = 'needs_human';