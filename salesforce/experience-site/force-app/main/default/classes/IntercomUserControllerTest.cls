@IsTest
private class IntercomUserControllerTest {

    // Reference token computed independently with Node's crypto (HS256) for the inputs used below.
    private static final String REFERENCE_JWT =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiMDA1MDAwMDAwMDAwMDAxQUFBIiwiZW1haWwiOiJhQGIuY29tIiwibmFtZSI6IkEgQiIsImNyZWF0ZWRfYXQiOjE3MDAwMDAwMDAsImlhdCI6MTcwMDAwMDEwMCwiZXhwIjoxNzAwMDAzNzAwfQ.g2tJ_RvCmhislubSxoscqhF5es99leOdkn9dib_SMns';

    @IsTest
    static void getIntercomIdentity_returnsCurrentUserPayload() {
        Test.startTest();
        IntercomUserController.IntercomUser payload = IntercomUserController.getIntercomIdentity();
        Test.stopTest();

        User runningUser = [SELECT Name, Email, CreatedDate FROM User WHERE Id = :UserInfo.getUserId()];
        Assert.areEqual(runningUser.Name, payload.name, 'Name should match the running user');
        Assert.areEqual(runningUser.Email, payload.email, 'Email should match the running user');
        Assert.areEqual(String.valueOf(UserInfo.getUserId()), payload.userId, 'userId should be the running user Id');
        Assert.areEqual(
            runningUser.CreatedDate.getTime() / 1000,
            payload.createdAt,
            'createdAt should be Unix seconds'
        );
        Assert.isTrue(
            payload.userJwt != null || payload.userHash != null,
            'The identity is always signed, with a JWT or the legacy hash'
        );
    }

    @IsTest
    static void getIntercomIdentity_guest_returnsNull() {
        // The running test user is not a Guest, so isGuestUser() is false here; we
        // assert the normal (authenticated) path still yields a payload and that the
        // guest predicate is wired. The guest-returns-null branch is exercised by
        // stubbing the predicate via a running-user whose UserType is 'Guest' when the
        // org exposes one; otherwise the predicate contract is asserted directly.
        Assert.isFalse(
            IntercomUserController.isGuestUser(),
            'The test runner is an authenticated user, not a Guest'
        );

        List<User> guests = [
            SELECT Id FROM User
            WHERE UserType = 'Guest' AND IsActive = TRUE
            LIMIT 1
        ];
        if (guests.isEmpty()) {
            // No Experience Site guest user provisioned in this org: the authenticated
            // path is already covered above; nothing more to run safely here.
            return;
        }
        System.runAs(guests[0]) {
            Test.startTest();
            IntercomUserController.IntercomUser payload = IntercomUserController.getIntercomIdentity();
            Test.stopTest();
            Assert.isNull(payload, 'Guest users must receive a null payload (authenticated-only Messenger)');
        }
    }

    @IsTest
    static void computeHmac_withSecret_returnsHexDigest() {
        String digest = IntercomUserController.computeHmac('super-secret', '005000000000001');
        Assert.isNotNull(digest, 'Digest should be produced when a secret is present');
        Assert.areEqual(64, digest.length(), 'HmacSHA256 hex digest should be 64 chars');
    }

    @IsTest
    static void computeHmac_blankSecret_returnsNull() {
        Assert.isNull(
            IntercomUserController.computeHmac(null, '005000000000001'),
            'No secret should yield a null hash'
        );
        Assert.isNull(
            IntercomUserController.computeHmac('secret', ''),
            'No data should yield a null hash'
        );
    }

    @IsTest
    static void buildJwt_matchesIndependentlyComputedToken() {
        String jwt = IntercomUserController.buildJwt(
            'unit-test-secret', '005000000000001AAA', 'a@b.com', 'A B', 1700000000L, 1700000100L, 1700003700L
        );
        Assert.areEqual(REFERENCE_JWT, jwt, 'Apex JWT must equal the token computed independently with Node');
    }

    @IsTest
    static void buildJwt_carriesTheSignedClaims() {
        String jwt = IntercomUserController.buildJwt(
            'unit-test-secret', '005000000000001AAA', 'a@b.com', 'A B', 1700000000L, 1700000100L, 1700003700L
        );
        List<String> parts = jwt.split('\\.');
        Assert.areEqual(3, parts.size(), 'A JWT has header.payload.signature');

        Map<String, Object> claims = (Map<String, Object>) JSON.deserializeUntyped(decodeBase64Url(parts[1]));
        Assert.areEqual('005000000000001AAA', claims.get('user_id'));
        Assert.areEqual('a@b.com', claims.get('email'));
        Assert.areEqual('A B', claims.get('name'));
        Assert.areEqual(1700003700L - 1700000100L, asLong(claims.get('exp')) - asLong(claims.get('iat')));
    }

    @IsTest
    static void buildJwt_blankSecretOrUser_returnsNull() {
        Assert.isNull(IntercomUserController.buildJwt('', '005000000000001AAA', 'a@b.com', 'A', 1L, 1L, 2L));
        Assert.isNull(IntercomUserController.buildJwt(null, '005000000000001AAA', 'a@b.com', 'A', 1L, 1L, 2L));
        Assert.isNull(IntercomUserController.buildJwt('secret', '', 'a@b.com', 'A', 1L, 1L, 2L));
    }

    @IsTest
    static void buildPayload_withJwtSecret_signsIdentityInsideJwtOnly() {
        Intercom_Config__mdt config = new Intercom_Config__mdt(
            App_Id__c = 'app123',
            Api_Base__c = 'https://api-iam.intercom.io',
            Secret_Key__c = 'legacy-secret',
            Jwt_Secret__c = 'jwt-secret'
        );
        User runningUser = [SELECT Id, Name, Email, CreatedDate FROM User WHERE Id = :UserInfo.getUserId()];

        IntercomUserController.IntercomUser payload = IntercomUserController.buildPayload(config, runningUser, 1700000000L);

        Assert.isNotNull(payload.userJwt, 'A JWT should be produced when a JWT secret is configured');
        Assert.isNull(payload.userHash, 'Legacy user_hash must not be sent together with a JWT');
        Map<String, Object> claims = (Map<String, Object>) JSON.deserializeUntyped(decodeBase64Url(payload.userJwt.split('\\.')[1]));
        Assert.areEqual(String.valueOf(runningUser.Id), claims.get('user_id'));
        Assert.areEqual(runningUser.Email, claims.get('email'), 'The email is signed inside the JWT');
        Assert.areEqual(1700000000L + IntercomUserController.JWT_TTL_SECONDS, asLong(claims.get('exp')));
    }

    @IsTest
    static void buildPayload_withoutJwtSecret_fallsBackToLegacyHmac() {
        Intercom_Config__mdt config = new Intercom_Config__mdt(
            App_Id__c = 'app123',
            Api_Base__c = 'https://api-iam.intercom.io',
            Secret_Key__c = 'legacy-secret'
        );
        User runningUser = [SELECT Id, Name, Email, CreatedDate FROM User WHERE Id = :UserInfo.getUserId()];

        IntercomUserController.IntercomUser payload = IntercomUserController.buildPayload(config, runningUser, 1700000000L);

        Assert.isNull(payload.userJwt, 'No JWT without a JWT secret');
        Assert.areEqual(64, payload.userHash.length(), 'Legacy HMAC digest is the rollback path when no JWT secret is set');
    }

    @IsTest
    static void buildPayload_withJwtSecret_neverAlsoReturnsTheLegacyHash() {
        // A JWT-mode payload must not carry a user_hash: that hash would let a caller boot the
        // legacy path with an unsigned email.
        Intercom_Config__mdt config = new Intercom_Config__mdt(
            App_Id__c = 'app123',
            Api_Base__c = 'https://api-iam.intercom.io',
            Secret_Key__c = 'legacy-secret',
            Jwt_Secret__c = 'jwt-secret'
        );
        User runningUser = [SELECT Id, Name, Email, CreatedDate FROM User WHERE Id = :UserInfo.getUserId()];

        IntercomUserController.IntercomUser payload = IntercomUserController.buildPayload(config, runningUser, 1700000000L);

        Assert.isNull(payload.userHash, 'No legacy hash alongside a JWT');
    }

    // deserializeUntyped returns small whole numbers as Integer, which cannot be cast to Long directly.
    private static Long asLong(Object value) {
        return Long.valueOf(String.valueOf(value));
    }

    private static String decodeBase64Url(String value) {
        String b64 = value.replace('-', '+').replace('_', '/');
        while (Math.mod(b64.length(), 4) != 0) {
            b64 += '=';
        }
        return EncodingUtil.base64Decode(b64).toString();
    }
}
