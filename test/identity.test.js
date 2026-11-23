import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedEmail, applyVerifiedIdentity } from '../src/identity.js';

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
test('header supplies the email when the body has none', () => {
  assert.equal(applyVerifiedIdentity({ change_request: 'x' }, { 'x-intercom-verified-email': 'j@a.com' }).body.requestor_email, 'j@a.com');
});
