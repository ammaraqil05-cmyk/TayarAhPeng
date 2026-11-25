/**
 * Stateless HMAC-SHA256 admin session authentication using ADMIN_PASSWORD.
 * Returns 503 whenever ADMIN_PASSWORD is not configured.
 */

const COOKIE_NAME = 'ahpeng_admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256Bytes(text) {
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function getHmacKey(secret) {
  const raw = new TextEncoder().encode(`ahpeng-cms:${secret}`);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function verifyPassword(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  const [a, b] = await Promise.all([sha256Bytes(submitted), sha256Bytes(expected)]);
  return timingSafeEqualBytes(a, b);
}

export async function createSessionToken(secret) {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const payload = `${exp}.${toBase64Url(nonceBytes)}`;
  const key = await getHmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = toBase64Url(new Uint8Array(sigBuf));
  return `${payload}.${sig}`;
}

export async function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sigStr] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const payload = `${expStr}.${nonce}`;
  let sigBytes;
  try {
    sigBytes = fromBase64Url(sigStr);
  } catch {
    return false;
  }
  const key = await getHmacKey(secret);
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload));
}

export function extractToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = request.headers.get('Cookie') || '';
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    if (name === COOKIE_NAME) {
      return decodeURIComponent(pair.slice(idx + 1).trim());
    }
  }
  return null;
}

export function buildSessionCookie(token, request, clear = false) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  if (clear) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/**
 * Checks whether ADMIN_PASSWORD is configured and the request carries a valid admin token.
 * Returns null if authorized, or a Response (503 or 401) if rejected.
 */
export async function requireAdmin(request, env, jsonResponse) {
  const adminPassword = env?.ADMIN_PASSWORD;
  if (!adminPassword || String(adminPassword).trim() === '') {
    return jsonResponse(
      {
        error:
          'ADMIN_PASSWORD belum dikonfigurasi. Sila tetapkan secret ADMIN_PASSWORD dalam Cloudflare Worker atau .dev.vars.',
      },
      503
    );
  }

  const token = extractToken(request);
  const valid = await verifySessionToken(token, String(adminPassword));
  if (!valid) {
    return jsonResponse({ error: 'Sesi admin tidak sah atau telah tamat. Sila log masuk semula.' }, 401);
  }
  return null;
}
