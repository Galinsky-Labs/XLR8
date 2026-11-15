# 0001 Start engine-independent units before R12 (provisional, owner-deferred)

Date: 2026-11-15. Status: **provisional owner-deferred decision**, made by an assistant session under the owner's delegated work brief while the owner was unavailable. It is not acceptance evidence.

The approved plan gates C01 on Browser-VR-Engine R12 ("complete engine before XLR8"). The brief keeps that hard gate for every conference feature that needs the engine, but allows units with no engine dependency to start: the application bootstrap with an explicit "engine unavailable" state, identities, events and registration on Postgres.

## What this permits

- C01 **bootstrap only**: workspace, shell, routes, API boundary, test harness, ledger, explicit engine-unavailable state. C01 acceptance ("builds against a pinned engine contract") **cannot be met** because no engine contract release exists; `docs/engine-dependency.json` records `status: unreleased`. C01 stays incomplete.
- C02 with local accounts, organizations, guest invitation identities and sessions. The scoped **engine grant exchange** depends on BVR-F08 and is not implemented; a hosted identity provider is optional and not configured.
- C03 and C04 in full (they have no engine dependency), except links to engine world templates are stored as plain identifiers.

## What stays gated on R12

C05 onward (roles mapped to engine capabilities, lobby/venue/rooms, media, presentation, moderation in-world, rehearsal and release), and all credit/subscription units that sell engine features.
