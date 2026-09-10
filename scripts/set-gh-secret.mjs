// Set a GitHub Actions repo secret via the API (libsodium sealed box). node scripts/set-gh-secret.mjs <owner/repo> <NAME> <value>
// Env: GH_TOKEN. Requires: npm i -g tweetnacl (or run with a local install).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [repo, name, value] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
const H = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' };
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');
const key = await (await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, { headers: H })).json();
if (!key.key) { console.error('public key fetch failed', key); process.exit(1); }
// sealed box = X25519 ephemeral + XSalsa20-Poly1305, nonce = blake2b(epk || pk)[0..24]
const { blake2b } = require('blakejs');
const pk = util.decodeBase64(key.key);
const msg = util.decodeUTF8(value);
const eph = nacl.box.keyPair();
const nonce = blake2b(new Uint8Array([...eph.publicKey, ...pk]), undefined, 24);
const boxed = nacl.box(msg, nonce, pk, eph.secretKey);
const sealed = new Uint8Array(eph.publicKey.length + boxed.length); sealed.set(eph.publicKey); sealed.set(boxed, eph.publicKey.length);
const r = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${name}`, { method: 'PUT', headers: H, body: JSON.stringify({ encrypted_value: util.encodeBase64(sealed), key_id: key.key_id }) });
console.log(`secret ${name}: HTTP ${r.status}`);
