# Fin × MeshMesh: Technical Configuration Guide (Step by Step)

_Version 2.0 · 22 Nov 2026 · v2 adds generic setup requests (§12); §0–§11 describe the v1 single-field PoC, which still works unchanged_

This guide rebuilds the whole PoC from scratch: an **Intercom Fin** conversation collects a Salesforce change request, a small **bridge service** hands it to **MeshMesh** (Salesforce's AI configuration agent), MeshMesh configures the **Salesforce org**, and progress and the final result flow back into the Fin conversation.

> **v1 PoC use case (§0–§11):** create one custom field on **Account** (type Text, Number, Checkbox or Date), add it to the default Account page layout, and grant a permission set Read/Edit field-level security on it.
>
> **v2 (§12): any Salesforce setup request.** The customer describes the change in their own words (for example *"set up outbound HTTPS callouts to our ERP"*, *"create an External Client App for our integration"*, *"add a validation rule on Opportunity"*, *"assign the Sales Ops permission set to jo@acme.com"*). MeshMesh plans it, the bridge checks the plan against a policy and the org, **the customer approves MeshMesh's actual plan in Fin**, then MeshMesh builds it and the bridge verifies every component. Jump to [§12](#12-v2-generic-setup-requests).

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
  2. **An access token (you create it):** Intercom → **Settings → API tokens** (`/settings/personal/authentication`) → **Create API token** → name `MeshMesh PoC Bridge` → copy it. **Don't reuse or revoke the existing "Salesforce" tokens**: they belong to CRDemo's Salesforce integration. *(Alternative: Developer Hub → New app → Authentication → Access token.)*
  3. **Your admin ID:** Settings → Teammates → click your name → the number after `/admins/` in the URL, or `GET https://api.intercom.io/me` with the token (`id`). In the PoC it's `12048801`.
  4. Put both in the bridge `.env` yourself (never paste them in chat): `INTERCOM_ACCESS_TOKEN=…`, `INTERCOM_ADMIN_ID=…`. Restart the bridge.
  5. **Test:** take a conversation id from `data/events.log` (`request_received.body.conversation_id`) and run `node scripts/test-after-conversation.js <id>`. The conversation should show *"Update on your Salesforce request fmr_fallback_test: completed…"* as a reply from your admin.
- **Status: working (22 Nov, T13).** The token was checked (`GET /me` → admin 12048801, workspace d29t5bj9). `node scripts/test-after-conversation.js 215476959156875` → `intercom_reply: 200`, and the customer saw *"Update on your Salesforce request fmr_fallback_test: completed…"* in the Messenger, marked **New**.
- **Notes for production:** (a) the reply appears as sent by the admin whose ID is configured (in the PoC, a real teammate), so use a dedicated bot teammate such as "Salesforce Setup Bot"; (b) an admin reply can reopen and assign the conversation, so check your inbox rules; (c) the bridge sends it only when the final webhook fails (`INTERCOM_REPLY_MODE=fallback`), so customers don't get the result twice.

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
| T12 | Connector sends `conversation_id` (for the after-close fallback) | Bridge receives the Intercom conversation id | **Pass**: `215476959156875` received. |
| T13 | **After-close reply** through the Intercom REST API | Final result reaches the customer without Fin's webhook | **Pass** (22 Nov). With no webhook available, the bridge posted a comment (HTTP 200), and the customer saw it in the Messenger, marked **New** (§4.10). |

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

---

## 12. v2: generic setup requests

### 12.1 What changed and why
v1 had a fixed input contract (field label, field type, permission set), a field-only prompt and field-only checks. Every new kind of setup would have needed new Fin inputs, a new prompt and new checks. v2 makes the bridge **independent of the kind of setup**:

| Concern | v1 (single field) | v2 (any setup) |
|---|---|---|
| What Fin collects | 5 fixed inputs | `change_request` (free text), `requestor_email`, `business_reason` |
| Who decides *how* | The bridge's prompt | MeshMesh plans it (plan mode, read-only) |
| What the bridge needs to understand | Field label/type | Only MeshMesh's **CHANGESET**: a JSON list of every component it will create or modify |
| Safety | Field duplicate check | **Policy** (allow/deny by metadata type and action) + **org pre-check** on every component |
| Customer approval | Fin's summary of the inputs, then auto-approve | **MeshMesh's actual plan**, approved by `plan_version` |
| Verification | Field exists + FLS | Every CHANGESET item exists, **plus drift detection**: anything that changed but wasn't approved → `needs_review` |

```
 Customer ─chat─► Fin Procedure "Salesforce Setup Assistant (MeshMesh v2)"
   │ ① connector "Plan Salesforce change"  POST /requests {change_request, …, plan_callback_url}
   ▼
 Bridge ── start_agent(plan) ──► MeshMesh ── read-only discovery ──► Salesforce org
   │  parse CHANGESET → policy (config/policy.json) → org pre-check (sf CLI, listMetadata)
   │ ② POST plan_callback_url  {status: plan_ready | needs_input | rejected | failed, message, changes, warnings, plan_version}
   ▼
 Fin shows the plan → customer says yes / asks for a change / cancels
   │ ③ connector "Decide on Salesforce plan"  POST /requests/:id/decision {decision, plan_version, callback_url, final_callback_url}
   ▼
 Bridge: snapshot org → continue_agent(build, "build exactly this list") → poll
   │ ④ POST callback_url        {status: building}            (one progress update)
   │    post-verify every item + drift check
   │ ⑤ POST final_callback_url  {status: succeeded | failed | needs_review}
   ▼
 Fin: Code Condition on status → success / failure (with real Reason) / teammate review
```

The v1 connector keeps working unchanged: a request with `field_label`/`field_type` is translated into a `change_request`, goes through the same CHANGESET, policy and verification, and is auto-approved (the customer already confirmed Fin's summary). Its duplicate check still answers synchronously (`accepted:false`, `duplicate_field`), as in T4/T8.

### 12.2 The CHANGESET contract (`src/changeset.js`, `src/prompt.js`)
The plan prompt makes MeshMesh end its plan with:
```
BEGIN_CHANGESET
[{"action":"create","type":"NamedCredential","name":"Partner_API","label":"Partner API","summary":"https://api.example.com"},
 {"action":"create","type":"ExternalCredential","name":"Partner_API","summary":"custom auth, one principal"},
 {"action":"modify","type":"PermissionSet","name":"Fin_PoC_Access","summary":"access to the Partner_API principal"}]
END_CHANGESET
```
- `action`: `create`, `modify` or `assign` (`update`/`edit` → `modify`, `remove` → `delete`).
- `type`: Salesforce **Metadata API type name**; `name`: the full name (`Account.Renewal_Risk__c`, `Account-Account Layout`). A permission set assignment is `{"action":"assign","type":"PermissionSetAssignment","name":"<PermissionSet API name>:<username>"}`.
- If the block is missing, the bridge asks MeshMesh once for it; if it's still missing, the request ends `failed` and nothing is built.
- `plan_version` (`pv_…`) is a hash of the list. The customer approves that version; if MeshMesh's plan changes (revision), the old version can't be approved.

Other prompt rules: plan only, check existence with Tooling/Metadata API (never describe; T4), never delete, never touch blocked types, **never generate, print or ask for secrets**, ask one question with `RESULT: NEEDS_INPUT - …` when a detail has no safe default, and a plain-language summary first (that's what Fin shows). The customer's text is fenced as requirements so it can't override the rules; the policy check is the real guard either way.

**Picking the right component.** The prompt tells MeshMesh to use what Salesforce recommends and to say so when the customer names the wrong thing. Example: *"External Client App for outbound HTTPS requests"*: an External Client App is for **inbound** OAuth clients calling Salesforce. Outbound callouts from Salesforce use a **Named Credential + External Credential** (plus permission set access to the principal), or a Remote Site Setting for simple legacy cases. MeshMesh explains this in the plan summary, and the customer approves the corrected plan.

### 12.3 Policy (`config/policy.json`, `src/policy.js`)
Read on every request (no restart needed). Checked **before** the customer is asked.

| Key | Meaning |
|---|---|
| `allowed_types` | Metadata types allowed through chat (fields, objects, validation rules, record types, layouts, Lightning pages, tabs, apps, permission sets and groups, assignments, queues, groups, roles, value sets, custom labels and permissions, Remote Site Settings, CSP Trusted Sites, Named/External Credentials, External Client Apps and their `ExtlClntApp*` settings, custom metadata). Anything else is refused (**fail closed**). |
| `blocked_types` | Always refused: Apex, triggers, Visualforce, LWC/Aura, static resources, profiles, sharing, security/session settings, Connected Apps, auth providers, SSO, certificates, **Flows** (MeshMesh flow support is experimental), users. |
| `allowed_actions` | `create`, `modify`, `assign`. **Delete is never allowed.** |
| `modify_allowed_types` | Types whose *existing* components may be changed (permission sets, layouts, pages, apps, value sets, credentials, External Client Apps…). Everything else is create-only, so an existing field can't be overwritten (T4). |
| `watch_types` | Snapshotted before the build for drift detection (default: CustomField, CustomObject, PermissionSet, Layout, ValidationRule). |
| `max_components` | Plan size limit (default 30). |

Refusals go to Fin as `status: rejected` with `Reason: … can't be done through chat (<type> <name>: <why>)`. Credential and OAuth components add a warning: secrets are never shown or entered in chat; the admin handles them in Setup. `src/notify.js` also redacts anything that looks like a secret before it reaches Fin or the Intercom reply.

### 12.4 Independent Salesforce guard, generic (`src/guard.js`)
Same principle as §4.7b (read-only, through the Salesforce CLI, the bridge never sees a token), now for any metadata type:
1. **Pre-check (after the plan, before the customer sees it):** `sf org list metadata --metadata-type <type>` for each type in the CHANGESET. A `create` of something that exists → `rejected` (`… already exists`). For fields, the label is also checked through Tooling `FieldDefinition`. A `modify` of something that doesn't exist is noted ("will be created"). Assignments are checked with SOQL on `PermissionSetAssignment`.
2. **Snapshot (just before the build):** `fullName → lastModifiedDate` for the CHANGESET types plus `watch_types`.
3. **Post-verify (after `RESULT: SUCCEEDED`):** every item must exist → else `failed` with the missing items. Then a **drift check**: any component of a snapshotted type that is new, changed or removed but is **not in the approved CHANGESET** → `needs_review` (Fin hands off to a teammate). Salesforce side effects of creating something (for example the layout and list views of a new object, or an External Client App's settings children) are tolerated by name prefix.
4. Types `listMetadata` can't enumerate without a folder (email templates, reports, dashboards, documents) are reported as "not auto-checkable" rather than verified.

> Drift detection compares the org before and after, so a change someone else makes in the same org during the 3–5 minute build also shows up as `needs_review`. That's intended (better a human check than a false success), but test in a quiet sandbox.

Dry run without MeshMesh (checks policy, the CLI login and the pre-check):
```powershell
node scripts/plan-check.js examples/changeset-outbound.json devhub
node scripts/plan-check.js examples/changeset-duplicate.json devhub   # expect conflicts: PoC_Customer_Tier__c already exists
```

### 12.5 Bridge API v2
**`POST /requests`** (Bearer token, connector ①)
```json
{
  "requestor_email": "jane.doe@test.com",
  "change_request": "Set up outbound HTTPS callouts from Salesforce to https://api.partner.example.com for the integration team. Auth is an API key header; our admin will enter the key.",
  "business_reason": "Sync orders to our ERP",
  "plan_callback_url": "https://api.intercom.io/hooks/procedures/callback/…",
  "conversation_id": "{{conversation.id}}"
}
```
- `change_request` 15–4000 characters. `plan_callback_url` is **required** for free-form requests (they are never auto-approved).
- `202 {"accepted":true,"request_id":"fmr_…","status":"accepted","approval":"customer","message":"… Nothing will change until you approve the plan."}`
- Rejections as before (`accepted:false`, HTTP 200): validation, `no_connection`, `connection_not_ready`.

**Plan webhook → `plan_callback_url`** (one delivery)
```json
{"request_id":"fmr_…","status":"plan_ready","message":"<MeshMesh's plain-language summary>","changes":"1. Create ExternalCredential Partner_API …\n2. Create NamedCredential Partner_API …\n3. Update PermissionSet Fin_PoC_Access …","warnings":"Passwords, API keys or tokens … are not entered through chat …","plan_version":"pv_3f9a1c02de","change_count":"3","is_terminal":"false"}
```
`status` is one of `plan_ready`, `needs_input` (message starts `Question: …`), `rejected` (policy or pre-check; message starts `Reason: …`), `failed` (MeshMesh couldn't plan; `Reason: …`). In every case except `plan_ready`, nothing was changed.

**`POST /requests/:id/decision`** (Bearer token, connector ②)
| `decision` | Other fields | Effect |
|---|---|---|
| `approve` | `plan_version` (from the plan webhook), `callback_url`, `final_callback_url` | Builds exactly that plan. `202 {"accepted":true,"status":"building"}`. Wrong version → `plan_version_mismatch`; after `PLAN_TTL_MINUTES` (default 60) → `plan_expired`; a plan can be built only once (`wrong_state`). |
| `revise` | `feedback` (the customer's answer or change), new `plan_callback_url` | MeshMesh re-plans (still read-only); a new plan webhook follows. |
| `cancel` | – | `cancelled`; nothing is built. |

Progress (`callback_url`, one delivery) and final (`final_callback_url`) payloads are the same as v1. Final `status` is now `succeeded`, `failed` **or `needs_review`**.

`GET /requests/:id` also returns `plan_version` and `changes` (useful for curl tests and support).

### 12.6 Intercom: two data connectors
**Connector ① `Plan Salesforce change (MeshMesh)`**: POST `https://<tunnel>/requests`, same Bearer token and `Content-Type` header as §5.
| Input | Description (Fin reads this) | Required | Source |
|---|---|---|---|
| `requestor_email` | Email of the person requesting the change | Yes | Let Fin collect |
| `change_request` | Complete description of the Salesforce setup the customer wants, in their words plus the details collected: what to set up, on which object or feature, names, types or values, URLs, who needs access. **Never include passwords, keys or tokens.** | Yes | Let Fin collect |
| `business_reason` | Why they need it | Yes | Let Fin collect |
| `plan_callback_url` | Webhook URL of the Procedure's `meshmesh_plan` wait. Set by the Procedure; never ask the customer. | No | Procedure |

Body:
```json
{"requestor_email": "{{requestor_email}}", "change_request": "{{change_request}}", "business_reason": "{{business_reason}}", "plan_callback_url": "{{plan_callback_url}}", "conversation_id": "{{conversation.id}}"}
```
Live test: `change_request = "short"` → `accepted:false` (too short) proves auth and routing without starting MeshMesh. Fin tab: Directly **off**.

**Connector ② `Decide on Salesforce plan (MeshMesh)`**: POST `https://<tunnel>/requests/decision` with `request_id` in the body (the bridge also accepts `/requests/<id>/decision`), same token and header.
| Input | Description | Required | Source |
|---|---|---|---|
| `request_id` | The request ID from the plan webhook | Yes | Procedure |
| `decision` | Exactly `approve`, `revise` or `cancel`, from the customer's explicit answer | Yes | Let Fin collect |
| `plan_version` | `plan_version` from the plan webhook | No | Procedure |
| `feedback` | The customer's answer to MeshMesh's question, or the change they want to the plan | No | Let Fin collect |
| `plan_callback_url` | URL of the `meshmesh_plan_2` wait (revise only) | No | Procedure |
| `callback_url` / `final_callback_url` | URLs of the `meshmesh_status` / `meshmesh_result` waits (approve only) | No | Procedure |

Body:
```json
{"request_id": "{{request_id}}", "decision": "{{decision}}", "plan_version": "{{plan_version}}", "feedback": "{{feedback}}", "plan_callback_url": "{{plan_callback_url}}", "callback_url": "{{callback_url}}", "final_callback_url": "{{final_callback_url}}"}
```

### 12.7 Intercom: Procedure `Salesforce Setup Assistant (MeshMesh v2)`
Create it next to the v1 Procedure (keep v1 **Disabled**). Trigger: *"The customer wants something set up or changed in their Salesforce org (fields, objects, validation rules, page layouts, permission sets or assignments, record types, credentials for callouts, External Client Apps, remote sites and similar) and wants it done for them."* Channels **Web**; audience **Fin PoC tester** (§7.1b).

Steps (`@` inserts tools, `/` inserts a Condition; set Conditions to **Code**):
1. **Instruction:** Say you can set up most Salesforce configuration in their connected sandbox. You'll collect the details, MeshMesh will prepare a plan, and **nothing changes until they approve that plan**. Code (Apex, triggers, components), flows, profiles, org-wide security settings and deletions can't be done in chat.
2. **Instruction:** Collect `requestor_email`, `change_request` and `business_reason`. Ask only for basics that are missing (which object or feature, names, field types or values, URLs, who needs access). Don't design the solution yourself. **Never ask for or accept passwords, API keys, tokens or secrets.** If the customer offers one, tell them not to share it and that their admin enters it in Setup.
3. **Call data connector ①** with the three details; map `plan_callback_url` → **Wait for webhook `meshmesh_plan` callback URL**.
4. **Instruction:** If `accepted = false`, explain `message`/`problems`, fix and call again. If `true`, share `request_id`, say MeshMesh is preparing a plan (1–3 minutes) and nothing has changed yet.
5. **Wait for webhook `meshmesh_plan`**: attributes `status`, `message`, `changes`, `warnings`, `plan_version`, `request_id`, `change_count`. Wait 15 min; timeout → hand off ("MeshMesh hasn't returned a plan in time…").
6. **Condition (Code)** on `inputs["webhook"]["meshmesh_plan"]["status"]`:
   - `== "plan_ready"` → Instruction: show `message`, then the numbered `changes` **verbatim**, then `warnings`. Ask: *approve*, *change something* or *cancel*. Require an explicit yes to approve.
     - approve → **connector ②** `decision=approve`, `request_id`, `plan_version` from `meshmesh_plan`, `callback_url` → `meshmesh_status` URL, `final_callback_url` → `meshmesh_result` URL. Then steps 7–8.
     - change → **connector ②** `decision=revise`, `feedback`, `plan_callback_url` → `meshmesh_plan_2` URL; wait `meshmesh_plan_2` (same attributes); show the new plan the same way; then approve (steps 7–8 with `meshmesh_plan_2`'s `plan_version`) or cancel. One revision round; after that, offer to start a new request.
     - cancel → **connector ②** `decision=cancel`; confirm nothing changed.
   - `== "needs_input"` → Instruction: ask MeshMesh's question (the `message` after "Question:"), then **connector ②** `decision=revise`, `feedback` = the answer, `plan_callback_url` → `meshmesh_plan_2`. Continue as in the `plan_ready` branch with `meshmesh_plan_2`.
   - `== "rejected"` or `== "failed"` → Instruction: say it can't be done and **nothing was changed**; give the reason using only the `Reason:` text; offer a teammate.
   - **ELSE** → can't confirm; hand off.
7. **Wait for webhook `meshmesh_status`** (as v1 §6 step 5) → relay it as a short progress update ("this usually takes 3–5 minutes").
8. **Wait for webhook `meshmesh_result`** (as v1 §6 step 6), then **Condition (Code)** on `inputs["webhook"]["meshmesh_result"]["status"]`:
   - `"succeeded"` → configuration complete and independently verified; summarise; give next steps (for credentials or External Client Apps: the admin enters secrets or retrieves the consumer key in Setup).
   - `"failed"` → not completed; use only the `Reason:` text; partial changes are possible; offer a teammate.
   - `"needs_review"` → the requested changes were made, but the check found changes outside the approved plan; a teammate will review them; hand off.
   - **ELSE** → can't confirm; hand off.

Preview limits from §7.1 still apply (only the first wait is real), so the full v2 flow must be tested in the live Messenger (§7.1b). Without Fin, test the bridge with curl (§12.8).

### 12.8 Testing v2
**Offline (no credits, no Salesforce changes):** `npm test` runs 37 tests: CHANGESET parsing, policy, prompts, secret redaction, the **live worker path** against a scripted MeshMesh and a fake `sf` CLI (stale-turn race, drift → `needs_review`, missing component → `failed`, label duplicate, no CHANGESET, Apex, NEEDS_INPUT), and a **mock end to end** through the real HTTP server with a fake Fin receiving the webhooks (outbound callouts, External Client App, duplicate, Apex, delete, question → revise, cancel, plan-version mismatch, legacy connector).

**Live, bridge only (curl, before Fin):**
```powershell
$h = @{ Authorization = "Bearer $env:FIN_BEARER_TOKEN"; "Content-Type" = "application/json" }
$b = @{ requestor_email="jane.doe@test.com"; business_reason="v2 test";
        change_request="Set up outbound HTTPS callouts from Salesforce to https://api.partner.example.com using a Named Credential. Auth is a custom API key header that our admin will enter. Give the Fin PoC Access permission set access.";
        plan_callback_url="https://example.com/no-op" } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri http://localhost:8787/requests -Headers $h -Body $b
# 1–3 min later:
Invoke-RestMethod -Uri "http://localhost:8787/requests/$($r.request_id)" -Headers $h   # status plan_ready, changes, plan_version
# approve (or decision=cancel)
$d = @{ decision="approve"; plan_version="<pv_… from above>" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:8787/requests/$($r.request_id)/decision" -Headers $h -Body $d
# watch: .\scripts\watch-log.ps1 ; final status via GET /requests/<id>
```

**Live test plan (run in the Dev Edition org, record results in §8):**
| # | Scenario (what the customer types) | Expected |
|---|---|---|
| T14 | "Add a Text field called **Contract Region** on Account, on the layout, Fin PoC Access gets Read/Edit" | v1 regression through v2: plan with CustomField + Layout + PermissionSet → approve → `succeeded`, 3 of 3 verified |
| T15 | "Set up **outbound HTTPS callouts** to https://api.partner.example.com, API key header, Fin PoC Access may use it" | Plan: ExternalCredential + NamedCredential + PermissionSet, warning about secrets → approve → `succeeded`; check Setup → Named Credentials |
| T16 | "Create an **External Client App** for outbound HTTPS requests" | MeshMesh corrects to Named/External Credential **or** plans an ECA with `ExtlClntApp*` settings (inbound); secrets warning; consumer secret never appears in Fin |
| T17 | "Validation rule on Opportunity: Amount required when Stage is Closed Won" | ValidationRule `Opportunity.<name>` → `succeeded` |
| T18 | "Assign the Fin PoC Access permission set to <test user>" | `assign PermissionSetAssignment` → verified by SOQL |
| T19 | "Write an Apex trigger that sets the Account rating" | `rejected` before approval, `Reason: … ApexClass/ApexTrigger … can't be done through chat`; org unchanged |
| T20 | "Add a field called PoC Customer Tier on Account" | `rejected` before approval (`already exists`); field still Text(50) |
| T21 | Vague: "add a validation rule for the sales team" | `needs_input` question → answer → revised plan → approve |
| T22 | Any plan → "cancel" | `cancelled`; org unchanged |
| T23 | v1 connector (§5) unchanged | Same behaviour as T7/T8 |

**Live results (bridge-only runs, Dev Edition `devhub`, 22 Nov 2026):**
| # | Request id | Result | Checked in the org |
|---|---|---|---|
| T14 | `fmr_c9b8a2bc` | `succeeded`. Plan (`pv_ddc8dcefdc`) had CustomField + Layout + PermissionSet; MeshMesh used the CHANGESET block with correct Metadata API names; plan about 1.5 min, build about 2 min | `Account.Contract_Region__c` Text(255), nillable. Layout `Account-Account Layout` has the field (Edit). `FieldPermissions` for `Fin_PoC_Access`: read + edit. Other permission sets with read-only rows on the field predate the run. |
| T15 | `fmr_50551f28` (first attempt `fmr_4f37dbaf` failed: see below) | `succeeded`. Plan `pv_81f79e0553`: ExternalCredential + NamedCredential `Partner_API` + PermissionSet `Fin_PoC_Access`; no secret in plan, final message tells the admin to add the `ApiKey` parameter in Setup; plan about 3.5 min, build about 2 min | `NamedCredential Partner_API`: SecuredEndpoint, URL `https://api.partner.example.com`, linked to the External Credential. `ExternalCredential Partner_API`: Custom protocol, NamedPrincipal `PartnerApiPrincipal`, `X-API-Key` header = `{!$Credential.Partner_API.ApiKey}` (merge reference, no stored secret). `Fin_PoC_Access`: principal access `Partner_API-PartnerApiPrincipal` + Read on `UserExternalCredential`. |
| T19 | `fmr_da3c61ff` (first attempt `fmr_0cb3c7b2` reported `failed` and leaked the CHANGESET/RESULT text) | `rejected`, no build. MeshMesh declined (Apex/Flow can't be done through chat) and gave the admin Flow steps; clean customer text | Nothing built, org untouched |
| T20 | `fmr_22431915` (first attempt `fmr_cee80da8` hit `Sandbox not available - please try again`) | `rejected` before approval: `PoC_Customer_Tier__c` already exists, Text(50); offers a revised plan | Field still Text(50) |
| T21 | `fmr_cd1be220` | Vague "add a validation rule for the sales team" -> `needs_input` (asks object, condition, message) -> `decision: revise` with feedback -> new plan `pv_3972611e50` (one ValidationRule) -> approve -> **build failed**: `continue_agent` got `Unauthorized` (token expired) and the retry failed with `fetch failed`; org untouched (0 validation rules). Flow up to the build works; see token finding below | Opportunity had no new rule |
| T17 | `fmr_1a003093` | `succeeded` (same rule, after the token fix). Plan about 1.5 min, build about 2 min, no retries logged | `Opportunity.Amount_Required_When_Closed_Won`: active, error on `Amount`, `Enter an Amount before closing the deal.`, formula `AND(ISPICKVAL(StageName,"Closed Won"), OR(ISBLANK(Amount), Amount <= 0))` |
| T22 | `fmr_6d5a097c` | Plan `pv_c3125e1452` (CustomField `Contact.Preferred_Language__c` + Layout + a new PermissionSet) -> `decision: cancel` -> `cancelled`, "Nothing was changed in Salesforce."; a late `approve` is refused (`wrong_state`). Note: for a one-field request MeshMesh also planned a layout change and a brand-new permission set; the customer sees that in the plan, but the prompt could ask it to keep the plan minimal | Field does not exist in the org |
| T16 | `fmr_87e60c7f` | `rejected` with no plan: MeshMesh corrected the request (an External Client App is for outside systems signing in to Salesforce; outbound callouts need a Named + External Credential) and pointed to the existing `Partner API` credentials from T15. No consumer key or secret anywhere in the message to Fin; the CHANGESET was empty | Nothing built |
| T18 | `fmr_ca517b9a` | `succeeded`. Plan `pv_6ff33ef615` was one `PermissionSetAssignment` (`Fin_PoC_Access:<test user>`); post-verify ok, no unexpected changes | `PermissionSetAssignment`: `<test user>` is the only assignee of `Fin_PoC_Access` |
| M1 (live Messenger, v1 Procedure) | `fmr_bbb794ee` | Experience site Messenger -> v1 Procedure (Fin collected email, label, type, permission set, reason; customer replied yes) -> v1 connector -> bridge legacy contract (`legacy_field`, auto-approved) -> `succeeded`. Progress webhook 200 (`planning`), final webhook 200; Fin told the customer it was complete and independently verified. Post-verify: `PermissionSet Fin_PoC_Access (field access ok: Account.Customer_Segment__c read+edit)` | `Account.Customer_Segment__c` Text(100), on `Account-Account Layout` (Edit), `Fin_PoC_Access` read+edit via `FieldPermissions` |


Finding from T21 (and T15's first failure): MeshMesh access tokens last only 300 s. A call landing just after expiry gets `Unauthorized`; the old single immediate retry raced the token refresh and failed with `fetch failed`. Fixes in `src/meshmesh.js`: connection setup is serialised (`connecting`), and write tools (`continue_agent`) retry up to 3 times with backoff on auth errors only (a 401 means the call never ran), other write failures keep one retry. Also: `customerMessage()` in `src/notify.js` now strips a `BEGIN_CHANGESET ... END_CHANGESET` block from every message that goes to Fin (it already removed the RESULT line and led needs_input with `Question:`).

Finding from M1 / Intercom setup: the v1 data connector (id 671985) still pointed at an old tunnel URL (`http_client_error`, 74% success). Fix = edit its HTTPS URL to the current tunnel + `/requests` (type it slowly: the editor drops characters on fast input), save draft, switch Test to Live request, fill the Conversation ID test value (the Test button stays disabled while a required test value is empty), run the test (expect 200 with the invalid `Picklist` value), then Set live. Authentication is the saved credential `MeshMesh PoC Bridge` (a 200 proves the token matches `FIN_BEARER_TOKEN`). A free `trycloudflare.com` URL changes whenever the tunnel restarts, so the connector URL must be updated again after each restart. The v1 Procedure needed no change: its ELSE branch already covers `needs_review`.

Finding from T19: MeshMesh can end the plan turn with `BEGIN_CHANGESET [] END_CHANGESET` + `RESULT: FAILED - ...`. That is now mapped to `rejected`, and `cleanMessage()` strips the block and the RESULT line before the text goes to Fin. Finding from T20: `start_agent` can answer `Sandbox not available - please try again` (seen when two agents were started at once); the bridge now retries `start_agent` on that kind of error only (10 s, 30 s, 60 s). Regression tests for both are in `test/retry.test.js`.

Finding from T15 (first attempt): a single `fetch failed` right after a MeshMesh token refresh failed a healthy plan turn. Read-only polling tools (`get_agent_status`, `get_plan`, `list_connections`) now retry with backoff in `src/meshmesh.js` (`withRetry`); `start_agent`/`continue_agent` keep one retry because they are not safe to repeat. Regression test: `test/retry.test.js`.

Finding from T14 (fixed): for a PermissionSet the bridge's post-verify only confirmed the set exists ("no new modification timestamp"), because changing field access does not update the set's `LastModifiedDate`. `verify()` in `src/guard.js` now queries `FieldPermissions` for every field the change set creates and fails the run if the set lacks the promised read (or edit) access; for changes it cannot prove (for example credential principal access) it says `grants not auto-checked` instead of claiming verification. Tested with a fake org (`test/live-flow.test.js`) and against the real org (T14 field: ok for `Fin_PoC_Access`, fails for a set with no grant).

> **Credits and time:** each request costs one plan turn plus one build turn (about 4–6 minutes end to end, plus the customer's reading time). Unapproved plans expire after `PLAN_TTL_MINUTES`.

### 12.9 Operations notes (v2)
| Symptom | Cause | Fix |
|---|---|---|
| Plan webhook says `failed: the plan could not be checked automatically` | MeshMesh didn't output a CHANGESET even after the reminder | Check `meshmesh_plan` / `changeset_unreadable` in `data/events.log`; rephrase or raise with MeshMesh |
| Everything is `rejected: … is not on the list of supported setup changes` | Type not in `allowed_types` | Add it to `config/policy.json` deliberately (no restart) |
| `needs_review` after a good build | Someone else changed a watched type during the build, or an unlisted side effect | Review `postverify.unexpected` in the log; add tolerated side effects or narrow `watch_types` |
| `pre-check of X failed` | `sf` CLI not logged in, or type not listable | `sf org login web --alias <alias>`; `node scripts/plan-check.js` |
| Decision returns `wrong_state` | Plan already approved, cancelled, expired, or the bridge restarted mid-plan | Start a new request. (In-flight requests don't survive a bridge restart in the PoC; hosted version: persist and resume.) |

### 12.10 Files added or changed in v2
| File | Purpose |
|---|---|
| `src/changeset.js` | Parse/format the CHANGESET, `plan_version` |
| `src/policy.js`, `config/policy.json` | Allow/deny policy |
| `src/prompt.js` | Plan, approval, revision and reminder prompts |
| `src/guard.js` | Generic read-only pre-check, snapshot, post-verify + drift (mock guard for mock mode) |
| `src/worker.js` | Plan → review → (customer) → build → verify state machine; mock planner |
| `src/server.js` | `POST /requests` (generic + legacy), `POST /requests/:id/decision` |
| `src/notify.js` | Plan/progress/final channels, `needs_input` messages, secret redaction |
| `src/validate.js` | Generic contract; legacy contract translated into a `change_request` |
| `scripts/plan-check.js`, `examples/*.json` | Dry-run policy + pre-check against the org |
| `test/generic.test.js`, `test/live-flow.test.js`, `test/e2e-mock.test.js` | 37 tests total |
