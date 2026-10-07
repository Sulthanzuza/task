-- Files attached before a description was asked for keep an empty one; the
-- default is dropped straight after so that every new row has to say what
-- the file is for.
ALTER TABLE "task_attachments" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_attachments" ALTER COLUMN "description" DROP DEFAULT;
