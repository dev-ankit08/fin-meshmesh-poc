import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedEmail, applyVerifiedIdentity, describeIntercomHeaders } from '../src/identity.js';

test('verified header wins over a typed or invented email', () => {
  const r = applyVerifiedIdentity({ requestor_email: 'customer@example.com', change_request: 'x' }, { 'x-intercom-verified-email': 'jane@acme.com' });
  assert.equal(r.body.requestor_email, 'jane@acme.com');
  assert.equal(r.source, 'verified_header');
});
test('no header: body email is kept; bad header ignored', () => {
  assert.equal(applyVerifiedIdentity({ requestor_email: 'a@b.com' }, {}).body.requestor_email, 'a@b.com');
  assert.equal(verifiedEmail({ 'x-intercom-verified-email': 'not an email' }), '');
  assert.equal(verifiedEmail({ 'x-intercom-verified-email': '' }), '');
});
test('describeIntercomHeaders logs names and token shape, never values', () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const secretClaimValue = 'super-secret-claim-value';
  const token = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ email: secretClaimValue, user_id: 'u1' })}.sig`;
  const d = describeIntercomHeaders({ 'x-intercom-messenger-security': token, 'x-intercom-source-app-id': 'abc', authorization: 'Bearer nope', 'content-type': 'application/json' });
  assert.deepEqual(d.names, ['x-intercom-messenger-security', 'x-intercom-source-app-id']);
  assert.deepEqual(d.messenger_security.claim_names, ['email', 'user_id']);
  assert.deepEqual(d.messenger_security.jwt_header, { alg: 'HS256', typ: 'JWT' });
  assert.equal(JSON.stringify(d).includes(secretClaimValue), false);
  assert.equal(JSON.stringify(d).includes('nope'), false);
  assert.deepEqual(describeIntercomHeaders({}), { names: [] });
  assert.equal(describeIntercomHeaders({ 'x-intercom-messenger-security': 'opaque-value' }).messenger_security.parts, 1);
});
test('header supplies the email when the body has none', () => {
  assert.equal(applyVerifiedIdentity({ change_request: 'x' }, { 'x-intercom-verified-email': 'j@a.com' }).body.requestor_email, 'j@a.com');
});
