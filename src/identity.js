// Who is asking? Prefer the identity Intercom verified (sent by the connector in a header) over any
// email Fin typed into the body, which can be a made-up placeholder.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function verifiedEmail(headers = {}) {
  const raw = headers['x-intercom-verified-email'];
  const v = String(Array.isArray(raw) ? raw[0] : raw || '').trim();
  return EMAIL.test(v) && v.length <= 254 ? v : '';
}

/**
 * Safe diagnostics for what Intercom actually sent: header NAMES only, plus the SHAPE of
 * X-Intercom-Messenger-Security (length, and for a JWT its header and claim NAMES). Never values.
 */
export function describeIntercomHeaders(headers = {}) {
  const names = Object.keys(headers).filter((k) => k.toLowerCase().startsWith('x-intercom-')).sort();
  const out = { names };
  const raw = headers['x-intercom-messenger-security'];
  const v = String(Array.isArray(raw) ? raw[0] : raw || '');
  if (!v) return out;
  const parts = v.split('.');
  out.messenger_security = { length: v.length, parts: parts.length };
  if (parts.length === 3) {
    const decode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    try {
      const h = decode(parts[0]);
      out.messenger_security.jwt_header = { alg: h.alg, typ: h.typ };
      out.messenger_security.claim_names = Object.keys(decode(parts[1])).sort();
    } catch {
      out.messenger_security.not_a_readable_jwt = true;
    }
  }
  return out;
}

/** Returns a copy of body whose requestor_email is the verified one when present. */
export function applyVerifiedIdentity(body, headers) {
  const verified = verifiedEmail(headers);
  if (!verified) return { body, source: 'body' };
  return { body: { ...body, requestor_email: verified }, source: 'verified_header', replaced: body && body.requestor_email !== verified ? body.requestor_email : undefined };
}
