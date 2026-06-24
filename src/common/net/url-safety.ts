/**
 * SSRF guard for fetching CUSTOMER-supplied URLs server-side.
 *
 * The customer's image URL (Facebook CDN `lastImageUrl`) is fetched
 * by the backend (vision pre-step + visual search). Without a guard a crafted
 * URL like `http://169.254.169.254/…` (cloud metadata) or `http://10.0.0.5/…`
 * reaches internal services from the backend's network position. This validates
 * a URL before any such fetch:
 *   - scheme must be http/https,
 *   - the host must not be a private/loopback/link-local IP literal,
 *   - the host must not RESOLVE to one (basic DNS-rebinding mitigation).
 *
 * Residual (accepted for a minimal guard): TOCTOU between resolve and fetch, and
 * exotic literal forms (decimal/hex IPs) that the OS resolver would have to
 * accept anyway. This stops the realistic SSRF vectors, not a determined
 * resolver-level attacker.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** True for IPv4/IPv6 literals that must never be fetched server-side. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return false; // not an IP literal
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved 224.0.0.0+
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]; // strip zone id
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Throw {@link UnsafeUrlError} unless `rawUrl` is an http(s) URL whose host is a
 * public address (or resolves to one). Safe to call before any server-side fetch
 * of a customer-supplied URL.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`disallowed URL scheme: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeUrlError('host is a loopback name');
  }

  // IP literal → check directly, no DNS.
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new UnsafeUrlError('URL host is a private/reserved IP');
    }
    return;
  }

  // Named host → resolve and reject if ANY resolved address is private/reserved.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`could not resolve host: ${host}`);
  }
  if (
    addresses.length === 0 ||
    addresses.some((a) => isPrivateOrReservedIp(a.address))
  ) {
    throw new UnsafeUrlError('host resolves to a private/reserved address');
  }
}
