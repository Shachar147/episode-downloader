#!/usr/bin/env ts-node
import dotenv from 'dotenv';
dotenv.config();
// Main workflow for episode downloader (TypeScript version)
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import fsSync from 'fs';
import { program } from 'commander';
import { muxSubtitles } from './utils/merge-utils';
import { compressForWhatsapp } from './utils/compress-utils';
import { waitForWhatsAppReady, whatsappClient, sendVideoViaWhatsApp, sendMessage as sendMessageFunc } from './utils/whatsapp-utils';
import { downloadTorrent, findMagnet } from './utils/torrent-utils';
import { downloadSubtitle, opensubsLogin, searchSubtitles, translateSRTtoHebrew } from './utils/subtitles-utils';
import { formatFileName, getFileInfo } from './utils/file-utils';
import { MessageMedia } from 'whatsapp-web.js';

const MY_NUMBER = process.env.MY_WHATSAPP_NUMBER;

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

const sendMessage = async (message:string) => MY_NUMBER && await sendMessageFunc(MY_NUMBER, episodeName, message);

async function setupDirectories(): Promise<string> {
  const outputDir = path.resolve(out);
  if (!existsSync(outputDir)) await fs.mkdir(outputDir, { recursive: true });
  const episodeFolder = path.join(outputDir, episodeName);
  if (!existsSync(episodeFolder)) await fs.mkdir(episodeFolder, { recursive: true });
  return episodeFolder;
}

async function handleVideoDownload(episodeFolder: string): Promise<string> {
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
    await sendMessage(`Skipping torrent download -\nVideo file already exists:\n\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
  } else {
    await sendMessage(`Searching torrent...`);
    const magnet = await findMagnet(show, EP_CODE, minSeeds);
    await sendMessage(`*Magnet link found!*\nStarting torrent download...`);
    videoPath = await downloadTorrent(magnet, episodeFolder, 'Starting torrent download...', MY_NUMBER || '', episodeName);
    const fileInfo = getFileInfo(videoPath);
    await sendMessage(`Torrent download complete!\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
  }
  return videoPath;
}

async function handleSubtitles(episodeFolder: string): Promise<string> {
  const subtitleFiles = await fs.readdir(episodeFolder).catch(() => []);
  const existingSubtitle = subtitleFiles.find(file =>
    /\.(srt)$/i.test(file) &&
    (file.toLocaleLowerCase().includes('heb'))
  );
  
  let subtitlePath: string;
  if (existingSubtitle) {
    subtitlePath = path.join(episodeFolder, existingSubtitle || '');
    await sendMessage(`Skipping subtitle download - \nSubtitle file already exists: \n\n${existingSubtitle || ''}`);
  } else {
    const token = await opensubsLogin();
    let subObj = await searchSubtitles(token, 'he', show, season, episode);
    subtitlePath = path.join(episodeFolder, subObj && subObj.fileName ? subObj.fileName : `${episodeName}.heb.srt`);
    if (subObj) {
      await sendMessage(`Hebrew subtitles found!`);
      await downloadSubtitle(subObj, subtitlePath, token);
    } else {
      await sendMessage(`Hebrew subtitles not found :(\nSearching for English subtitles...`);
      subObj = await searchSubtitles(token, 'en', show, season, episode);
      if (!subObj) {
        await sendMessage(`No subtitles found :(`);
        throw new Error('No subtitles found');
      }
      const engPath = path.join(episodeFolder, subObj.fileName || `${episodeName}.eng.srt`);
      await sendMessage(`English subtitles found!`);
      await downloadSubtitle(subObj, engPath, token);
      await sendMessage(`Translating subtitles from english to Hebrew...`);
      await translateSRTtoHebrew(engPath, subtitlePath);
    }
  }
  return subtitlePath;
}

async function handleMuxing(videoPath: string, subtitlePath: string, episodeFolder: string): Promise<string> {
  const outputVideo = path.join(episodeFolder, `${path.parse(videoPath || '').name}.hebsub.mp4`);
  if (existsSync(outputVideo)) {
    await sendMessage(`Skipping video & subtitles merge -\nMerged video already exists:\n\n${path.basename(outputVideo)}`);
  } else {
    const mergeMessage = `Merging video and subtitles...`;
    await sendMessage(mergeMessage);
    await muxSubtitles(videoPath || '', subtitlePath || '', outputVideo, mergeMessage, MY_NUMBER || '', episodeName);
    const fileInfo = getFileInfo(outputVideo);
    await sendMessage(`Merge completed:\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
  }
  return outputVideo;
}

async function handleCompression(videoPath: string, outputVideo: string, episodeFolder: string): Promise<string> {
  const compressedPath = path.join(episodeFolder, `${path.parse(videoPath || '').name}.whatsapp.mp4`);
  if (existsSync(compressedPath)) {
    await sendMessage(`Skipping compression - \nCompressed video already exists:\n\n${path.basename(compressedPath)}`);
  } else {
    try {
      const compressMessage = 'Compressing video for WhatsApp...';
      await sendMessage(`${compressMessage}`);
      await compressForWhatsapp(outputVideo, compressedPath, compressMessage, episodeName, MY_NUMBER || '');
      const fileInfo = getFileInfo(compressedPath);
      await sendMessage(`Compression completed:\n📁 File: ${formatFileName(fileInfo.name)}\n📊 Size: ${fileInfo.size}`);
    } catch (err: any) {
      await sendMessage(`Compression failed: ${err.message || err}`);
      throw err;
    }
  }
  return compressedPath;
}

async function main(): Promise<void> {
  try {
    await waitForWhatsAppReady();
    
    // Step 1: Setup directories
    const episodeFolder = await setupDirectories();
    
    // Step 2: Handle video download
    const videoPath = await handleVideoDownload(episodeFolder);
    
    // Step 3: Handle subtitles
    const subtitlePath = await handleSubtitles(episodeFolder);
    
    // Step 4: Handle muxing
    const outputVideo = await handleMuxing(videoPath, subtitlePath, episodeFolder);
    
    // Step 5: Handle compression
    const compressedPath = await handleCompression(videoPath, outputVideo, episodeFolder);
    
    // Step 6: Send completion message with final file info
    const finalFileInfo = getFileInfo(compressedPath);
    await sendMessage(`✅ All done!\n\n📁 Final file: ${formatFileName(finalFileInfo.name)}\n📊 Size: ${finalFileInfo.size}\n📂 Location: ${episodeFolder}`);
    
    // Step 7: Send video via WhatsApp
    await sendVideoViaWhatsApp(compressedPath, episodeName, MY_NUMBER || '');
    
  } catch (err: any) {
    await sendMessage(`⛔ Error: ${err.message}`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    process.exit(1);
  } finally {
    // // Gracefully close WhatsApp client
    // if (whatsappClient) {
    //   console.log('Closing WhatsApp client...');
    //   await whatsappClient.destroy();
    // }
    
    // Add delay to ensure WhatsApp messages are delivered
    console.log('Waiting 10 seconds for WhatsApp messages to be delivered...');
    await new Promise(resolve => setTimeout(resolve, 10000));
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
void main(); 