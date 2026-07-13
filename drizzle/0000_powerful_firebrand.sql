CREATE TABLE "burn_mode_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"correlation_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_state_cache" (
	"key_prefix" text NOT NULL,
	"cache_key" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_state_cache_key_prefix_cache_key_pk" PRIMARY KEY("key_prefix","cache_key")
);
--> statement-breakpoint
CREATE TABLE "chat_state_lists" (
	"key_prefix" text NOT NULL,
	"list_key" text NOT NULL,
	"seq" bigserial NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "chat_state_lists_key_prefix_list_key_seq_pk" PRIMARY KEY("key_prefix","list_key","seq")
);
--> statement-breakpoint
CREATE TABLE "chat_state_locks" (
	"key_prefix" text NOT NULL,
	"thread_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_state_locks_key_prefix_thread_id_pk" PRIMARY KEY("key_prefix","thread_id")
);
--> statement-breakpoint
CREATE TABLE "chat_state_queues" (
	"key_prefix" text NOT NULL,
	"thread_id" text NOT NULL,
	"seq" bigserial NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_state_queues_key_prefix_thread_id_seq_pk" PRIMARY KEY("key_prefix","thread_id","seq")
);
--> statement-breakpoint
CREATE TABLE "chat_state_subscriptions" (
	"key_prefix" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_state_subscriptions_key_prefix_thread_id_pk" PRIMARY KEY("key_prefix","thread_id")
);
--> statement-breakpoint
CREATE INDEX "burn_mode_events_type_time_idx" ON "burn_mode_events" USING btree ("environment","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "burn_mode_events_correlation_idx" ON "burn_mode_events" USING btree ("environment","correlation_key");--> statement-breakpoint
CREATE INDEX "chat_state_cache_expires_idx" ON "chat_state_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_state_lists_expires_idx" ON "chat_state_lists" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_state_locks_expires_idx" ON "chat_state_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_state_queues_expires_idx" ON "chat_state_queues" USING btree ("expires_at");