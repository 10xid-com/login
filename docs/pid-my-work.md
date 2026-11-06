# PiD My Work

Shared, read-only Work Deck page on the Login host.

- `/auth/pid/my-work` lists the signed-in person's decks; `/auth/pid/my-work/<deck uuid>` opens one.
- Reached from the shared `public/uid-tools/members.js` ("My Work" link). `/api/uid/assets` writes the Login origin into the script; if it is missing the link is hidden.
- Authority: Login session past the authenticator, then `userByAuthUserId` (that one portal account). Linked sign-ins or sibling accounts are never merged.
- Bridge (`lib/pid/my-work.ts`, server-only): `GET <origin>/internal/pid-my-work` and `/<deck>`, plus `/<deck>/cards/<card>/content[/files/<file>][?preview=1]`. Bearer `CID_WORK_DECKS_SECRET`, `x-10xid-account` = the session actor, no redirects, 10 s timeout, no-store.
- Origin: `CONTROL_ROOM_ORIGIN` if set, else `https://$CLOTHING_UI_HOST` (default `uid-bypaolo.10xid.com`); must be plain https on `*.10xid.com`.
- Unauthorized and missing decks both show "not found"; an upstream failure shows an error, never an empty list.
- Detail response is `{deck, events}`; `deck` has no inline cards. The page shows the deck's current stage (or `?stage=1..9`) and fetches only that stage's card content on demand. Stages, in order: Enquiry, Pricing, Quote approval, Design, Client proof, File setup, Production, Fulfilment, Complete. Default card id = 1-based stage position (ASSUMPTION, unverified); an inline `deck.cards[]` entry titled like the stage wins if upstream adds one.
- Card content shape is tolerant: `notes`/`blocks`/`content` (strings or `{text|body|note|content}`) and `files`/`attachments` (`{id uuid, name}`), rendered as plain text. `events` are shown as plain text (`summary|message|note|text`, else `from to`), time from `at|createdAt`; actor ids are dropped.
- Other assumed shapes (unverified): `decks` as array or id-keyed object, `order` as ids.
- PiD home (`/auth/pid`) links to My Work in the section nav and the Work section.
