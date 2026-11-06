-- Rename the existing relations in place. Their IDs, foreign keys, triggers and grants follow the tables.
ALTER TABLE public.people RENAME TO "PiD";
--> statement-breakpoint
ALTER TABLE public.organizations RENAME TO "CiD";
--> statement-breakpoint
ALTER TABLE public.memberships RENAME TO "role";
--> statement-breakpoint

-- Deployed services and older database functions still use these names.
-- Invoker views apply the caller's privileges on the renamed tables.
CREATE VIEW public.people WITH (security_invoker = true) AS SELECT * FROM public."PiD";
--> statement-breakpoint
CREATE VIEW public.organizations WITH (security_invoker = true) AS SELECT * FROM public."CiD";
--> statement-breakpoint
CREATE VIEW public.memberships WITH (security_invoker = true) AS SELECT * FROM public."role";
--> statement-breakpoint
REVOKE ALL ON public.people, public.organizations, public.memberships FROM PUBLIC, portal_app, portal_auth;
--> statement-breakpoint
GRANT INSERT (id) ON public.people TO portal_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations, public.memberships TO portal_app;
--> statement-breakpoint
COMMENT ON VIEW public.people IS 'Compatibility view for older apps. The table is PiD.';
--> statement-breakpoint
COMMENT ON VIEW public.organizations IS 'Compatibility view for older apps. The table is CiD.';
--> statement-breakpoint
COMMENT ON VIEW public.memberships IS 'Compatibility view for older apps. The table is role.';
