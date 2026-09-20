CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_status_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"entered_at" timestamp with time zone NOT NULL,
	"exited_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"reclassified_from" text
);
--> statement-breakpoint
CREATE TABLE "apikeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"permissions" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"child_id" uuid,
	"day" date NOT NULL,
	"effect" text NOT NULL,
	"extend_minutes" integer,
	"window_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_exceptions_child_day_window_unique" UNIQUE("child_id","day","window_id"),
	CONSTRAINT "calendar_exceptions_effect_check" CHECK ("calendar_exceptions"."effect" IN
    ('treat_as_weekend','no_bedtime','custom','dismiss_holiday')),
	CONSTRAINT "calendar_exceptions_minutes_check" CHECK ("calendar_exceptions"."effect" <> 'custom' OR "calendar_exceptions"."extend_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desired_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"unsupported_detail" text,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desired_items_kind_check" CHECK ("desired_items"."kind" IN ('credential','diagnostics','self_test','agent_version'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"policy_set_id" uuid,
	"label" text NOT NULL,
	"hardware_uuid" text,
	"hostname" text,
	"model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"api_key_id" uuid,
	"last_sync_at" timestamp with time zone,
	"last_tick_seq" integer,
	"last_boot_id" text,
	"system_boot_time" timestamp with time zone,
	"agent_version" text,
	"os_version" text,
	"arch" text,
	"applied_policy_version" integer,
	"health_state" text DEFAULT 'UNENROLLED' NOT NULL,
	"health_reason" text,
	"health_since" timestamp with time zone,
	"away_until" timestamp with time zone,
	"attended_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"child_id" uuid,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"payload" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_channel" text,
	CONSTRAINT "digests_household_child_period_unique" UNIQUE("household_id","child_id","period","period_start")
);
--> statement-breakpoint
CREATE TABLE "enforcement_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"window_id" uuid,
	"policy_version" integer,
	"summary" text NOT NULL,
	"detail" jsonb,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enforcement_log_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_hint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_ip" text,
	"consumed_hardware_uuid" text,
	"reissue_count" smallint DEFAULT 0 NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"v" smallint DEFAULT 1 NOT NULL,
	"class" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"boot_id" text NOT NULL,
	"seq" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "events_device_event_unique" UNIQUE("device_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "expected_online_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"policy_set_id" uuid NOT NULL,
	"days" text[] NOT NULL,
	"from_time" time NOT NULL,
	"until_time" time NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'parent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_household_user_unique" UNIQUE("household_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"holiday_countries" text[],
	"holidays_enabled" boolean DEFAULT true NOT NULL,
	"service_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"first_fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_channel" text,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_household_dedupe_unique" UNIQUE("household_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"device_id" uuid,
	"type" text DEFAULT 'extend' NOT NULL,
	"window_id" uuid,
	"minutes" integer,
	"effective_date" date NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_via" text DEFAULT 'ui' NOT NULL,
	"granted_by" uuid,
	"source_exception_id" uuid,
	"reason" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overrides_type_check" CHECK ("overrides"."type" IN ('extend','suspend','grant_minutes')),
	CONSTRAINT "overrides_granted_via_check" CHECK ("overrides"."granted_via" IN ('ui','calendar')),
	CONSTRAINT "overrides_minutes_check" CHECK ("overrides"."type" = 'suspend' OR "overrides"."minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "policy_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"name" text DEFAULT 'Default' NOT NULL,
	"kind" text DEFAULT 'windows' NOT NULL,
	"agent_log_level" text DEFAULT 'info' NOT NULL,
	"diagnostics_retention_days" integer DEFAULT 7 NOT NULL,
	"poll_base_interval_s" integer DEFAULT 60 NOT NULL,
	"poll_boundary_interval_s" integer DEFAULT 15 NOT NULL,
	"poll_boundary_lead_s" integer DEFAULT 900 NOT NULL,
	"override_enabled" boolean DEFAULT true NOT NULL,
	"override_allowed_minutes" smallint[] DEFAULT '{15,30,60}' NOT NULL,
	"override_max_minutes_per_day" integer DEFAULT 120 NOT NULL,
	"override_max_grants_per_day" integer DEFAULT 3 NOT NULL,
	"telemetry_enabled" boolean DEFAULT true NOT NULL,
	"telemetry_sample_interval_s" integer DEFAULT 60 NOT NULL,
	"telemetry_flush_interval_s" integer DEFAULT 300 NOT NULL,
	"telemetry_collect" text[] DEFAULT '{"session.state","enforcement.*","power.*","app.usage_sample"}' NOT NULL,
	"telemetry_max_queue_events" integer DEFAULT 50000 NOT NULL,
	"telemetry_max_queue_bytes" integer DEFAULT 33554432 NOT NULL,
	"telemetry_max_queue_age_days" integer DEFAULT 14 NOT NULL,
	"telemetry_audit_retention_days" integer DEFAULT 90 NOT NULL,
	"staleness_warn_after_s" integer DEFAULT 86400 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_sets_override_caps_check" CHECK (
    "policy_sets"."override_max_minutes_per_day" BETWEEN 0 AND 480
    AND "policy_sets"."override_max_grants_per_day" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"policy_set_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"document_hash" text NOT NULL,
	"jws" text,
	"signing_key_id" text,
	"etag" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"confirm_immediate_effect" boolean DEFAULT false NOT NULL,
	"published_by" uuid,
	"publish_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_versions_device_version_unique" UNIQUE("device_id","version")
);
--> statement-breakpoint
CREATE TABLE "projection_state" (
	"name" text PRIMARY KEY NOT NULL,
	"watermark_received_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_rows" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "schedule_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"policy_set_id" uuid NOT NULL,
	"days" text[] NOT NULL,
	"budget_minutes" integer NOT NULL,
	"meter" text DEFAULT 'active_s' NOT NULL,
	"reset_at" time DEFAULT '04:00' NOT NULL,
	"action" text DEFAULT 'lock' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_budgets_action_check" CHECK ("schedule_budgets"."action" IN ('warn_only','lock','shutdown')),
	CONSTRAINT "schedule_budgets_meter_check" CHECK ("schedule_budgets"."meter" IN ('active_s','foreground_s'))
);
--> statement-breakpoint
CREATE TABLE "schedule_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"lead_minutes" smallint NOT NULL,
	"channel" text DEFAULT 'modal' NOT NULL,
	CONSTRAINT "schedule_warnings_window_lead_unique" UNIQUE("window_id","lead_minutes"),
	CONSTRAINT "schedule_warnings_lead_check" CHECK ("schedule_warnings"."lead_minutes" BETWEEN 1 AND 240)
);
--> statement-breakpoint
CREATE TABLE "schedule_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"policy_set_id" uuid NOT NULL,
	"label" text NOT NULL,
	"days" text[] NOT NULL,
	"restricted_from" time NOT NULL,
	"restricted_until" time NOT NULL,
	"crosses_midnight" boolean GENERATED ALWAYS AS ("schedule_windows"."restricted_until" <= "schedule_windows"."restricted_from") STORED,
	"action" text DEFAULT 'lock' NOT NULL,
	"shutdown_grace_s" integer DEFAULT 300 NOT NULL,
	"escalate_after_failures" smallint DEFAULT 3 NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_windows_action_check" CHECK ("schedule_windows"."action" IN ('warn_only', 'lock', 'shutdown')),
	CONSTRAINT "schedule_windows_days_check" CHECK ("schedule_windows"."days" <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']::text[]
        AND array_length("schedule_windows"."days", 1) >= 1),
	CONSTRAINT "schedule_windows_distinct_bounds_check" CHECK ("schedule_windows"."restricted_from" <> "schedule_windows"."restricted_until"),
	CONSTRAINT "schedule_windows_grace_check" CHECK ("schedule_windows"."shutdown_grace_s" BETWEEN 60 AND 3600)
);
--> statement-breakpoint
CREATE TABLE "session_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"boot_id" text,
	"console_user" text,
	"end_inferred" boolean DEFAULT false NOT NULL,
	CONSTRAINT "session_spans_device_kind_started_unique" UNIQUE("device_id","kind","started_at")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tripwires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"detail" jsonb,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	CONSTRAINT "tripwires_device_kind_unique" UNIQUE("device_id","kind")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"local_day" date NOT NULL,
	"bundle_id" text NOT NULL,
	"foreground_s" integer DEFAULT 0 NOT NULL,
	"active_s" integer DEFAULT 0 NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_device_day_bundle_unique" UNIQUE("device_id","local_day","bundle_id")
);
--> statement-breakpoint
CREATE TABLE "usage_hourly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bundle_id" text NOT NULL,
	"foreground_s" integer DEFAULT 0 NOT NULL,
	"active_s" integer DEFAULT 0 NOT NULL,
	"cpu_pct_avg" integer DEFAULT 0 NOT NULL,
	"sample_count" smallint DEFAULT 0 NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_hourly_device_bucket_bundle_unique" UNIQUE("device_id","bucket_start","bundle_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"color" text DEFAULT '#6b7280' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"is_service" boolean DEFAULT false NOT NULL,
	"holiday_countries" text[],
	"receives_daily_digest" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_status_intervals" ADD CONSTRAINT "agent_status_intervals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_status_intervals" ADD CONSTRAINT "agent_status_intervals_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikeys" ADD CONSTRAINT "apikeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_window_id_schedule_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."schedule_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_exceptions" ADD CONSTRAINT "calendar_exceptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "children" ADD CONSTRAINT "children_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desired_items" ADD CONSTRAINT "desired_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desired_items" ADD CONSTRAINT "desired_items_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_api_key_id_apikeys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_log" ADD CONSTRAINT "enforcement_log_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_log" ADD CONSTRAINT "enforcement_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_log" ADD CONSTRAINT "enforcement_log_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enforcement_log" ADD CONSTRAINT "enforcement_log_window_id_schedule_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."schedule_windows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expected_online_windows" ADD CONSTRAINT "expected_online_windows_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expected_online_windows" ADD CONSTRAINT "expected_online_windows_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_service_user_id_users_id_fk" FOREIGN KEY ("service_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_window_id_schedule_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."schedule_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_source_exception_id_calendar_exceptions_id_fk" FOREIGN KEY ("source_exception_id") REFERENCES "public"."calendar_exceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_sets" ADD CONSTRAINT "policy_sets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_sets" ADD CONSTRAINT "policy_sets_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_budgets" ADD CONSTRAINT "schedule_budgets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_budgets" ADD CONSTRAINT "schedule_budgets_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_warnings" ADD CONSTRAINT "schedule_warnings_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_warnings" ADD CONSTRAINT "schedule_warnings_window_id_schedule_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."schedule_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_windows" ADD CONSTRAINT "schedule_windows_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_windows" ADD CONSTRAINT "schedule_windows_policy_set_id_policy_sets_id_fk" FOREIGN KEY ("policy_set_id") REFERENCES "public"."policy_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_spans" ADD CONSTRAINT "session_spans_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_spans" ADD CONSTRAINT "session_spans_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_spans" ADD CONSTRAINT "session_spans_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tripwires" ADD CONSTRAINT "tripwires_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tripwires" ADD CONSTRAINT "tripwires_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tripwires" ADD CONSTRAINT "tripwires_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_hourly" ADD CONSTRAINT "usage_hourly_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_hourly" ADD CONSTRAINT "usage_hourly_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_hourly" ADD CONSTRAINT "usage_hourly_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_status_intervals_device_entered_at_idx" ON "agent_status_intervals" USING btree ("device_id","entered_at");--> statement-breakpoint
CREATE INDEX "calendar_exceptions_household_day_idx" ON "calendar_exceptions" USING btree ("household_id","day");--> statement-breakpoint
CREATE INDEX "children_household_id_idx" ON "children" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "desired_items_device_status_idx" ON "desired_items" USING btree ("device_id","status");--> statement-breakpoint
CREATE INDEX "devices_household_id_idx" ON "devices" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "devices_child_id_idx" ON "devices" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "devices_hardware_uuid_idx" ON "devices" USING btree ("hardware_uuid");--> statement-breakpoint
CREATE INDEX "enforcement_log_child_occurred_at_idx" ON "enforcement_log" USING btree ("child_id","occurred_at");--> statement-breakpoint
CREATE INDEX "enforcement_log_device_kind_idx" ON "enforcement_log" USING btree ("device_id","kind");--> statement-breakpoint
CREATE INDEX "enrollments_device_id_idx" ON "enrollments" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "events_device_ts_idx" ON "events" USING btree ("device_id","ts");--> statement-breakpoint
CREATE INDEX "events_received_at_brin_idx" ON "events" USING brin ("received_at");--> statement-breakpoint
CREATE INDEX "expected_online_windows_policy_set_id_idx" ON "expected_online_windows" USING btree ("policy_set_id");--> statement-breakpoint
CREATE INDEX "household_members_household_id_idx" ON "household_members" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "notifications_household_last_fired_idx" ON "notifications" USING btree ("household_id","last_fired_at");--> statement-breakpoint
CREATE INDEX "overrides_child_effective_date_idx" ON "overrides" USING btree ("child_id","effective_date");--> statement-breakpoint
CREATE INDEX "overrides_expires_at_idx" ON "overrides" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "policy_sets_child_id_idx" ON "policy_sets" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "policy_versions_device_created_at_idx" ON "policy_versions" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_versions_etag_idx" ON "policy_versions" USING btree ("etag");--> statement-breakpoint
CREATE INDEX "schedule_budgets_policy_set_id_idx" ON "schedule_budgets" USING btree ("policy_set_id");--> statement-breakpoint
CREATE INDEX "schedule_warnings_window_id_idx" ON "schedule_warnings" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "schedule_windows_policy_set_id_idx" ON "schedule_windows" USING btree ("policy_set_id");--> statement-breakpoint
CREATE INDEX "session_spans_device_started_at_idx" ON "session_spans" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE INDEX "tripwires_household_last_seen_idx" ON "tripwires" USING btree ("household_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "usage_daily_child_day_idx" ON "usage_daily" USING btree ("child_id","local_day");--> statement-breakpoint
CREATE INDEX "usage_hourly_child_bucket_idx" ON "usage_hourly" USING btree ("child_id","bucket_start");