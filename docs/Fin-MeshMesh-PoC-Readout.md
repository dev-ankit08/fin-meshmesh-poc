# Fin × MeshMesh PoC: Readout

**Date:** 22 Nov 2026 · **Recommendation: PROCEED (iterate on hardening before a pilot)**

## 1. Answer to the hypothesis
> *Fin can collect structured requirements in conversation, send them to MeshMesh, MeshMesh configures Salesforce, and progress and completion come back to Fin.*

**Confirmed end to end in a live Intercom Messenger** (not just the Preview simulator), against a Salesforce Developer Edition org. The test use case was one custom field on Account, put on the page layout, plus permission-set Read/Edit.

## 2. Results against the success criteria (brief §8)

| Criterion | Result | Evidence |
|---|---|---|
| Requirements collection (POC-01/02) | ✅ Pass | Fin collects 5 inputs, asks only for missing ones, refuses unsupported types, and requires an explicit "yes" |
| Handoff and acknowledgement (POC-04) | ✅ Pass | Request ID returned and shown in Fin (for example `fmr_b323a19e`) |
| Execution in Salesforce (POC-05) | ✅ Pass | 6 fields created by MeshMesh; each checked independently in the org (field, layout, permission set) |
| Progress update (POC-06) | ✅ Pass | "MeshMesh is planning…" shown in Fin, tied to the request ID (webhook) |
| Completion (POC-07) | ✅ Pass | Final "complete and independently verified" message in the live Messenger, about 4.5 min after "yes" |
| Controlled failure, no false success (POC-08) | ✅ Pass | Duplicate field: **(a)** refused by the bridge pre-check, and **(b)** with the pre-check off, MeshMesh itself stopped with `RESULT: FAILED - duplicate field`, and Fin said the change was not made and gave the real reason. The org was unchanged in both cases. |
| Connection to Salesforce (POC-03) | ⚠️ Partial | MeshMesh connects to the org through a connection an admin set up once. Fin does not start a per-customer connection. |

## 3. How it works (integration findings)
- **Fin → bridge:** Fin *Data connector* (HTTPS POST with a bearer token), called from a Fin *Procedure* after the customer confirms.
- **Bridge → MeshMesh:** MeshMesh remote **MCP** (`start_agent` in plan mode → `get_plan` → `continue_agent` in build mode → `get_agent_status` polling). OAuth with PKCE. MeshMesh runs asynchronously, so the bridge returns 202 at once and works in the background.
- **MeshMesh → Fin:** two Fin **Wait-for-webhook** steps: #1 for one progress update and #2 for the final result. A **Code Condition** on the final status decides success, failure or "can't confirm" deterministically.
- **Correlation:** a bridge `request_id`, plus a one-time callback URL for each wait.
- **Customer approval:** an explicit "yes" to a summary in Fin before any call. MeshMesh then runs unattended.

## 4. Key findings and limitations
1. **MeshMesh's duplicate detection was unreliable at first.** In run T4 it missed an existing field and *overwrote* it (Text 50 → 100), because describe hides fields the user has no access to. Fixed with an independent read-only Salesforce check in the bridge: a duplicate pre-check, plus verification after the run. With better prompting, MeshMesh has since caught duplicates correctly twice. **The independent check is required, not optional.**
2. **Fin can invent details.** In Preview it made up a success message, and in the first live failure it made up a cause ("deployment error"). Fixed by deciding the outcome in code (Code Condition) and putting the real "Reason: …" first in the message the bridge sends to Fin.
3. **Preview can't show the full flow.** The final webhook is only delivered in a live Messenger conversation.
4. **About 4–5 minutes per request.** Fin shows only one progress update in that time.
5. **Updates after the conversation ends are not tested.** The webhook waits only work while the Procedure is waiting. The bridge has a fallback that posts into the conversation through the Intercom REST API, but it needs an access token and was not exercised.

## 5. Risks and dependencies (brief §9.4)

| Area | Risk / dependency | Mitigation / next step |
|---|---|---|
| Integration | MeshMesh is a beta. The MCP tool contract and discovery accuracy may change. | Keep the independent Salesforce check; pin the tested behaviour in regression tests; raise the discovery/upsert issue with MeshMesh |
| Integration | Metadata deploy is an *upsert*, so it can silently change existing components | Duplicate pre-check; ask MeshMesh for a validate-only deploy with "Created vs Changed" reporting |
| Access | PoC used a Developer Edition org and a personal admin identity | Use a real **sandbox**, a dedicated MeshMesh service identity, and a least-privilege Salesforce integration user |
| Access | Per-customer org connection isn't solved (POC-03) | Define with the MeshMesh team how a customer authorises their own sandbox |
| Security | Unattended MeshMesh build after one "yes" in chat | Plan-mode first, narrow prompt scope ("change nothing else"), post-verify; consider a human approval step for wider use cases |
| Security | Shared bearer token; quick-tunnel public URL | Hosted endpoint, secret manager, request signing (HMAC), IP allow-listing |
| Legal / compliance | AI agent changing customer orgs: liability, consent wording, audit trail; data residency of MeshMesh and Intercom | Legal review of the consent text in Fin; keep the bridge event log as an audit trail; confirm data-processing terms with both vendors |
| Operational | Laptop and quick tunnel (dropped once, URL changes) | Host the bridge (Cloud Run, Azure Functions or Heroku) with monitoring and retries; idempotency on `request_id` |
| Operational | MeshMesh credits and quotas, run time of about 5 min | Confirm quotas and pricing; set customer expectations in Fin |

## 6. Recommendation: **Proceed**, with these conditions before a pilot
1. Re-run the test suite in a **real Salesforce sandbox** with least-privilege identities.
2. **Host the bridge.** Add signing, retries and idempotency.
3. Agree the **per-customer connection model** (POC-03) and **after-conversation updates** with the MeshMesh and Intercom teams.
4. Keep the **independent Salesforce check** as a design rule for every future use case.
5. Record a **demo** of the live Messenger run (deliverable 1).

*Details:* [Technical guide](Fin-MeshMesh-Technical-Guide.md) (setup, test log, troubleshooting) · [Plan and findings](Fin-MeshMesh-PoC-Plan.md) · [Brief](Fin-MeshMesh-PoC-Brief.pdf)
