#!/usr/bin/env ts-node
import dotenv from 'dotenv';
dotenv.config();
// Main workflow for episode downloader (TypeScript version)
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { program } from 'commander';
import { compressForWhatsapp, muxSubtitles } from './utils/merge-utils';
import { sendWhatsAppMessage, waitForWhatsAppReady } from './utils/whatsapp-utils';
import { downloadTorrent, findMagnet } from './utils/torrent-utils';
import { downloadSubtitle, opensubsLogin, searchSubtitles, translateSRTtoHebrew } from './utils/subtitles-utils';

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

const sendMessage = async (message:string) => MY_NUMBER && await sendWhatsAppMessage(MY_NUMBER, `[${episodeName}]\n${message}`);

(async () => {
  try {
    await waitForWhatsAppReady();
    const outputDir = path.resolve(out);
    if (!existsSync(outputDir)) await fs.mkdir(outputDir, { recursive: true });
    const episodeFolder = path.join(outputDir, episodeName);
    if (!existsSync(episodeFolder)) await fs.mkdir(episodeFolder, { recursive: true });
    const videoFiles = await fs.readdir(episodeFolder).catch(() => []);
    const existingVideo = videoFiles.find(file =>
      /\.(mp4|mkv|avi|mov|wmv|flv)$/i.test(file) &&
      !file.includes('.hebsub.') &&
      !file.includes('.whatsapp.')
    );
    let videoPath: string;
    if (existingVideo) {
      videoPath = path.join(episodeFolder, existingVideo || '');
      await sendMessage(`Skipping torrent download - video file already exists: ${existingVideo || ''}`);
    } else {
      await sendMessage(`Searching torrent...`);
      const magnet = await findMagnet(show, EP_CODE, minSeeds);
      await sendMessage(`*Magnet link found!*\nStarting torrent download...`);
      videoPath = await downloadTorrent(magnet, episodeFolder, 'Starting torrent download...', MY_NUMBER || '', episodeName);
      await sendMessage(`Torrent download complete!`);
    }
    const subtitleFiles = await fs.readdir(episodeFolder).catch(() => []);
    const existingSubtitle = subtitleFiles.find(file =>
      /\.(srt)$/i.test(file) &&
      (file.includes('.heb.') || file.includes('.hebsub.'))
    );
    let subtitlePath: string;
    if (existingSubtitle) {
      subtitlePath = path.join(episodeFolder, existingSubtitle || '');
      await sendMessage(`Skipping subtitle download - subtitle file already exists: ${existingSubtitle || ''}`);
    } else {
      const token = await opensubsLogin();
      let subObj = await searchSubtitles(token, 'he', show, season, episode);
      subtitlePath = path.join(episodeFolder, subObj && subObj.fileName ? subObj.fileName : `${episodeName}.heb.srt`);
      if (subObj) {
        await sendMessage(`Hebrew subtitles found!`);
        await downloadSubtitle(subObj, subtitlePath, token);
      } else {
        await sendMessage(`Hebrew subtitles not found :() searching for English subtitles...`);
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
    const outputVideo = path.join(episodeFolder, `${path.parse(videoPath || '').name}.hebsub.mp4`);
    if (existsSync(outputVideo)) {
      await sendMessage(`Skipping subtitle muxing - muxed video already exists: ${path.basename(outputVideo)}`);
    } else {
      const mergeMessage = `Merging video and subtitles...`;
      await sendMessage(mergeMessage);
      await muxSubtitles(videoPath || '', subtitlePath || '', outputVideo, mergeMessage, MY_NUMBER || '', episodeName);
    }
    await sendMessage(`✅ *All done!*\nFiles organized in: ${episodeFolder}`);
    const compressedPath = path.join(episodeFolder, `${path.parse(videoPath || '').name}.whatsapp.mp4`);
    if (existsSync(compressedPath)) {
      await sendMessage(`Skipping compression - compressed video already exists: ${path.basename(compressedPath)}`);
    } else {
      try {
        const compressMessage = 'Compressing video for WhatsApp...';
        await sendMessage(`${compressMessage}`);
        await compressForWhatsapp(outputVideo, compressedPath, compressMessage, episodeName, MY_NUMBER || '');
      } catch (err: any) {
        await sendMessage(`Compression failed: ${err.message || err}`);
        throw err;
      }
    }
    // WhatsApp send logic omitted for brevity
  } catch (err: any) {
    await sendMessage(`⛔ Error: ${err.message}`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    process.exit(1);
  }
})(); 