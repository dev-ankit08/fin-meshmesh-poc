# Verified identity for the Experience site Messenger (JWT)

## Why
The site used Intercom's legacy HMAC identity verification: `user_hash = HMAC(secret, user_id)`. That signs **only the user id**. The email, name and other fields in the boot payload were unsigned, so a logged-in visitor could change them, and Intercom never marked the email as verified. As a result Fin's `X-Intercom-Verified-Email` connector header was never sent, and the bridge fell back to the contact's email (`email_source=body`).

With a JWT, the identity (`user_id`, `email`, `name`, `created_at`) is **inside a token signed on the server**, so Intercom treats the email as verified and the header is populated.

## What changed (code in `salesforce/experience-site/`)
| File | Change |
|---|---|
| `IntercomUserController.cls` | One endpoint, `getIntercomIdentity()`: **not cacheable** (the token expires), returns a signed HS256 JWT when `Intercom_Config__mdt.Jwt_Secret__c` is set, else the legacy `user_hash` (deliberate rollback path). Token lifetime: 8 hours (`JWT_TTL_SECONDS`). The old cacheable `getIntercomUser()` was **retired on 24 Nov**; calling it now returns HTTP 400. |
| `IntercomUserControllerTest.cls` | Original tests plus: JWT equals a token computed independently with Node (`reference-jwt.mjs`), claims, blank secret, both signing modes, and "a JWT payload never also carries the legacy hash". |
| `intercomMessenger.js` | Calls `getIntercomIdentity` imperatively (a non-cacheable method cannot be `@wire`d). In JWT mode it posts only `app_id`, `api_base` and `intercom_user_jwt`; otherwise the old settings. |
| `Jwt_Secret__c.field-meta.xml` | New text field on `Intercom_Config__mdt` for the Messenger API secret. |

**No Head Markup change is needed:** the site's listener boots Intercom with `data.settings` exactly as posted.

Validated with a check-only deploy (nothing saved): 4/4 components, 9 tests, 0 failures.

## Rollout (you do the secret steps; never paste the secret in chat or git)
1. **Get the secret.** Intercom → Settings → Channels → Messenger → Security (web). Find the *Messenger API Secret* (used to sign JWTs) and copy it.
2. **Deploy the code** (done on 24 Nov). The live site is unaffected, because it still runs the previously published LWC, which calls the unchanged `getIntercomUser()`:
   ```powershell
   cd salesforce\experience-site
   sf project deploy start --target-org devhub --test-level RunSpecifiedTests --tests IntercomUserControllerTest --source-dir force-app
   ```
   > **Lesson learned (LWR sites):** the site serves the last *published* LWC. My first deploy made `getIntercomUser` non-cacheable while the published LWC still called it as `cacheable=true`, and the Messenger failed to boot (HTTP 400/500 on `/webruntime/api/apex/execute`) until I restored that method and added `getIntercomIdentity` beside it. Never change the contract of an Apex method that a published LWC calls; add a new method, publish, then retire the old one.
3. **Publish the site** so the new LWC goes live: Experience Builder → Publish, or `sf community publish --name "FIN Agent" --target-org devhub`. Publishing also pushes any *other* unpublished draft edits in the builder, so glance at those first. Until the secret is set (step 4), the new LWC still boots in legacy mode.
4. **Set the secret.** Setup → Custom Metadata Types → *Intercom Config* → Manage Records → *Default* → Edit → paste into **Messenger JWT Secret** → Save. (Same storage pattern as the existing `Secret_Key__c`. For production, use a protected setting or a Named Credential.)
5. **Verify.** Log in to the site, open the browser console and run `Object.keys(window.intercomSettings)`. JWT mode shows `["api_base","app_id","intercom_user_jwt"]`; legacy mode shows `user_hash`, `email`, and so on. (`window.__finAuth` is not visible from the console: it lives inside Lightning's sandbox.) Then send a request through Fin and confirm:
   - the connector's Logs show an `X-Intercom-Verified-Email` header, and
   - the bridge log shows `email_source=verified_header`.
6. **Fix what depends on the email** (see below).
7. **Enforcement is already on.** On Intercom's Security page (web), step 8 shows a red *Disable Messenger Security* button, which means "Enforce JWT Authentication for Messenger" is already enabled (checked 24 Nov). That one switch also governs legacy Identity Verification, so do not click it. It was on while the site used the legacy `user_hash`, and JWT logins pass it.
8. **Legacy Apex method retired (done 24 Nov).** `getIntercomUser()` was removed after the published LWC switched to `getIntercomIdentity()`. While it existed, any logged-in site user could call it, receive a valid `user_hash` for their own user id, and boot Intercom through the legacy path with an email of their choosing. Verified afterwards: the site still boots in JWT mode (`api_base, app_id, intercom_user_jwt`, no `user_hash`), and the old endpoint returns HTTP 400 with no hash.
   - **Remaining caveat:** if you ever clear *Messenger JWT Secret* (the rollback path), `getIntercomIdentity()` goes back to returning the legacy `user_hash`, which does not verify the email. Keep the secret set in normal operation.

## Side effects to handle in step 5
The verified email is the Salesforce **User.Email** (currently `affinity.tester@example.com`), not the `jane.doe@test.com` currently on the Intercom contact. These depend on the email:
- Fin audience **Fin PoC tester** (rule: Email is `jane.doe@test.com`): update to the new email, or the Procedure won't trigger.
- `config/customers.json` `email_domains: ["test.com"]`: add `example.com`, or requests are refused with `no_connection`.

Alternatively set the Salesforce user's email to `jane.doe@test.com`. After the first JWT login, check in Intercom which contact the visitor lands on, because contact matching and merging can change what you see.

## Notes and rollback
- Token expiry: after 8 hours the Messenger needs a page reload.
- **Rollback without redeploying:** clear **Messenger JWT Secret**. The site returns to the legacy HMAC boot.
## Findings from the first live run (24 Nov)
What worked:
- The site boots in **JWT mode** (`Object.keys(window.intercomSettings)` is `api_base, app_id, intercom_user_jwt`). The signed claims carry the Salesforce user id and `affinity.tester@example.com`.
- Intercom adopted the signed email as the contact's email, so the connector body's `{{email}}` is now `affinity.tester@example.com`.
- The Fin audience **Fin PoC tester** still matched `jane.doe@test.com`, so the Procedure stopped triggering (Fin fell back to the generic support-case flow). Fixed by changing the audience rule to `Email is affinity.tester@example.com`. `config/customers.json` now also maps `example.com`.

What did not work as hoped:
- **`X-Intercom-Verified-Email` is still not sent.** In JWT mode Intercom instead sends `X-Intercom-Messenger-Security` (about 250 characters, three dot-separated parts that do not decode as a plain JWT). The connector's *Verified user email* attribute stays empty. Intercom's Security tab says it adds the verified-email header for customers authenticated by the workspace's **customer authentication rules** (for example email OTP). A Messenger-JWT login does not trigger that. So `email_source` stays `body`.
- The bridge now logs, on every request, the names of the `x-intercom-*` headers it received and the shape (never the value) of `X-Intercom-Messenger-Security` (`intercom_headers` in `events.log`).

What this means for trust: the body email is the contact's `{{email}}`, not something the customer types. Messenger enforcement is already on (see step 7), so a boot without a valid signature is refused. The legacy path that would have let a logged-in user obtain a `user_hash` and boot with a different email was closed by retiring `getIntercomUser()` (step 8). With the JWT secret set, the email can only come from the server-signed JWT. To use a cryptographically verifiable proof at the bridge instead, we would need Intercom's documentation for `X-Intercom-Messenger-Security` (not found publicly) or to switch on Fin's customer authentication so the verified-email header is populated.
