import { sendTelegramMessage } from './telegram-utils';
import { sendWhatsAppMessageToMyNumber } from './whatsapp-utils';

export enum MessageTunnel {
  WHATSAPP = 'whatsapp',
  TELEGRAM = 'telegram',
}

const MESSAGE_TUNNEL = (process.env.MESSAGE_TUNNEL as MessageTunnel) || MessageTunnel.TELEGRAM;

/**
 * Unified sendMessage function for all messaging tunnels.
 * @param message - The message to send
 * @param numberOrChatId - WhatsApp number or Telegram chat ID (optional, for future extensibility)
 */
export async function sendMessage(message: string): Promise<void> {
  if (MESSAGE_TUNNEL === MessageTunnel.WHATSAPP) {
    await sendWhatsAppMessageToMyNumber(message);
  } else if (MESSAGE_TUNNEL === MessageTunnel.TELEGRAM) {
    await sendTelegramMessage(message);
  } else {
    throw new Error(`Unknown MESSAGE_TUNNEL: ${MESSAGE_TUNNEL}`);
  }
} 