// Who is asking? Prefer the identity Intercom verified (sent by the connector in a header) over any
// email Fin typed into the body, which can be a made-up placeholder.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function verifiedEmail(headers = {}) {
  const raw = headers['x-intercom-verified-email'];
  const v = String(Array.isArray(raw) ? raw[0] : raw || '').trim();
  return EMAIL.test(v) && v.length <= 254 ? v : '';
}

/** Returns a copy of body whose requestor_email is the verified one when present. */
export function applyVerifiedIdentity(body, headers) {
  const verified = verifiedEmail(headers);
  if (!verified) return { body, source: 'body' };
  return { body: { ...body, requestor_email: verified }, source: 'verified_header', replaced: body && body.requestor_email !== verified ? body.requestor_email : undefined };
}
