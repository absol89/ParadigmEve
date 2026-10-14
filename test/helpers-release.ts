import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { strToU8, zipSync } from 'fflate';

/** A local stand-in for GitHub: release metadata under /api, assets under /dl. No real network. */
export interface MockRelease { tag: string; assets: Array<{ name: string; bytes: Uint8Array; digest?: string | null; size?: number }>; prerelease?: boolean }
export function mockReleaseServer() {
  const releases = new Map<string, MockRelease>();
  const requests: string[] = [];
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    const meta = /^\/api\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url);
    if (meta) {
      const release = releases.get(meta[1]!);
      if (!release) { res.writeHead(404).end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        tag_name: release.tag,
        draft: false,
        prerelease: release.prerelease ?? false,
        assets: release.assets.map((asset) => ({
          name: asset.name,
          size: asset.size ?? asset.bytes.length,
          digest: asset.digest === undefined ? `sha256:${createHash('sha256').update(asset.bytes).digest('hex')}` : asset.digest,
          browser_download_url: `${base}/dl/${meta[1]}/releases/download/${release.tag}/${asset.name}`
        }))
      }));
      return;
    }
    const download = /^\/dl\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url);
    const asset = download ? releases.get(download[1]!)?.assets.find((entry) => entry.name === download[3]) : undefined;
    if (!asset) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(asset.bytes));
  });
  return {
    releases,
    requests,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      return { apiBase: `${base}/api`, downloadBase: `${base}/dl` };
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

export function craftZip(slug: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ [`${slug}/${slug}-cli.exe`]: strToU8(`fake ${slug} cli`), [`${slug}/${slug}.exe`]: strToU8('fake desktop app'), ...extra });
}
