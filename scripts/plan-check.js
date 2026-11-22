// Dry run of the generic guard against the real org, WITHOUT MeshMesh: policy + read-only pre-check
// for a CHANGESET you write by hand. Useful to tune config/policy.json and to test the sf CLI login.
// Usage: node scripts/plan-check.js examples/changeset-outbound.json [sf-alias]
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { parseChangeset, formatChanges, planVersion } from '../src/changeset.js';
import { evaluatePolicy } from '../src/policy.js';
import { precheck } from '../src/guard.js';

const [file, alias = config.sfTargetOrg] = process.argv.slice(2);
if (!file) { console.error('Usage: node scripts/plan-check.js <changeset.json> [sf-alias]'); process.exit(1); }
const p = parseChangeset(`BEGIN_CHANGESET\n${readFileSync(file, 'utf8')}\nEND_CHANGESET`);
if (!p.ok) { console.error(p.error); process.exit(1); }
console.log(`Plan ${planVersion(p.changes)}:\n${formatChanges(p.changes)}\n`);
const pre = await precheck(p.changes, alias);
console.log('Pre-check:', JSON.stringify({ ...pre, existing: [...pre.existing] }, null, 2));
console.log('Policy:', JSON.stringify(evaluatePolicy(p.changes, undefined, pre.existing), null, 2));
