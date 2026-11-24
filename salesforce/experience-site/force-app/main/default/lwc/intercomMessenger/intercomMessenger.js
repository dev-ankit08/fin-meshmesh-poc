import { LightningElement } from 'lwc';
// Non-cacheable endpoint that returns the signed JWT. (The old cacheable getIntercomUser was retired.)
import getIntercomIdentity from '@salesforce/apex/IntercomUserController.getIntercomIdentity';
// Compile-time flag: true for the site guest user, false for an authenticated
// community user. Not readable from the browser console directly, so we stamp it
// onto window.__finAuth below for test/diagnostic visibility.
import isGuest from '@salesforce/user/isGuest';
import userId from '@salesforce/user/Id';

/**
 * Supplies the Intercom Messenger boot payload for the logged-in Experience
 * Cloud user.
 *
 * The Intercom loader lives in the site Head Markup and runs in the page's main
 * context. This component runs inside Lightning Web Security, which sandboxes
 * its `window` separately, so it cannot call window.Intercom directly. Instead
 * it posts the per-user payload via window.postMessage; the Head Markup listens
 * for that message and boots Intercom in page context with the settings
 * exactly as posted.
 *
 * Identity is signed on the server (IntercomUserController):
 *  - JWT mode: the user's identity (user_id, email, name, created_at) travels ONLY
 *    inside the signed `intercom_user_jwt`, so Intercom treats the email as
 *    verified. No unsigned identity fields are sent alongside it.
 *  - Legacy mode (no JWT secret configured in Intercom_Config__mdt): the previous
 *    user_hash boot, which only verifies the user id, not the email.
 */
// US region API base. A boot without api_base lets the Messenger resolve the
// wrong regional endpoint, which surfaces as a 404 on .../messenger/web/ping.
const DEFAULT_API_BASE = 'https://api-iam.intercom.io';

export default class IntercomMessenger extends LightningElement {
    posted = false;

    connectedCallback() {
        // Diagnostic flag readable from the browser console as `window.__finAuth`.
        // Tells you, before starting a chat, whether the site sees you as a guest
        // and (once the call resolves) whether the Intercom identity boot fired.
        this.stampAuth({ isGuest, userId, bootPosted: false, identity: null });
        this.loadAndBoot();
    }

    stampAuth(patch) {
        try {
            window.__finAuth = Object.assign({}, window.__finAuth, patch);
        } catch (e) {
            // window may be sandboxed in some contexts; ignore.
        }
    }

    // Imperative call (not @wire): the JWT has an expiry, so the Apex method is not
    // cacheable and a wire adapter cannot be used with it.
    async loadAndBoot() {
        if (this.posted) {
            return;
        }
        try {
            const data = await getIntercomIdentity();
            if (data && !this.posted) {
                this.stampAuth({
                    identity: {
                        userId: data.userId,
                        email: data.email,
                        mode: data.userJwt ? 'jwt' : 'hmac',
                        hasUserJwt: !!data.userJwt,
                        hasUserHash: !!data.userHash
                    }
                });
                this.postBoot(data);
            } else if (!data) {
                // Apex returned null -> guest guard fired (or no identity available).
                this.stampAuth({ identity: null, wireReturnedNull: true });
            }
        } catch (error) {
            this.stampAuth({ wireError: String(error && error.body ? error.body.message : error) });
            // eslint-disable-next-line no-console
            console.error('Intercom: unable to load user context', error);
        }
    }

    postBoot(user) {
        if (!user.appId) {
            // eslint-disable-next-line no-console
            console.error('Intercom: App Id is not configured in Intercom_Config__mdt.');
            return;
        }
        this.posted = true;

        const settings = {
            api_base: user.apiBase || DEFAULT_API_BASE,
            app_id: user.appId
        };
        if (user.userJwt) {
            // Verified identity: everything about the user is inside the signed token.
            settings.intercom_user_jwt = user.userJwt;
        } else {
            // Legacy fallback (HMAC over the user id only).
            settings.name = user.name;
            settings.email = user.email;
            settings.created_at = user.createdAt;
            settings.user_id = user.userId;
            if (user.userHash) {
                settings.user_hash = user.userHash;
            }
        }

        const message = { type: 'INTERCOM_BOOT', settings };
        const origin = window.location.origin;

        // Post immediately, then once more shortly after in case the Head Markup
        // listener registers slightly later than this component renders.
        window.postMessage(message, origin);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => window.postMessage(message, origin), 1000);

        this.stampAuth({ bootPosted: true });
    }
}
