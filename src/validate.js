// Contract between Fin and the bridge for the PoC use case:
// "Add one custom field to Account, put it on the layout, grant a permission set access."

export const FIELD_TYPES = ['Text', 'Number', 'Checkbox', 'Date'];

const REQUIRED = ['requestor_email', 'field_label', 'field_type', 'permission_set', 'business_reason'];

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

export function toApiName(label) {
  const base = str(label)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/__+/g, '_');
  const safe = /^[A-Za-z]/.test(base) ? base : `F_${base}`;
  return `${safe.slice(0, 40)}__c`;
}

/** Returns { ok, missing[], invalid[], value } */
export function validateRequest(body = {}) {
  const missing = REQUIRED.filter((k) => !str(body[k]));
  const invalid = [];

  const fieldType = str(body.field_type);
  const normalisedType = FIELD_TYPES.find((t) => t.toLowerCase() === fieldType.toLowerCase());
  if (fieldType && !normalisedType) invalid.push(`field_type must be one of ${FIELD_TYPES.join(', ')}`);

  const email = str(body.requestor_email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) invalid.push('requestor_email is not a valid email');

  const label = str(body.field_label);
  if (label && label.length > 40) invalid.push('field_label must be 40 characters or fewer');

  const requiredOnLayoutRaw = str(body.required_on_layout).toLowerCase();
  const requiredOnLayout = ['true', 'yes', '1'].includes(requiredOnLayoutRaw);

  const value = {
    conversation_id: str(body.conversation_id),
    callback_url: str(body.callback_url),
    final_callback_url: str(body.final_callback_url),
    requestor_email: email,
    target_object: 'Account',
    field_label: label,
    field_api_name: str(body.field_api_name) || (label ? toApiName(label) : ''),
    field_type: normalisedType || fieldType,
    text_length: Number(body.text_length) > 0 ? Math.min(Number(body.text_length), 255) : 100,
    required_on_layout: requiredOnLayout,
    permission_set: str(body.permission_set),
    business_reason: str(body.business_reason),
  };

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid, value };
}

/** Builds the natural-language mission MeshMesh receives. Deterministic so tests can assert on it. */
export function buildMeshMeshPrompt(v, requestId) {
  const typeSpec =
    v.field_type === 'Text' ? `Text(${v.text_length})` :
    v.field_type === 'Number' ? 'Number(18, 0)' :
    v.field_type === 'Checkbox' ? 'Checkbox (default unchecked)' : 'Date';
  return [
    `[Fin PoC request ${requestId}] Requested by ${v.requestor_email} via Intercom Fin.`,
    `In the attached Salesforce org, create ONE custom field on the ${v.target_object} object:`,
    `- Label: "${v.field_label}"`,
    `- API name: ${v.field_api_name}`,
    `- Type: ${typeSpec}`,
    `- ${v.required_on_layout ? 'Required on the page layout' : 'Not required'}`,
    `Add the field to the default ${v.target_object} page layout.`,
    `Create the permission set "${v.permission_set}" if it does not already exist, and grant it Read and Edit field-level security on the new field.`,
    `Business reason: ${v.business_reason}`,
    `To check whether the field exists, query the Tooling API (SELECT QualifiedApiName, Label FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${v.target_object}'); do NOT rely on describe, which hides fields the running user has no field-level access to. Treat a match on API name or label as existing.`,
    `If a field with this API name or label already exists on ${v.target_object}, STOP immediately (do not plan or build anything), do not modify it, and end your message with the line "RESULT: FAILED - duplicate field".`,
    `Done means: the field exists, it is on the layout, and the permission set has Read/Edit on it. Verify each item.`,
    `When the build is finished, end your final message with exactly one line: "RESULT: SUCCEEDED" or "RESULT: FAILED - <one-line reason>". Do not write that line in a plan.`,
    `Do not change anything else in the org.`,
  ].join('\n');
}
