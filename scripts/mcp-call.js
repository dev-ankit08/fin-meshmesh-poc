// Generic MCP tool caller for investigation: node scripts/mcp-call.js <tool> '<json args>'
import '../src/config.js';
import * as mesh from '../src/meshmesh.js';

const [tool, args = '{}'] = process.argv.slice(2);
try {
  const r = await mesh.callTool(tool, JSON.parse(args));
  console.log(r.json ? JSON.stringify(r.json, null, 2) : r.text);
  process.exit(0);
} catch (e) {
  console.error(e.meshmesh ? e.message : e);
  process.exit(1);
}
