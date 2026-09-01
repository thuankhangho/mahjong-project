const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const SUITS = ['m', 'p', 's'];
const HONORS = ['1z', '2z', '3z', '4z', '5z', '6z', '7z'];

// Hàm sắp xếp bài
function sortTiles(tilesArray) {
    const order = { 'm': 1, 'p': 2, 's': 3, 'z': 4 };
    return tilesArray.sort((a, b) => {
        if (a[1] !== b[1]) return order[a[1]] - order[b[1]];
        return parseInt(a[0]) - parseInt(b[0]);
    });
}

function generateDeck(ruleType, playerCount) {
    let deck = [];
    if (playerCount === 4) {
        SUITS.forEach(s => {
            for (let i = 1; i <= 9; i++) {
                for (let c = 0; c < 4; c++) deck.push(`${i}${s}`);
            }
        });
        HONORS.forEach(h => {
            for (let c = 0; c < 4; c++) deck.push(h);
        });
    } else if (playerCount === 3) {
        for (let c = 0; c < 4; c++) {
            deck.push('1m', '9m');
            for (let i = 1; i <= 9; i++) deck.push(`${i}p`, `${i}s`);
            HONORS.forEach(h => deck.push(h));
        }
    } else if (playerCount === 2) {
        for (let c = 0; c < 4; c++) {
            for (let i = 1; i <= 9; i++) deck.push(`${i}p`, `${i}s`);
            HONORS.forEach(h => deck.push(h));
        }
    }

    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Ghế 0 luôn là host (Nam - bạn). Với các người chơi tiếp theo, giao diện chỉ hiện
// ghế Đông(1) khi maxPlayers>=3, ghế Bắc(2) khi maxPlayers>=2, ghế Tây(3) khi maxPlayers===4.
// Hàm này quy đổi thứ tự vào bàn (0,1,2...) sang đúng seatIndex sẽ được hiển thị.
function getSeatIndexForJoinOrder(joinOrder, maxPlayers) {
    if (joinOrder === 0) return 0;
    if (maxPlayers === 2) return 2; // đối thủ duy nhất -> ghế Bắc (ghế được hiện)
    if (maxPlayers === 3) return joinOrder; // 1 -> Đông, 2 -> Bắc
    return joinOrder; // 4 người: 1 -> Đông, 2 -> Bắc, 3 -> Tây
}

function getPublicRoomList() {
    const list = [];
    rooms.forEach((room, id) => {
        list.push({
            id,
            name: room.name,
            ruleType: room.ruleType,
            playerCount: room.players.length,
            maxPlayers: room.maxPlayers,
            hasPassword: !!room.password,
            status: room.status,
            isSinglePlayer: room.isSinglePlayer
        });
    });
    return list;
}

function checkChiOptions(hand, discardedTile) {
    const val = parseInt(discardedTile[0]);
    const suit = discardedTile[1];
    if (suit === 'z') return [];

    const options = [];
    if (val >= 3 && hand.includes(`${val-2}${suit}`) && hand.includes(`${val-1}${suit}`)) {
        options.push([`${val-2}${suit}`, `${val-1}${suit}`]);
    }
    if (val >= 2 && val <= 8 && hand.includes(`${val-1}${suit}`) && hand.includes(`${val+1}${suit}`)) {
        options.push([`${val-1}${suit}`, `${val+1}${suit}`]);
    }
    if (val <= 7 && hand.includes(`${val+1}${suit}`) && hand.includes(`${val+2}${suit}`)) {
        options.push([`${val+1}${suit}`, `${val+2}${suit}`]);
    }
    return options;
}

io.on('connection', (socket) => {
    socket.emit('room_list', getPublicRoomList());

    socket.on('create_room', ({ name, password, maxPlayers, ruleType, isSinglePlayer }) => {
        const roomId = 'room_' + Math.random().toString(36).substr(2, 6);
        const maxP = parseInt(maxPlayers) || 4;
        const room = {
            id: roomId,
            name: name || `Phòng của ${socket.id.substr(0, 4)}`,
            password: password || null,
            maxPlayers: maxP,
            ruleType: ruleType || 'riichi',
            isSinglePlayer: !!isSinglePlayer,
            status: 'waiting',
            hostId: socket.id,
            players: [],
            gameState: null,
            pendingCalls: null
        };

        room.players.push({
            id: socket.id,
            name: isSinglePlayer ? "Bạn" : `Player_${socket.id.substr(0, 4)}`,
            isBot: false,
            seatIndex: 0,
            hand: [],
            melds: [],
            score: 25000
        });

        if (room.isSinglePlayer) {
            // seatIndex 1 = ghế Đông (hiện khi >=3 người), 2 = ghế Bắc (hiện khi >=2 người),
            // 3 = ghế Tây (chỉ hiện khi đủ 4 người). Gán đúng seatIndex theo số người chơi
            // để giao diện (badge/hand/river) luôn khớp với vị trí thực sự được hiển thị.
            const botSeats = maxP === 4 ? [
                { name: 'Bot Đông', seatIndex: 1 },
                { name: 'Bot Bắc', seatIndex: 2 },
                { name: 'Bot Tây', seatIndex: 3 }
            ] : maxP === 3 ? [
                { name: 'Bot Đông', seatIndex: 1 },
                { name: 'Bot Bắc', seatIndex: 2 }
            ] : [
                { name: 'Bot Bắc', seatIndex: 2 }
            ];

            botSeats.forEach((b, idx) => {
                room.players.push({
                    id: `bot_${idx + 1}`,
                    name: b.name,
                    isBot: true,
                    seatIndex: b.seatIndex,
                    hand: [],
                    melds: [],
                    score: 25000
                });
            });
            room.status = 'playing';
        }

        rooms.set(roomId, room);
        socket.join(roomId);
        socket.emit('room_created', { roomId, room });
        io.emit('room_list', getPublicRoomList());

        if (room.isSinglePlayer) startGame(roomId);
    });

    socket.on('join_room', ({ roomId, password }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error_msg', 'Phòng không tồn tại!');
        if (room.status === 'playing') return socket.emit('error_msg', 'Phòng đang chơi!');
        if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', 'Phòng đã đầy!');
        if (room.password && room.password !== password) return socket.emit('error_msg', 'Sai mật khẩu!');

        room.players.push({
            id: socket.id,
            name: `Player_${socket.id.substr(0, 4)}`,
            isBot: false,
            seatIndex: getSeatIndexForJoinOrder(room.players.length, room.maxPlayers),
            hand: [],
            melds: [],
            score: 25000
        });

        socket.join(roomId);
        io.to(roomId).emit('player_joined', { room });
        io.emit('room_list', getPublicRoomList());

        if (room.players.length === room.maxPlayers) {
            room.status = 'playing';
            startGame(roomId);
        }
    });

    socket.on('game_action', ({ roomId, action, data }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameState) return;

        const state = room.gameState;
        const currentPlayer = room.players[state.turnIndex];
        if (currentPlayer.id !== socket.id) return;

        if (action === 'discard') {
            const tile = data.tile;
            const tileIdx = currentPlayer.hand.indexOf(tile);
            if (tileIdx > -1) {
                currentPlayer.hand.splice(tileIdx, 1);
            } else {
                currentPlayer.hand.splice(data.tileIndex, 1);
            }

            state.lastDiscard = { playerSeat: currentPlayer.seatIndex, tile };
            state.rivers[currentPlayer.seatIndex].push({
                tile: tile,
                discarder: currentPlayer.name
            });

            sendGameUpdate(room, `${currentPlayer.name} vừa đánh ra 1 cây`);
            checkCallsForDiscard(room, currentPlayer.seatIndex, tile);
        }
    });

    socket.on('player_call_decision', ({ roomId, decision, details }) => {
        const room = rooms.get(roomId);
        if (!room || !room.pendingCalls) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        applyCallDecision(room, player, decision, details);
    });

    socket.on('player_declare_win', ({ roomId, playerName }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        io.to(roomId).emit('game_over', { 
            reason: `🎉 ${playerName || 'Người chơi'} đã TSUMO / Ù (Hu) THÀNH CÔNG!` 
        });
    });

    socket.on('leave_room', (roomId) => handleLeaveRoom(socket, roomId));
    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => handleLeaveRoom(socket, roomId));
    });
});

function applyCallDecision(room, player, decision, details = {}) {
    const pCall = room.pendingCalls;
    if (!pCall) return;

    if (decision === 'pass') {
        resolvePendingCall(room);
        return;
    }

    const tile = pCall.discardedTile;
    const CALL_LABELS = { pon: 'Pon (Phỗng)', kan: 'Kan (Cóng)', chi: 'Chi (Ăn)' };

    if (decision === 'pon') {
        removeTilesFromHand(player.hand, tile, 2);
        player.melds.push({ type: 'pon', tiles: [tile, tile, tile], fromSeat: pCall.discarderSeat });
        state_removeLastRiverTile(room, pCall.discarderSeat);
        broadcastCallAnnouncement(room, player, decision, tile, CALL_LABELS);
        setTurnToPlayer(room, player.seatIndex);
    } else if (decision === 'kan') {
        removeTilesFromHand(player.hand, tile, 3);
        player.melds.push({ type: 'kan', tiles: [tile, tile, tile, tile], fromSeat: pCall.discarderSeat });
        state_removeLastRiverTile(room, pCall.discarderSeat);
        broadcastCallAnnouncement(room, player, decision, tile, CALL_LABELS);
        setTurnToPlayer(room, player.seatIndex, true);
    } else if (decision === 'chi') {
        const chosenComb = details.combination;
        chosenComb.forEach(t => {
            const idx = player.hand.indexOf(t);
            if (idx > -1) player.hand.splice(idx, 1);
        });

        const meldTiles = sortTiles([chosenComb[0], tile, chosenComb[1]]);
        player.melds.push({ type: 'chi', tiles: meldTiles, fromSeat: pCall.discarderSeat });
        state_removeLastRiverTile(room, pCall.discarderSeat);
        broadcastCallAnnouncement(room, player, decision, tile, CALL_LABELS);
        setTurnToPlayer(room, player.seatIndex);
    }
}

// Thông báo Pon/Kan/Chi cho TẤT CẢ người chơi (kể cả khi người gọi là AI) để hiện banner giữa màn hình.
function broadcastCallAnnouncement(room, player, decision, tile, labels) {
    io.to(room.id).emit('call_announcement', {
        playerName: player.name,
        isBot: !!player.isBot,
        type: decision,
        label: labels[decision] || decision,
        tile
    });
}

// AI luôn ưu tiên Kan > Pon > Chi nếu đủ điều kiện; chỉ Chi khi ngồi ngay sau người đánh ra.
function decideBotCall(eligibleCalls) {
    const kanCall = eligibleCalls.find(ec => ec.player.isBot && ec.canKan);
    if (kanCall) return { player: kanCall.player, decision: 'kan', details: {} };

    const ponCall = eligibleCalls.find(ec => ec.player.isBot && ec.canPon);
    if (ponCall) return { player: ponCall.player, decision: 'pon', details: {} };

    const chiCall = eligibleCalls.find(ec => ec.player.isBot && ec.chiOptions && ec.chiOptions.length > 0);
    if (chiCall) return { player: chiCall.player, decision: 'chi', details: { combination: chiCall.chiOptions[0] } };

    return null;
}

function removeTilesFromHand(hand, tile, count) {
    let removed = 0;
    for (let i = hand.length - 1; i >= 0 && removed < count; i--) {
        if (hand[i] === tile) {
            hand.splice(i, 1);
            removed++;
        }
    }
}

function state_removeLastRiverTile(room, seat) {
    if (room.gameState.rivers[seat] && room.gameState.rivers[seat].length > 0) {
        room.gameState.rivers[seat].pop();
    }
}

function setTurnToPlayer(room, seatIndex, isKanDraw = false) {
    room.pendingCalls = null;
    const player = room.players.find(p => p.seatIndex === seatIndex);
    room.gameState.turnIndex = room.players.indexOf(player);

    if (isKanDraw) {
        playerDraw(room.id);
    } else {
        sendGameUpdate(room, `Lượt đánh của: ${player.name} (Sau khi gọi bài)`);
        if (player.isBot) botAutoDiscard(room, player);
    }
}

function checkCallsForDiscard(room, discarderSeat, discardedTile) {
    const eligibleCalls = [];
    const discarderIdx = room.players.findIndex(p => p.seatIndex === discarderSeat);
    const nextPlayer = room.players[(discarderIdx + 1) % room.players.length];

    room.players.forEach(p => {
        if (p.seatIndex === discarderSeat) return;

        const countInHand = p.hand.filter(t => t === discardedTile).length;
        const canPon = countInHand >= 2;
        const canKan = countInHand >= 3;
        const chiOptions = (p.id === nextPlayer.id) ? checkChiOptions(p.hand, discardedTile) : [];

        if (canPon || canKan || chiOptions.length > 0) {
            eligibleCalls.push({ player: p, canPon, canKan, chiOptions });
        }
    });

    if (eligibleCalls.length === 0) {
        nextTurn(room.id);
        return;
    }

    room.pendingCalls = { discarderSeat, discardedTile, calls: eligibleCalls };

    eligibleCalls.forEach(ec => {
        if (!ec.player.isBot) {
            io.to(ec.player.id).emit('show_call_actions', {
                discardedTile,
                canPon: ec.canPon,
                canKan: ec.canKan,
                chiOptions: ec.chiOptions
            });
        }
    });

    const hasHuman = eligibleCalls.some(ec => !ec.player.isBot);
    if (!hasHuman) {
        setTimeout(() => {
            if (!rooms.has(room.id) || !room.pendingCalls) return;
            const botDecision = decideBotCall(eligibleCalls);
            if (botDecision) {
                applyCallDecision(room, botDecision.player, botDecision.decision, botDecision.details);
            } else {
                resolvePendingCall(room);
            }
        }, 900);
    }
}

function resolvePendingCall(room) {
    room.pendingCalls = null;
    nextTurn(room.id);
}

function handleLeaveRoom(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);

    if (room.players.filter(p => !p.isBot).length === 0 || room.hostId === socket.id) {
        rooms.delete(roomId);
    } else {
        io.to(roomId).emit('player_left', { room });
    }
    io.emit('room_list', getPublicRoomList());
}

function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const deck = generateDeck(room.ruleType, room.players.length);
    room.players.forEach(p => {
        p.hand = [];
        p.melds = [];
        for (let i = 0; i < 13; i++) p.hand.push(deck.pop());
    });

    const rivers = { 0: [], 1: [], 2: [], 3: [] };
    room.gameState = {
        deck,
        doraIndicators: room.ruleType === 'riichi' ? [deck.pop()] : [],
        rivers,
        turnIndex: 0,
        roundWind: 'Đông 1'
    };

    io.to(roomId).emit('game_started', { room });
    playerDraw(roomId);
}

function sendGameUpdate(room, logMsg) {
    room.players.forEach(recipient => {
        if (recipient.isBot) return;

        const sanitizedPlayers = room.players.map(p => {
            if (p.id === recipient.id) {
                return { ...p, hand: p.hand, melds: p.melds };
            } else {
                return { ...p, handCount: p.hand.length, melds: p.melds, hand: [] };
            }
        });

        io.to(recipient.id).emit('game_update', {
            gameState: { ...room.gameState, deckCount: room.gameState.deck.length },
            players: sanitizedPlayers,
            log: logMsg
        });
    });
}

function playerDraw(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;

    const state = room.gameState;
    if (state.deck.length === 0) {
        io.to(roomId).emit('game_over', { reason: 'Hết bài trong tường (Hòa ván / Ryuukyoku)!' });
        return;
    }

    const currentPlayer = room.players[state.turnIndex];
    const drawnTile = state.deck.pop();
    currentPlayer.hand.push(drawnTile);

    sendGameUpdate(room, `Lượt của: ${currentPlayer.name} (Bốc bài)`);

    if (currentPlayer.isBot) botAutoDiscard(room, currentPlayer);
}

function botAutoDiscard(room, botPlayer) {
    setTimeout(() => {
        if (!rooms.has(room.id)) return;
        const discardIdx = Math.floor(Math.random() * botPlayer.hand.length);
        const discarded = botPlayer.hand.splice(discardIdx, 1)[0];
        
        room.gameState.rivers[botPlayer.seatIndex].push({
            tile: discarded,
            discarder: botPlayer.name
        });

        sendGameUpdate(room, `[AI] ${botPlayer.name} vừa đánh ra 1 cây`);
        checkCallsForDiscard(room, botPlayer.seatIndex, discarded);
    }, 1100);
}

function nextTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.gameState) return;

    room.gameState.turnIndex = (room.gameState.turnIndex + 1) % room.players.length;
    playerDraw(roomId);
}

server.listen(3000, () => {
    console.log(' Mahjong Server running at http://localhost:3000');
});