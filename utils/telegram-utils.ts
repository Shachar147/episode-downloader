// @ts-ignore
import fetch from 'node-fetch';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
}
if (!TELEGRAM_CHAT_ID) {
  throw new Error('TELEGRAM_CHAT_ID is not set in environment variables');
}

export const sendMessage = async (episodeName: string, message:string) => await sendTelegramMessage(`*[${episodeName}]*\n${message}`);

export async function sendTelegramMessage(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');

  // Log the message and parameters before sending
  console.log('[Telegram] Sending message:', message);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown', // Uncomment if you want formatting
    }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to send Telegram message: ${res.status} ${res.statusText} - ${errorText}`);
  }
} 