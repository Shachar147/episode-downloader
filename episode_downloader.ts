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
import { downloadTorrent, findMagnet } from './utils/torrent-utils';
import { downloadSubtitle, opensubsLogin, searchSubtitles, translateSRTtoHebrew } from './utils/subtitles-utils';
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
  
  async handleVideoDownload(episodeFolder: string): Promise<string> {
    const videoFiles = await fs.readdir(episodeFolder).catch(() => []);
    const existingVideo = videoFiles.find(file =>
      /\.(mp4|mkv|avi|mov|wmv|flv)$/i.test(file) &&
      !file.includes('.hebsub.') &&
      !file.includes('.whatsapp.')
    );
    
    let videoPath: string;
    if (existingVideo) {
      videoPath = path.join(episodeFolder, existingVideo || '');
      const fileInfo = getFileInfo(videoPath);
      await this.sendMessage(`Skipping torrent download -\nVideo file already exists:\n\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
    } else {
      await this.sendMessage(`Searching torrent...`);
      const magnet = await findMagnet(this.show, this.epCode, this.minSeeds);
      await this.sendMessage(`*Magnet link found!*`);
      videoPath = await downloadTorrent(magnet, episodeFolder, '*Starting torrent download...*', this.episodeName);
      const fileInfo = getFileInfo(videoPath);
      await this.sendMessage(`Torrent download complete!\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
    }
    return videoPath;
  }
  
  async handleSubtitles(episodeFolder: string): Promise<string> {
    const subtitleFiles = await fs.readdir(episodeFolder).catch(() => []);
    const existingSubtitle = subtitleFiles.find(file =>
      /\.(srt)$/i.test(file) &&
      (file.toLocaleLowerCase().includes('heb'))
    );
    
    let subtitlePath: string;
    if (existingSubtitle) {
      subtitlePath = path.join(episodeFolder, existingSubtitle || '');
      await this.sendMessage(`Skipping subtitle download - \nSubtitle file already exists: \n\n${existingSubtitle || ''}`);
    } else {
      const token = await opensubsLogin();
      let subObj = await searchSubtitles(token, 'he', this.show, this.season, this.episode);
      subtitlePath = path.join(episodeFolder, subObj && subObj.fileName ? subObj.fileName : `${this.episodeName}.heb.srt`);
      if (subObj) {
        await this.sendMessage(`Hebrew subtitles found!`);
        await downloadSubtitle(subObj, subtitlePath, token);
      } else {
        await this.sendMessage(`Hebrew subtitles not found :(\nSearching for English subtitles...`);
        subObj = await searchSubtitles(token, 'en', this.show, this.season, this.episode);
        if (!subObj) {
          await this.sendMessage(`No subtitles found :(`);
          throw new Error('No subtitles found');
        }
        const engPath = path.join(episodeFolder, subObj.fileName || `${this.episodeName}.eng.srt`);
        await this.sendMessage(`English subtitles found!`);
        await downloadSubtitle(subObj, engPath, token);
        await this.sendMessage(`Translating subtitles from english to Hebrew...`);
        await translateSRTtoHebrew(engPath, subtitlePath);
      }
    }
    return subtitlePath;
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

  async run(): Promise<void> {
    try {
      if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
        await waitForWhatsAppReady();
      }
      
      // Step 1: Setup directories
      const episodeFolder = await this.setupDirectories();
      
      // Step 2: Handle video download
      const videoPath = await this.handleVideoDownload(episodeFolder);
      
      // Step 3: Handle subtitles
      const subtitlePath = await this.handleSubtitles(episodeFolder);
      
      // Step 4: Handle muxing
      const outputVideo = await this.handleMuxing(videoPath, subtitlePath, episodeFolder);
      
      // Step 5: Handle compression
      // const compressedPath = await this.handleCompression(videoPath, outputVideo, episodeFolder);
      
      // Step 6: Send completion message with final file info
      const finalFileInfo = getFileInfo(outputVideo);
      await this.sendMessage(`✅ All done!\n\n📁 Final file: ${formatFileName(finalFileInfo.name)}\n📊 Size: ${finalFileInfo.size}\n📂 Location: ${episodeFolder}`);
      
      // Step 7: Send video via WhatsApp
      // await sendVideoViaWhatsApp(compressedPath, this.episodeName, MY_NUMBER || '');
      
    } catch (err: any) {
      await this.sendMessage(`⛔ Error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      // process.exit(1);
    } finally {
      // // Gracefully close WhatsApp client
      // if (whatsappClient) {
      //   console.log('Closing WhatsApp client...');
      //   await whatsappClient.destroy();
      // }
      
      // Add delay to ensure WhatsApp messages are delivered
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