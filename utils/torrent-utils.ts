import path from 'path';
// @ts-ignore
const fetch: any = function(...args: any[]) { return import('node-fetch').then(mod => (mod.default || mod)(...args)); };
import { formatDuration } from './time-utils';
import { sendMessage } from './messaging-utils';

let WebTorrentClass: any;
async function getWebTorrent() {
  if (!WebTorrentClass) {
    WebTorrentClass = (await import('webtorrent')).default;
  }
  return WebTorrentClass;
}

let chalkInstance: any;
async function getChalk() {
  if (!chalkInstance) {
    chalkInstance = (await import('chalk')).default;
  }
  return chalkInstance;
}

export interface Torrent {
  name: string;
  seeders?: string | number;
  info_hash: string;
  [key: string]: any;
}

export function scoreTorrent(torrent: Torrent, searchQuery: string): number {
  const title = torrent.name;
  let qualityScore = 0;
  if (/1080p/i.test(title)) qualityScore = 3;
  else if (/720p/i.test(title)) qualityScore = 2;
  else if (/480p/i.test(title)) qualityScore = 1;
  return qualityScore * 1000 + parseInt(torrent.seeders ? String(torrent.seeders) : '0') / 1000;
}

export async function findMagnet(show: string, EP_CODE: string, minSeeds: number): Promise<string> {
  const apiUrl = `https://apibay.org/q.php?q=${encodeURIComponent(`${show} ${EP_CODE}`)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`apibay request failed: ${res.status}`);
  const results = (await res.json()) as Torrent[];
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('No torrents found for this episode.');
  }
  const filtered = results.filter(t => t.seeders && parseInt(String(t.seeders)) >= (minSeeds || 0));
  if (filtered.length === 0) {
    throw new Error('No torrents found with enough seeders.');
  }
  const searchQuery = `${show} ${EP_CODE}`;
  const scored = filtered.map(t => ({ ...t, score: scoreTorrent(t, searchQuery) }));
  console.log('Found torrents and their scores:');
  scored.forEach((t: Torrent) => {
    console.log(`  Name: ${t.name}, Seeders: ${t.seeders}, Score: ${t.score.toFixed(2)}`);
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const chalk = await getChalk();
  console.log(chalk.green(`Selected torrent for download: ${top.name}`));
  const magnet = `magnet:?xt=urn:btih:${top.info_hash}&dn=${encodeURIComponent(top.name)}&tr=udp://tracker.openbittorrent.com:80/announce`;
  return magnet;
}

export async function findMagnets(show: string, EP_CODE: string, minSeeds: number): Promise<Torrent[]> {
  const apiUrl = `https://apibay.org/q.php?q=${encodeURIComponent(`${show} ${EP_CODE}`)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`apibay request failed: ${res.status}`);
  const results = (await res.json()) as Torrent[];
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('No torrents found for this episode.');
  }
  const filtered = results.filter(t => t.seeders && parseInt(String(t.seeders)) >= (minSeeds || 0));
  if (filtered.length === 0) {
    throw new Error('No torrents found with enough seeders.');
  }
  const searchQuery = `${show} ${EP_CODE}`;
  const scored = filtered.map(t => ({ ...t, score: scoreTorrent(t, searchQuery) }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export async function downloadTorrent(
  magnet: string,
  outputDir: string,
  downloadTorrentMessage: string,
  episodeName: string
): Promise<string> {
  const chalk = await getChalk();
  console.log(chalk.green(`Starting torrent download…`));
  const WebTorrent = await getWebTorrent();
  const client = new WebTorrent();
  return new Promise((resolve, reject) => {
    // @ts-ignore: WebTorrent typings may not match actual usage
    client.add(magnet, { path: outputDir }, async (torrent: any) => {
      console.log('Torrent files:', torrent.files.map((f: any) => f.name));
      const video = torrent.files.find((file: any) =>
        file.name.match(/\.(mp4|mkv|avi|mov|wmv|flv)$/i)
      );
      if (!video) {
        console.error('No video file found in the torrent. Files:', torrent.files.map((f: any) => f.name));
        reject(new Error('No video file found in the torrent.'));
        return;
      }
      await sendMessage(`${downloadTorrentMessage}\n\n 📁 File: ${video.name}`);

      const startTime = Date.now();
      let lastLogged = '';
      let lastPercentNotified = 0;
      const notifyStep = 20;
      const logInterval = setInterval(async () => {
        const percent = (torrent.progress * 100).toFixed(2);
        const percentInt = Math.floor(torrent.progress * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const eta = torrent.timeRemaining ? (torrent.timeRemaining / 1000) : 0;
        if (percent !== lastLogged || elapsed % 5 < 1) {
          process.stdout.write(`\rDownloaded: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta.toFixed(1)}s   `);
          lastLogged = percent;
        }
        if (percentInt >= lastPercentNotified + notifyStep) {
          lastPercentNotified += notifyStep;
          if (lastPercentNotified <= 100) {
            await sendMessage(`${video.name}\n\nDownloading...\n${lastPercentNotified}% (Elapsed: ${formatDuration(elapsed)}, ETA: ${formatDuration(eta)})`
            );
          }
        }
      }, 1000) as unknown as NodeJS.Timeout;
      torrent.on('done', () => {
        clearInterval(logInterval);
        process.stdout.write('\n');
        console.log('Torrent download complete');
        client.destroy();
        resolve(path.join(outputDir, video.path));
      });
    });
  });
} 