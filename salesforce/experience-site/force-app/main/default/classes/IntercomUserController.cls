/**
 * Supplies the Intercom Messenger boot payload for the currently logged-in
 * Experience Cloud user.
 *
 * Identity is signed on the server so the browser cannot forge it:
 *  - JWT mode (preferred): when Intercom_Config__mdt.Jwt_Secret__c is set, the user's
 *    identity (user_id, email, name, created_at) is placed inside an HS256 JWT signed
 *    with the Intercom Messenger API secret. Intercom then treats the email as
 *    verified, which is what Fin data connectors send as X-Intercom-Verified-Email.
 *  - Legacy mode (fallback): when no JWT secret is set, an HMAC user_hash over the
 *    user id is returned, exactly as before. This only verifies the user id, NOT the
 *    email, so the email is not trustworthy in this mode.
 *
 * The secrets never leave the server: only the signed token / digest is returned.
 */
public with sharing class IntercomUserController {

    /** How long a signed token stays valid. After this the Messenger needs a page reload. */
    @TestVisible
    private static final Integer JWT_TTL_SECONDS = 28800; // 8 hours

    /**
     * The only identity endpoint. Not cacheable: the JWT carries an expiry, so a client-side
     * cached copy could go stale. Returns a signed JWT when Jwt_Secret__c is set; with no JWT
     * secret it falls back to the legacy HMAC user_hash (deliberate rollback path: clear the
     * secret to go back; note that this path does NOT verify the email).
     *
     * History: the earlier cacheable getIntercomUser() was retired once the published LWC called
     * this method. It handed any logged-in user a valid user_hash for their own user id, which
     * let them boot Intercom with an email of their choosing.
     */
    @AuraEnabled
    public static IntercomUser getIntercomIdentity() {
        return loadPayload();
    }

    private static IntercomUser loadPayload() {
        Intercom_Config__mdt config = Intercom_Config__mdt.getInstance('Default');
        if (config == null) {
            throw new AuraHandledException('Intercom configuration (Default) is missing.');
        }

        // Authenticated-only: the site allows public (guest) access, but Fin agent
        // affinity depends on a verified, Contact-linked identity. Guests have none,
        // so we return null and the component boots nothing for them. This makes the
        // Messenger effectively authenticated-only regardless of page placement.
        if (isGuestUser()) {
            return null;
        }

        return buildPayload(config, loadCurrentUser(), DateTime.now().getTime() / 1000);
    }

    /**
     * Pure function (no org reads) so both signing modes can be unit tested.
     * nowSeconds is passed in so tests are deterministic.
     */
    @TestVisible
    private static IntercomUser buildPayload(Intercom_Config__mdt config, User currentUser, Long nowSeconds) {
        IntercomUser payload = new IntercomUser();
        payload.appId = config.App_Id__c;
        payload.apiBase = config.Api_Base__c;
        payload.name = currentUser.Name;
        payload.email = currentUser.Email;
        // Intercom expects created_at as a Unix timestamp in seconds.
        payload.createdAt = currentUser.CreatedDate.getTime() / 1000;
        payload.userId = String.valueOf(currentUser.Id);

        if (String.isNotBlank(config.Jwt_Secret__c)) {
            payload.userJwt = buildJwt(
                config.Jwt_Secret__c,
                payload.userId,
                payload.email,
                payload.name,
                payload.createdAt,
                nowSeconds,
                nowSeconds + JWT_TTL_SECONDS
            );
        } else {
            payload.userHash = computeHmac(config.Secret_Key__c, payload.userId);
        }
        return payload;
    }

    /**
     * True when the running user is the Experience Site guest (unauthenticated).
     * Guest users have UserType 'Guest'; we also treat the standard guest license
     * defensively via UserInfo.
     */
    @TestVisible
    private static Boolean isGuestUser() {
        return UserInfo.getUserType() == 'Guest';
    }

    private static User loadCurrentUser() {
        return [
            SELECT Id, Name, Email, CreatedDate
            FROM User
            WHERE Id = :UserInfo.getUserId()
            WITH USER_MODE
            LIMIT 1
        ];
    }

    /** Legacy identity verification: HMAC-SHA256 hex digest of the user id. */
    @TestVisible
    private static String computeHmac(String secret, String data) {
        if (String.isBlank(secret) || String.isBlank(data)) {
            return null;
        }
        Blob mac = Crypto.generateMac('HmacSHA256', Blob.valueOf(data), Blob.valueOf(secret));
        return EncodingUtil.convertToHex(mac);
    }

    /**
     * Builds an HS256 JWT for the Intercom Messenger. Claim order is fixed so the output
     * is deterministic (and testable against an independently computed token).
     * Returns null when the secret or user id is missing.
     */
    @TestVisible
    private static String buildJwt(
        String secret,
        String userId,
        String email,
        String name,
        Long createdAt,
        Long issuedAt,
        Long expiresAt
    ) {
        if (String.isBlank(secret) || String.isBlank(userId)) {
            return null;
        }
        String header = base64Url(Blob.valueOf('{"alg":"HS256","typ":"JWT"}'));

        JSONGenerator claims = JSON.createGenerator(false);
        claims.writeStartObject();
        claims.writeStringField('user_id', userId);
        if (String.isNotBlank(email)) {
            claims.writeStringField('email', email);
        }
        if (String.isNotBlank(name)) {
            claims.writeStringField('name', name);
        }
        if (createdAt != null) {
            claims.writeNumberField('created_at', createdAt);
        }
        claims.writeNumberField('iat', issuedAt);
        claims.writeNumberField('exp', expiresAt);
        claims.writeEndObject();

        String signingInput = header + '.' + base64Url(Blob.valueOf(claims.getAsString()));
        Blob signature = Crypto.generateMac('HmacSHA256', Blob.valueOf(signingInput), Blob.valueOf(secret));
        return signingInput + '.' + base64Url(signature);
    }

    /** Base64url (RFC 7515): URL-safe alphabet, no padding. */
    private static String base64Url(Blob value) {
        return EncodingUtil.base64Encode(value).replace('+', '-').replace('/', '_').replace('=', '');
    }

    public class IntercomUser {
        @AuraEnabled public String appId;
        @AuraEnabled public String apiBase;
        @AuraEnabled public String name;
        @AuraEnabled public String email;
        @AuraEnabled public Long createdAt;
        @AuraEnabled public String userId;
        /** Legacy HMAC digest of the user id. Set only when no JWT secret is configured. */
        @AuraEnabled public String userHash;
        /** Signed identity token. Set when Intercom_Config__mdt.Jwt_Secret__c is configured. */
        @AuraEnabled public String userJwt;
    }
}
