const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// === HARD CODED USERS ===
const VALID_USERS = {
    "betu": "bubu",
    "puchu": "shona"
};

// === DATABASE PATH ===
const DB_PATH = path.join(__dirname, 'data.json');
let db = { users: [], messages: [] };

// === LOAD DATABASE ===
function loadDB() {
    if (fs.existsSync(DB_PATH)) {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        db = JSON.parse(data);
    } else {
        // Default users
        db = {
            users: [
                {
                    id: "betu",
                    password: "bubu",
                    username: "Betu Baby",
                    dares: [],
                    truths: []
                },
                {
                    id: "puchu",
                    password: "shona",
                    username: "Puchu Jaan",
                    dares: [],
                    truths: []
                }
            ],
            messages: []
        };
        saveDB();
    }
}

// === SAVE DATABASE ===
function saveDB() {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

loadDB();

// === AUTH MIDDLEWARE ===
io.use((socket, next) => {
    const { id, password } = socket.handshake.auth;
    if (id && password && VALID_USERS[id] === password) {
        const user = db.users.find(u => u.id === id);
        if (user) {
            socket.user = user; // ✅ use reference
            return next();
        }
    }
    next(new Error("Authentication failed"));
});

// === BROADCAST USER LIST (for reveal) ===
function broadcastUserList() {
    const userList = db.users.map(u => ({ id: u.id, username: u.username }));
    io.emit('userList', userList);
}

// === CONNECTION ===
io.on('connection', (socket) => {
    // console.log(`${socket.user.username} connected`);
    console.log(`user connected`);

    // Send initial data to this user only
    socket.emit('init', {
        currentUser: { id: socket.user.id, username: socket.user.username },
        dares: socket.user.dares,
        truths: socket.user.truths,
        messages: db.messages
    });

    // Send updated user list to all
    broadcastUserList();

    // === ADD DARE ===
    socket.on('addDare', (text) => {
        const dare = { id: Date.now().toString(), text };
        socket.user.dares.push(dare);
        saveDB();
        socket.emit('updateOwnDares', socket.user.dares);
        broadcastUserList(); // For reveal
    });

    // === ADD TRUTH ===
    socket.on('addTruth', (text) => {
        const truth = { id: Date.now().toString(), text };
        socket.user.truths.push(truth);
        saveDB();
        socket.emit('updateOwnTruths', socket.user.truths);
        broadcastUserList();
    });

    // === DELETE ITEM ===
    socket.on('deleteItem', ({ type, id }) => {
        if (type === 'dare') {
            socket.user.dares = socket.user.dares.filter(d => d.id !== id);
        } else if (type === 'truth') {
            socket.user.truths = socket.user.truths.filter(t => t.id !== id);
        }
        saveDB();
        socket.emit(type === 'dare' ? 'updateOwnDares' : 'updateOwnTruths', 
            type === 'dare' ? socket.user.dares : socket.user.truths);
        broadcastUserList();
    });

    // === EDIT ITEM ===
    socket.on('editItem', ({ type, id, newText }) => {
        if (type === 'dare') {
            const dare = socket.user.dares.find(d => d.id === id);
            if (dare) dare.text = newText;
        } else if (type === 'truth') {
            const truth = socket.user.truths.find(t => t.id === id);
            if (truth) truth.text = newText;
        }
        saveDB();
        socket.emit(type === 'dare' ? 'updateOwnDares' : 'updateOwnTruths', 
            type === 'dare' ? socket.user.dares : socket.user.truths);
        broadcastUserList();
    });

    // === SEND MESSAGE ===
    socket.on('sendMessage', (message) => {
        const msg = {
            username: socket.user.username,
            message,
            timestamp: new Date().toISOString()
        };
        db.messages.push(msg);
        saveDB();
        io.emit('newMessage', msg);
    });

    // === REVEAL ITEM ===
    socket.on('revealItem', () => {
        const otherUsers = db.users.filter(u => u.id !== socket.user.id);
        const allItems = [];
        otherUsers.forEach(u => {
            u.dares.forEach(d => allItems.push({ text: d.text, owner: u.username }));
            u.truths.forEach(t => allItems.push({ text: t.text, owner: u.username }));
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
    });

    // === CLEAR CHAT ===
    socket.on('clearChat', () => {
        db.messages = [];
        saveDB();
        io.emit('clearChat');
    });

    // === EDIT USERNAME ===
    socket.on('editUsername', (newUsername) => {
        if (newUsername && newUsername.trim()) {
            const oldName = socket.user.username;
            socket.user.username = newUsername.trim();
            // Update in db
            const dbUser = db.users.find(u => u.id === socket.user.id);
            if (dbUser) dbUser.username = newUsername.trim();
            saveDB();
            socket.emit('usernameUpdated', newUsername.trim());
            broadcastUserList();
            // Update old messages
            db.messages.forEach(m => {
                if (m.username === oldName) m.username = newUsername.trim();
            });
            saveDB();
            io.emit('messagesUpdated', db.messages);
        }
    });

    // === DISCONNECT ===
    socket.on('disconnect', () => {
        console.log(`${socket.user.username} disconnected`);
        broadcastUserList();
    });
});

// === SERVE FRONTEND ===
// app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // console.log(`Open: http://localhost:${PORT}`);
});