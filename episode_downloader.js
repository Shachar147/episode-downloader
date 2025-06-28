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
 *   node episode_downloader.js --show "Rick and Morty" --season 8 --episode 5 --out /path/to/output
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
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
let chalk;
(async () => {
  chalk = (await import('chalk')).default;
})();

dotenv.config();

// uncomment if there are login problems to verify script managed to read your credentials
// console.log('OS_API_USER:', process.env.OS_API_USER, 'OS_API_PASS:', process.env.OS_API_PASS);

const execAsync = promisify(exec);

const { OS_API_KEY } = process.env;
const OPEN_SUBTITLES_API_KEY = OS_API_KEY || 'rlF1xGalT47V4qYxdgSLR2GFTO3Cool8';
const OPEN_SUBTITLES_USER_AGENT = 'MyDownloader/1.0';

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
  // --- Similarity logic (commented out for now) ---
  // const sim = similarity(title, searchQuery);
  // return sim * 1000 + parseInt(torrent.seeders || 0) / 1000;

  // --- Quality preference ---
  let qualityScore = 0;
  if (/1080p/i.test(title)) qualityScore = 3;
  else if (/720p/i.test(title)) qualityScore = 2;
  else if (/480p/i.test(title)) qualityScore = 1;
  // You can add more quality tiers if needed

  // Use quality as main score, seeders as tiebreaker
  return qualityScore * 1000 + parseInt(torrent.seeders || 0) / 1000;
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
  console.log((chalk && chalk.green ? chalk.green : x => x)(`Selected torrent for download: ${top.name}`));
  const magnet = `magnet:?xt=urn:btih:${top.info_hash}&dn=${encodeURIComponent(top.name)}&tr=udp://tracker.openbittorrent.com:80/announce`;
  return magnet;
}

async function downloadTorrent(magnet, outputDir) {
  console.log((chalk && chalk.green ? chalk.green : x => x)(`Starting torrent download…`));
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
          process.stdout.write(`\rDownloaded: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta}s   `);
          lastLogged = percent;
        }
      }, 1000);
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

// --------------------------- OpenSubtitles API -----------------------------
async function opensubsLogin() {
  const { OS_API_USER, OS_API_PASS } = process.env;
  if (!OS_API_USER || !OS_API_PASS) throw new Error('Set OS_API_USER & OS_API_PASS env vars');
  const res = await fetch('https://api.opensubtitles.com/api/v1/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': OPEN_SUBTITLES_API_KEY,
      'User-Agent': OPEN_SUBTITLES_USER_AGENT
    },
    body: JSON.stringify({ username: OS_API_USER, password: OS_API_PASS })
  });
  const data = await res.json();
  if (!data.token) throw new Error('OpenSubtitles login failed');
  return data.token;
}

async function searchSubtitles(token, lang) {
  // Build query: show name (lowercase, + for spaces) and season number
  const showQuery = show.toLowerCase().replace(/\s+/g, '+');
  const query = `${showQuery}+season+${season}+episode+${episode}`;
  const url = `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(query)}&languages=${lang}`;
  console.log(`[OpenSubtitles] Searching by query: ${url}`);
  const res = await fetch(url, {
    headers: {
      'Api-Key': OPEN_SUBTITLES_API_KEY,
      'User-Agent': OPEN_SUBTITLES_USER_AGENT,
      Authorization: `Bearer ${token}`
    }
  });
  const data = await res.json();
  if (data.data && data.data.length > 0) {
    const sub = data.data[0];
    const fileId = sub.attributes.files?.[0]?.file_id;
    const fileName = sub.attributes.files?.[0]?.file_name || undefined;
    if (!fileId) {
      console.log('[OpenSubtitles] No file_id found in subtitle attributes.');
      return null;
    }
    return { fileId, fileName, release: sub.attributes.release };
  }
  console.log(`[OpenSubtitles] No subtitles found for query: ${query} (${lang})`);
  return null;
}

async function downloadSubtitle(subObj, dest, token) {
  if (!subObj || !subObj.fileId) throw new Error('No file_id for subtitle download');
  // Use the /download endpoint
  const downloadUrl = 'https://api.opensubtitles.com/api/v1/download';
  const res = await fetch(downloadUrl, {
    method: 'POST',
    headers: {
      'Api-Key': OPEN_SUBTITLES_API_KEY,
      'User-Agent': OPEN_SUBTITLES_USER_AGENT,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file_id: subObj.fileId })
  });
  const data = await res.json();
  if (!data.link) {
    console.error('[Subtitle Download] No direct link returned from /download endpoint:', data);
    throw new Error('Subtitle download failed');
  }
  // Now fetch the actual SRT file
  const srtRes = await fetch(data.link);
  if (!srtRes.ok) {
    console.error(`[Subtitle Download] Failed to download subtitle. Status: ${srtRes.status} ${srtRes.statusText}`);
    try {
      const text = await srtRes.text();
      console.error(`[Subtitle Download] Response body (snippet):`, text.slice(0, 500));
    } catch (e) {
      console.error(`[Subtitle Download] Could not read response body.`);
    }
    throw new Error('Subtitle download failed');
  }
  const buffer = await srtRes.arrayBuffer();
  await fs.writeFile(dest, Buffer.from(buffer));
}

// --------------------------- Translation via OpenAI ------------------------
async function translateSRTtoHebrew(srcPath, destPath) {
  const openai = new OpenAI();
  const text = await fs.readFile(srcPath, 'utf-8');
  // Split SRT into blocks
  const blocks = text.split(/\n\n+/);
  const chunkSize = 100; // number of subtitle blocks per chunk
  const chunks = [];
  for (let i = 0; i < blocks.length; i += chunkSize) {
    chunks.push(blocks.slice(i, i + chunkSize));
  }
  // Create or truncate the destination file at the start
  await fs.writeFile(destPath, '', 'utf-8');
  const startTime = Date.now();
  let lastPercent = 0;
  console.log((chalk && chalk.green ? chalk.green : x => x)(`Translating file: ${destPath}`));
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i].join('\n\n');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a subtitles translation assistant. Keep timestamps unchanged and translate dialogue only. Translate to Hebrew, and ensure the translation is right-to-left. Punctuation such as dots and question marks should appear at the end of the line, not the beginning, as is correct for Hebrew.' },
        { role: 'user', content: `Translate the following SRT file content to Hebrew while preserving timestamps and right-to-left punctuation:\n\n${chunkText}` }
      ]
    });
    const translated = response.choices[0].message.content.trim();
    // Append the translated chunk to the file
    await fs.appendFile(destPath, translated + '\n\n', 'utf-8');
    // Progress logging
    const percent = ((i + 1) / chunks.length * 100).toFixed(2);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const eta = ((chunks.length - (i + 1)) * (elapsed / (i + 1))).toFixed(1);
    process.stdout.write(`\rProgress: ${percent}% | Elapsed: ${elapsed}s | ETA: ${eta}s   `);
    lastPercent = percent;
  }
  process.stdout.write('\n');
}

// --------------------------- FFmpeg Mux ------------------------------------
async function muxSubtitles(videoPath, srtPath, outputPath) {
  // Get video duration first
  const getDurationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
  let totalSeconds = 0;
  try {
    const { stdout } = await execAsync(getDurationCmd);
    totalSeconds = parseFloat(stdout.trim());
  } catch (e) {
    console.warn('Could not determine video duration for progress calculation.');
  }
  const cmd = `ffmpeg -y -i "${videoPath}" -vf subtitles='${srtPath.replace(/'/g, "'\\''")}' -c:v libx264 -c:a copy "${outputPath}"`;
  console.log('Merging video and subtitles using ffmpeg…');
  return new Promise((resolve, reject) => {
    const proc = exec(cmd);
    let startTime = Date.now();
    let lastPercent = 0;
    proc.stderr?.on('data', data => {
      const line = data.toString();
      // Parse time= from ffmpeg output
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && totalSeconds > 0) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseFloat(timeMatch[3]);
        const currentSeconds = hours * 3600 + minutes * 60 + seconds;
        const percent = ((currentSeconds / totalSeconds) * 100).toFixed(2);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const eta = ((totalSeconds - currentSeconds) / (currentSeconds / (elapsed || 1))).toFixed(1);
        if (percent !== lastPercent) {
          process.stdout.write(`\rProgress: ${percent}% | Elapsed: ${elapsed}s | ETA: ${eta}s   `);
          lastPercent = percent;
        }
      }
    });
    proc.on('close', code => {
      process.stdout.write('\n');
      if (code === 0) {
        console.log('Muxing complete →', outputPath);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

// --------------------------- Main Workflow ---------------------------------
(async () => {
  try {
    const outputDir = path.resolve(out);
    if (!existsSync(outputDir)) await fs.mkdir(outputDir, { recursive: true });

    // Create episode-specific folder
    const episodeName = `${show} ${EP_CODE}`;
    const episodeFolder = path.join(outputDir, episodeName);
    if (!existsSync(episodeFolder)) await fs.mkdir(episodeFolder, { recursive: true });
    console.log((chalk && chalk.green ? chalk.green : x => x)(`Created episode folder: ${episodeFolder}`));

    // 1. Torrent search & download
    const magnet = await findMagnet();
    console.log((chalk && chalk.green ? chalk.green : x => x)(`Magnet link found`));
    const videoPath = await downloadTorrent(magnet, episodeFolder);

    // 2. Subtitles
    const token = await opensubsLogin();
    let subObj = await searchSubtitles(token, 'he');
    let subtitlePath = path.join(episodeFolder, subObj ? subObj.fileName : `${episodeName}.heb.srt`);

    if (subObj) {
      console.log((chalk && chalk.green ? chalk.green : x => x)(`Hebrew subtitles found: ${subObj.fileName} [release: ${subObj.release || ''}]`));
      await downloadSubtitle(subObj, subtitlePath, token);
    } else {
      console.log('Hebrew not found, trying English…');
      subObj = await searchSubtitles(token, 'en');
      if (!subObj) {
        console.log('No English subtitles found either.');
        throw new Error('No subtitles found');
      }
      const engPath = path.join(episodeFolder, subObj.fileName || `${episodeName}.eng.srt`);
      console.log((chalk && chalk.green ? chalk.green : x => x)(`English subtitles found: ${subObj.fileName} [release: ${subObj.release || ''}]`));
      await downloadSubtitle(subObj, engPath, token);
      console.log('Translating subtitles…');
      await translateSRTtoHebrew(engPath, subtitlePath);
    }

    // 3. Mux subtitles
    const outputVideo = path.join(episodeFolder, `${path.parse(videoPath).name}.hebsub.mp4`);
    await muxSubtitles(videoPath, subtitlePath, outputVideo);
    console.log((chalk && chalk.green ? chalk.green : x => x)(`✅ All done! Files organized in: ${episodeFolder}`));
  } catch (err) {
    console.error('⛔', err.message);
    process.exit(1);
  }
})();
