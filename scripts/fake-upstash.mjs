/**
 * A minimal Upstash-REST stand-in, for testing locally without an account.
 *
 *   node scripts/fake-upstash.mjs [port] [token]
 *
 * It speaks the same protocol this app's store uses — POST the command as a
 * JSON array, authenticating with `Authorization: Bearer <token>`:
 *
 *   curl -X POST localhost:4000 -H 'authorization: Bearer dev' -d '["PING"]'
 *
 * Then point the app at it:
 *
 *   STORE_BACKEND=upstash KV_REST_API_URL=http://localhost:4000 \
 *   KV_REST_API_TOKEN=dev node src/server/server.js
 *   node scripts/check-kv.mjs http://localhost:4000 dev
 *
 * Data lives in memory: restarting this process simulates the thing that breaks
 * free hosting — which makes it the right fixture for `npm run smoke`, since
 * phase 2 must survive the *app* restarting while this store keeps its state.
 */
import http from 'node:http';

const port = Number(process.argv[2] || 4000);
const TOKEN = process.argv[3] || 'dev';
const data = new Map();

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };

  if (req.method !== 'POST') {
    return send(400, { error: 'ERR fake store: only POST is implemented (send the command as a JSON array in the body)' });
  }
  if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
    return send(401, { error: 'WRONGPASS invalid username-password pair or user is disabled.' });
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let command;
    try { command = JSON.parse(body); } catch { return send(400, { error: 'ERR invalid JSON body' }); }
    if (!Array.isArray(command) || !command.length) return send(400, { error: 'ERR expected a command array' });

    const [name, ...args] = command.map(String);
    switch (name.toUpperCase()) {
      case 'PING': return send(200, { result: 'PONG' });
      case 'SET': {
        if (args.length < 2) return send(400, { error: "ERR wrong number of arguments for 'set' command" });
        data.set(args[0], args.slice(1).join(' '));
        return send(200, { result: 'OK' });
      }
      case 'GET': return send(200, { result: data.has(args[0]) ? data.get(args[0]) : null });
      case 'DEL': {
        const n = args.filter((k) => data.delete(k)).length;
        return send(200, { result: n });
      }
      default: return send(400, { error: `ERR unknown command '${name}' (this fake implements PING, SET, GET, DEL)` });
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`fake Upstash REST store on http://0.0.0.0:${port}  (token: ${TOKEN})`);
  console.log('  curl -X POST localhost:%d -H "authorization: Bearer %s" -d \'["PING"]\'', port, TOKEN);
});
