-- 0020 — WHICH SIGN-IN A SESSION WAS HANDED OVER FROM.
--
-- One browser holds a session on every host it has visited: the one it signed
-- in to on the login host, and one per destination the handoff took it to
-- (the portal host, a client domain). Until now nothing recorded that those
-- belong together, so ending "this device" from the portal ended the portal's
-- session and left the login host's — and the very next page handed the browser
-- straight back in, as though sign-out had not happened. The same left a
-- person's own login-host session counted among their "other devices".
--
-- The ticket already names the session that minted it (sso_tickets.
-- source_session_id); this carries it onto the session the ticket becomes. A
-- device is then a session signed in to directly together with every session
-- whose source it is. Tickets are only minted on the login host, from sessions
-- signed in to there, so the chain is never more than one step long.
--
-- Nullable, and left null on every existing row: a session created before this
-- simply stands as a device of its own, which is what it was treated as before.

ALTER TABLE "sessions" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_source_session_idx" ON "sessions" USING btree ("source_session_id");
