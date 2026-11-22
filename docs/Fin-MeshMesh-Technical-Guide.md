# Fin × MeshMesh: Technical Configuration Guide (Step by Step)

_Version 1.0 · 21 Nov 2026 · Proof of Concept configuration_

This guide rebuilds the whole PoC from scratch: an **Intercom Fin** conversation collects a Salesforce change request, a small **bridge service** hands it to **MeshMesh** (Salesforce's AI configuration agent), MeshMesh configures the **Salesforce org**, and progress and the final result flow back into the Fin conversation.

> **PoC use case:** create one custom field on **Account** (type Text, Number, Checkbox or Date), add it to the default Account page layout, and grant a permission set Read/Edit field-level security on it.

---

## 0. Architecture

```
 Customer ──chat──► Intercom Fin  (Procedure: "Salesforce Setup Assistant (MeshMesh PoC)")
                      │  ① Data connector  POST /requests   (Bearer token)
                      ▼
               Bridge service  (Node.js, laptop, exposed by a Cloudflare tunnel)
                      │  ② MCP over HTTPS (OAuth): start_agent(plan) → continue_agent(build) → get_agent_status (poll 15 s)
                      ▼
                   MeshMesh  ──OAuth (MeshMesh Studio managed package)──►  Salesforce org
                      │
 Bridge ──③a first progress {status:"planning",…} ──► Fin Wait for webhook #1  "meshmesh_status" (callback_url)
 Bridge ──③b final result  {status:"succeeded|failed",…} ──► Fin Wait for webhook #2  "meshmesh_result" (final_callback_url)
```

> **Why two webhooks?** A Fin Wait-for-webhook URL accepts one delivery per wait. In testing, posting several updates to the same URL returned **HTTP 404** after the first, and Fin moved on too early. With one webhook for the first progress update and a separate one for the final result, the behaviour is deterministic: Fin always reports exactly one progress update, then the real outcome.

| # | Hop | Mechanism | Auth |
|---|---|---|---|
| ① | Fin → Bridge | Intercom **Data connector** (HTTP POST, JSON) | `Authorization: Bearer <FIN_BEARER_TOKEN>` |
| ② | Bridge → MeshMesh | **MeshMesh remote MCP server** `https://gateway.meshmesh.io/mcp` (Streamable HTTP) | OAuth 2.0 + PKCE (one-time browser consent, auto-refresh) |
| ②b | MeshMesh → Salesforce | MeshMesh **connection** via the MeshMesh Studio External Client App | Salesforce OAuth (the signed-in user's permissions) |
| ③ | Bridge → Fin | Fin Procedure **Wait for webhook** callback URL (unique per conversation) | URL is the secret |

Why a bridge instead of connecting Fin straight to MeshMesh MCP:
- Fin's Custom MCP connector expects SSE, but MeshMesh only serves Streamable HTTP.
- Fin allows one connector call per turn.
- MeshMesh has no completion push. Someone must poll and push results back to Fin.

---

## 1. Prerequisites

| Item | Used in the PoC |
|---|---|
| Salesforce org (sandbox or Developer Edition, **not production**) | Developer Edition `orgfarm-8414c843e4-dev-ed.develop.my.salesforce.com` |
| Salesforce admin login for that org | Yes (System Administrator) |
| MeshMesh account (beta) | studio.meshmesh.io |
| Intercom workspace with Fin + Procedures + Data connectors | Workspace **CRDemo** (`d29t5bj9`) |
| A machine to run the bridge | Windows laptop, Node.js 24, Git |
| Public HTTPS for the bridge | `cloudflared` quick tunnel |

---

## 2. Salesforce: install the MeshMesh Studio managed package

1. Sign in to the target org as an admin.
2. Open the package install URL **on the org's own domain**. That way it installs into the right org when you have several:
   `https://<your-my-domain>.my.salesforce.com/packaging/installPackage.apexp?p0=04tfj000000c8ivAAA`
   - Sandbox: `https://test.salesforce.com/packaging/installPackage.apexp?p0=04tfj000000c8ivAAA`
   - Production or Dev Edition: `https://login.salesforce.com/packaging/installPackage.apexp?p0=04tfj000000c8ivAAA`
3. Choose **Install for All Users** and click **Install**. Wait for **Installation Complete!** (MeshMesh Studio ver 0.5).
4. Go to **Setup → External Client App Manager** and confirm **MeshMesh Studio** shows **App Status = Enabled**. If it shows disabled, open it and click **Enable**.

> If the org restricts IPs, allowlist MeshMesh egress IPs `209.71.108.40` and `209.71.102.179`.

---

## 3. MeshMesh: connect the Salesforce org

1. Sign in at **https://studio.meshmesh.io**.
2. Open **Connect** (first-run tour) or **Integrations**, then **Salesforce**.
3. **Environment:**
   - **Custom domain** when you have several orgs or a My Domain. Enter `https://<your-my-domain>.my.salesforce.com`.
   - (Sandbox = test.salesforce.com, Production = login.salesforce.com.)
4. Leave **Or use your own External Client App** collapsed. If it's open, the Connect button stays disabled.
5. **Name and description:** Name = `Fin PoC Dev Org`, plus a short description.
6. Click **Connect with Salesforce**. In the Salesforce popup, sign in and click **Allow**. You must click this yourself; popups are blocked for automation.
7. Confirm the tile shows **1 connected**.

**Optional smoke test in the MeshMesh UI** (proves MeshMesh can do the change before integrating):
1. In **What do you want done in Salesforce?**, describe the change, pick **Plan**, and click **Go**.
2. When asked **Connection Required**, select `Fin PoC Dev Org` and click **Use Selected Connection**.
3. Review the plan, click **Begin Build**, and **Allow** the deploy prompt.
4. Verify the result in Salesforce Setup.

---

## 4. Bridge service (laptop)

### 4.1 Code layout

```
fin-meshmesh-bridge/
  package.json            # dependency: @modelcontextprotocol/sdk
  .env                    # config + secrets (git-ignored)
  src/config.js           # loads .env
  src/server.js           # HTTP API: POST /requests, GET /requests/:id, /health, /oauth/*
  src/validate.js         # input contract + MeshMesh prompt builder
  src/meshmesh.js         # MCP client (Streamable HTTP + OAuth/PKCE, token file)
  src/worker.js           # orchestration: plan → approve → build → poll → notify
  src/notify.js           # POST status to Fin callback URL (+ after-conversation REST reply)
  src/sfcheck.js          # independent read-only Salesforce guard (§4.7b)
  src/customers.js        # POC-03: per-customer MeshMesh connection lookup (§4.9)
  src/store.js            # JSON correlation store + event log (data/)
  config/customers.example.json  # template for config/customers.json (git-ignored)
  scripts/mcp-probe.js    # list MCP tools + connections
  scripts/mcp-call.js     # call any MCP tool for debugging
  scripts/watch-log.ps1   # live, readable event log (used in the demo)
  scripts/record-demo.ps1 # full-screen recorder (docs/demo/Demo-Script.md)
  scripts/test-after-conversation.js  # tests the REST reply fallback (§4.10)
  test/validate.test.js   # unit tests (11)
```

### 4.2 Install

```powershell
cd "$env:USERPROFILE\OneDrive - CriticalRiver Technologies Pvt. Ltd\Desktop\fin-meshmesh-bridge"
npm install
npm test
```

### 4.3 Configure `.env`

| Key | Value / meaning |
|---|---|
| `PORT` | `8787` |
| `FIN_BEARER_TOKEN` | Random 40-character secret. Fin must send it as `Authorization: Bearer <token>`. |
| `MESHMESH_MODE` | `mock` (simulated, no Salesforce changes) or `live` |
| `MESHMESH_MCP_URL` | `https://gateway.meshmesh.io/mcp` |
| `MESHMESH_CONNECTION_ID` | ID of the MeshMesh Salesforce connection (step 4.5) |
| `AUTO_APPROVE_PLAN` | `true`. The customer already confirmed in Fin, so the bridge approves MeshMesh's plan. |
| `POLL_INTERVAL_MS` | `15000` |
| `MAX_RUN_MINUTES` | `30` |
| `PUBLIC_BASE_URL` | Tunnel URL (informational) |
| `INTERCOM_ACCESS_TOKEN`, `INTERCOM_ADMIN_ID` | After-conversation fallback (§4.10). Empty = off. |
| `INTERCOM_REPLY_TYPE` | `comment` (customer sees it, default) or `note` (internal only) |
| `INTERCOM_REPLY_MODE` | `fallback` (default: only when the final webhook can't be delivered) or `always` |
| `SF_TARGET_ORG`, `SF_GUARD`, `SF_PRECHECK` | Salesforce guard (§4.7b). Overridden per customer by `config/customers.json` (§4.9). |

### 4.4 Start the bridge and sign it in to MeshMesh (one time)

```powershell
node src/server.js
```
1. Open `http://localhost:8787/oauth/start` in a browser on the same machine.
2. On the MeshMesh consent screen **"Fin MeshMesh PoC Bridge would like access to your account"**, click **Allow access**. The redirect to `localhost:8787` is expected.
3. Tokens are saved to `data/meshmesh-oauth.json` and refresh automatically.

### 4.5 Find the MeshMesh connection ID

```powershell
npm run probe
```
Copy the `id` of `Fin PoC Dev Org` into `MESHMESH_CONNECTION_ID`, set `MESHMESH_MODE=live`, and restart the bridge.

### 4.6 Expose the bridge publicly

```powershell
& "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe" tunnel --no-autoupdate --url http://localhost:8787
```
Note the `https://<random>.trycloudflare.com` URL. **It changes on every restart.** When it does, update the Fin connector's URL (step 5.4).

Check it: `https://<tunnel>/health` should return `{"ok":true,"mode":"live","meshmesh_authorised":true}`.

### 4.7 Bridge API contract

**`POST /requests`** (header `Authorization: Bearer <FIN_BEARER_TOKEN>`)

```json
{
  "requestor_email": "jane.doe@test.com",
  "field_label": "Renewal Risk",
  "field_type": "Text",
  "permission_set": "Fin PoC Access",
  "business_reason": "flag accounts at risk of not renewing",
  "callback_url": "https://api.intercom.io/hooks/procedures/callback/…",
  "final_callback_url": "https://api.intercom.io/hooks/procedures/callback/…",
  "conversation_id": "215476959156875"
}
```
Optional: `company_id` (customer key for §4.9).

Additional rejections (all `accepted:false`, HTTP 200): `problems: "no_connection: …"` (customer has no connected sandbox, §4.9), `"connection_not_ready: …"`, `"duplicate_field: …"`, `"precheck_unavailable"`.
When `final_callback_url` is present, the bridge sends **only the first** non-terminal update to `callback_url` and the **terminal** result to `final_callback_url`. Without it, everything goes to `callback_url` (legacy single-webhook mode).
- **Accepted (202):** `{"accepted":true,"request_id":"fmr_…","status":"accepted","field_api_name":"Renewal_Risk__c","missing_fields":"","problems":"","message":"…"}`
- **Rejected (200):** `{"accepted":false,"request_id":"","status":"rejected","field_api_name":"","missing_fields":"…","problems":"field_type must be one of Text, Number, Checkbox, Date","message":"…"}`
- **No or bad token:** `401`

**Status push to `callback_url`** (each change):
```json
{"request_id":"fmr_…","agent_id":"…","status":"planning|building|succeeded|failed","message":"…","is_terminal":"false|true","updated_at":"…"}
```

### 4.7b Independent Salesforce guard (`src/sfcheck.js`) — added after test T4
The bridge does not trust MeshMesh alone for safety or for the result. It runs its own **read-only** checks:

1. **One-time setup:** sign the Salesforce CLI in to the target org (in the PoC it was already signed in as alias `devhub`):
   ```powershell
   sf org login web --instance-url https://<your-my-domain>.my.salesforce.com --alias devhub
   ```
   Then set `SF_TARGET_ORG=devhub` and `SF_GUARD=true` in `.env`.
   - `SF_PRECHECK=true` (default) runs the duplicate pre-check. Set it to `false` **only** for a controlled-failure test where MeshMesh itself should detect the duplicate (T9). Post-verification stays on through `SF_GUARD`. Restart the bridge after changing it, and set it back to `true`.
2. **Pre-check (in `POST /requests`)**, before MeshMesh is called:
   - Query the Tooling API: `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Account'`.
   - If a field with the same **API name or label** already exists, return `accepted:false` with `problems:"duplicate_field: …"` and a customer-friendly `message`. Nothing is sent to MeshMesh, and nothing changes in Salesforce.
3. **Post-verify (in the worker)**, after MeshMesh reports `RESULT: SUCCEEDED`:
   - Re-query `FieldDefinition` to confirm the field exists with the requested type.
   - Query `FieldPermissions` to confirm the permission set has Read and Edit.
   - Only then push `succeeded`. Otherwise push `failed` with the specific problem.
4. **Health:** `GET /health` now shows `salesforce_guard: {ok, daily_api_remaining}`.
5. **Implementation note:** the CLI makes the calls (`sf api request rest … --target-org devhub`), so the bridge never sees a Salesforce token. Each check takes about 5–15 s, which is within Fin's 30-second connector limit.

> **Root cause of T4, and why `describe` must not be used.** `/sobjects/Account/describe` only returns fields the **running user has field-level security on**. The PoC fields are granted only through the *Fin PoC Access* permission set, which is not assigned to the integration user. So describe showed them as absent, and MeshMesh, running as the same user, concluded "does not exist" and upserted over the existing field. `FieldDefinition` lists metadata regardless of FLS. The MeshMesh prompt now also tells the agent to check with `FieldDefinition` and treat a match on API name or label as existing.

### 4.8 What the worker does (`src/worker.js`)

1. Builds a precise MeshMesh prompt from the inputs. The prompt includes a duplicate-field stop rule and requires a final `RESULT: SUCCEEDED` or `RESULT: FAILED - <reason>` line.
2. Calls `start_agent { name, prompt, mode:"plan", connectionIds:[<connection>] }` and gets back an `agentId`. Pushes `planning`.
3. Polls `get_agent_status` every 15 s. The observed shape is `status`, `isExecuting`, `waitingFor`, `phase`, `summary`, `recentMessages[]`.
   - `isExecuting:true` → still working
   - `status:"waiting"`, `isExecuting:false`, empty `waitingFor` → turn finished
   - `waitingFor:"confirmation"` → per-step approval needed
4. When the plan is ready, calls `continue_agent { agentId, message:"Approved…", mode:"build" }`. Pushes `building`.
5. If `waitingFor:"confirmation"` appears, approves it with `continue_agent`.
6. When the build turn finishes, reads the **last assistant message**, not `summary` (which lags), and maps its `RESULT:` line to `succeeded` or `failed`. Pushes the final status with `is_terminal:"true"`.
7. Failure messages to Fin start with `Reason: …`, and the technical `RESULT:` line is removed (`customerMessage()` in `notify.js`), so Fin relays the real cause (T9).

### 4.9 Per-customer Salesforce connection (POC-03)
**What MeshMesh allows:** its MCP tools can `list_connections`, `get_connection` and `attach_connection`, but **cannot create** a connection. A Salesforce connection is authorised once by the customer's Salesforce admin in **MeshMesh Studio → Connections → Salesforce** (OAuth sign-in to the sandbox). So Fin can't "initialise" the connection itself. The bridge handles the rest:

1. **Map customers to connections** in `config/customers.json` (git-ignored; copy `config/customers.example.json`):
   ```json
   {"connect_url": "https://studio.meshmesh.io",
    "customers": [{"name": "Northwind (PoC Dev Edition org)",
                   "match": {"email_domains": ["test.com"], "company_ids": []},
                   "meshmesh_connection_id": "b6ef3fbf-…", "sf_target_org": "devhub"}]}
   ```
   `sf_target_org` is the Salesforce CLI alias the read-only guard uses for that customer's org (`sf org login web --alias <alias>`).
2. **On each request** the bridge:
   - finds the customer, by `company_id` if sent, else by email domain;
   - calls MeshMesh `list_connections` to check the connection is **present, enabled and has credentials**;
   - starts MeshMesh with **that customer's** `connectionIds`, and runs the pre-check and post-verify against **that customer's** org.
3. **Unknown customer, or connection not ready:** `accepted:false` with `no_connection` / `connection_not_ready`. Fin tells the customer that nothing was changed and how their admin connects the sandbox. **Nothing runs against another customer's org.**
4. Without `config/customers.json`, the bridge uses the single `MESHMESH_CONNECTION_ID` / `SF_TARGET_ORG` (PoC default).
5. **Production note:** the PoC keys on the typed email domain. In production, key on Intercom's **verified** company or user identity (Messenger identity verification) so a customer can't claim another company's domain.

**Onboarding a new customer:** (a) their admin connects the sandbox in MeshMesh Studio; (b) you run `npm run probe` to get the new connection id; (c) `sf org login web --alias <customer>-sbx` for the guard; (d) add the entry to `config/customers.json` (no restart needed; it's read on each request).

### 4.10 Updates after the conversation ends
- **Customer leaves but the conversation stays open** (closes the tab or browser): works with no extra setup. The Procedure keeps waiting, the final webhook is delivered, and the message is waiting, marked **New**, when the customer returns. Tested live in T10.
- **Conversation closed, or the 20-minute wait expired:** Fin's webhook URL no longer accepts the result (HTTP 404). The bridge then **replies into the conversation through the Intercom REST API** as a customer-visible comment. That reopens the conversation, and Intercom emails the customer if they're away. Requirements:
  1. The connector body sends `"conversation_id": "{{conversation.id}}"` (§5 step 6). **Done**: verified, the bridge received `215476959156875`.
  2. **An access token (you create it):** Intercom → **Settings → Integrations → Developer Hub** → **New app** (name `MeshMesh PoC Bridge`, workspace CRDemo) → **Authentication** → copy the **Access token**. Make sure the app's permissions allow writing conversations (replies) and reading admins; the exact labels in Intercom may differ slightly.
  3. **Your admin ID:** Developer Hub → your app → **API**, or call `GET https://api.intercom.io/me` with the token; the `id` field is the admin ID.
  4. Put both in the bridge `.env` yourself (never paste them in chat): `INTERCOM_ACCESS_TOKEN=…`, `INTERCOM_ADMIN_ID=…`. Restart the bridge.
  5. **Test:** take a conversation id from `data/events.log` (`request_received.body.conversation_id`) and run `node scripts/test-after-conversation.js <id>`. The conversation should show *"Update on your Salesforce request fmr_fallback_test: completed…"* as a reply from your admin.
- Status: code done, connector updated, **token pending** (owner: you).

---

## 5. Intercom: Data connector

Path: **Settings → Integrations → Data connectors → + New data connector → Create from scratch**

1. **Name:** `Start Salesforce configuration (MeshMesh PoC)`
2. **Description:** internal note about the PoC.
3. **Data inputs** (all Format = Text, Data source = **Let Fin collect**):

   | Name | Description (Fin reads this) | Required |
   |---|---|---|
   | `requestor_email` | Email of the person requesting the change | Yes |
   | `field_label` | Label of the new Account field, max 40 characters | Yes |
   | `field_type` | Exactly one of Text, Number, Checkbox, Date | Yes |
   | `permission_set` | Permission set to get Read/Edit (created if missing) | Yes |
   | `business_reason` | Short business reason | Yes |
   | `callback_url` | Webhook URL of the Procedure's progress Wait for webhook. Set by the Procedure; never ask the customer. | **No** |
   | `final_callback_url` | Webhook URL of the Procedure's final-result Wait for webhook. Set by the Procedure; never ask the customer. | **No** |

4. **API endpoint:** Method **POST**, URL `https://<tunnel>/requests`.
5. **Authentication → No authentication → + New token:**
   - Name `MeshMesh PoC Bridge`, Type **Text**, Header `Authorization`, Value `Bearer <FIN_BEARER_TOKEN>` (copied from the bridge `.env`).
   - Make sure it's ticked.
6. **Body → JSON:**
   ```json
   {"requestor_email": "{{requestor_email}}", "field_label": "{{field_label}}", "field_type": "{{field_type}}", "permission_set": "{{permission_set}}", "business_reason": "{{business_reason}}", "callback_url": "{{callback_url}}", "final_callback_url": "{{final_callback_url}}", "conversation_id": "{{conversation.id}}"}
   ```
   Use **Add data** or type the `{{…}}` placeholders. For `conversation_id`, use the expand icon on the JSON box → **Add data** → search *Conversation ID* (conversation attribute). The narrow inline editor scrolls sideways and is easy to garble.
7. **Headers → Add key and value:** `Content-Type` = `application/json`.
8. **Test → Live request** with a safe invalid value, for example `field_type = Picklist`. Expect **Pass 200 OK** and `accepted:false`. This proves Intercom → tunnel → bridge and auth without starting MeshMesh. Optionally switch to **Mock response** with an accepted sample, so Preview has a positive example.
9. **Fin tab:**
   - **Prompt:** use only after explicit customer confirmation; never ask for callback_url; on `accepted=false`, explain `missing_fields` and `problems`; on `accepted=true`, share `request_id`.
   - **Directly:** **off** (only the Procedure may run it).
10. **Save draft → Set live** (add a version note).

---

## 6. Intercom: Fin Procedure

Path: **Fin AI Agent → Train → Procedures → + New procedure → Create from scratch → Text → Continue**

1. **Title:** `Salesforce Setup Assistant (MeshMesh PoC)`
2. **Fin availability:** keep **Disabled** until tested.
3. **Trigger → Based on the conversation:** "The customer wants help configuring Salesforce, for example adding a new custom field to the Account object or giving a permission set access to a field, and wants it done for them in their Salesforce org."
4. **Instructions** (press Enter for each new step; type `@` to insert tools):
   1. Tell the customer you can create one custom field on Account and give a permission set Read/Edit, and that you need a few details.
   2. Collect the five details, asking only for missing or ambiguous ones. Field type must be Text, Number, Checkbox or Date. If they ask for Picklist or another type, explain it isn't supported and ask them to choose. Don't continue until all five are known.
   3. Show a summary and require an explicit **yes** before anything changes. If no, ask what to change.
   4. After confirmation, call **`@` → Call data connector → Start Salesforce configuration (MeshMesh PoC)** with the five details. Set callback_url to the webhook URL of the Wait for webhook step below.
   5. If `accepted = false`, explain `missing_fields` and `problems`, re-collect, re-confirm and call again. On an error, say nothing was changed.
   6. If `accepted = true`, share the `request_id`, say MeshMesh is configuring the org, then wait using **`@` → Wait for webhook** (#1, progress).
   7. When the first MeshMesh status update arrives, relay its message as a short progress update and say the final result will follow. This update is never the final result. Then wait using **`@` → Wait for webhook** (#2, final result).
   8. **Condition step** (type `/` → **Condition**, then switch the format to **Code**, so branches are decided by exact Python evaluation, not by the AI):
      - **IF** `inputs["webhook"]["meshmesh_result"]["status"] == "succeeded"` → Instruction: confirm the configuration is complete and independently verified, summarise the result, and give the next step (assign the permission set to users).
      - **ELSE IF** `inputs["webhook"]["meshmesh_result"]["status"] == "failed"` → Instruction: say it did NOT complete and the change was not made, give the reason, and offer a teammate. Add: *"Use only the reason written in the meshmesh_result message (it starts with "Reason:"); never guess or invent a cause such as a deployment error."* Without this, Fin made up a cause in test T9.
      - **ELSE** → Instruction: say the result can't be confirmed yet, a teammate will verify, then hand off to the team.

      Use the condition panel's **Test** button: `succeeded` → True, `preview` → False (both verified in the PoC).
5. **Configure Wait for webhook #1** (click the chip):
   - Name: `meshmesh_status`
   - **Response attributes** (Text): `status`, `message`, `is_terminal`, `request_id`
   - **Wait time:** 15 minutes. On timeout, hand off to **Team → Default** with: "MeshMesh hasn't reported back in time… A teammate will check your org and follow up here."
6. **Configure Wait for webhook #2:**
   - Name: `meshmesh_result`
   - **Response attributes** (Text): `status`, `message`, `request_id`
   - **Wait time:** 20 minutes. Timeout message: "MeshMesh hasn't sent a final result in time… A teammate will check your org and follow up here."
7. **Map both callback URLs:** click the connector chip in step 4. Under **Input parameters**, set:
   - `callback_url` → **Wait for webhook → meshmesh_status callback URL**
   - `final_callback_url` → **Wait for webhook → meshmesh_result callback URL**

   The red warnings on both webhook chips disappear.
8. Click **Save to Fin Main**.

---

## 7. Testing

### 7.1 Preview modes (important)
- **Preview user / New lead + "Use sample response data":** Fin uses the connector's saved example response, and the webhook resolves with preview values. Good for conversation logic only.
- **Real run:** open **Preview → … → Settings → Test as → User or lead**, pick a **test contact** (PoC used `jane.doe@test.com`), select **Data connector behavior → Access and update real user data when triggered**, and click **Save**. Then restart the preview conversation. Fin now calls the real bridge, and the bridge's first status push reaches the real callback URL.
  - The setting can reset to "Preview user" when you reopen Test. Check "Testing as" before every run.
- **Observed limitation:** even in real-data mode, Preview really waits only for the **first** Wait-for-webhook. Later waits resolve at once with the attribute **preview values**. So Preview proves Fin → bridge → MeshMesh → Salesforce plus the first progress update, but not the final message.
  - Set the final webhook's preview values to a neutral status (`preview`), and make the Procedure treat unknown statuses as "can't confirm yet". Then Preview can never show a false success.
  - The final result in Fin can only be shown end to end in a **live Messenger conversation** (Procedure availability enabled for a test audience).

### 7.2 Test scenarios and results

| # | Scenario | Expected | Result |
|---|---|---|---|
| T1 | Happy path: all details given | Request ID → progress → success; field visible in Salesforce | **Pass** in Salesforce (Renewal Risk, Last Health Check). Fin showed the real request ID and progress. The final Fin message isn't verifiable in Preview. |
| T2 | Missing details ("add Renewal Risk to Account") | Fin asks only for email, type, permission set, reason | **Pass** |
| T2b | Unsupported type (Picklist) | Fin refuses and asks for Text, Number, Checkbox or Date | **Pass** |
| T3 | Confirmation gate | Summary + explicit yes before any call | **Pass** |
| T4 | Duplicate field (`PoC Customer Tier` already exists) | MeshMesh stops; Fin reports failure, no false success | First run **Fail**: MeshMesh missed the existing field and overwrote it (Text 50 → 100). **Re-test after the guard: Pass.** The bridge rejected it before MeshMesh ran, and Fin replied: "a field called 'PoC Customer Tier' already exists… I couldn't create a duplicate. Could you please provide a different field label?" Nothing changed in Salesforce. |
| T5 | Connector auth | Missing or wrong token → 401 | **Pass** (bridge test) |
| T6 | Invalid input at connector level | `accepted:false` with `problems` | **Pass** (live connector test) |
| T7 | **Live Messenger** happy path (FIN Agent site, visitor identified as jane.doe@test.com) | Request ID → progress → real final message | **Pass** (22 Nov). `fmr_b323a19e` Account Health Score, Number: Fin showed the request ID, then "planning", and about 4.5 minutes later the final message "The Salesforce configuration is now complete and has been independently verified…" from the Code Condition's *succeeded* branch. Final webhook HTTP 200. |
| T8 | **Live Messenger** duplicate (`PoC Customer Tier`) | Refused, no change | **Pass** (22 Nov). The bridge guard rejected it (`precheck_duplicate`), and Fin asked for a different label. The field is still Text(50). |
| T9 | **Live Messenger, failure reported by MeshMesh itself** (pre-check off with `SF_PRECHECK=false`; duplicate of `Account Health Score`, Number, so even a wrong redeploy would be identical and harmless) | MeshMesh reports FAILED; Fin says not done, gives the real reason, no false success | **Pass** after one fix (22 Nov). `fmr_251a4833`: MeshMesh stopped in planning with `RESULT: FAILED - duplicate field`, final webhook 200, and Fin took the *failed* branch, **but it invented the cause** ("error during the final deployment phase"). Fix: the bridge now starts failure messages with `Reason: …` and drops the `RESULT:` line (`customerMessage()` in `src/notify.js`), and the failed-branch instruction says to use only that reason. Re-test `fmr_7c4cc1d5`: Fin said *"The requested field label 'Account Health Score' already exists on the Account object."* The field is unchanged (LastModifiedDate is still its creation time). The pre-check is back on. |

| T10 | **Customer leaves mid-run** (live Messenger) | Result still reaches the customer | **Pass** (22 Nov). `fmr_f96148ba` Last QBR Date (Date): after the request ID and the "planning" update, the site was closed. MeshMesh finished, post-verify passed, and the final webhook returned 200. When the site was reopened, the final "complete and independently verified" message was waiting, marked **New**. Salesforce: `Last_QBR_Date__c` Date, Fin PoC Access Read/Edit. |
| T11 | **POC-03: customer without a connected sandbox** (live Messenger, email `ops@unknown-co.io`) | Refused before anything runs, with connect instructions | **Pass** (22 Nov). Fin: *"I was unable to start the configuration because your Salesforce sandbox is not connected yet. Nothing was changed… A Salesforce admin at your company needs to connect the sandbox in MeshMesh (https://studio.meshmesh.io: Connections > Salesforce > sign in to the sandbox)."* A known customer (test.com) was routed to its own connection (checked with `list_connections`) and its own org for the guard. |
| T12 | Connector sends `conversation_id` (for the after-close fallback) | Bridge receives the Intercom conversation id | **Pass**: `215476959156875` received. The REST reply itself awaits the access token (§4.10). |

### 7.1b Running a live Messenger test (how the final result was shown)
Preview can't deliver the second webhook, so the final result was shown in a real Messenger conversation:
1. **Procedure → Fin availability → Enabled**, then **Save/Publish to Fin Main**.
2. **Trigger → Channels: Web.** The original setting was *Salesforce Cases* only, and the Procedure never triggered in the Messenger.
3. **Trigger → Audience:** a test-only audience, **Fin PoC tester** (Settings → Data → Audiences), with the rule **Email is `jane.doe@test.com`**. The Experience Cloud site identifies its visitor to Intercom as `jane.doe@test.com`, not as the Salesforce community user's login, so the audience has to match the email Intercom actually sees. Check it in Inbox → the conversation → contact.
4. Open the site with the Messenger test parameters: `https://<site>/?intercomTest=true&messenger_environment=<env id>`, then **Messages → Ask a question**.
5. Afterwards, set **Fin availability → Disabled** and save. *(Done on 22 Nov after T7/T8.)*

Expect about **4–5 minutes** between "Yes" and the final message: plan, then build, then MeshMesh's own verification, then the bridge's verification. Fin shows only the first progress update during that time, so tell customers up front how long it takes.

### 7.2b Demo recording (deliverable 1)
A real, full-screen recording of one run, made by a person in a normal browser. Step-by-step script with the exact messages, timings and narration: **[docs/demo/Demo-Script.md](demo/Demo-Script.md)**.
- Recorder: Windows Snipping Tool (**Win + Shift + R**), or `.\scripts\record-demo.ps1`. The script was tested at 1920×1200, 30 fps, and reads true pixels even with display scaling; press **q** to stop.
- Optional live console: `.\scripts\watch-log.ps1` shows Fin → bridge → MeshMesh → Salesforce check → Fin in plain lines.
- Keep the MP4 out of git (`*.mp4` is ignored). Share it through SharePoint or OneDrive.

### 7.3 Verifying in Salesforce
- **Field:** Setup → Object Manager → Account → Fields & Relationships → search the API name (for example `Renewal_Risk__c`).
- **Layout:** Object Manager → Account → Page Layouts → Account Layout → field present in "Account Information".
- **FLS:** Setup → Permission Sets → *Fin PoC Access* → Object Settings → Accounts → field shows Read + Edit.

### 7.4 Logs and evidence
- Bridge event log: `fin-meshmesh-bridge/data/events.log` (requests, MeshMesh status snapshots, each push to Fin with HTTP result).
- Request records: `data/requests.json` and `GET /requests/<id>`.
- MeshMesh: studio.meshmesh.io → the agent named `Fin PoC fmr_…` (plan, steps, verification report).
- Intercom: conversation in Inbox → **Show conversation events**, and the connector **Logs** tab.

---

## 8. PoC run log (21 Nov 2026, all against Dev Edition org `orgfarm-8414c843e4`)

| Request | Started from | Field | Bridge → MeshMesh | MeshMesh result | Verified in Salesforce |
|---|---|---|---|---|---|
| (UI spike) | MeshMesh web UI | PoC Customer Tier, Text(50) | n/a | Success | ✅ field, layout, new permission set `Fin_PoC_Access` (Read/Edit) |
| `fmr_b3c3177b` | Bridge API (curl) | PoC Renewal Score, Number(18,0) | plan → approve → build | `RESULT: SUCCEEDED` (~3 min) | ✅ field, layout, FLS |
| `fmr_4a3e37f1` | **Fin** (Preview as jane.doe@test.com, real data) | Renewal Risk, Text(100) | progress webhook **200** | `RESULT: SUCCEEDED` (~3.5 min) | ✅ `Renewal_Risk__c`; Fin PoC Access Read ✓ Edit ✓ |
| `fmr_1a700a31` | **Fin** (two-webhook design) | Last Health Check, Date | progress webhook **200**, building updates held back, final sent to webhook #2 | `RESULT: SUCCEEDED` (~4 min) | ✅ `Last_Health_Check__c` (Date) on Account; on Account Layout below Renewal Risk |
| `fmr_3c3b7929` | **Fin**: controlled failure (duplicate "PoC Customer Tier") | already existed (Text 50) | progress webhook 200 | ❌ **Expected FAILED, got `RESULT: SUCCEEDED`**. MeshMesh's discovery reported "field does not exist" and deployed anyway. | ⚠️ Existing `PoC_Customer_Tier__c` was **modified from Text(50) to Text(100)** (metadata deploy = upsert) |

| *(after fixes)* `precheck` | **Fin**: duplicate "PoC Customer Tier" | already exists | **Rejected by the bridge guard before MeshMesh**; Fin asked for a different label | not run | ✅ nothing changed |
| `fmr_78112c70` | **Fin** (after fixes) | Onboarding Owner, Text | progress webhook 200; Preview final → Code Condition ELSE ("cannot confirm yet"), not a false success | `RESULT: SUCCEEDED` + **bridge post-verify ok** | ✅ `Onboarding_Owner__c` Text(100) + Fin PoC Access Read/Edit (checked by the bridge's independent query) |
| `fmr_b323a19e` (22 Nov) | **Fin live Messenger** (FIN Agent site) | Account Health Score, Number | progress webhook **200**, final webhook **200**; Fin showed the real final success message | `RESULT: SUCCEEDED` (~4.5 min) + post-verify ok | ✅ `Account_Health_Score__c` Number(18,0); Fin PoC Access Read ✓ Edit ✓ |
| `precheck` (22 Nov) | **Fin live Messenger**: duplicate "PoC Customer Tier" | already exists | rejected by the guard | not run | ✅ unchanged, Text(50) |
| `fmr_251a4833` (22 Nov) | **Fin live Messenger**, pre-check off: duplicate "Account Health Score" | already exists | progress 200, final 200 (failed) | `RESULT: FAILED - duplicate field` (in planning, ~45 s) | ✅ unchanged. ⚠️ Fin invented the cause; fixed |
| `fmr_7c4cc1d5` (22 Nov) | same, after the reason fix | already exists | progress 200, final 200 (failed) | `RESULT: FAILED - duplicate field` | ✅ unchanged; Fin quoted the real reason |
| `fmr_f96148ba` (22 Nov) | **Fin live Messenger**, customer left mid-run | Last QBR Date, Date | progress 200, final 200 while the site was closed | `RESULT: SUCCEEDED` (~4 min) + post-verify ok | ✅ `Last_QBR_Date__c` Date; Fin PoC Access Read ✓ Edit ✓; message waiting on return |
| `no_connection` (22 Nov) | **Fin live Messenger**, unknown company | Strategic Account, Checkbox | rejected (POC-03) | not run | ✅ nothing changed |

> **Key risk found (T4).** MeshMesh's read-only discovery gave a false "does not exist" for an existing custom field, and the metadata deploy then silently **overwrote** the field definition. Widening a field is harmless, but narrowing it, or changing its type, could truncate or lose data. Recommendations:
> 1. Add an **independent pre-check** in the bridge: a read-only Salesforce describe through its own integration user, or a separate read-only MeshMesh research run whose result the bridge parses. Reject duplicates before any build.
> 2. Ask MeshMesh to run a **validate-only deploy and report "Changed" vs "Created"** components, and fail if any existing component would change unexpectedly.
> 3. Raise this with the MeshMesh team as a product issue (discovery accuracy, plus an upsert warning in plans).

**What this proves:**
- POC-01 (collect inputs), POC-02 (validate and refuse incomplete or unsupported input), POC-03 (connections), POC-04 (hand-off with request ID), POC-05 (execution, verified in Salesforce) and POC-06 (at least one real intermediate status shown in Fin) all pass **through Fin**.
- POC-07 and POC-08 (final status in Fin) **pass end to end in the live Messenger** (T7, T8 on 22 Nov). Intercom Preview cannot show them, because it doesn't deliver the second webhook, and in early Preview runs Fin made up a success message. The deterministic Code Condition on `meshmesh_result.status` (§6 step 8) prevents that: Preview now falls through to "can't confirm yet".

A MeshMesh-reported failure (not just the bridge's pre-check) was also shown live in T9, and Fin relayed the real reason after the fix. See the one-page **[Readout](Fin-MeshMesh-PoC-Readout.md)** for the summary, risks and dependencies.

**Recommendation: Proceed (iterate on hardening).** The full loop works: Fin conversation → bridge → MeshMesh → Salesforce → verified final status in Fin, with failures blocked before any change. MeshMesh's own duplicate detection was unreliable (T4), so the independent Salesforce guard and post-verify in the bridge are **required**, not optional. Before a pilot: host the bridge, use least-privilege identities, and raise the discovery/upsert issue with MeshMesh (§11).

---

## 9. Operations and troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Fin says "issue starting the configuration" but the bridge log shows nothing | Preview is using sample data | Preview Settings → User or lead + **Access and update real user data** |
| Connector test returns 401 | Token missing, wrong, or no `Bearer ` prefix | Re-check the token value `Bearer <FIN_BEARER_TOKEN>` |
| Connector times out | Tunnel down or URL changed | Restart cloudflared; update the connector URL; **Set changes live** |
| `/health` shows `meshmesh_authorised:false` | MeshMesh OAuth missing or expired | Open `http://localhost:8787/oauth/start` and Allow |
| MeshMesh agent asks for a connection | `connectionIds` not passed | Set `MESHMESH_CONNECTION_ID` |
| Outcome misread | Agent didn't print a RESULT line | The bridge asks once for an explicit verdict, otherwise reports failure |
| MeshMesh "Grant type not supported" | Environment mismatch (Sandbox vs Production install) | Use Custom domain with the org's My Domain URL |
| Procedure never waits | callback_url not mapped | Step 6.6 |
| Procedure doesn't trigger in the live Messenger | Channel set to Salesforce Cases only, or the audience doesn't match the identified visitor | Channels → Web; audience rule on the email Intercom actually sees (§7.1b) |
| Fin: "configuration could not be started" right after Yes | Quick tunnel dropped (HTTP 530) and the URL changed | Restart cloudflared, update the connector URL, **Set changes live**. A hosted endpoint avoids this. |
| Final message seems slow | Normal: plan + build + two verifications take about 4–5 minutes | Wait; check `data/events.log` for `postverify` / `notify_fin succeeded` |

---

## 10. Security notes
- PoC runs only against a Developer Edition org. Production is out of scope (MeshMesh can only read production orgs anyway).
- MeshMesh agents started over MCP run unattended. Safety comes from Fin's explicit customer confirmation, the bridge starting in **plan** mode, prompts scoped to "change nothing else", and a least-privilege Salesforce user (recommended beyond the PoC).
- Secrets: `FIN_BEARER_TOKEN` lives in the bridge `.env` and as an Intercom token. MeshMesh OAuth tokens live in `data/meshmesh-oauth.json`. Both are git-ignored and must never be pasted in chat or tickets.
- The quick tunnel URL is public but useless without the bearer token. A production design would use a stable hosted endpoint, a secret manager, and request signing.

## 11. Moving beyond the PoC
0. ✅ *Done in the PoC:* deterministic Code Condition on the final status (§6 step 8), the independent Salesforce guard (§4.7b), and the final Fin message shown end to end in a live Messenger (T7/T8). The Procedure is back to **Disabled**.
1. Host the bridge (Azure Functions, Cloud Run or Heroku) with a fixed URL. Replace the quick tunnel.
2. Use a dedicated MeshMesh service identity and a least-privilege Salesforce integration user.
3. Add more use cases as separate Procedures, each with its own input contract.
4. Push progress via the Intercom REST reply API for after-hours or closed conversations.
5. Replace the JSON store with a database. Add retries and idempotency on `request_id`.
