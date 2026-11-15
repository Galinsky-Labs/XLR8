# XLR8

XLR8 is the conference application built on the reusable [Browser-VR-Engine](https://github.com/Galinsky-Labs/Browser-VR-Engine). The engine owns worlds, rendering, VR, physics, networking and media; XLR8 owns accounts, organizations, events, registration and conference roles.

**Current stage:** bootstrap (C01, partial) plus identity (C02, local accounts), events and sessions (C03) and registration/invitations (C04). The 3D venue is **unavailable** until the engine's R12 release; the app says so explicitly in its UI, `/api/status`, `/config.json` and `503 engine_unavailable` on room joins. See [the owner-deferred start decision](docs/decisions/0001-start-engine-independent-units.md).

## Run locally

Node 24 and PostgreSQL 14+.

```sh
npm ci
DATABASE_URL=postgres://user:pass@localhost:5432/xlr8 npm start   # migrates, then serves http://localhost:3000
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm test   # creates and drops a database per test file
```

Without `DATABASE_URL` the server still starts and reports the database as unavailable (`/healthz` 503).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime Postgres URL (Neon pooled host in production). Required when `NODE_ENV=production`. |
| `MIGRATION_DATABASE_URL` | Direct (non-pooled) URL for migrations; defaults to `DATABASE_URL`. |
| `PUBLIC_ORIGIN` | Exact origin used for the same-origin check on state-changing requests. |
| `SESSION_HOURS`, `GUEST_DAYS` | Session and guest-identity lifetimes (defaults 12 h, 7 days). |
| `ENGINE_SERVICE_URL` | Reserved for the engine release. Unset means "engine unavailable". |

No paid provider is required. A hosted identity provider (OIDC) can be added behind the identity module later; until then accounts use email + scrypt-hashed passwords.

## API (JSON, same-origin, cookie session)

`POST /api/auth/{signup,login,logout,logout-all}`, `GET /api/me`, `POST /api/orgs`, `POST /api/orgs/:slug/members`, `GET|POST /api/orgs/:slug/events`, `GET /api/events`, `GET /api/events/by-slug/:slug`, `PATCH /api/events/:id` (with `version`), `POST /api/events/:id/{publish,cancel,sessions,invitations,registration}`, `PATCH /api/events/:id/sessions/:sid`, `DELETE /api/events/:id/registration`, `GET /api/events/:id/attendees`, `POST /api/events/:id/attendees/:uid/check-in`, `POST /api/events/:id/invitations/:iid/revoke`, `GET /api/invitations/:token`, `POST /api/invitations/:token/accept`, `GET /api/status`, `GET /healthz`.

## Records

- Plan: [`registry/prs.json`](registry/prs.json) (41 units); progress and blockers: [HANDOFF.md](HANDOFF.md).
- Engine dependency: [`docs/engine-dependency.json`](docs/engine-dependency.json).
- Security review: [`docs/security/C01-C04.md`](docs/security/C01-C04.md).
- Deployment: [`render.yaml`](render.yaml) (Render free web service `xlr8`, Neon project `xlr8`).
