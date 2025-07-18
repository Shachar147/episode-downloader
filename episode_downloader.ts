#!/usr/bin/env ts-node
import dotenv from 'dotenv';
dotenv.config();
// Main workflow for episode downloader (TypeScript version)
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { program } from 'commander';
import { muxSubtitles } from './utils/merge-utils';
import { compressForWhatsapp } from './utils/compress-utils';
import { waitForWhatsAppReady, whatsappClient, sendMessage as sendMessageFunc } from './utils/whatsapp-utils';
import { sendMessage as sendTelegramMessage } from './utils/telegram-utils';
import { downloadTorrent, findMagnets } from './utils/torrent-utils';
import { downloadSubtitle, opensubsLogin, searchSubtitlesAll, translateSRTtoHebrew } from './utils/subtitles-utils';
import { formatFileName, getFileInfo } from './utils/file-utils';
import { MESSAGE_TUNNEL, MessageTunnel } from './utils/messaging-utils';
import TelegramBot from 'node-telegram-bot-api';

const MY_NUMBER = process.env.MY_WHATSAPP_NUMBER;

class EpisodeDownloader {
  show: string;
  season: number;
  episode: number;
  out: string = '~/Videos/';
  minSeeds: number = 20;
  epCode: string;
  episodeName: string;

  constructor(show: string, season: number, episode: number, out?: string, minSeeds?: number) {
    this.show = show;
    this.season = season;
    this.episode = episode;
    if (out){
      this.out = out;
    }
    if (minSeeds) {
      this.minSeeds = minSeeds;
    }
    this.epCode = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
    this.episodeName = `${show} ${this.epCode}`;
  }

  async sendMessage (message:string) {
    if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
      await sendMessageFunc(MY_NUMBER, this.episodeName, message)
    } else {
      await sendTelegramMessage(this.episodeName, message);
    }
  };
  
  async setupDirectories(): Promise<string> {
    const outputDir = path.resolve(this.out);
    if (!existsSync(outputDir)) await fs.mkdir(outputDir, { recursive: true });
    const episodeFolder = path.join(outputDir, this.episodeName);
    if (!existsSync(episodeFolder)) await fs.mkdir(episodeFolder, { recursive: true });
    return episodeFolder;
  }
  
  async handleMuxing(videoPath: string, subtitlePath: string, episodeFolder: string): Promise<string> {
    const outputVideo = path.join(episodeFolder, `${path.parse(videoPath || '').name}.hebsub.mp4`);
    if (existsSync(outputVideo)) {
      await this.sendMessage(`Skipping video & subtitles merge -\nMerged video already exists:\n\n${path.basename(outputVideo)}`);
    } else {
      const mergeMessage = `Merging video and subtitles...`;
      await this.sendMessage(mergeMessage);
      await muxSubtitles(videoPath || '', subtitlePath || '', outputVideo, mergeMessage, MY_NUMBER || '', this.episodeName);
      const fileInfo = getFileInfo(outputVideo);
      await this.sendMessage(`Merge completed:\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
    }
    return outputVideo;
  }
  
  async handleCompression(videoPath: string, outputVideo: string, episodeFolder: string): Promise<string> {
    const compressedPath = path.join(episodeFolder, `${path.parse(videoPath || '').name}.whatsapp.mp4`);
    if (existsSync(compressedPath)) {
      await this.sendMessage(`Skipping compression - \nCompressed video already exists:\n\n${path.basename(compressedPath)}`);
    } else {
      try {
        const compressMessage = 'Compressing video for WhatsApp...';
        await this.sendMessage(`${compressMessage}`);
        await compressForWhatsapp(outputVideo, compressedPath, compressMessage, this.episodeName, MY_NUMBER || '');
        const fileInfo = getFileInfo(compressedPath);
        await this.sendMessage(`Compression completed:\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
      } catch (err: any) {
        await this.sendMessage(`Compression failed: ${err.message || err}`);
        throw err;
      }
    }
    return compressedPath;
  }

  // Add a function to compute name similarity
  private nameSimilarity(a: string, b: string): number {
    // Simple similarity: count of shared words (case-insensitive, ignoring punctuation)
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
    const aWords = new Set(clean(a));
    const bWords = new Set(clean(b));
    let shared = 0;
    for (const word of aWords) {
      if (bWords.has(word)) shared++;
    }
    return shared / Math.max(aWords.size, bWords.size, 1);
  }

  async handleVideoAndSubtitleMatching(episodeFolder: string): Promise<{video: any, subtitle: any, lang: string}> {
    await this.sendMessage('Searching for torrent candidates...');
    const torrents = await findMagnets(this.show, this.epCode, this.minSeeds);
    await this.sendMessage(`Found ${torrents.length} torrent candidates.`);
    const token = await opensubsLogin();
    await this.sendMessage('Searching for Hebrew subtitle candidates...');
    let subtitles = await searchSubtitlesAll(token, 'he', this.show, this.season, this.episode);
    let lang = 'he';
    if (subtitles.length === 0) {
      await this.sendMessage('No Hebrew subtitles found. Searching for English subtitles...');
      subtitles = await searchSubtitlesAll(token, 'en', this.show, this.season, this.episode);
      lang = 'en';
      if (subtitles.length === 0) {
        await this.sendMessage('No subtitles found :(');
        throw new Error('No subtitles found');
      }
    }
    await this.sendMessage(`Found ${subtitles.length} subtitle candidates (${lang === 'he' ? 'Hebrew' : 'English'}).`);
    // Find best match by name similarity
    let bestScore = -1;
    let bestPair: { video: any; subtitle: any } = { video: torrents[0], subtitle: subtitles[0] };
    for (const torrent of torrents) {
      for (const subtitle of subtitles) {
        if (!torrent.name || !subtitle.fileName) continue;
        const score = this.nameSimilarity(torrent.name, subtitle.fileName);
        if (score > bestScore) {
          bestScore = score;
          bestPair = { video: torrent, subtitle };
        }
      }
    }
    await this.sendMessage(`Matched video and subtitle:\nVideo: ${bestPair.video.name}\nSubtitle: ${bestPair.subtitle.fileName || bestPair.subtitle.release || 'unknown'}\nSimilarity score: ${bestScore.toFixed(2)}`);
    return { video: bestPair.video, subtitle: bestPair.subtitle, lang };
  }

  async run(): Promise<void> {
    try {
      if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
        await waitForWhatsAppReady();
      }
      // Step 1: Setup directories
      const episodeFolder = await this.setupDirectories();
      // Step 2: Find best-matching video and subtitle
      const { video, subtitle, lang } = await this.handleVideoAndSubtitleMatching(episodeFolder);
      // Step 3: Download video (or use existing)
      let videoPath: string | undefined;
      // Check for existing video file in episodeFolder
      const filesInFolder = await fs.readdir(episodeFolder);
      let largest = null;
      let largestSize = 0;
      for (const file of filesInFolder) {
        const ext = path.extname(file).toLowerCase();
        if ([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv"].includes(ext)) {
          const filePath = path.join(episodeFolder, file);
          const fileStat = await fs.stat(filePath);
          if (fileStat.size > largestSize) {
            largest = filePath;
            largestSize = fileStat.size;
          }
        }
      }
      if (largest) {
        videoPath = largest;
        await this.sendMessage(`Video file already exists, skipping torrent download.\n📁 File: ${path.basename(videoPath)}\n📊 Size: ${largestSize}`);
      } else {
        // Download video
        const magnet = `magnet:?xt=urn:btih:${video.info_hash}&dn=${encodeURIComponent(video.name)}&tr=udp://tracker.openbittorrent.com:80/announce`;
        const videoPathRaw = await downloadTorrent(magnet, episodeFolder, '*Starting torrent download...*', this.episodeName);
        videoPath = videoPathRaw;
        const stat = await fs.stat(videoPathRaw);
        if (stat.isDirectory()) {
          const files = await fs.readdir(videoPathRaw);
          let largest = null;
          let largestSize = 0;
          for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if ([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv"].includes(ext)) {
              const filePath = path.join(videoPathRaw, file);
              const fileStat = await fs.stat(filePath);
              if (fileStat.size > largestSize) {
                largest = filePath;
                largestSize = fileStat.size;
              }
            }
          }
          if (!largest) {
            throw new Error('No video file found in the downloaded folder.');
          }
          videoPath = largest;
        }
        const fileInfo = getFileInfo(videoPath);
        await this.sendMessage(`Torrent download complete!\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
      }
      // Step 4: Download subtitle (or use existing)
      const token = await opensubsLogin();
      const subtitlePath = path.join(episodeFolder, subtitle.fileName || `${this.episodeName}.${lang}.srt`);
      try {
        await fs.access(subtitlePath);
        await this.sendMessage(`Subtitle file already exists, skipping subtitle download.\n📄 File: ${path.basename(subtitlePath)}`);
      } catch {
        // File does not exist, download it
        await downloadSubtitle(subtitle, subtitlePath, token);
      }
      // Step 5: Muxing
      if (lang === 'en') {
        // Look for any Hebrew subtitle file in the folder
        const files = await fs.readdir(episodeFolder);
        let hebSubFile: string | undefined = undefined;
        for (const file of files) {
          const lower = file.toLowerCase();
          if ((lower.includes('.heb.') || lower.includes('hebrew')) && (lower.endsWith('.srt') || lower.endsWith('.sub'))) {
            hebSubFile = path.join(episodeFolder, file);
            break;
          }
        }
        if (hebSubFile) {
          await this.sendMessage(`Hebrew subtitle already exists (${path.basename(hebSubFile)}), skipping translation.`);
          // Use the found Hebrew subtitle file for muxing
          await this.handleMuxing(videoPath, hebSubFile, episodeFolder);
        } else {
          const hebPath = path.join(episodeFolder, `${this.episodeName}.heb.srt`);
          await this.sendMessage('Translating subtitles from English to Hebrew...');
          await translateSRTtoHebrew(subtitlePath, hebPath);
          // Use the translated file for muxing
          await this.handleMuxing(videoPath, hebPath, episodeFolder);
        }
      } else {
        await this.handleMuxing(videoPath, subtitlePath, episodeFolder);
      }
      // Step 5: Send completion message
      const finalFileInfo = getFileInfo(videoPath);
      await this.sendMessage(`✅ All done!\n\n📁 Final file: ${formatFileName(finalFileInfo.name)}\n📊 Size: ${finalFileInfo.size}\n📂 Location: ${episodeFolder}`);
    } catch (err: any) {
      await this.sendMessage(`⛔ Error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    } finally {
      if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
        console.log('Waiting 10 seconds for WhatsApp messages to be delivered...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
}

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

// Start the application
if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
  program
    .requiredOption('--show <title>', 'Show title, e.g., "Rick and Morty"')
    .requiredOption('--season <number>', 'Season number', parseInt)
    .requiredOption('--episode <number>', 'Episode number', parseInt)
    .option('--out <dir>', 'Output directory', '.')
    .option('--min-seeds <n>', 'Minimum seeders', parseInt, 20)
    .parse();
} else {
  program
    .option('--show <title>', 'Show title, e.g., "Rick and Morty"')
    .option('--season <number>', 'Season number', parseInt)
    .option('--episode <number>', 'Episode number', parseInt)
    .option('--out <dir>', 'Output directory', '.')
    .option('--min-seeds <n>', 'Minimum seeders', parseInt, 20)
    .parse();
}

const options = program.opts();
const { show, season, episode, out, minSeeds } = options;

if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
  void new EpisodeDownloader(show, season, episode, out, minSeeds).run();
} else if (MESSAGE_TUNNEL === MessageTunnel.TELEGRAM) {
  if (show && season && episode) {
    void new EpisodeDownloader(show, season, episode, out, minSeeds).run();
  }
}

function listenForTelegramEpisodeRequests() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
  const bot = new TelegramBot(token, { polling: true });
  const pattern = /^(.+?)\s+[sS](\d{2})[eE](\d{2})$/i;

  bot.on('message', async (msg) => {
    if (!msg.text) return;
    const match = msg.text.trim().match(pattern);
    if (!match) return; // ignore messages that aren't on the right format
    const show = match[1].trim();
    const season = parseInt(match[2], 10);
    const episode = parseInt(match[3], 10);
    await bot.sendMessage(msg.chat.id, `Looking for downloads for "${show}", Season ${season}, Episode ${episode}...`);
    const downloader = new EpisodeDownloader(show, season, episode, '/Users/shacharratzabi/Videos/');
    await downloader.run();
  });
}

if (MESSAGE_TUNNEL === MessageTunnel.TELEGRAM && process.argv.length <= 2) {
  console.log('Listening for Telegram episode requests...');
  listenForTelegramEpisodeRequests();
}