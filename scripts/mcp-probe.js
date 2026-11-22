// Lists MeshMesh MCP tools and connections so we can fill MESHMESH_CONNECTION_ID and tune status mapping.
// Usage: npm run probe            (requires the bridge to have been signed in via /oauth/start)
//        npm run probe -- status <agentId>
import '../src/config.js';
import * as mesh from '../src/meshmesh.js';

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'status') {
    const r = await mesh.callTool('get_agent_status', { agentId: arg });
    console.log(JSON.stringify(r.json ?? r.text, null, 2));
  } else if (cmd === 'plan') {
    const r = await mesh.callTool('get_plan', { agentId: arg });
    console.log(JSON.stringify(r.json ?? r.text, null, 2));
  } else {
    const tools = await mesh.listTools();
    console.log('TOOLS:\n' + tools.map((t) => `- ${t.name}: ${(t.description || '').split('\n')[0]}`).join('\n'));
    const conns = await mesh.callTool('list_connections', {});
    console.log('\nCONNECTIONS:\n' + JSON.stringify(conns.json ?? conns.text, null, 2));
  }
  process.exit(0);
} catch (e) {
  console.error(e.message === 'MESHMESH_AUTH_REQUIRED' ? 'Not signed in. Start the bridge (npm start) and open http://localhost:8787/oauth/start' : e);
  process.exit(1);
}
