# UiD inventory ownership

Personal inventories are the inventories owned by the signed-in person, including inventories they share with other people. Shared inventories are inventories owned by someone else that the person may access. A business Owner role does not establish collection ownership.

Paolo identified these existing collections as his:

| Collection | Source | Display for Paolo |
| --- | --- | --- |
| Paolo Nutrient System | General inventory | Personal |
| TBOX Studio | Clothing Inventory | Personal |

Migration 0058 records the collection owner's stable account UUID in `uid_inventory_owners`, separately from business ownership, stock ownership and tool access. It resolves Paolo through his existing verified account and requires his existing Owner memberships in both businesses. An existing different collection owner causes a refusal. New ownership records are audited.

This metadata grants no access. Existing memberships, inventory configuration and tool permissions continue to determine which inventories a person can open. The existing general inventory connection is available on Paolo's UiD; this change does not add a general inventory connection to the other templates.

The app role has scoped read access to ownership metadata and cannot insert, update or delete ownership rows. The overview returns only per-tool `inventoryOwnership` booleans for the current person, rather than other owners' account IDs. Recipients with an Owner-role membership still receive `false` when someone else owns the collection.

The chooser derives both sections from those server-provided booleans. Shared access does not move an inventory out of its owner's Personal section. Collection ownership does not follow a display-name change or an additional member's role.

Validation includes an isolated PostgreSQL migration, owner/recipient grouping, read isolation, denied ownership rewrites, preservation of memberships and grants, idempotent initial assignment, and refusal to replace an existing different owner. Desktop and 390 px phone previews exercise the grouping and existing inventory entry points.
