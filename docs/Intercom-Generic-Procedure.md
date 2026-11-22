# Intercom: generic Salesforce request Procedure (paste-ready)

Edits Procedure "Salesforce Setup Assistant (MeshMesh PoC)" (id 2228214). Both connectors are already live.

Connectors (already configured and live):
- **Start Salesforce configuration (MeshMesh PoC)** (671985): inputs `requestor_email`, `change_request`, `business_reason`, `plan_callback_url`. POST `<tunnel>/requests`.
- **Decide on Salesforce plan (MeshMesh PoC)** (672979): inputs `request_id`, `decision`, `plan_version`, `feedback` (optional), `callback_url`, `final_callback_url`, `plan_callback_url` (optional). POST `<tunnel>/requests/decision`.
- The decision connector must be switched on for Fin/Procedures (its Fin tab); it did not appear in the Procedure's connector list yet.

Webhook waits needed (names are used by the code conditions):
- `meshmesh_plan`: attributes `status`, `message`, `changes`, `warnings`, `plan_version`, `request_id`. Wait 10 min.
- `meshmesh_status`: attributes `status`, `message`. Wait 10 min.
- `meshmesh_result`: attributes `status`, `message`. Wait 15 min.

## Trigger
The customer wants something set up or changed in Salesforce and wants it done for them in their Salesforce org. This can be any declarative setup: for example custom fields, objects, validation rules, page layouts, permission sets and permission set assignments, record types, credentials for outbound HTTPS callouts, External Client Apps, or remote sites.

## Steps
1. Tell the customer you can set up most Salesforce configuration for them in their connected Salesforce org, for example fields, validation rules, page layouts, permission sets and assignments, and credentials for outbound HTTPS callouts. Explain that you will collect a few details, MeshMesh will prepare a plan, and nothing is changed until they approve that plan. Code (Apex, triggers, components), flows, profiles, org-wide security settings and deleting things cannot be done in chat.
2. Collect three things, asking only for what the customer has not already said: (a) their email address, (b) a complete description of what they want set up, in their own words, with the details needed to do it: what to set up, on which object or feature, names, types or values, URLs, and who needs access, (c) a short business reason. Do not design the solution yourself. Never ask for or accept passwords, API keys, tokens or secrets; if the customer offers one, tell them not to share it here and that their admin enters it in Salesforce Setup. Do not continue until all three are known.
3. Repeat the request back in one or two sentences and ask the customer to confirm it is right. Explain that this only asks MeshMesh to prepare a plan and that nothing is changed in Salesforce yet. If they want to change something, update the details first.
4. Once the customer has confirmed the request, ask MeshMesh to prepare a plan by calling **@Call data connector: Start Salesforce configuration (MeshMesh PoC)** with the customer email, their request and the business reason. Map `plan_callback_url` to the callback URL of the `meshmesh_plan` wait. Never ask the customer for the callback URL.
5. If the connector response has accepted = false, tell the customer what is missing or invalid (use `problems` and `message`), collect the corrected details, and call the connector again. If the call fails or returns an error, tell the customer the request could not be started and that nothing was changed in Salesforce.
6. If accepted = true, tell the customer their request ID (`request_id`), that MeshMesh is now preparing a plan for them to review (usually one to three minutes), and that nothing has been changed in Salesforce yet. Then wait for the plan using **@Wait for webhook: meshmesh_plan**.
7. **Condition (Code)** on `inputs["webhook"]["meshmesh_plan"]["status"]`:
   - **IF** `== "plan_ready"`:
     1. Show the customer the plan MeshMesh prepared: first `message`, then the numbered list in `changes` exactly as given, then any `warnings`. Do not reword or shorten the list of changes. Ask whether they approve this plan or want to cancel it, and require an explicit yes before approving.
     2. If the customer approves, call **@Call data connector: Decide on Salesforce plan (MeshMesh PoC)** with `decision` = approve, `request_id` and `plan_version` from `meshmesh_plan`, `callback_url` mapped to the callback URL of the `meshmesh_status` wait and `final_callback_url` mapped to the callback URL of the `meshmesh_result` wait. Then continue with the next steps below.
     3. If the customer cancels, call the same connector with `decision` = cancel and `request_id` from `meshmesh_plan`, tell them nothing was changed in Salesforce, and end.
   - **ELSE IF** `== "needs_input"`: tell the customer the question in `message`, and ask them to start the request again with that detail included, then end.
   - **ELSE** (rejected, failed or anything else): tell the customer this could not be done and that nothing was changed in Salesforce; give the reason using only the text that starts with "Reason:" in `message`; offer to connect them with a teammate. End.
8. Then wait for MeshMesh status updates using **@Wait for webhook: meshmesh_status**. When the first update arrives, share its message with the customer as a short progress update (for example planning or building) and say you will report the final result here. This update is never the final result, even if it sounds positive. Then wait for the final result using **@Wait for webhook: meshmesh_result**.
9. **Condition (Code)** on `inputs["webhook"]["meshmesh_result"]["status"]`:
   - **IF** `== "succeeded"`: tell the customer the Salesforce configuration is complete and was independently verified, summarise the final result message, and give the next step (for credentials or External Client Apps: the admin enters secrets or retrieves the consumer key in Setup; for fields: assign the permission set to the users who need to see it).
   - **ELSE IF** `== "failed"`: tell the customer the configuration did NOT complete and that the requested change was not made. Give the reason from the final result message in plain language and offer to connect them with a teammate. Do not say anything was created or succeeded. Use only the reason written in the `meshmesh_result` message (it starts with "Reason:"); never guess or invent a cause.
   - **ELSE IF** `== "needs_review"`: tell the customer the requested changes were made but the check found other changes that were not part of the approved plan, and that a teammate will review them. Hand off to the team.
   - **ELSE**: tell the customer you cannot confirm the result yet, do not say it succeeded or failed, and say a teammate will verify the org and follow up here. Hand off to the team.

## Notes
- A free `trycloudflare.com` tunnel URL changes whenever the tunnel restarts; update both connector URLs if it does.
- Publish only when no step shows a red warning triangle (unmapped callback URLs or empty conditions).
