// Manual check of the read-only Salesforce guard: node scripts/sf-guard-check.js
import '../src/config.js';
import { findExistingField, verifyConfiguration } from '../src/sfcheck.js';

const show = (t, v) => console.log(`${t}:`, JSON.stringify(v));
show('existing by API name (PoC_Customer_Tier__c)', await findExistingField('Account', 'PoC_Customer_Tier__c', 'Something Else'));
show('existing by label (Renewal Risk)', await findExistingField('Account', 'Totally_New__c', 'Renewal Risk'));
show('new field (Guard Test Field)', await findExistingField('Account', 'Guard_Test_Field__c', 'Guard Test Field'));
show('verify Renewal Risk / Text / Fin PoC Access', await verifyConfiguration({ target_object: 'Account', field_api_name: 'Renewal_Risk__c', field_type: 'Text', permission_set: 'Fin PoC Access' }));
show('verify wrong type (Renewal Risk as Number)', await verifyConfiguration({ target_object: 'Account', field_api_name: 'Renewal_Risk__c', field_type: 'Number', permission_set: 'Fin PoC Access' }));
