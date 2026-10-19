# OpsDesk

An internal web app for coordinating operational work: requests, incidents, investigations
and approvals, with clear ownership, history and a view of what needs attention.

Built for the Newtonite Software Engineering Challenge.

Status: in development.

## Requirements

- Node.js 20 or newer
- Docker Desktop

## Database

```
Copy-Item .env.example .env
npm run db:up
```

Assumptions are documented in `docs/ASSUMPTIONS.md`.
## Run everything (development)

```
npm install
npm run migrate
npm run seed
npm run dev        # API on :4000
npm run worker     # notifications worker (second terminal)
npm run dev:web    # web app on http://localhost:5173 (third terminal)
```

The web dev server proxies `/api` to the API, so no CORS setup is needed.
Sign in with `lead@opsdesk.test` / `password123` (more accounts are printed by the seed script).