# Fin × MeshMesh bridge

**Intercom Fin** collects a Salesforce configuration request in conversation, this bridge hands it to **MeshMesh** (remote MCP), MeshMesh configures a Salesforce org, and progress plus a verified final result are pushed back to Fin.

The customer describes the change in their own words (fields, objects, validation rules, layouts, permission sets and assignments, Named/External Credentials for outbound callouts, External Client Apps, remote sites…). MeshMesh plans it and lists every component in a machine-readable **CHANGESET**. The bridge checks that list against a policy (`config/policy.json`) and the org, the **customer approves MeshMesh's actual plan** in Fin, MeshMesh builds exactly that list, and the bridge verifies every component and flags anything changed outside the plan.

```
Fin ──POST /requests {change_request}──▶ bridge ──MCP start_agent(plan)──▶ MeshMesh ──read-only──▶ Salesforce
 ▲                                          │ CHANGESET → policy → org pre-check (sf CLI)
 └──── plan webhook (plan_ready / needs_input / rejected) ◀──┘
Fin ──POST /requests/decision {approve, plan_version}──▶ bridge ──continue_agent(build)──▶ MeshMesh ──▶ Salesforce
 ▲                                          │ post-verify every item + drift check
 └──── progress webhook, final webhook (succeeded / failed / needs_review) ◀──┘
```

Full documentation: [Technical guide](docs/Fin-MeshMesh-Technical-Guide.md) (architecture, why it matters, file map, setup, testing with sample utterances).

## Quick start
```bash
npm install
cp .env.example .env        # fill in FIN_BEARER_TOKEN, MESHMESH_CONNECTION_ID, SF_TARGET_ORG
npm test                    # unit tests, live path with fake MeshMesh/sf CLI, mock end to end
npm start                   # http://localhost:8787/health
# one-time MeshMesh sign-in (localhost only): http://localhost:8787/oauth/start
# expose publicly, e.g.: cloudflared tunnel --url http://localhost:8787
```

## Layout
| Path | Purpose |
|---|---|
| `src/server.js` | HTTP API: `POST /requests`, `POST /requests/decision`, `GET /requests/:id`, `/health`, OAuth routes |
| `src/validate.js` | Input contract (generic `change_request`; legacy single-field contract) |
| `src/prompt.js` | MeshMesh plan / approval / revision prompts |
| `src/changeset.js` | CHANGESET parsing, formatting and `plan_version` |
| `src/policy.js`, `config/policy.json` | What may be changed through chat (allow/deny by metadata type and action) |
| `src/worker.js` | Plan → policy + pre-check → customer approval → build → verify → final status |
| `src/guard.js` | Generic read-only Salesforce guard (listMetadata pre-check, snapshot, post-verify, drift) |
| `src/notify.js` | Pushes plan/progress/final status to Fin's Wait-for-webhook URLs; redacts secrets |
| `src/sfcheck.js` | Single-field checks (Tooling `FieldDefinition`, `FieldPermissions`) |
| `scripts/plan-check.js` | Dry-run a hand-written CHANGESET against policy and the org |
| `src/meshmesh.js` | MCP client with OAuth (tokens in `data/`, git-ignored) |
| `src/customers.js` | Per-customer MeshMesh connection + org (`config/customers.json`) |
| `scripts/watch-log.ps1` | Live, readable event log |
| `scripts/record-demo.ps1` | Full-screen demo recorder (press q to stop) |
| `docs/` | Technical guide and supporting documents |

## Security
`.env` and `data/` (OAuth tokens, request logs) are git-ignored. Never commit tokens. Use Developer Edition and sandbox orgs only.
