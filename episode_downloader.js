#!/usr/bin/env node
/**
 * Automated workflow for locating, downloading, subtitling, and muxing an episode.
 *
 * Designed for LEGAL content only. Ensure you hold the rights to any media you process.
 *
 * Prerequisites:
 *  - Node.js ≥ 18
 *  - FFmpeg installed and in PATH
 *  - WebTorrent (npm module)
 *  - Environment variables:
 *      OPENAI_API_KEY           – for subtitle translation (if needed)
 *      OS_API_USER & OS_API_PASS – OpenSubtitles credentials (free account)
 *
 * Usage:
 *   node episode_downloader.js --show "Rick and Morty" --season 8 --episode 5 \
 *       --out /path/to/output
 */
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const cheerio = require('cheerio');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { program } = require('commander');

dotenv.config();

const execAsync = promisify(exec);

// --------------------------- CLI Arguments ----------------------------------
program
  .requiredOption('--show <title>', 'Show title, e.g., "Rick and Morty"')
  .requiredOption('--season <number>', 'Season number', parseInt)
  .requiredOption('--episode <number>', 'Episode number', parseInt)
  .option('--out <dir>', 'Output directory', '.')
  .option('--min-seeds <n>', 'Minimum seeders', parseInt, 20)
  .parse();

const options = program.opts();
const { show, season, episode, out, minSeeds } = options;
const EP_CODE = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;

// --------------------------- Helpers ---------------------------------------
function similarity(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  b = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / Math.max(a.length, b.length);
}

function scoreTorrent(torrent, searchQuery) {
  const title = torrent.name;
  const sim = similarity(title, searchQuery);
  // Use similarity as main score, seeders as tiebreaker
  return sim * 1000 + parseInt(torrent.seeders || 0) / 1000;
}

function pirateBaySearchUrl(query) {
  return `https://thepiratebay.org/search.php?q=${encodeURIComponent(query)}&all=on&page=0&orderby=99`;
}

async function findMagnet() {
  const apiUrl = `https://apibay.org/q.php?q=${encodeURIComponent(`${show} ${EP_CODE}`)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`apibay request failed: ${res.status}`);
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('No torrents found for this episode.');
  }
  // Optionally filter by seeds, etc.
  const filtered = results.filter(t => t.seeders && parseInt(t.seeders) >= (minSeeds || 0));
  if (filtered.length === 0) {
    throw new Error('No torrents found with enough seeders.');
  }
  const searchQuery = `${show} ${EP_CODE}`;
  const scored = filtered.map(t => ({ ...t, score: scoreTorrent(t, searchQuery) }));
  // Log all found torrents and their scores
  console.log('Found torrents and their scores:');
  scored.forEach(t => {
    console.log(`  Name: ${t.name}, Seeders: ${t.seeders}, Score: ${t.score.toFixed(2)}`);
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  console.log(`Selected torrent for download: ${top.name}`);
  const magnet = `magnet:?xt=urn:btih:${top.info_hash}&dn=${encodeURIComponent(top.name)}&tr=udp://tracker.openbittorrent.com:80/announce`;
  return magnet;
}

async function downloadTorrent(magnet, outputDir) {
  console.log('Starting torrent download…');
  let WebTorrent;
  WebTorrent = (await import('webtorrent')).default;
  const client = new WebTorrent();
  return new Promise((resolve, reject) => {
    client.add(magnet, { path: outputDir }, torrent => {
      console.log('Torrent files:', torrent.files.map(f => f.name));
      const video = torrent.files.find(file =>
        file.name.match(/\.(mp4|mkv|avi|mov|wmv|flv)$/i)
      );
      if (!video) {
        console.error('No video file found in the torrent. Files:', torrent.files.map(f => f.name));
        reject(new Error('No video file found in the torrent.'));
        return;
      }
      const startTime = Date.now();
      let lastLogged = 0;
      const logInterval = setInterval(() => {
        const percent = (torrent.progress * 100).toFixed(2);
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const eta = torrent.timeRemaining ? (torrent.timeRemaining / 1000).toFixed(1) : 'N/A';
        // Only log if progress changed or every 5 seconds
        if (percent !== lastLogged || elapsed % 5 < 1) {
          console.log(`Downloaded: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta}s`);
          lastLogged = percent;
        }
      }, 1000);
      torrent.on('done', () => {
        clearInterval(logInterval);
        console.log('Torrent download complete');
        client.destroy();
        resolve(path.join(outputDir, video.path));
      });
    });
  });
}

// --------------------------- OpenSubtitles API -----------------------------
async function opensubsLogin() {
  const { OS_API_USER, OS_API_PASS } = process.env;
  if (!OS_API_USER || !OS_API_PASS) throw new Error('Set OS_API_USER & OS_API_PASS env vars');
  const res = await fetch('https://api.opensubtitles.com/api/v1/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': 'temporary_key' // replace with your OpenSubtitles API key if you have one
    },
    body: JSON.stringify({ username: OS_API_USER, password: OS_API_PASS })
  });
  const data = await res.json();
  if (!data.token) throw new Error('OpenSubtitles login failed');
  return data.token;
}

async function searchSubtitles(token, lang) {
  const query = `${show} ${season}x${String(episode).padStart(2, '0')}`;
  const url = `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(query)}&languages=${lang}`;
  const res = await fetch(url, {
    headers: {
      'Api-Key': 'temporary_key',
      Authorization: `Bearer ${token}`
    }
  });
  const data = await res.json();
  return data.data?.[0]?.attributes?.url || null;
}

async function downloadSubtitle(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Subtitle download failed');
  const buffer = await res.arrayBuffer();
  await fs.writeFile(dest, Buffer.from(buffer));
}

// --------------------------- Translation via OpenAI ------------------------
async function translateSRTtoHebrew(srcPath, destPath) {
  const openai = new OpenAI();
  const text = await fs.readFile(srcPath, 'utf-8');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 4096,
    messages: [
      { role: 'system', content: 'You are a subtitles translation assistant. Keep timestamps unchanged and translate dialogue only.' },
      { role: 'user', content: `Translate the following SRT file content to Hebrew while preserving timestamps:\n\n${text}` }
    ]
  });
  const translated = response.choices[0].message.content;
  await fs.writeFile(destPath, translated, 'utf-8');
}

// --------------------------- FFmpeg Mux ------------------------------------
async function muxSubtitles(videoPath, srtPath, outputPath) {
  const cmd = `ffmpeg -y -i "${videoPath}" -vf subtitles='${srtPath.replace(/'/g, "'\\''")}' -c:v libx264 -c:a copy "${outputPath}"`;
  console.log('Running ffmpeg…');
  await execAsync(cmd);
  console.log('Muxing complete →', outputPath);
}

// --------------------------- Main Workflow ---------------------------------
(async () => {
  try {
    const outputDir = path.resolve(out);
    if (!existsSync(outputDir)) await fs.mkdir(outputDir, { recursive: true });

    // 1. Torrent search & download
    const magnet = await findMagnet();
    console.log('Magnet link found');
    const videoPath = await downloadTorrent(magnet, outputDir);

    // 2. Subtitles
    const token = await opensubsLogin();
    let subUrl = await searchSubtitles(token, 'heb');
    let subtitlePath = path.join(outputDir, `${EP_CODE}.srt`);

    if (subUrl) {
      console.log('Hebrew subtitles found');
      await downloadSubtitle(subUrl, subtitlePath);
    } else {
      console.log('Hebrew not found, trying English…');
      subUrl = await searchSubtitles(token, 'eng');
      if (!subUrl) throw new Error('No subtitles found');
      const engPath = path.join(outputDir, `${EP_CODE}.eng.srt`);
      await downloadSubtitle(subUrl, engPath);
      console.log('Translating subtitles…');
      await translateSRTtoHebrew(engPath, subtitlePath);
    }

    // 3. Mux subtitles
    const outputVideo = path.join(outputDir, `${path.parse(videoPath).name}.heb.mp4`);
    await muxSubtitles(videoPath, subtitlePath, outputVideo);
    console.log('✅ All done!');
  } catch (err) {
    console.error('⛔', err.message);
    process.exit(1);
  }
})();
