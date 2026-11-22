# Handoff: live-test and ship v2 (generic Salesforce setup requests)

This file is the brief for whoever picks the work up next (written for Claude Code). Read it fully before you act. Then read `docs/Fin-MeshMesh-Technical-Guide.md` §12 (v2) and skim §4–§7 (v1 setup that already works).

## 1. Goal
The v1 PoC (Intercom Fin → bridge → MeshMesh MCP → Salesforce) works live, but only for one custom field on Account. **v2 makes it generic**: a customer can ask for *any* Salesforce setup in plain words (fields, validation rules, layouts, permission sets/assignments, Named/External Credentials for outbound HTTPS callouts, External Client Apps, …). MeshMesh plans it, the bridge checks the plan, the customer approves MeshMesh's actual plan in Fin, MeshMesh builds it, and the bridge verifies it.

## 2. Current state (branch `generic-setup-requests`)
- v2 code is written and committed. `npm test` passes **37 tests** (unit, live worker path against a scripted fake MeshMesh and a fake `sf` CLI, mock end-to-end through the HTTP server with a fake Fin).
- **Not yet run against real MeshMesh, the real org or Intercom.** The previous environment couldn't reach `gateway.meshmesh.io`. That is your job.
- v1 behaviour must stay intact (legacy connector body with `field_label`/`field_type` is auto-translated and auto-approved).

Design in one paragraph: `POST /requests {change_request, requestor_email, business_reason, plan_callback_url}` → `start_agent(mode: plan)` → MeshMesh must end its plan with a `BEGIN_CHANGESET … END_CHANGESET` JSON list of components → `src/policy.js` (`config/policy.json`) + `src/guard.js` read-only org pre-check (`sf org list metadata`) → plan webhook to Fin (`plan_ready | needs_input | rejected | failed`, with `plan_version`) → `POST /requests/decision {request_id, decision: approve|revise|cancel, plan_version, callback_url, final_callback_url}` → snapshot → `continue_agent(mode: build)` with "build exactly this list" → poll → post-verify every item + drift check → final webhook `succeeded | failed | needs_review`.

## 3. Rules
- **Dev Edition / sandbox only.** Never production.
- **Secrets:** never print, paste or commit `.env`, `data/meshmesh-oauth.json`, `config/customers.json`, the Fin bearer token or the Intercom token. The human types secrets into `.env` themselves. Don't echo `.env` contents.
- **Sign-ins are done by the human** in the browser you open: MeshMesh OAuth (`http://localhost:8787/oauth/start` → *Allow access*), Salesforce CLI (`sf org login web --alias devhub --instance-url https://<my-domain>.my.salesforce.com`), Intercom admin UI. Open the page, then wait for them to say "done".
- Ask before anything that changes the org beyond the test scenarios below, before enabling the Fin Procedure for anyone except the test audience, and before pushing.
- Keep the Intercom Procedure **Disabled** when you finish (§7.1b).
- Record every live run (request id, scenario, result, what you checked in Setup) in the guide's §8 run log and §12.8 table.

## 4. Plan

### Phase A: local setup (human present)
1. `git status`. You should be on `generic-setup-requests` (if this repo came from the patch: `git am 0001-v2-generic-Salesforce-setup-requests.patch`). Then `npm install` and `npm test` (expect 37 pass).
2. `.env` exists from v1 (if not: `cp .env.example .env` and the human fills in `FIN_BEARER_TOKEN`, `MESHMESH_CONNECTION_ID`, `SF_TARGET_ORG=devhub`). Set `MESHMESH_MODE=live`, `SF_GUARD=true`, `SF_PRECHECK=true`.
3. `sf org display --target-org devhub`. If it isn't logged in, open the login (human signs in).
4. `npm start`, then open `http://localhost:8787/oauth/start` in the browser (human clicks Allow). Check that `GET /health` shows `meshmesh_authorised: true` and `salesforce_guard.ok: true`.
5. `npm run probe`: confirm the connection id and list the MCP tools. **Compare tool names and arguments with what `src/worker.js` calls** (`start_agent`, `get_agent_status`, `get_plan`, `continue_agent`, `list_connections`).

### Phase B: guard dry run (no MeshMesh, read-only)
6. `node scripts/plan-check.js examples/changeset-outbound.json devhub`: expect no conflicts and policy ok.
7. `node scripts/plan-check.js examples/changeset-duplicate.json devhub`: expect a conflict (`PoC_Customer_Tier__c already exists`).
8. Check that `sf org list metadata` works for `ExternalCredential`, `NamedCredential`, `ExternalClientApplication`, `ExtlClntAppOauthSettings` and `ValidationRule` in this org and API version (v62). Fix `src/guard.js` if a type needs a different name or flag.

### Phase C: bridge-only live runs (curl/PowerShell, before Fin), guide §12.8
Use `plan_callback_url: "https://example.com/no-op"` and read the results with `GET /requests/<id>`. Watch `data/events.log` (`scripts/watch-log.ps1` on Windows, `tail -f data/events.log` on macOS).
9. **T14** (field, v1 regression through v2), then **T15** (outbound HTTPS → Named + External Credential + permission set). For each, check:
   - the plan turn ends and `meshmesh_status` shows the CHANGESET block; `plan_review` shows parsed `changes`, policy ok, pre-check ok;
   - approve with the `plan_version` → build → `postverify` ok → status `succeeded`;
   - verify in Salesforce Setup yourself (Object Manager, Named Credentials, External Credentials, Permission Sets).
10. Things most likely to need fixing, because they're only assumptions so far:
   - **CHANGESET compliance:** does MeshMesh output the block, with Metadata API type names and full names (`Account.X__c`, `Account-Account Layout`)? If not, tune `src/prompt.js` (keep the tests green and add a regression test using the real message shape from the log).
   - **Plan-turn detection:** in v1 the plan ended as `status: waiting, isExecuting: false, waitingFor: ""`. Make sure `waitForTurn` doesn't stop early or hang (the stale-turn logic after `continue_agent`).
   - **Name matching:** CHANGESET names vs `listMetadata` `fullName` (case, namespace, layout names). Mismatches show up as false conflicts, "not found" or `needs_review`. Normalise in `src/guard.js`.
   - **Drift false positives:** if Salesforce side effects appear in `postverify.unexpected`, extend `isSideEffectOf` rather than removing the check.
11. Then **T19** (Apex → `rejected`, no build), **T20** (duplicate → `rejected`), **T21** (vague → `needs_input` → `decision: revise` with `feedback` → new plan), **T22** (cancel), **T16** (External Client App: confirm no consumer key or secret appears anywhere sent to Fin), **T17** (validation rule), **T18** (permission set assignment to a test user).

### Phase D: Intercom (human signs in to app.intercom.com, workspace CRDemo)
12. Start the tunnel (`cloudflared tunnel --no-autoupdate --url http://localhost:8787`) and note the URL.
13. Create **connector ① "Plan Salesforce change (MeshMesh)"** and **connector ② "Decide on Salesforce plan (MeshMesh)"** exactly as in guide §12.6 (decision URL `https://<tunnel>/requests/decision`, `request_id` in the body). Run a live test on each with a safe invalid value (`change_request: "short"`, `decision: "nope"`). Directly = off. Set live.
14. Build Procedure **"Salesforce Setup Assistant (MeshMesh v2)"** as in guide §12.7: waits `meshmesh_plan`, `meshmesh_plan_2`, `meshmesh_status`, `meshmesh_result`, and Code Conditions. Keep v1 Disabled. Channel Web, audience **Fin PoC tester** (jane.doe@test.com).
15. Live Messenger tests (§7.1b): T14, T15, T19, T21, T22 at least. Preview can't deliver later webhooks, so use the live Messenger. Disable the Procedure afterwards.

### Phase E: finish
16. Update the guide (§8 run log, §12.8 results, any changed steps), the Readout addendum and the README if behaviour changed. Commit in small, clear commits.
17. Ask the human, then `git push -u origin generic-setup-requests` and offer to open a PR to `main`.

## 5. Definition of done
- T14, T15 and T19–T22 pass live through Fin. T16–T18 pass at least via the bridge.
- No false `succeeded` in any run. No secrets in Fin messages or logs sent to Fin.
- `npm test` green, including new regression tests for any real MeshMesh shapes you had to handle.
- Docs updated, branch pushed, Procedure back to Disabled.

## 6. Where things are
| What | Where |
|---|---|
| v2 design and Intercom setup | `docs/Fin-MeshMesh-Technical-Guide.md` §12 |
| v1 setup that already works | same guide §1–§11 |
| Policy | `config/policy.json` (read per request) |
| Event log / requests | `data/events.log`, `data/requests.json`, `GET /requests/<id>` |
| Tests | `test/*.test.js` (`npm test`) |
