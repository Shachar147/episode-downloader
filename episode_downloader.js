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
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import cheerio from 'cheerio';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { program } from 'commander';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fsSync from 'fs';

dotenv.config();

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

let chalk;
(async () => {
  chalk = (await import('chalk')).default;
})();

// uncomment if there are login problems to verify script managed to read your credentials
// console.log('OS_API_USER:', process.env.OS_API_USER, 'OS_API_PASS:', process.env.OS_API_PASS);

const execAsync = promisify(exec);

const { OS_API_KEY } = process.env;
const OPEN_SUBTITLES_API_KEY = OS_API_KEY || 'rlF1xGalT47V4qYxdgSLR2GFTO3Cool8';
const OPEN_SUBTITLES_USER_AGENT = 'MyDownloader/1.0';

// --------------------------- WhatsApp Integration --------------------------
const whatsappClient = new Client({ 
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});
let whatsappReady = false;
let messageQueue = [];

whatsappClient.on('qr', qr => {
    console.log('Scan this QR code to connect WhatsApp:');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    whatsappReady = true;
    console.log('WhatsApp client is ready!');
    for (const { number, message } of messageQueue) {
        whatsappClient.sendMessage(`${number}@c.us`, message);
    }
    messageQueue = [];
});

whatsappClient.on('auth_failure', () => {
    console.log('WhatsApp authentication failed');
});

whatsappClient.on('disconnected', () => {
    console.log('WhatsApp client disconnected');
    whatsappReady = false;
});

whatsappClient.initialize();

async function sendWhatsAppMessage(number, message) {
    if (!whatsappReady) {
        messageQueue.push({ number, message });
        console.log('WhatsApp client not ready yet. Queuing message:', message);
        return;
    }
    try {
        console.log(`Attempting to send WhatsApp message to ${number}@c.us:`, message);
        const result = await whatsappClient.sendMessage(`${number}@c.us`, message);
        console.log('WhatsApp message sent successfully. Message ID:', result.id._serialized);
        return result;
    } catch (error) {
        console.error('Failed to send WhatsApp message:', error.message);
        console.error('Error details:', error);
        throw error;
    }
}

const MY_NUMBER = process.env.MY_WHATSAPP_NUMBER;

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
const episodeName = `${show} ${EP_CODE}`;

// --------------------------- Helpers ---------------------------------------
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

async function downloadTorrent(magnet, outputDir, downloadTorrentMessage) {
  console.log((chalk && chalk.green ? chalk.green : x => x)(`Starting torrent download…`));
  const WebTorrent = (await import('webtorrent')).default;
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
      let lastPercentNotified = 0;
      const notifyStep = 20;
      const logInterval = setInterval(async () => {
        const percent = (torrent.progress * 100).toFixed(2);
        const percentInt = Math.floor(torrent.progress * 100);
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const eta = torrent.timeRemaining ? (torrent.timeRemaining / 1000) : 0;
        // Only log if progress changed or every 5 seconds
        if (percent !== lastLogged || elapsed % 5 < 1) {
          process.stdout.write(`\rDownloaded: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta.toFixed(1)}s   `);
          lastLogged = percent;
        }
        // WhatsApp update every 20%
        if (percentInt >= lastPercentNotified + notifyStep) {
          lastPercentNotified += notifyStep;
          if (lastPercentNotified <= 100) {
            await sendWhatsAppMessage(
              MY_NUMBER,
              `${downloadTorrentMessage} ${lastPercentNotified}% (Elapsed: ${formatDuration(elapsed)}, ETA: ${formatDuration(eta)})`
            );
          }
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

// Helper to format seconds as 1d 3h 2m 30s
function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds)));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  let result = '';
  if (days) result += `${days}d `;
  if (hours) result += `${hours}h `;
  if (minutes) result += `${minutes}m `;
  result += `${seconds}s`;
  return result.trim();
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
async function muxSubtitles(videoPath, srtPath, outputPath, mergeMessage) {
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
    let lastPercentNotified = 0;
    const notifyStep = 20;
    proc.stderr?.on('data', async data => {
      const line = data.toString();
      // Parse time= from ffmpeg output
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && totalSeconds > 0) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseFloat(timeMatch[3]);
        const currentSeconds = hours * 3600 + minutes * 60 + seconds;
        const percent = ((currentSeconds / totalSeconds) * 100).toFixed(2);
        const percentInt = Math.floor((currentSeconds / totalSeconds) * 100);
        const elapsed = ((Date.now() - startTime) / 1000);
        const eta = ((totalSeconds - currentSeconds) / (currentSeconds / (elapsed || 1)));
        if (percent !== lastPercent) {
          process.stdout.write(`\rProgress: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta.toFixed(1)}s   `);
          lastPercent = percent;
        }
        // WhatsApp update every 20%
        if (percentInt >= lastPercentNotified + notifyStep) {
          lastPercentNotified += notifyStep;
          if (lastPercentNotified <= 100) {
            await sendWhatsAppMessage(
              MY_NUMBER,
              `${mergeMessage} ${lastPercentNotified}% (Elapsed: ${formatDuration(elapsed)}, ETA: ${formatDuration(eta)})`
            );
          }
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

// Compress video for WhatsApp with progress logging
async function compressForWhatsapp(inputPath, outputPath, progressMessage, episodeName) {
  // Faster compression: H.264, CRF 35, 480p, mono audio, low bitrate, fast preset
  const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 35 -vf scale=480:-2 -b:v 500k -c:a aac -b:a 32k -ac 1 "${outputPath}"`;
  console.log('Compressing video for WhatsApp (fast preset, H.264)...');
  return new Promise((resolve, reject) => {
    const proc = exec(cmd);
    let startTime = Date.now();
    let lastPercent = 0;
    let lastPercentNotified = 0;
    const notifyStep = 20;
    let totalSeconds = 0;
    // Get duration of input video
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`, (err, stdout) => {
      if (!err && stdout) {
        totalSeconds = parseFloat(stdout.trim());
      }
    });
    proc.stderr?.on('data', async data => {
      const line = data.toString();
      // Parse time= from ffmpeg output
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && totalSeconds > 0) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseFloat(timeMatch[3]);
        const currentSeconds = hours * 3600 + minutes * 60 + seconds;
        const percent = ((currentSeconds / totalSeconds) * 100).toFixed(2);
        const percentInt = Math.floor((currentSeconds / totalSeconds) * 100);
        const elapsed = ((Date.now() - startTime) / 1000);
        const eta = ((totalSeconds - currentSeconds) / (currentSeconds / (elapsed || 1)));
        if (percent !== lastPercent) {
          process.stdout.write(`\r[Compression] Progress: ${percent}% | Elapsed: ${elapsed.toFixed(1)}s | ETA: ${eta.toFixed(1)}s   `);
          lastPercent = percent;
        }
        // WhatsApp update every 20%
        if (percentInt >= lastPercentNotified + notifyStep) {
          lastPercentNotified += notifyStep;
          if (lastPercentNotified <= 100) {
            await sendWhatsAppMessage(
              MY_NUMBER,
              `[${episodeName}]\n${progressMessage} ${lastPercentNotified}% (Elapsed: ${formatDuration(elapsed)}, ETA: ${formatDuration(eta)})`
            );
          }
        }
      }
    });
    proc.on('close', code => {
      process.stdout.write('\n');
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg compression exited with code ${code}`));
      }
    });
  });
}

// --------------------------- Main Workflow ---------------------------------
(async () => {
  
  try {
    // Wait for WhatsApp client to be ready before starting
    console.log('Initializing WhatsApp client...');
    await waitForWhatsAppReady();
    
    const outputDir = path.resolve(out);
    if (!existsSync(outputDir)) await fs.mkdir(outputDir, { recursive: true });

    // Create episode-specific folder
    const episodeFolder = path.join(outputDir, episodeName);
    if (!existsSync(episodeFolder)) await fs.mkdir(episodeFolder, { recursive: true });
    console.log((chalk && chalk.green ? chalk.green : x => x)(`Created episode folder: ${episodeFolder}`));

    // Check for existing video files (torrent download)
    const videoFiles = await fs.readdir(episodeFolder).catch(() => []);
    const existingVideo = videoFiles.find(file => 
      /\.(mp4|mkv|avi|mov|wmv|flv)$/i.test(file) && 
      !file.includes('.hebsub.') && 
      !file.includes('.whatsapp.')
    );
    
    let videoPath;
    if (existingVideo) {
      console.log((chalk && chalk.green ? chalk.green : x => x)(`Skipping torrent download - video file already exists: ${existingVideo}`));
      videoPath = path.join(episodeFolder, existingVideo);
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nSkipping torrent download - video file already exists: ${existingVideo}`);
    } else {
      // 1. Torrent search & download
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nSearching torrent...`);
      const magnet = await findMagnet();
      console.log((chalk && chalk.green ? chalk.green : x => x)(`Magnet link found`));
      const downloadTorrentMessage = 'Starting torrent download...';
      const foundMessageMessage = `[${episodeName}]\n*Magnet link found!*\n${downloadTorrentMessage}`;
      await sendWhatsAppMessage(MY_NUMBER, foundMessageMessage);
      videoPath = await downloadTorrent(magnet, episodeFolder, downloadTorrentMessage);
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nTorrent download complete!`);
    }

    // Check for existing subtitle files
    const subtitleFiles = await fs.readdir(episodeFolder).catch(() => []);
    const existingSubtitle = subtitleFiles.find(file => 
      /\.(srt)$/i.test(file) && 
      (file.includes('.heb.') || file.includes('.hebsub.'))
    );
    
    let subtitlePath;
    if (existingSubtitle) {
      console.log((chalk && chalk.green ? chalk.green : x => x)(`Skipping subtitle download - subtitle file already exists: ${existingSubtitle}`));
      subtitlePath = path.join(episodeFolder, existingSubtitle);
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nSkipping subtitle download - subtitle file already exists: ${existingSubtitle}`);
    } else {
      // 2. Subtitles
      const token = await opensubsLogin();
      let subObj = await searchSubtitles(token, 'he');
      subtitlePath = path.join(episodeFolder, subObj ? subObj.fileName : `${episodeName}.heb.srt`);

      if (subObj) {
        console.log((chalk && chalk.green ? chalk.green : x => x)(`Hebrew subtitles found: ${subObj.fileName} [release: ${subObj.release || ''}]`));
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nHebrew subtitles found!`);
        await downloadSubtitle(subObj, subtitlePath, token);
      } else {
        console.log('Hebrew not found, trying English…');
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nHebrew subtitles not found :() searching for English subtitles...`);
        subObj = await searchSubtitles(token, 'en');
        if (!subObj) {
          console.log('No English subtitles found either.');
          await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nNo subtitles found :(`);
          throw new Error('No subtitles found');
        }
        const engPath = path.join(episodeFolder, subObj.fileName || `${episodeName}.eng.srt`);
        console.log((chalk && chalk.green ? chalk.green : x => x)(`English subtitles found: ${subObj.fileName} [release: ${subObj.release || ''}]`));
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nEnglish subtitles found!`);
        await downloadSubtitle(subObj, engPath, token);
        console.log('Translating subtitles…');
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nTranslating subtitles from english to Hebrew...`);
        await translateSRTtoHebrew(engPath, subtitlePath);
      }
    }

    // Check for existing muxed video
    const outputVideo = path.join(episodeFolder, `${path.parse(videoPath).name}.hebsub.mp4`);
    if (existsSync(outputVideo)) {
      console.log((chalk && chalk.green ? chalk.green : x => x)(`Skipping subtitle muxing - muxed video already exists: ${path.basename(outputVideo)}`));
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nSkipping subtitle muxing - muxed video already exists: ${path.basename(outputVideo)}`);
    } else {
      // 3. Mux subtitles
      const mergeMessage = `[${episodeName}]\nMerging video and subtitles...`;
      await sendWhatsAppMessage(MY_NUMBER, mergeMessage);
      await muxSubtitles(videoPath, subtitlePath, outputVideo, mergeMessage);
    }
    
    await sendWhatsAppMessage(MY_NUMBER, `✅ All done! Files organized in: ${episodeFolder}`);
    console.log((chalk && chalk.green ? chalk.green : x => x)(`✅ All done! Files organized in: ${episodeFolder}`));

    // Check for existing compressed video
    const compressedPath = path.join(episodeFolder, `${path.parse(videoPath).name}.whatsapp.mp4`);
    if (existsSync(compressedPath)) {
      console.log((chalk && chalk.green ? chalk.green : x => x)(`Skipping compression - compressed video already exists: ${path.basename(compressedPath)}`));
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nSkipping compression - compressed video already exists: ${path.basename(compressedPath)}`);
    } else {
      // 4. Compress for WhatsApp
      try {
        const compressMessage = 'Compressing video for WhatsApp...';
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\n${compressMessage}`);
        await compressForWhatsapp(outputVideo, compressedPath, compressMessage, episodeName);
      } catch (err) {
        console.error('Compression error:', err);
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nCompression failed: ${err.message || err}`);
        throw err;
      }
    }

    // Send via WhatsApp (always try to send if compressed file exists)
    try {
      const stats = fsSync.statSync(compressedPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      
      if (stats.size > 95 * 1024 * 1024) { // WhatsApp limit is ~100MB, use 95MB for safety
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nCompressed file is too big to send on WhatsApp (size: ${fileSizeMB} MB).`);
      } else {
        // Add retry logic for WhatsApp media sending
        let retryCount = 0;
        const maxRetries = 3;
        let success = false;
        
        while (retryCount < maxRetries && !success) {
          try {
            if (retryCount > 0) {
              console.log(`Retry attempt ${retryCount} for WhatsApp media sending...`);
              await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nRetry attempt ${retryCount} for sending video...`);
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
            
            await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nSending compressed video via WhatsApp (size: ${fileSizeMB} MB)...`);
            
            // Check if file still exists and is readable
            if (!fsSync.existsSync(compressedPath)) {
              throw new Error('Compressed file no longer exists');
            }
            
            // Check WhatsApp session status before attempting to send
            const sessionValid = await checkWhatsAppSession();
            if (!sessionValid && retryCount === 1) {
              console.log('Session appears invalid, attempting to refresh...');
              await refreshWhatsAppSession();
              // Wait for session to be ready again
              await new Promise(resolve => setTimeout(resolve, 10000));
            }
            
            console.log('Creating MessageMedia object...');
            const media = await MessageMedia.fromFilePath(compressedPath);
            console.log('MessageMedia created successfully, mimeType:', media.mimetype, 'data length:', media.data.length);
            
            // Try different approaches for sending
            let result;
            if (retryCount === 0) {
              // First attempt: standard method
              console.log('Attempting standard media send...');
              result = await whatsappClient.sendMessage(`${MY_NUMBER}@c.us`, media, { caption: `[${episodeName}] Compressed video` });
            } else if (retryCount === 1) {
              // Second attempt: without caption
              console.log('Attempting media send without caption...');
              result = await whatsappClient.sendMessage(`${MY_NUMBER}@c.us`, media);
            } else {
              // Third attempt: send as document
              console.log('Attempting to send as document...');
              result = await whatsappClient.sendMessage(`${MY_NUMBER}@c.us`, media, { 
                sendMediaAsDocument: true,
                caption: `[${episodeName}] Compressed video`
              });
            }
            
            console.log('WhatsApp media sent successfully:', result.id._serialized);
            success = true;
            
          } catch (sendError) {
            retryCount++;
            console.error(`WhatsApp send attempt ${retryCount} failed:`);
            console.error('Error name:', sendError.name);
            console.error('Error message:', sendError.message);
            console.error('Error stack:', sendError.stack);
            
            // Try to get more details about the error
            if (sendError.message && sendError.message.includes('Evaluation failed')) {
              console.error('This appears to be a browser evaluation error - possible causes:');
              console.error('- WhatsApp Web session expired');
              console.error('- File too large or corrupted');
              console.error('- Network connectivity issues');
              console.error('- Browser automation timeout');
            }
            
            if (retryCount >= maxRetries) {
              throw new Error(`Failed to send media after ${maxRetries} attempts. Last error: ${sendError.name}: ${sendError.message}`);
            }
            
            // Wait longer between retries
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
        }
      }
    } catch (err) {
      console.error('WhatsApp send error:', err);
      await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nWhatsApp sending failed: ${err.message || err}`);
      
      // Try to send a fallback message with file info
      try {
        const stats = fsSync.statSync(compressedPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\nVideo file ready but couldn't send via WhatsApp.\nFile: ${path.basename(compressedPath)}\nSize: ${fileSizeMB} MB\nLocation: ${compressedPath}`);
      } catch (fallbackErr) {
        console.error('Fallback message also failed:', fallbackErr);
      }
    }
  } catch (err) {
    console.error('⛔', err.message);
    await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\n⛔ Error: ${err.message}`);
    
    // Add delay to ensure WhatsApp messages are delivered before exiting
    console.log('Waiting 10 seconds for WhatsApp messages to be delivered...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    process.exit(1);
  } finally {
    // Gracefully close WhatsApp client
    if (whatsappClient) {
      console.log('Closing WhatsApp client...');
      await whatsappClient.destroy();
    }
    
    // Add delay to ensure WhatsApp messages are delivered
    console.log('Waiting 10 seconds for WhatsApp messages to be delivered...');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
})();

// Graceful shutdown handler
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  if (whatsappClient) {
    await whatsappClient.destroy();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  if (whatsappClient) {
    await whatsappClient.destroy();
  }
  process.exit(0);
});

// Wait for WhatsApp client to be ready
async function waitForWhatsAppReady(timeout = 30000) {
    const startTime = Date.now();
    while (!whatsappReady && (Date.now() - startTime) < timeout) {
        console.log('Waiting for WhatsApp client to be ready...');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!whatsappReady) {
        console.log('WhatsApp client not ready after timeout, continuing anyway...');
    }
    return whatsappReady;
}

// Check WhatsApp Web session status
async function checkWhatsAppSession() {
    try {
        console.log('Checking WhatsApp Web session status...');
        // Try to get basic info to test if session is valid
        const info = await whatsappClient.getState();
        console.log('WhatsApp session state:', info);
        return info === 'CONNECTED';
    } catch (error) {
        console.error('Error checking WhatsApp session:', error);
        return false;
    }
}

// Refresh WhatsApp Web session if needed
async function refreshWhatsAppSession() {
    try {
        console.log('Attempting to refresh WhatsApp Web session...');
        await whatsappClient.logout();
        await new Promise(resolve => setTimeout(resolve, 2000));
        await whatsappClient.initialize();
        console.log('WhatsApp session refresh initiated');
        return true;
    } catch (error) {
        console.error('Failed to refresh WhatsApp session:', error);
        return false;
    }
}
