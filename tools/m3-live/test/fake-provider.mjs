// Offline stand-in for the provider: records every request, signs session tokens with a throwaway RS256 key.
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';

export const PROJECT_ID = `P${'a'.repeat(27)}`;
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export async function startFake(claimsOverride = {}, headerOverride = {}, { wrongSignature = false } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'k1';
  const requests = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? '' });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/mgmt/tests/generate/otp') return res.end(JSON.stringify({ code: '123456' }));
      if (req.url === '/v1/auth/otp/verify/email') {
        const header = { alg: 'RS256', typ: 'JWT', kid, ...headerOverride };
        const payload = { iss: PROJECT_ID, sub: 'U1', drn: 'DS', exp: Math.floor(Date.now() / 1000) + 600, ...claimsOverride };
        const signing = `${b64(header)}.${b64(payload)}`;
        const sig = createSign('RSA-SHA256').update(signing).sign(wrongSignature ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : privateKey).toString('base64url');
        return res.end(JSON.stringify({ sessionJwt: `${signing}.${sig}` }));
      }
      if (req.url === `/v2/keys/${PROJECT_ID}`) return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' }] }));
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${String(server.address().port)}`, close: () => new Promise((r) => server.close(r)) };
}
