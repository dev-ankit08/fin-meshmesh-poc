import crypto from 'node:crypto';

// Reference HS256 JWT for the Apex unit test. Claim order matches the Apex JSONGenerator order.
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const header = '{"alg":"HS256","typ":"JWT"}';
const body = '{"user_id":"005000000000001AAA","email":"a@b.com","name":"A B","created_at":1700000000,"iat":1700000100,"exp":1700003700}';
const input = `${b64u(header)}.${b64u(body)}`;
const sig = crypto.createHmac('sha256', 'unit-test-secret').update(input).digest();
console.log(`${input}.${b64u(sig)}`);
