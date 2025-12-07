# LAN Video Server

Simple local-server for sharing video links and sites to your TV's browser.

Features:
- Input a direct video URL (mp4, webm), HLS (.m3u8) or a website (iframe).
- Generates shareable link that any device on your LAN can open.
- Includes a streaming proxy (`/proxy?url=...`) which proxies content and supports Range requests for seeking.

Quick start (development):
```bash
cd /home/q/Відео
npm install
npm start
```

Run with process manager (recommended):
```bash
cd /home/q/Відео
npm install
# Start with PM2 (auto restart + daemonize)
npm run start:pm2
# Save pm2 list and enable startup script for persistent boot (one-time commands):
# sudo pm2 startup systemd -u $USER --hp $HOME
# npx pm2 save
```

Systemd unit example (optional):
```bash
# Copy scripts/lan-video-server.service to /etc/systemd/system/lan-video-server.service
# sudo cp scripts/lan-video-server.service /etc/systemd/system/
# sudo systemctl daemon-reload
# sudo systemctl enable lan-video-server
# sudo systemctl start lan-video-server
```

Open `http://<server-ip>:8081` on a phone or laptop, paste a video URL and click "Share". Then open the generated link on your TV browser.

Notes:
- For YouTube, using `player.html` uses the YouTube embed and autoplay when possible.
- Some websites block embedding; in those cases the iframe won't work. Use the TV's browser or a native app.
- HLS playback depends on TV browser support. If not supported, consider using a device that supports HLS or implement HLS.js as a fallback.
- Streaming of DRM-protected content is not supported.

Advanced: For improved compatibility, run this behind a reverse proxy or use nginx to handle TLS and host a stable URL.
