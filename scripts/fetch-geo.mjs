// Download v2fly geoip.dat and geosite.dat (dlc.dat) into data/geo/.
// Checks each file against the lockfile and the official .sha256sum asset.
// A mismatch deletes the partial download and exits with an error.
// Never writes the binaries into git.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCK_PATH = join(ROOT, 'data', 'geo.lock.json');
const DEST_DIR = join(ROOT, 'data', 'geo');

const REPOS = new Set(['geoip', 'domain-list-community']);
const ASSETS = {
  geoip: 'geoip.dat',
  'domain-list-community': 'dlc.dat',
};

export function assertV2flyReleaseUrl(url, { repo, asset }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid geo dataset URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error(`Refusing geo dataset URL outside https://github.com: ${url}`);
  }
  if (!REPOS.has(repo) || ASSETS[repo] !== asset) {
    throw new Error(`Refusing geo dataset ${repo}/${asset}; only v2fly geoip.dat and dlc.dat are allowed`);
  }
  const prefix = `/v2fly/${repo}/releases/download/`;
  if (!parsed.pathname.startsWith(prefix)) {
    throw new Error(`Refusing non-v2fly geo dataset URL: ${url}`);
  }
  const name = parsed.pathname.slice(prefix.length).split('/')[1];
  if (name !== asset && name !== `${asset}.sha256sum`) {
    throw new Error(`Refusing unexpected geo asset in ${url}`);
  }
}

export function parseSha256Sum(text, asset) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  throw new Error(`Official checksum has no SHA-256 line for ${asset}`);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertChecksum(label, actual, expected) {
  const got = String(actual).toLowerCase();
  const want = String(expected).toLowerCase();
  if (got !== want) {
    throw new Error(`${label} checksum mismatch: expected ${want}, got ${got}`);
  }
}

async function readBody(response, url) {
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function installDatasets({
  lock,
  destDir,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!lock?.datasets?.length) throw new Error('Geo lockfile has no datasets');
  mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const item of lock.datasets) {
    assertV2flyReleaseUrl(item.url, item);
    assertV2flyReleaseUrl(item.checksumUrl, { repo: item.repo, asset: item.asset });
    const officialText = (await readBody(await fetchImpl(item.checksumUrl), item.checksumUrl)).toString('utf8');
    const official = parseSha256Sum(officialText, item.asset);
    assertChecksum(`${item.file} official .sha256sum vs lockfile`, official, item.sha256);

    const partial = join(destDir, `${item.file}.partial`);
    const finalPath = join(destDir, item.file);
    try {
      const bytes = await readBody(await fetchImpl(item.url), item.url);
      const digest = sha256(bytes);
      assertChecksum(`${item.file} download vs official .sha256sum`, digest, official);
      assertChecksum(`${item.file} download vs lockfile`, digest, item.sha256);
      writeFileSync(partial, bytes);
      renameSync(partial, finalPath);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
    written.push({ file: item.file, sha256: item.sha256, tag: item.tag });
  }
  return written;
}

export function loadLock(path = LOCK_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const lock = loadLock();
  const written = await installDatasets({ lock, destDir: DEST_DIR });
  for (const item of written) {
    console.log(`geo ${item.file} ${item.tag} ${item.sha256}`);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

export const paths = { ROOT, LOCK_PATH, DEST_DIR };
