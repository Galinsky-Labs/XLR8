# XLR8 handoff

Updated 2026-11-15.

| Unit | State | Notes |
| --- | --- | --- |
| C01 | implementing (bootstrap merged) | Shell, routes, API boundary, tests, explicit engine-unavailable state. Blocked: no published engine contract (BVR-R12) to pin. |
| C02 | implementing | Accounts (scrypt), sessions (hashed tokens, expiry, logout, logout-all), organizations/memberships, guest identities via invitations. Not done: engine grant exchange (needs BVR-F08), hosted IdP adapter, account recovery (needs email delivery, C22). |
| C03 | implemented | Events/sessions, draft/published/cancelled, IANA time zones, optimistic versions, organizer-only mutations, private-event non-disclosure. |
| C04 | implemented | Idempotent registration, row-locked capacity with waitlist promotion, revocable/expiring/max-use invitations with optional email binding, check-in. Not done: abuse throttling beyond in-memory per-IP limits. |
| C05+ | planned, gated on BVR-R12 (and N13 etc.) | Do not start conference features that need the engine. |

Decision record: [0001](docs/decisions/0001-start-engine-independent-units.md) (provisional, owner-deferred). Tests run against a real PostgreSQL (`TEST_DATABASE_URL`); CI uses a `postgres:17` service.

Deployment: Render free web service `xlr8` + Neon project `xlr8` (see README). Migrations run at start (`npm start`).
