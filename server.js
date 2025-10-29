// server.js (NEW - MongoDB + Mongoose)
// Replace your old server.js with this file. It keeps same socket events & behavior.
// IMPORTANT: set process.env.MONGO_URI in Render / your env before starting.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// === HARD CODED USERS (keeps same credentials for quick auth) ===
// You can later remove this and use DB-only auth if required.
const VALID_USERS = {
    "betu": "bubu",
    "puchu": "shona"
};

// === MONGO CONNECTION ===
const MONGO_URI = process.env.MONGO_URI || ''; // ← SET THIS in Render env
if (!MONGO_URI) {
    console.error('MONGO_URI not set. Set the environment variable and restart.');
    process.exit(1);
}

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// === SCHEMAS / MODELS ===
const itemSchema = new mongoose.Schema({
    id: String,
    text: String
}, { _id: false });

const userSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    password: String,
    username: String,
    dares: [itemSchema],
    truths: [itemSchema]
});

const messageSchema = new mongoose.Schema({
    username: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// === Helper: ensure default users exist (migrated behavior from data.json defaults) ===
async function ensureDefaultUsers() {
    for (const [id, pwd] of Object.entries(VALID_USERS)) {
        const exists = await User.findOne({ id }).exec();
        if (!exists) {
            const defaultUsername = id === 'betu' ? 'shona (shri)' : (id === 'puchu' ? 'betuu (moni)' : id);
            await User.create({
                id,
                password: pwd,
                username: defaultUsername,
                dares: [],
                truths: []
            });
            // console.log(`Created default user: ${id}`);
        }
    }
}

// Run once at startup
ensureDefaultUsers().catch(err => console.error('Error creating default users:', err));

// === AUTH MIDDLEWARE (Socket.IO) ===
io.use(async (socket, next) => {
    try {
        const { id, password } = socket.handshake.auth || {};
        if (id && password && VALID_USERS[id] === password) {
            // Fetch user from DB
            let user = await User.findOne({ id }).exec();
            if (!user) {
                // Shouldn't happen due to ensureDefaultUsers, but create if missing
                user = await User.create({ id, password, username: id, dares: [], truths: [] });
            }
            socket.user = user; // attach mongoose doc
            return next();
        } else {
            // Reject
            return next(new Error("Authentication failed"));
        }
    } catch (err) {
        console.error('Auth middleware error:', err);
        return next(new Error("Authentication error"));
    }
});

// === BROADCAST USER LIST (for reveal) ===
async function broadcastUserList() {
    const users = await User.find({}, 'id username').lean().exec();
    const userList = users.map(u => ({ id: u.id, username: u.username }));
    io.emit('userList', userList);
}

// === SOCKET CONNECTION ===
io.on('connection', (socket) => {
    // console.log(`user connected`);

    // IMPORTANT: socket.user is a mongoose document snapshot from auth middleware
    // We will re-query for latest state where needed.

    // Send initial data to this user only
    (async () => {
        try {
            const freshUser = await User.findOne({ id: socket.user.id }).lean().exec();
            const messages = await Message.find({}).sort({ timestamp: 1 }).lean().exec();

            socket.emit('init', {
                currentUser: { id: freshUser.id, username: freshUser.username },
                dares: freshUser.dares || [],
                truths: freshUser.truths || [],
                messages: messages || []
            });

            // Update global user list
            broadcastUserList();
        } catch (err) {
            console.error('Error during init emit:', err);
        }
    })();

    // === ADD DARE ===
    socket.on('addDare', async (text) => {
        try {
            const dare = { id: Date.now().toString(), text };
            await User.updateOne({ id: socket.user.id }, { $push: { dares: dare } }).exec();
            const updated = await User.findOne({ id: socket.user.id }).lean().exec();
            socket.emit('updateOwnDares', updated.dares);
            broadcastUserList();
        } catch (err) {
            console.error('addDare error:', err);
        }
    });

    // === ADD TRUTH ===
    socket.on('addTruth', async (text) => {
        try {
            const truth = { id: Date.now().toString(), text };
            await User.updateOne({ id: socket.user.id }, { $push: { truths: truth } }).exec();
            const updated = await User.findOne({ id: socket.user.id }).lean().exec();
            socket.emit('updateOwnTruths', updated.truths);
            broadcastUserList();
        } catch (err) {
            console.error('addTruth error:', err);
        }
    });

    // === DELETE ITEM ===
    socket.on('deleteItem', async ({ type, id }) => {
        try {
            if (type === 'dare') {
                await User.updateOne({ id: socket.user.id }, { $pull: { dares: { id } } }).exec();
                const updated = await User.findOne({ id: socket.user.id }).lean().exec();
                socket.emit('updateOwnDares', updated.dares);
            } else if (type === 'truth') {
                await User.updateOne({ id: socket.user.id }, { $pull: { truths: { id } } }).exec();
                const updated = await User.findOne({ id: socket.user.id }).lean().exec();
                socket.emit('updateOwnTruths', updated.truths);
            }
            broadcastUserList();
        } catch (err) {
            console.error('deleteItem error:', err);
        }
    });

    // === EDIT ITEM ===
    socket.on('editItem', async ({ type, id, newText }) => {
        try {
            if (type === 'dare') {
                await User.updateOne({ id: socket.user.id, 'dares.id': id }, { $set: { 'dares.$.text': newText } }).exec();
                const updated = await User.findOne({ id: socket.user.id }).lean().exec();
                socket.emit('updateOwnDares', updated.dares);
            } else if (type === 'truth') {
                await User.updateOne({ id: socket.user.id, 'truths.id': id }, { $set: { 'truths.$.text': newText } }).exec();
                const updated = await User.findOne({ id: socket.user.id }).lean().exec();
                socket.emit('updateOwnTruths', updated.truths);
            }
            broadcastUserList();
        } catch (err) {
            console.error('editItem error:', err);
        }
    });

    // === SEND MESSAGE ===
    socket.on('sendMessage', async (message) => {
        try {
            const msgDoc = await Message.create({
                username: socket.user.username,
                message,
                timestamp: new Date()
            });
            const msg = { username: msgDoc.username, message: msgDoc.message, timestamp: msgDoc.timestamp };
            io.emit('newMessage', msg);
        } catch (err) {
            console.error('sendMessage error:', err);
        }
    });

    // === REVEAL ITEM ===
    socket.on('revealItem', async () => {
        try {
            const otherUsers = await User.find({ id: { $ne: socket.user.id } }).lean().exec();
            const allItems = [];
            otherUsers.forEach(u => {
                (u.dares || []).forEach(d => allItems.push({ text: d.text, owner: u.username }));
                (u.truths || []).forEach(t => allItems.push({ text: t.text, owner: u.username }));
            });

            if (allItems.length > 0) {
                const random = allItems[Math.floor(Math.random() * allItems.length)];
                socket.emit('revealResult', random.text);
                socket.broadcast.emit('revealNotification', {
                    username: socket.user.username,
                    item: random.text
                });
            } else {
                socket.emit('revealResult', 'No items from your partner yet!');
            }
        } catch (err) {
            console.error('revealItem error:', err);
        }
    });

    // === CLEAR CHAT ===
    socket.on('clearChat', async () => {
        try {
            await Message.deleteMany({}).exec();
            io.emit('clearChat');
        } catch (err) {
            console.error('clearChat error:', err);
        }
    });

    // === EDIT USERNAME ===
    socket.on('editUsername', async (newUsername) => {
        try {
            if (newUsername && newUsername.trim()) {
                const oldName = socket.user.username;
                const trimmed = newUsername.trim();

                await User.updateOne({ id: socket.user.id }, { $set: { username: trimmed } }).exec();

                // Update messages that had oldName
                await Message.updateMany({ username: oldName }, { $set: { username: trimmed } }).exec();

                socket.emit('usernameUpdated', trimmed);
                broadcastUserList();

                const messages = await Message.find({}).sort({ timestamp: 1 }).lean().exec();
                io.emit('messagesUpdated', messages);
            }
        } catch (err) {
            console.error('editUsername error:', err);
        }
    });

    // === REFRESH DATA ON REQUEST (for auto reconnect) ===
socket.on('requestFreshData', async () => {
    try {
        const freshUser = await User.findOne({ id: socket.user.id }).lean().exec();
        const messages = await Message.find({}).sort({ timestamp: 1 }).lean().exec();

        socket.emit('init', {
            currentUser: { id: freshUser.id, username: freshUser.username },
            dares: freshUser.dares || [],
            truths: freshUser.truths || [],
            messages: messages || []
        });

        // console.log(`✅ Fresh data sent to ${socket.user.id}`);
    } catch (err) {
        console.error('Fresh data request failed:', err);
    }
});

    // === DISCONNECT ===
    socket.on('disconnect', () => {
        // console.log(`user disconnected`);
        broadcastUserList();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
