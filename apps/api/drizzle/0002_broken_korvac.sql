CREATE TABLE "digest_log" (
	"user_id" uuid NOT NULL,
	"sent_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_log_user_id_sent_on_pk" PRIMARY KEY("user_id","sent_on")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_log" ADD CONSTRAINT "digest_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_pending_email_idx" ON "notifications" USING btree ("user_id","task_id") WHERE emailed_at IS NULL;