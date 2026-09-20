ALTER TABLE "devices" ADD COLUMN "previous_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "previous_api_key_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_previous_api_key_id_apikeys_id_fk" FOREIGN KEY ("previous_api_key_id") REFERENCES "public"."apikeys"("id") ON DELETE set null ON UPDATE no action;