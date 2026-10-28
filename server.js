const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Socket.io's defaults (pingInterval 25s, pingTimeout 20s) are too strict
  // for a free-tier host — any brief delay in the server responding to a
  // ping (shared/throttled CPU, a GC pause, a slow moment) gets treated as
  // a dead connection and forces a reconnect, even though the network and
  // both people are completely fine. Giving it more patience here cuts
  // down on those false "left the chat" / reconnect cycles substantially.
  pingInterval: 20000,
  pingTimeout: 30000,
});

const PORT = process.env.PORT || 3000;

// Make sure uploads folder exists
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer setup for photo/video uploads
const ALLOWED_EXT = /^\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|m4v|mov|webm|mp3|m4a|aac|ogg|oga|wav)$/i;
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB cap
  // Only photos / videos / audio. Without this anyone with the link could
  // upload e.g. an .html file and have it served from your own domain.
  fileFilter: (req, file, cb) => {
    const okType = /^(image|video|audio)\//.test(file.mimetype);
    const okExt = ALLOWED_EXT.test(path.extname(file.originalname));
    if (okType && okExt) return cb(null, true);
    cb(new Error("Only photos, videos and audio are allowed."));
  },
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  })
);

// Optional TURN server config, read from environment variables so no
// credentials live in the code/repo.
app.get("/ice-config", (req, res) => {
  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    return res.json({
      turn: { urls: TURN_URL.split(",").map((u) => u.trim()), username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    });
  }
  res.json({ turn: null });
});

app.post(
  "/upload",
  (req, res, next) =>
    upload.single("media")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 25 MB)." : err.message;
        return res.status(400).json({ error: msg });
      }
      next();
    }),
  (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let type = "image";
  if (req.file.mimetype.startsWith("video")) type = "video";
  else if (req.file.mimetype.startsWith("audio")) type = "audio";
  res.json({
    url: `/uploads/${req.file.filename}`,
    type,
  });
  }
);

// Track who's online: socket.id -> nickname
const onlineUsers = new Map();
// nickname -> pending "they actually left" timeout. A dropped socket often
// reconnects within a couple seconds (brief wifi hiccup, mobile network
// switch, a free-tier host blipping) — this grace period stops those from
// being announced as a real "left the chat" or killing an active call.
const pendingLeaves = new Map();
const LEAVE_GRACE_MS = Number(process.env.LEAVE_GRACE_MS) || 20000;

function broadcastPresence() {
  // Set() so the same person connected on two sockets (old dead one +
  // new reconnected one) is only listed once.
  io.emit("presence", Array.from(new Set(onlineUsers.values())));
}

function isNicknameOnline(nickname) {
  for (const n of onlineUsers.values()) if (n === nickname) return true;
  return false;
}

io.on("connection", (socket) => {
  socket.on("join", (nickname) => {
    if (!nickname || typeof nickname !== "string") return;
    const clean = nickname.trim().slice(0, 24);
    if (!clean) return;
    socket.data.nickname = clean;

    const isQuickReconnect = pendingLeaves.has(clean) || isNicknameOnline(clean);
    if (isQuickReconnect) {
      clearTimeout(pendingLeaves.get(clean));
      pendingLeaves.delete(clean);
    }

    onlineUsers.set(socket.id, clean);
    // Only announce "joined" for an actual new arrival, not a quick
    // reconnect that nobody even noticed was gone.
    if (!isQuickReconnect) {
      io.emit("system", { text: `${clean} joined the chat`, ts: Date.now() });
    }
    broadcastPresence();
  });

  socket.on("message", (msg) => {
    if (!socket.data.nickname) return;
    // msg: { type: 'text' | 'image' | 'video' | 'audio', text?, url? }
    if (!msg || !["text", "image", "video", "audio"].includes(msg.type)) return;
    const text = typeof msg.text === "string" ? msg.text.slice(0, 4000) : "";
    const url = typeof msg.url === "string" && msg.url.startsWith("/uploads/") ? msg.url : "";
    if (msg.type === "text" && !text.trim()) return;
    if (msg.type !== "text" && !url) return;
    io.emit("message", {
      id: `${Date.now()}-${Math.random()}`,
      sender: socket.data.nickname,
      type: msg.type,
      text,
      url,
      ts: Date.now(),
    });
  });

  socket.on("typing", (isTyping) => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("typing", {
      nickname: socket.data.nickname,
      isTyping: !!isTyping,
    });
  });

  // ---- Voice/video call signaling (just relays between the two peers) ----
  socket.on("call-offer", (data) => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-offer", {
      offer: data.offer,
      callType: data.callType,
      from: socket.data.nickname,
    });
  });

  socket.on("call-answer", (data) => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-answer", { answer: data.answer });
  });

  socket.on("call-ice-candidate", (data) => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-ice-candidate", { candidate: data.candidate });
  });

  socket.on("call-end", () => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-end");
  });

  socket.on("call-decline", () => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-decline");
  });

  socket.on("call-cancel", () => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-cancel");
  });

  // Renegotiation relay — used when someone starts/stops screen sharing
  // mid-call (the set of tracks changes, so SDP needs to be re-exchanged)
  socket.on("call-renegotiate-offer", (data) => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-renegotiate-offer", { offer: data.offer });
  });

  socket.on("call-renegotiate-answer", (data) => {
    if (!socket.data.nickname) return;
    socket.broadcast.emit("call-renegotiate-answer", { answer: data.answer });
  });

  socket.on("leave", () => {
    // Explicit "Leave" button — the person meant it, so skip the grace
    // period entirely and announce it right away.
    const nickname = socket.data.nickname;
    if (!nickname) return;
    if (pendingLeaves.has(nickname)) {
      clearTimeout(pendingLeaves.get(nickname));
      pendingLeaves.delete(nickname);
    }
    onlineUsers.delete(socket.id);
    socket.data.nickname = null; // so the disconnect that follows is a no-op
    if (!isNicknameOnline(nickname)) {
      io.emit("system", { text: `${nickname} left the chat`, ts: Date.now() });
      io.emit("call-end");
    }
    broadcastPresence();
  });

  socket.on("disconnect", () => {
    const nickname = socket.data.nickname;
    if (!nickname) return;
    onlineUsers.delete(socket.id);
    broadcastPresence();

    // BUG FIX: if this person already reconnected on a newer socket (very
    // common: the client reconnects BEFORE the server notices the old
    // socket died), they have NOT left. Without this check the old socket's
    // late disconnect announced "left" and killed the active call even
    // though the person was still connected.
    if (isNicknameOnline(nickname)) return;

    const timeout = setTimeout(() => {
      pendingLeaves.delete(nickname);
      if (isNicknameOnline(nickname)) return; // came back in the meantime
      io.emit("system", { text: `${nickname} left the chat`, ts: Date.now() });
      io.emit("call-end");
    }, LEAVE_GRACE_MS);
    pendingLeaves.set(nickname, timeout);
  });
});

server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
});
