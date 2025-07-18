import fs from 'fs/promises';
// @ts-ignore
const fetch: any = function(...args: any[]) { return import('node-fetch').then(mod => (mod.default || mod)(...args)); };
import { OpenAI } from 'openai';
import { formatDuration } from './time-utils';
import { formatFileName } from './file-utils';

let chalkInstance: any;
async function getChalk() {
  if (!chalkInstance) {
    chalkInstance = (await import('chalk')).default;
  }
  return chalkInstance;
}

const OPEN_SUBTITLES_API_KEY = process.env.OS_API_KEY || 'rlF1xGalT47V4qYxdgSLR2GFTO3Cool8';
const OPEN_SUBTITLES_USER_AGENT = 'MyDownloader/1.0';

export interface SubtitleSearchResult {
  fileId: string;
  fileName?: string;
  release?: string;
}

export async function opensubsLogin(): Promise<string> {
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
  const loginData = (await res.json()) as { token?: string };
  if (!loginData.token) throw new Error('OpenSubtitles login failed');
  return loginData.token;
}

export async function searchSubtitles(token: string, lang: string, show: string, season: number, episode: number): Promise<SubtitleSearchResult | null> {
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
  const searchData = (await res.json()) as { data?: any[] };
  if (searchData && Array.isArray(searchData.data) && searchData.data.length > 0) {
    const sub = searchData.data[0];
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

export async function searchSubtitlesAll(token: string, lang: string, show: string, season: number, episode: number): Promise<SubtitleSearchResult[]> {
  const showQuery = show.toLowerCase().replace(/\s+/g, '+');
  const query = (!season && !episode) ? showQuery :  `${showQuery}+season+${season}+episode+${episode}`;
  const url = `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(query)}&languages=${lang}`;
  console.log(`[OpenSubtitles] Searching by query: ${url}`);
  const res = await fetch(url, {
    headers: {
      'Api-Key': OPEN_SUBTITLES_API_KEY,
      'User-Agent': OPEN_SUBTITLES_USER_AGENT,
      Authorization: `Bearer ${token}`
    }
  });
  const searchData = (await res.json()) as { data?: any[] };
  if (searchData && Array.isArray(searchData.data) && searchData.data.length > 0) {
    return searchData.data.map(sub => {
      const fileId = sub.attributes.files?.[0]?.file_id;
      const fileName = sub.attributes.files?.[0]?.file_name || undefined;
      if (!fileId) return null;
      return { fileId, fileName, release: sub.attributes.release };
    }).filter(Boolean) as SubtitleSearchResult[];
  }
  console.log(`[OpenSubtitles] No subtitles found for query: ${query} (${lang})`);
  return [];
}

export async function downloadSubtitle(subObj: SubtitleSearchResult, dest: string, token: string): Promise<void> {
  if (!subObj || !subObj.fileId) throw new Error('No file_id for subtitle download');
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
  const downloadData = (await res.json()) as { link?: string };
  if (!downloadData.link) {
    console.error('[Subtitle Download] No direct link returned from /download endpoint:', downloadData);
    throw new Error('Subtitle download failed');
  }
  const srtRes = await fetch(downloadData.link);
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

export async function translateSRTtoHebrew(srcPath: string, destPath: string): Promise<void> {
  const openai = new OpenAI();
  const text = await fs.readFile(srcPath, 'utf-8');
  const blocks = text.split(/\n\n+/);
  const chunkSize = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < blocks.length; i += chunkSize) {
    chunks.push(blocks.slice(i, i + chunkSize));
  }
  await fs.writeFile(destPath, '', 'utf-8');
  const startTime = Date.now();
  let lastPercent = 0;
  const chalk = await getChalk();
  console.log(chalk.green(`Translating file: ${formatFileName(destPath)}`));
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
    const translated = response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content
      ? response.choices[0].message.content.trim()
      : '';
    await fs.appendFile(destPath, translated + '\n\n', 'utf-8');
    const percent = ((i + 1) / chunks.length * 100).toFixed(2);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const eta = formatDuration(Number(((chunks.length - (i + 1)) * (Number(elapsed) / (i + 1))).toFixed(1)));
    process.stdout.write(`\rProgress: ${percent}% | Elapsed: ${elapsed}s | ETA: ${eta}s   `);
    lastPercent = Number(percent);
  }
  process.stdout.write('\n');
} 