# Fin × MeshMesh PoC: Research Findings & Execution Plan

## Status (2026-11-22): PoC complete. Recommendation: **Proceed (iterate on hardening)**
- **Live Messenger, end to end (FIN Agent site):** `fmr_b323a19e` Account Health Score (Number). Fin showed the request ID, then progress, then the real final "complete and independently verified" message (both webhooks HTTP 200). Verified in Salesforce: `Account_Health_Score__c` Number(18,0); Fin PoC Access Read/Edit.
- **Live duplicate test** ("PoC Customer Tier"): refused by the bridge guard before MeshMesh ran; the field is unchanged (Text 50).
- **What made the live Messenger work:** the Procedure channel changed from Salesforce Cases to **Web**, and the audience "Fin PoC tester" matches **jane.doe@test.com** (the identity Intercom sees for the site visitor).
- **Clean-up:** the Procedure is back to **Disabled**. The audience and channel are left as is for future tests.
- **Ops note:** the cloudflared quick tunnel dropped once (530) and its URL changed. Use a hosted endpoint beyond the PoC.
- **MeshMesh-reported failure, live (T9):** with the bridge pre-check off (`SF_PRECHECK=false`), MeshMesh itself detected the duplicate and returned `RESULT: FAILED`. Fin showed "not completed" with no false success. It first invented a cause, which was fixed by putting a `Reason:` line first in the bridge's message and tightening the failed-branch instruction. The re-test quoted the real reason. The pre-check is back on and the Procedure is Disabled.
- **One-page readout** with risks and dependencies: `docs/Fin-MeshMesh-PoC-Readout.md`.
- **POC-03 (22 Nov):** the bridge routes each customer to its own MeshMesh connection and org (`config/customers.json`) and refuses customers with no connected sandbox, with connect instructions. Tested live (T11). MeshMesh's API cannot create connections; the customer's admin connects once in MeshMesh Studio.
- **After the customer leaves (22 Nov):** the result waits in the conversation (T10, live). For closed or expired conversations there is a REST reply fallback; the connector sends `conversation_id` (T12). With the token added, the customer saw the reply in the Messenger (T13).
- **Demo (22 Nov):** recording script and tested full-screen recorder in `docs/demo/`. The Procedure is **Enabled** for the recording; disable it afterwards.
- Full details: `Fin-MeshMesh-Technical-Guide.md` §7.1b, §7.2 (T7–T9), §8.

## Progress log (2026-11-21)

| Step | Status | Evidence / notes |
|---|---|---|
| MeshMesh Studio package in SF Dev Edition org `orgfarm-8414c843e4` | Done | ver 0.5 installed for all users; External Client App "MeshMesh Studio" Enabled ("Fin for Salesforce" app also present) |
| MeshMesh connection "Fin PoC Dev Org" | Done | Custom-domain OAuth; connection id `b6ef3fbf-0d6d-4605-84c4-148081c08ea5` |
| Spike in MeshMesh UI (POC-05 de-risk) | **Pass** | `PoC_Customer_Tier__c` Text(50) + Account Layout + new permission set `Fin_PoC_Access` (Read/Edit), verified in Setup |
| Bridge service (`fin-meshmesh-bridge/`) | Done | Node 24; 6 unit tests pass; mock E2E pass (incomplete → rejected, good → succeeded, duplicate → failed, no token → 401) |
| Public tunnel | Up | cloudflared quick tunnel (URL changes on every restart; update the Fin connector URL if it does) |
| Bridge → MeshMesh MCP → Salesforce (live, no Fin) | **Pass** | `fmr_b3c3177b`: `PoC_Renewal_Score__c` Number(18,0) created, on layout, FLS in Fin PoC Access; ~3 min; plan approved over MCP; `RESULT: SUCCEEDED` |
| Intercom workspace | Switched | "Salesforce" (`kotsdo1p`) trial expired, so the PoC moved to **CRDemo** (`d29t5bj9`, active, live Fin) |
| Fin data connector "Start Salesforce configuration (MeshMesh PoC)" (CRDemo, id 671985) | **Live** | Bearer token "MeshMesh PoC Bridge" added by user. Live test via tunnel → bridge: 200 OK, Picklist correctly rejected. Directly = off. Example response = accepted mock (for Preview). |
| Fin Procedure "Salesforce Setup Assistant (MeshMesh PoC)" (id 2228214) | Saved, Fin availability **Disabled** | 8 steps: intro → collect 5 inputs → confirm → call connector (callback_url mapped to Wait-for-webhook URL) → handle rejected → share request ID + Wait for webhook `meshmesh_status` (status, message, is_terminal, request_id; 15 min; timeout → team handoff) → loop on progress → success/failure. |
| Preview tests | Pass (logic only) | T2: asked only for missing fields. Picklist refused, Fin asked for a supported type. Summary + explicit yes before call. Accepted path showed request ID → progress → success + next step. |
| Real E2E through Fin | **Done (backend)** | Preview as jane.doe@test.com + "Access and update real user data". `fmr_4a3e37f1` (Renewal Risk) and `fmr_1a700a31` (Last Health Check) created and verified in Salesforce (field, layout, FLS). First progress update reached Fin (200). |
| Two-webhook design | Done | Fin webhook URLs are single-delivery: later posts returned 404. Added `final_callback_url` + `meshmesh_result` wait. |
| Final message in Fin | **Not verifiable in Preview** | Preview doesn't deliver the 2nd webhook, and Fin made up "complete" even with a neutral preview value. Needs live Messenger plus a deterministic Condition step. |
| T4 duplicate-field failure | **FAIL → fixed → PASS** | First run: MeshMesh missed the existing field (describe hides fields without FLS) and upserted it Text(50) → Text(100). Fix: bridge pre-check via Tooling `FieldDefinition` + post-verify. Re-test through Fin: rejected before MeshMesh; Fin asked for a different label. |
| Deterministic final message | **Fixed** | Procedure step 8 is a Code Condition (`succeeded` / `failed` / else → can't confirm + handoff). Preview now says "cannot confirm yet" instead of a false success. |

Full step-by-step configuration and results: **Fin-MeshMesh-Technical-Guide.md**.

### More findings
- Intercom Preview does **not** call live data connectors; it replays the connector's saved test/example response, even as "New lead". Webhook steps resolve at once with preview values. Real E2E needs Fin availability enabled (or Simulations with mocks, which still isn't real).
- In this workspace's connector UI, typing `{{attribute}}` into the JSON body works as well as the Add-data picker.

### Integration findings so far
- **MeshMesh MCP works for server-to-server use** once a one-time browser OAuth consent is done; tokens refresh automatically (dynamic client registration + PKCE, localhost redirect accepted).
- **Connection must be attached per agent** (`connectionIds` on `start_agent`); otherwise the agent stops and asks for one.
- **Status shape** (`get_agent_status`): `status:"waiting"`, `isExecuting`, `waitingFor` (`"confirmation"`, `""`…), `phase`, `summary`, `recentMessages[]`. Finished = `waiting` + `isExecuting:false` + empty `waitingFor`. `summary` lags behind; read the last assistant message.
- **Plan mode → build**: `continue_agent(mode:"build")` approves the plan. Agents started in the web UI pause for a per-step "deploy" confirmation; MCP-started agents did **not** pause (consistent with docs: MCP runs are unattended).
- **Outcome detection** needs an explicit marker. Free-text matching misread a plan that mentioned "SUCCEEDED or FAILED" as a failure; the fix is a required `RESULT: SUCCEEDED|FAILED - reason` line.
- **No push from MeshMesh**: polling every 15 s works; bridge pushes to Fin.


_Prepared 2026-11-21. Based on the PoC brief plus the public docs for Intercom Fin and MeshMesh (docs.meshmesh.io). Items marked **[verify]** come from docs that were unclear or only partly readable. Each one gets checked in Phase 0._

---

## 1. What the research found

### MeshMesh (Salesforce's AI config agent, Customer Hands-On Beta)
| Topic | Finding |
|---|---|
| Programmatic entry point | **Remote MCP server**: `POST https://gateway.meshmesh.io/mcp` (Streamable HTTP, stateless; no SSE or stdio endpoint) |
| Auth | **OAuth 2.0 bearer only.** No API key for MCP. First use needs a browser sign-in. Identity and workspace come from the token. |
| Key tools | `start_agent(name, prompt, mode=plan\|build, connectionIds)` returns an **agentId**. `get_plan(agentId)`, `continue_agent(agentId, message)` (approve the plan or follow up), `get_agent_status(agentId)` (state, summary, recent messages, artifacts), `list_connections` |
| Status back | **Polling only** (`get_agent_status`). No documented outbound webhook or callback on completion. |
| Approval gate | MCP-started agents in **build** mode run unattended with no confirmation prompts. Safe pattern: start in **plan** mode, review `get_plan`, then approve with `continue_agent`. |
| Salesforce connection | Install the **MeshMesh Studio** managed package in the sandbox (`test.salesforce.com/packaging/installPackage.apexp?p0=04tfj000000c8ivAAA`). Then Setup → External Client App Manager → MeshMesh Studio → **Enable**. Then in MeshMesh: Connections → Salesforce → **Sandbox** → OAuth. Agents act with the permissions of the signed-in SF user, so use a dedicated integration user. |
| Capabilities | Custom objects and fields, validation rules, page layouts, permission sets, profiles, Apex, LWC. Flows are "experimental". Picklists are not named explicitly **[verify]**. |
| Constraints | Beta runs until about 31 Jan 2027 with 100k free credits. Web app at studio.meshmesh.io (desktop app is macOS only). Read-write access is limited to sandboxes and dev orgs. Intercom/Fin is **not** a listed integration. |

### Intercom Fin
| Topic | Finding |
|---|---|
| Calling external systems | **Data connectors** (HTTP GET/POST/PUT/PATCH/DELETE with token or OAuth headers) or **Custom MCP connector** (Settings → Integrations → Data connectors → Custom MCP) |
| Custom MCP caveats | Docs show only **SSE** URLs, and MeshMesh is Streamable HTTP only, so it **may not be compatible [verify]**. OAuth is set up once per connector, not per customer. **One connector call per turn.** About a 30 s response limit **[verify]**. |
| Conversation logic | **Fin Procedures** (Fin AI Agent → Train → Procedures). Steps: Instruction, Condition, Call data connector, Wait for reply, **Wait for Webhook**, Handoff, End. Connector inputs marked "Let Fin collect" + Required make Fin ask for the missing fields. |
| Async return path | **Wait for Webhook**: each Procedure run gets a unique callback URL. An external system POSTs scalar fields to it and Fin resumes. The same URL is reused if the Procedure loops back to the same Wait step. Fin stays silent while it waits. On timeout, it escalates. |
| Other return path | Intercom REST `POST /conversations/{id}/reply` (bot or admin comment, or note). Usable for progress messages. |
| Failure handling | Procedures do **not** handle connector failures automatically. You need explicit Condition branches on `status_code` / result fields. |
| Testing | Preview resolves webhooks instantly with defaults. **Simulations** support mock callbacks. Real end-to-end testing needs a live (test-user) Messenger. |

### Answers to the brief's open questions (§10)
| Question | Answer |
|---|---|
| Can Fin pass info through a supported mechanism? | Yes. A Data connector (REST) works for sure. Direct MCP is uncertain because of the transport mismatch. |
| Does MeshMesh support async execution and status? | Yes. `start_agent` returns an agentId, and `get_agent_status` polls it. |
| Can Fin receive updates mid-conversation? | Yes, through Wait for Webhook. It can loop for multiple updates **[verify]**. The REST reply API is the fallback. |
| How are updates tied to the right request? | Correlation record: `requestId ↔ conversationId ↔ agentId ↔ callbackUrl`. |
| Authentication? | Fin → bridge: bearer token (Text token in Intercom). Bridge → MeshMesh: OAuth refresh token for one integration user. MeshMesh → SF: managed-package OAuth. |
| Customer approval before changes? | Fin shows a summary and asks for an explicit "yes" in the Procedure. MeshMesh also runs plan mode, and the bridge approves the plan only after the customer confirms. |
| Updates after the conversation ends? | Undocumented. Test it in Phase 4. Fallback is the REST reply API, which reopens the conversation. |

---

## 2. Recommended architecture

A direct Fin → MeshMesh MCP connection has three likely blockers: the SSE vs Streamable HTTP mismatch, the one-call-per-turn limit, and no push from MeshMesh. So the plan uses a **thin bridge service** between the two. It is small, around 300 lines, and it also gives the PoC its integration findings.

```
Customer ⇄ Fin (Procedure "Salesforce Setup")
              │ 1. Data connector POST /requests  {requirements, conversationId, callbackUrl}
              ▼
        Bridge service (Node/Python, HTTPS)
              │ 2. MCP start_agent(mode=plan) → get_plan → continue_agent("approve") → build
              │ 3. poll get_agent_status every ~20 s
              ▼
        MeshMesh ──OAuth──► Salesforce Sandbox
              │
Bridge ──4. POST progress/final {requestId, status, message} ──► Fin Wait-for-Webhook URL
        (fallback: Intercom REST reply into the conversation)
```

The bridge's responsibilities:
- **Validate the payload against a JSON schema** before calling MeshMesh. This is a second line of defence for POC-02.
- Turn the structured requirements into a precise MeshMesh prompt.
- Return `{requestId, agentId, status:"accepted"}` right away (POC-04 acknowledgement and ID).
- Poll MeshMesh, map its states to `queued | planning | building | succeeded | failed`, and push each change to Fin (POC-06, 07, 08).
- Log every request and response as test evidence.

**Hosting for the PoC:** run it locally with a tunnel (ngrok or Cloudflare Tunnel) so Intercom can reach it, or deploy to a small Azure Function or Render app. Exposing it publicly needs your OK.

---

## 3. Use case (CONFIRMED 2026-11-21)

> **Decided:** Custom field + access on **Account**. Allowed field types: **Text, Number, Checkbox, Date** (no picklist). Controlled failure (T4): **duplicate field name**, meaning a request for a field that already exists. `target_object` is fixed to Account, and `field_values` is dropped.

### Original proposal (for reference)

**"Add custom fields to a standard object and grant access"**. For example, add a *Customer Tier* field to Account and make it visible to a permission set.

Required inputs (the contract between Fin and the bridge):
| Field | Type | Example | Rule |
|---|---|---|---|
| `requestor_email` | text | test.user@example.com | required |
| `sandbox_connection` | text | "POC Sandbox" | required, must match a MeshMesh connection |
| `target_object` | text | Account | required, standard or existing custom object |
| `field_label` | text | Customer Tier | required |
| `field_type` | text | Picklist / Text / Number / Checkbox / Date | required, from that list |
| `field_values` | text | Gold;Silver;Bronze | required only if Picklist |
| `required_on_layout` | bool | false | optional, default false |
| `permission_set` | text | Sales Ops | required (FLS grant) |
| `business_reason` | text | Segment accounts for renewals | required (context for MeshMesh) |

Inputs are flat scalars because Fin connectors and webhooks handle scalars best. If MeshMesh can't create picklists, fall back to a Text field.

Success check: the field exists in Setup → Object Manager → Account → Fields, and the permission set shows Read/Edit FLS on it.

---

## 4. Execution plan

### Phase 0: Access & verification (needs your logins)
1. **You sign in** to Intercom and MeshMesh in the in-app browser. I don't type passwords; you sign in, then I drive.
2. MeshMesh: confirm beta access and workspace role, check `list_connections`, and confirm the MCP tools are visible.
3. Salesforce sandbox: confirm one exists, install the MeshMesh Studio package, enable the External Client App, create an integration user, and connect it in MeshMesh as **Sandbox**.
4. Intercom: confirm the plan includes Data connectors and Procedures, that Custom MCP and Wait for Webhook are enabled, and that you have "Can access developer hub" permission.
5. Resolve the **[verify]** items: picklist support, MCP transport compatibility in Fin, the webhook loop, and the 30 s timeout.
6. Spike: run `start_agent` (plan mode) from the MeshMesh UI or an MCP client against the sandbox with the use-case prompt. This proves MeshMesh can do the config at all before any integration work. **(POC-05 de-risk)**

### Phase 1: Bridge service
7. Build the bridge with `POST /requests` and `GET /requests/{id}`, the MeshMesh MCP client (OAuth with refresh), the poller, the webhook pusher, and the Intercom reply fallback.
8. Add schema validation and a correlation store (SQLite or JSON is enough for a PoC).
9. Expose it over HTTPS and add a bearer token for Fin → bridge.

### Phase 2: Fin configuration
10. Create a Data connector "Start Salesforce configuration": POST to the bridge, inputs as above (Let Fin collect + Required), `callbackUrl` from the Wait-for-Webhook tool attribute, `conversationId` from the attribute, Fin trigger **Disabled** (manual, used only inside the Procedure).
11. Create the Procedure "Salesforce Setup Assistant":
    - Intro: explain the onboarding flow (Flow step 1).
    - Collect inputs and ask clarifying questions. Condition: if Picklist, require values (POC-01, 02).
    - Summary plus explicit confirmation (customer approval).
    - Call connector. Condition on `status_code` / `accepted`, with a failure branch (POC-04, 08).
    - Tell the customer "started, tracking ID X", then **Wait for Webhook** (`status`, `message`, `request_id`).
    - Condition: terminal? If not, relay progress and loop back to wait (POC-06). On success, give the result and next steps (POC-07). On failure, give the error and hand off (POC-08).
12. Test in Simulations with mock callbacks, then set it live for a test audience only.

### Phase 3: End-to-end test scenarios
| # | Scenario | Proves |
|---|---|---|
| T1 | Happy path: all inputs given up front | POC-01, 04, 05, 06, 07 |
| T2 | Missing and ambiguous inputs (no field type, picklist without values) | POC-02, nothing sent until complete |
| T3 | Customer declines at confirmation | No request sent |
| T4 | Controlled failure: non-existent object `Foo__c`, or integration user lacking Customize Application | POC-08, no false success |
| T5 | Bridge or MeshMesh down (connector error) | Failure branch, no fabricated answer |
| T6 | Customer closes chat mid-run | Post-conversation update behaviour (open question) |

Evidence for each test: a screen recording or screenshots of the Fin chat, bridge logs, the MeshMesh agent page, and the sandbox Setup screen.

### Phase 4: Deliverables (brief §9)
13. Demo recording of T1 and T4.
14. Integration findings: input contract, mechanisms (Data connector + polling + Wait for Webhook), auth, and status mapping.
15. Test results table with pass/fail and limitations.
16. Risk and dependency summary (below), plus a **Proceed / Iterate / Defer / Stop** recommendation.

---

## 5. Risks & dependencies
| Risk | Impact | Mitigation |
|---|---|---|
| Fin Custom MCP can't talk to MeshMesh (SSE vs Streamable HTTP) | Direct path blocked | Bridge (the default plan) |
| MeshMesh OAuth needs an interactive sign-in, and refresh behaviour is unclear | Bridge auth breaks after token expiry | Capture the refresh token in Phase 0; test the expiry. If it isn't supported, log it as a finding. |
| MCP build mode runs unattended | Unreviewed changes | Plan mode first; approve only after customer confirmation; sandbox only; least-privilege user |
| Fin silent during Wait for Webhook; looping unverified | Weaker POC-06 | Fallback: bridge posts progress with the REST reply API |
| About 30 s connector timeout | Start call times out | Bridge returns 202 immediately and does all MeshMesh work async |
| MeshMesh beta / invite-only / credits | Access or quota blocks | Confirm in Phase 0; keep test runs small |
| Connector output reaches the customer | Leaks internal details | Bridge returns only customer-safe fields |
| Approvals: sandbox access, security sign-off (brief §7 S5) | Can't start | Confirm owner and approvals before Phase 1 |

---

## 6. What I need from you before we start
1. **Intercom workspace**: you sign in yourself in the in-app browser (please don't paste passwords in chat). Plus admin rights to create Data connectors and Procedures.
2. **MeshMesh**: same, signed in at studio.meshmesh.io, with beta access confirmed.
3. **Salesforce sandbox**: which org, and an admin login (you sign in) so we can install the MeshMesh package and create the integration user.
4. **Hosting OK** for the bridge: local + tunnel, or a cloud host you prefer.
5. Confirm the **use case** in §3, or name the one MeshMesh/Fin teams picked.
