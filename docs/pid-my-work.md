# PiD My Work

Shared, read-only Work Deck page on the Login host.

- `/auth/pid/my-work` lists the signed-in person's decks; `/auth/pid/my-work/<deck uuid>` opens one.
- Reached from the shared `public/uid-tools/members.js` ("My Work" link). `/api/uid/assets` writes the Login origin into the script; if it is missing the link is hidden.
- Authority: Login session past the authenticator, then `userByAuthUserId` (that one portal account). Linked sign-ins or sibling accounts are never merged.
- Bridge (`lib/pid/my-work.ts`, server-only): `GET <origin>/internal/pid-my-work` and `/<deck>`, plus `/<deck>/cards/<card>/content[/files/<file>][?preview=1]`. Bearer `CID_WORK_DECKS_SECRET`, `x-10xid-account` = the session actor, no redirects, 10 s timeout, no-store.
- Origin: `CONTROL_ROOM_ORIGIN` if set, else `https://$CLOTHING_UI_HOST` (default `uid-bypaolo.10xid.com`); must be plain https on `*.10xid.com`.
- Unauthorized and missing decks both show "not found"; an upstream failure shows an error, never an empty list.
- Assumed shapes (unverified against the live Control Room): `decks` as array or id-keyed object, `order` as ids, optional `cards[{id,title,files[{id,name}]}]` on a deck. Owner/participants are reduced to names.
