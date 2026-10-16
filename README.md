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