const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Make sure uploads folder exists
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer setup for photo/video uploads
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB cap
});

app.use(express.static(path.join(__dirname, "public")));

app.post("/upload", upload.single("media"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  let type = "image";
  if (req.file.mimetype.startsWith("video")) type = "video";
  else if (req.file.mimetype.startsWith("audio")) type = "audio";
  res.json({
    url: `/uploads/${req.file.filename}`,
    type,
  });
});

// Track who's online: socket.id -> nickname
const onlineUsers = new Map();
// nickname -> pending "they actually left" timeout. A dropped socket often
// reconnects within a couple seconds (brief wifi hiccup, mobile network
// switch, a free-tier host blipping) — this grace period stops those from
// being announced as a real "left the chat" or killing an active call.
const pendingLeaves = new Map();
const LEAVE_GRACE_MS = 8000;

function broadcastPresence() {
  io.emit("presence", Array.from(onlineUsers.values()));
}

io.on("connection", (socket) => {
  socket.on("join", (nickname) => {
    if (!nickname || typeof nickname !== "string") return;
    const clean = nickname.trim().slice(0, 24);
    if (!clean) return;
    socket.data.nickname = clean;

    const isQuickReconnect = pendingLeaves.has(clean);
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
    // msg: { type: 'text' | 'image' | 'video', text?, url? }
    io.emit("message", {
      id: `${Date.now()}-${Math.random()}`,
      sender: socket.data.nickname,
      type: msg.type,
      text: msg.text || "",
      url: msg.url || "",
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
    socket.broadcast.emit("call-answer", { answer: data.answer });
  });

  socket.on("call-ice-candidate", (data) => {
    socket.broadcast.emit("call-ice-candidate", { candidate: data.candidate });
  });

  socket.on("call-end", () => {
    socket.broadcast.emit("call-end");
  });

  socket.on("call-decline", () => {
    socket.broadcast.emit("call-decline");
  });

  socket.on("call-cancel", () => {
    socket.broadcast.emit("call-cancel");
  });

  // Renegotiation relay — used when someone starts/stops screen sharing
  // mid-call (the set of tracks changes, so SDP needs to be re-exchanged)
  socket.on("call-renegotiate-offer", (data) => {
    socket.broadcast.emit("call-renegotiate-offer", { offer: data.offer });
  });

  socket.on("call-renegotiate-answer", (data) => {
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
    io.emit("system", { text: `${nickname} left the chat`, ts: Date.now() });
    io.emit("call-end");
    broadcastPresence();
  });

  socket.on("disconnect", () => {
    const nickname = socket.data.nickname;
    if (!nickname) return;
    onlineUsers.delete(socket.id);
    broadcastPresence();
    // Don't immediately declare them gone or end any active call — give a
    // short window for this to just be a brief reconnect, not a real leave.
    const timeout = setTimeout(() => {
      pendingLeaves.delete(nickname);
      io.emit("system", { text: `${nickname} left the chat`, ts: Date.now() });
      io.emit("call-end");
    }, LEAVE_GRACE_MS);
    pendingLeaves.set(nickname, timeout);
  });
});

server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
});
