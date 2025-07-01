# 📺 Auto-Downloader v2

This script simplifies the process of downloading TV series episodes, fetching Hebrew subtitles (or translating them if needed), and muxing them together into a single video file! 🎬✨

![Demo](demo.gif)

## 🚀 Features
- Search and download TV episodes via torrent
- Automatically fetch Hebrew subtitles (or English and translate to Hebrew)
- Mux subtitles into the video using FFmpeg
- Easy to use from the command line

## 🛠️ Prerequisites
- **Node.js** ≥ 18
- **FFmpeg** installed and in your PATH
- **WebTorrent** (npm module, installed automatically)
- **OpenAI API key** (for subtitle translation, if needed)
- **OpenSubtitles account** (for subtitle downloads)
- **WhatsApp account** (for notifications, optional)

## ⚙️ Setup
1. **Clone this repository**
2. **Install dependencies:**
   ```sh
   npm install
   ```
3. **Create a `.env` file in your project root:**
   ```env
   OS_API_USER=your_opensubtitles_username
   OS_API_PASS=your_opensubtitles_password
   OS_API_KEY=your_opensubtitles_api_key
   OPENAI_API_KEY=your_openai_api_key # (for translation of eng subtitles to hebrew)
   MY_WHATSAPP_NUMBER=your_whatsapp_phone_number # (for WhatsApp notifications, country code, no plus sign for example - 972501234567)
   
   # Messaging tunnel: telegram or whatsapp
   MESSAGE_TUNNEL=telegram
   
   # Telegram bot integration
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_CHAT_ID=your_telegram_chat_id
   ```

### 🔑 How to get your OpenSubtitles API Key
1. Register or log in at [OpenSubtitles.com](https://www.opensubtitles.com/)
2. Go to your profile or account settings
3. Find the **API Key** section and generate/copy your API key
4. Paste it as `OS_API_KEY` in your `.env` file

> **Note:** You must use your OpenSubtitles **username** (not email) and password for `OS_API_USER` and `OS_API_PASS`.

### 🤖 How to get your OpenAI API Key (for subtitle translation)
1. Sign up or log in at [OpenAI Platform](https://platform.openai.com/signup)
2. Go to your [API keys page](https://platform.openai.com/api-keys)
3. Click **"Create new secret key"** and copy the key
4. Add it to your `.env` file as:
   ```env
   OPENAI_API_KEY=sk-...
   ```
5. **Free credits:** New accounts get some free credits, but usage is not unlimited. See [OpenAI Pricing](https://openai.com/pricing) for details.

### 🟦 How to get your Telegram Bot Token and Chat ID
1. **Create a bot with [@BotFather](https://t.me/botfather) on Telegram:**
   - Send `/newbot` and follow the instructions to get your bot token.
2. **Get your chat ID (must be your own user or group chat, NOT the bot's ID!):**
   - Start a chat with your bot from your personal Telegram account (not from another bot).
   - Send any message to your bot.
   - Visit `https://api.telegram.org/bot<YourBOTToken>/getUpdates` in your browser after sending a message to your bot.
   - Look for `chat":{"id":...` in the JSON response; that's your chat ID. It should be a number associated with your user or group, **not the bot's ID**.
   - **If you use the bot's own ID, you will get an error: `Forbidden: bots can't send messages to bots`.**
3. **Copy these values into your `.env` file, example:**
   ```env
   TELEGRAM_BOT_TOKEN=7872878394:AAGKcrvsqZaPBMSbAYbDs6QXsYVMAvRWDvs
   TELEGRAM_CHAT_ID=1801579986  # <-- your user or group chat ID, not the bot's ID!
   ```

## 📝 Usage

```sh
node episode_downloader.js --show "Rick and Morty" --season 8 --episode 5 \
    --out /path/to/output
```

- `--show`      TV show title (e.g., "Rick and Morty")
- `--season`    Season number
- `--episode`   Episode number
- `--out`       Output directory (default: current directory)
- `--min-seeds` Minimum seeders (default: 20)

## 💡 Example
```sh
node episode_downloader.js --show "Rick and Morty" --season 1 --episode 1 --out ~/Videos/ --min-seeds 25
```

## 🧩 What it does
1. Finds the best torrent for your episode (prefers 1080p/720p, most seeders)
2. Downloads the episode
3. Fetches Hebrew subtitles (or English, then translates to Hebrew if needed)
4. Muxes the subtitles into the video file
5. Saves the final video in your output directory

---

Enjoy your automated TV experience! 🍿

### 📲 WhatsApp Notifications

If you set `MY_WHATSAPP_NUMBER` in your `.env`, the script will send you real-time updates about the download and processing steps via WhatsApp (using WhatsApp Web). 

On first run, you'll need to scan a QR code in your terminal to connect your WhatsApp account. 
The script will wait for the WhatsApp client to be ready before proceeding with the download.

**Example notifications:**
- Started search for episode
- Magnet link found
- Torrent download started/completed
- Subtitles found/translated
- Muxing started/completed
- Errors

> **Note:** Your computer must stay online and logged in to WhatsApp Web for notifications to work.

## 🔧 Troubleshooting

### WhatsApp Web Issues

If WhatsApp notifications stop working or you encounter connection errors:

1. **Clear WhatsApp session data:**
   ```sh
   rm -rf .wwebjs_auth
   rm -rf .wwebjs_cache
   ```

2. **Disconnect linked devices from WhatsApp:**
   - Open WhatsApp on your phone
   - Go to **Settings** → **Linked Devices**
   - Remove any existing WhatsApp Web sessions

3. **Restart the script:**
   ```sh
   npm run download:rick
   ```

4. **Scan the QR code again** when prompted

This should resolve most WhatsApp Web connection issues.

### Other Common Issues

- **"Bad CPU type in executable"**: You're running Intel binaries on Apple Silicon. Install ARM64 versions of Node.js and FFmpeg.
- **FFmpeg not found**: Install FFmpeg via Homebrew: `brew install ffmpeg`
- **Compression errors**: Check that the input video file exists and is not corrupted.
