CREATE TABLE "checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
/*
 * checklist_items has existed since 0000 with no code path that ever wrote to
 * it: the feature had a table and nothing else. So it is empty, and adding a
 * NOT NULL column is safe. The DELETE is there because "it is empty" is a
 * belief about every deployment rather than a constraint, and a migration
 * that fails on that belief takes the release down. An item with no checklist
 * could not be shown anyway.
 */
ALTER TABLE "checklist_items" ADD COLUMN "checklist_id" uuid;--> statement-breakpoint
DELETE FROM "checklist_items" WHERE "checklist_id" IS NULL;--> statement-breakpoint
ALTER TABLE "checklist_items" ALTER COLUMN "checklist_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "progress_follows_checklist" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklists_task_idx" ON "checklists" USING btree ("task_id","position");--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_checklist_id_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_items_list_idx" ON "checklist_items" USING btree ("checklist_id","position");