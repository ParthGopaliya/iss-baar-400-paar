# Chat Room

A simple private real-time chat app: nicknames, typing status, photo/video sharing, join/leave notifications.

## Run it locally (to test)

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

## Get a real link you can share (deploy for free on Render)

1. Create a free account at https://render.com
2. Push this folder to a new GitHub repository (or use Render's "Deploy from a folder" option if available).
3. On Render, click **New +** → **Web Service**, connect your repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Leave everything else as default (free plan is fine).
5. Click **Deploy**. Render will give you a URL like `https://your-app-name.onrender.com`.
6. Send that link to your girlfriend — whoever opens it can enter a nickname and start chatting with you live.

### Notes
- Free Render services "sleep" after 15 minutes of no traffic and take ~30-50 seconds to wake up on the next visit. This is fine for casual personal use.
- Uploaded photos/videos are stored on the server's disk — on Render's free tier, this storage is wiped on redeploy/restart (not on every sleep/wake, only on redeploy). For a personal chat app this is totally fine; just know old media may not survive if you push updates later.
- If you outgrow the free tier or want persistent media storage, you could later switch to a paid Render disk or an external storage service like Cloudinary — not needed for now.
