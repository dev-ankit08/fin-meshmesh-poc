// Contract between Fin and the bridge.
//
// GENERIC (v2): the customer describes ANY Salesforce setup change in plain words. Fin collects:
//   requestor_email, change_request (what they want, in detail), business_reason
// plus the Procedure-supplied plan_callback_url / callback_url / final_callback_url / conversation_id.
// MeshMesh then plans it, the bridge checks the plan (policy + org pre-check), the customer approves the
// actual plan in Fin, and only then MeshMesh builds it.
//
// LEGACY (v1, the original PoC connector): field_label / field_type / permission_set. Still accepted and
// translated into a change_request, so the existing Fin connector keeps working unchanged.

export const FIELD_TYPES = ['Text', 'Number', 'Checkbox', 'Date']; // legacy contract only

// https only; plain http is allowed for localhost so the mock end-to-end test can receive webhooks.
export const okUrl = (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u);

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

export function toApiName(label) {
  const base = str(label)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/__+/g, '_');
  const safe = /^[A-Za-z]/.test(base) ? base : `F_${base}`;
  return `${safe.slice(0, 40)}__c`;
}

export const isLegacy = (body) => !str(body.change_request) && (str(body.field_label) || str(body.field_type));

function legacyChangeRequest(v) {
  const typeSpec =
    v.field_type === 'Text' ? `Text(${v.text_length})` :
    v.field_type === 'Number' ? 'Number(18, 0)' :
    v.field_type === 'Checkbox' ? 'Checkbox (default unchecked)' : 'Date';
  return [
    `Create ONE custom field on Account: label "${v.field_label}", API name ${v.field_api_name}, type ${typeSpec}, ${v.required_on_layout ? 'required on the page layout' : 'not required'}.`,
    `Add it to the default Account page layout.`,
    `Create the permission set "${v.permission_set}" if it does not exist, and grant it Read and Edit field-level security on the new field.`,
  ].join(' ');
}

/** Returns { ok, missing[], invalid[], value } */
export function validateRequest(body = {}) {
  const legacy = isLegacy(body);
  const required = legacy
    ? ['requestor_email', 'field_label', 'field_type', 'permission_set', 'business_reason']
    : ['requestor_email', 'change_request']; // business_reason is optional for free-form requests
  const missing = required.filter((k) => !str(body[k]));
  const invalid = [];

  const email = str(body.requestor_email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) invalid.push('requestor_email is not a valid email');

  const common = {
    contract: legacy ? 'legacy_field' : 'generic',
    conversation_id: str(body.conversation_id),
    plan_callback_url: str(body.plan_callback_url),
    callback_url: str(body.callback_url),
    final_callback_url: str(body.final_callback_url),
    requestor_email: email,
    business_reason: str(body.business_reason),
  };

  if (!legacy) {
    const cr = str(body.change_request);
    if (cr && cr.length < 15) invalid.push('change_request is too short; describe what should be set up, on which object or feature, and for whom');
    if (cr.length > 4000) invalid.push('change_request must be 4000 characters or fewer; split large requests');
    // Free-form requests are never auto-approved: the customer must see and approve MeshMesh's plan.
    if (!common.plan_callback_url) invalid.push('plan_callback_url is required for free-form requests (set it to the Procedure\'s plan Wait-for-webhook URL; never ask the customer)');
    for (const k of ['plan_callback_url', 'callback_url', 'final_callback_url']) {
      if (common[k] && !okUrl(common[k])) invalid.push(`${k} must be an https URL`);
    }
    const value = { ...common, change_request: cr, title: cr.split(/[.\n]/)[0].slice(0, 60) };
    return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, value };
  }

  // ---- legacy single-field contract ----
  const fieldType = str(body.field_type);
  const normalisedType = FIELD_TYPES.find((t) => t.toLowerCase() === fieldType.toLowerCase());
  if (fieldType && !normalisedType) invalid.push(`field_type must be one of ${FIELD_TYPES.join(', ')}`);
  const label = str(body.field_label);
  if (label && label.length > 40) invalid.push('field_label must be 40 characters or fewer');
  const value = {
    ...common,
    target_object: 'Account',
    field_label: label,
    field_api_name: str(body.field_api_name) || (label ? toApiName(label) : ''),
    field_type: normalisedType || fieldType,
    text_length: Number(body.text_length) > 0 ? Math.min(Number(body.text_length), 255) : 100,
    required_on_layout: ['true', 'yes', '1'].includes(str(body.required_on_layout).toLowerCase()),
    permission_set: str(body.permission_set),
  };
  value.change_request = legacyChangeRequest(value);
  value.title = label;
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, value };
}
