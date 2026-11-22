# Fin × MeshMesh PoC bridge

Proof of concept: **Intercom Fin** collects a Salesforce configuration request in conversation, this bridge hands it to **MeshMesh** (remote MCP), MeshMesh configures a Salesforce org, and progress plus a verified final result are pushed back to Fin.

PoC use case: create one custom field on Account (Text, Number, Checkbox or Date), add it to the default page layout, and give a permission set Read/Edit on it. Controlled failure: a duplicate field name.

```
Fin Procedure ──POST /requests──▶ bridge ──MCP──▶ MeshMesh ──▶ Salesforce org
      ▲                              │  read-only guard (sf CLI): pre-check duplicates, post-verify
      └── Wait for webhook #1 (progress) / #2 (final result) ◀──┘
```

## Quick start
```bash
npm install
cp .env.example .env        # fill in FIN_BEARER_TOKEN, MESHMESH_CONNECTION_ID, SF_TARGET_ORG
npm test
npm start                   # http://localhost:8787/health
# one-time MeshMesh sign-in (localhost only): http://localhost:8787/oauth/start
# expose publicly, e.g.: cloudflared tunnel --url http://localhost:8787
```

## Layout
| Path | Purpose |
|---|---|
| `src/server.js` | HTTP API: `POST /requests`, `GET /requests/:id`, `/health`, OAuth routes |
| `src/validate.js` | Input contract and the MeshMesh mission prompt |
| `src/worker.js` | Runs MeshMesh: plan → build → approve → verify → final status |
| `src/notify.js` | Pushes status to Fin's Wait-for-webhook callback URLs |
| `src/sfcheck.js` | Independent read-only Salesforce guard (Tooling `FieldDefinition`, `FieldPermissions`) |
| `src/meshmesh.js` | MCP client with OAuth (tokens in `data/`, git-ignored) |
| `src/customers.js` | POC-03: per-customer MeshMesh connection + org (`config/customers.json`) |
| `scripts/watch-log.ps1` | Live, readable event log |
| `scripts/record-demo.ps1` | Full-screen demo recorder (press q to stop) |
| `docs/` | Readout, execution plan, step-by-step technical guide, demo script |

## Results
All PoC requirements (POC-01 to POC-08) passed, including the final status shown in a live Intercom Messenger. Recommendation: **Proceed (iterate on hardening)**. See [docs/Fin-MeshMesh-Technical-Guide.md](docs/Fin-MeshMesh-Technical-Guide.md).

## Security
`.env` and `data/` (OAuth tokens, request logs) are git-ignored. Never commit tokens. PoC is for Developer Edition and sandbox orgs only.
