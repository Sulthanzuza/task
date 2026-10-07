CREATE TABLE "daily_snapshots" (
	"date" date NOT NULL,
	"team_id" uuid NOT NULL,
	"open" integer NOT NULL,
	"overdue" integer NOT NULL,
	"blocked" integer NOT NULL,
	"waiting_review" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_snapshots_date_team_id_pk" PRIMARY KEY("date","team_id")
);
--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD CONSTRAINT "daily_snapshots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_snapshots_team_idx" ON "daily_snapshots" USING btree ("team_id","date");