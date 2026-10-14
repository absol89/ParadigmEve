/**
 * Acquires one file-capability provider for this machine only.
 *
 * Nothing here runs at build time and nothing is bundled. PluginManager's install transaction
 * reaches this only after the user said yes in Eve's own confirmation (file-provider-consent.ts).
 * Every step fails closed: the newest stable release of the app's official repository must list
 * the one asset for this OS and CPU *with* a published SHA-256 digest, the download may not exceed
 * the published size and must hash to that digest, and the archive passes the same validated
 * extraction as an MCP bundle before the one expected CLI is located.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  currentProviderPlatform,
  fileCapabilityProvider,
  providerAssetTemplate,
  type FileCapabilityProvider,
  type ProviderPlatform
} from './file-capabilities.js';
import { unzipValidated, writeUnzipped, type InstalledLaunch } from './plugins/installer.js';

/** Endpoints are fixed in production; tests point them at a local mock release server. */
export interface ProviderAcquireOptions {
  fetch?: typeof fetch;
  apiBase?: string;
  downloadBase?: string;
  platform?: ProviderPlatform | null;
  signal?: AbortSignal;
  /** The version the user approved; a different newest release is refused, not installed. */
  expectVersion?: string;
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_DOWNLOAD = 'https://github.com';
/** Hosts GitHub serves release downloads from after its redirect. */
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;

let testOptions: ProviderAcquireOptions = {};
/** Test seam: points release metadata and downloads at a mock release server. */
export function setProviderAcquireOptionsForTests(options: ProviderAcquireOptions): void {
  testOptions = options;
}

/** A refusal the user can be told as-is: nothing was downloaded or installed. */
export class ProviderUnavailableError extends Error {}

interface ReleaseMetadata {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: Array<{ name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown }>;
}

async function boundedBody(response: Response, limit: number, label: string): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`${label} request failed (HTTP ${response.status}).`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) throw new Error(`${label} is larger than expected.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${label} is larger than expected.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Finds exactly one file with this basename; anything else is an unexpected archive layout. */
function locateExecutable(names: readonly string[], executable: string): string {
  const matches = names.filter((name) => !name.endsWith('/') && name.split('/').pop()!.toLowerCase() === executable.toLowerCase());
  if (matches.length !== 1) throw new Error(`The downloaded archive does not contain exactly one ${executable}.`);
  return matches[0]!;
}

export interface ProviderReleaseChoice {
  provider: FileCapabilityProvider;
  tag: string;
  version: string;
  asset: { name: string; size: number; sha256: string; url: string };
}

/** Reads the official release metadata and chooses this machine's asset, or refuses. */
export async function chooseProviderRelease(providerId: string, given: ProviderAcquireOptions = {}): Promise<ProviderReleaseChoice> {
  const options = { ...testOptions, ...given };
  const provider = fileCapabilityProvider(providerId);
  if (!provider) throw new ProviderUnavailableError('This app is not in ParadigmEve\'s registry.');
  const platform = options.platform === undefined ? currentProviderPlatform() : options.platform;
  const template = providerAssetTemplate(provider, platform);
  if (!template) throw new ProviderUnavailableError(`${provider.displayName} does not publish a build ParadigmEve can install on this system yet.`);
  const http = options.fetch ?? fetch;
  const response = await http(`${options.apiBase ?? GITHUB_API}/repos/${provider.release.repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
    redirect: 'error',
    ...(options.signal ? { signal: options.signal } : {})
  });
  let metadata: ReleaseMetadata;
  try {
    metadata = JSON.parse((await boundedBody(response, MAX_METADATA_BYTES, 'Release metadata')).toString('utf8')) as ReleaseMetadata;
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'Release metadata is not valid JSON.' : (error as Error).message);
  }
  const tag = typeof metadata.tag_name === 'string' ? metadata.tag_name : '';
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || metadata.draft === true || metadata.prerelease === true) {
    throw new ProviderUnavailableError(`${provider.displayName} has no stable release to install.`);
  }
  const version = tag.slice(1);
  const name = template.replace('{version}', version);
  const published = (metadata.assets ?? []).find((entry) => entry.name === name);
  if (!published) throw new ProviderUnavailableError(`${provider.displayName} ${version} has no build for this system yet.`);
  if (typeof published.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(published.digest)) {
    throw new ProviderUnavailableError(`${provider.displayName} ${version} publishes no SHA-256 checksum for this build, so ParadigmEve will not install it.`);
  }
  const size = published.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_BYTES) {
    throw new ProviderUnavailableError(`${provider.displayName} ${version} has an unexpected download size.`);
  }
  const url = `${options.downloadBase ?? GITHUB_DOWNLOAD}/${provider.release.repo}/releases/download/${tag}/${name}`;
  if (published.browser_download_url !== url) throw new ProviderUnavailableError('The release download address is not the official one.');
  return { provider, tag, version, asset: { name, size, sha256: published.digest.slice('sha256:'.length), url } };
}

export async function acquireFileProvider(providerId: string, directory: string, given: ProviderAcquireOptions = {}): Promise<InstalledLaunch> {
  const options = { ...testOptions, ...given };
  const { provider, version, asset } = await chooseProviderRelease(providerId, options);
  if (options.expectVersion && options.expectVersion !== version) {
    throw new ProviderUnavailableError(`${provider.displayName} published a newer release (${version}) after you approved ${options.expectVersion}. Nothing was installed; ask again to install the new one.`);
  }
  const http = options.fetch ?? fetch;
  const download = await http(asset.url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) });
  if (!options.downloadBase && !DOWNLOAD_HOSTS.has(new URL(download.url || asset.url).hostname)) {
    throw new Error('The download was redirected to an unexpected host.');
  }
  const bytes = await boundedBody(download, asset.size, 'Download');
  if (bytes.length !== asset.size) throw new Error('The download is incomplete.');
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('The download does not match the SHA-256 its release publishes. Nothing was installed.');
  }

  const { files, modes } = unzipValidated(bytes, provider.displayName, MAX_EXTRACTED_BYTES);
  const executable = `${provider.release.cli}${(options.platform ?? currentProviderPlatform())?.startsWith('win32') ? '.exe' : ''}`;
  const relative = locateExecutable(Object.keys(files), executable);
  const target = path.join(directory, 'app');
  await writeUnzipped(files, modes, target);
  const command = path.resolve(target, relative);
  if (!command.startsWith(path.resolve(target) + path.sep)) throw new Error('Unsafe executable path.');
  if (process.platform !== 'win32') await fs.chmod(command, 0o700);
  return { command, args: [...provider.release.mcpArgs], version, license: provider.license };
}
