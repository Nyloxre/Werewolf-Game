// Werewolf Multiplayer Server
// Run with: node server.js
// Requires: npm install ws

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const rooms = {}; // roomCode -> roomState

function generateCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (rooms[code]);
  return code;
}

function broadcast(room, msg, excludeWs = null) {
  room.clients.forEach(({ ws, name }) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(msg));
  });
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getLobbyState(room) {
  return {
    type: 'lobby_update',
    players: room.clients.map(c => c.name),
    hostName: room.hostName,
    gameMode: room.gameMode,
    roleConfig: room.roleConfig
  };
}

function buildRandomRolePool(n) {
  let pool = [];
  if (n <= 6) {
    pool.push(Math.random() < 0.5 ? 'Werewolf' : 'Arsonist');
  } else {
    let r = Math.random();
    if (r < 0.50) pool.push('Werewolf');
    else if (r < 0.75) pool.push('Werewolf', 'Arsonist');
    else pool.push('Werewolf', 'Werewolf');
  }
  pool.push('Detective');
  let optional = shuffle(['Doctor', 'Hunter', 'Jester', 'Time Keeper', 'Medium']);
  let extra = n <= 5 ? 0 : n <= 7 ? 1 : 2;
  for (let i = 0; i < extra; i++) if (optional[i]) pool.push(optional[i]);
  while (pool.length < n) pool.push('Villager');
  let evilCount = pool.filter(r => r === 'Werewolf' || r === 'Arsonist').length;
  if (evilCount === 1) {
    let vi = pool.map((r, i) => r === 'Villager' ? i : -1).filter(i => i >= 0);
    shuffle(vi);
    if (vi.length > 0 && Math.random() < 0.20) pool[vi[0]] = 'Ally';
  }
  return pool;
}

function shuffle(a) { return a.sort(() => Math.random() - 0.5); }

function isEvil(role) { return role === 'Werewolf' || role === 'Arsonist'; }

function startGame(room) {
  const players = room.clients.map(c => c.name);
  let rolePool;
  if (room.gameMode === 'random') {
    rolePool = shuffle(buildRandomRolePool(players.length));
  } else {
    const cfg = room.roleConfig || {};
    rolePool = [];
    for (let i = 0; i < (cfg.Werewolf||0); i++) rolePool.push('Werewolf');
    for (let i = 0; i < (cfg.Detective||1); i++) rolePool.push('Detective');
    for (let i = 0; i < (cfg.Doctor||0); i++) rolePool.push('Doctor');
    for (let i = 0; i < (cfg.Hunter||0); i++) rolePool.push('Hunter');
    for (let i = 0; i < (cfg['King Tez']||0); i++) rolePool.push('King Tez');
    for (let i = 0; i < (cfg.Jester||0); i++) rolePool.push('Jester');
    for (let i = 0; i < (cfg['Time Keeper']||0); i++) rolePool.push('Time Keeper');
    for (let i = 0; i < (cfg.Arsonist||0); i++) rolePool.push('Arsonist');
    for (let i = 0; i < (cfg.Medium||0); i++) rolePool.push('Medium');
    for (let i = 0; i < (cfg.Ally||0); i++) rolePool.push('Ally');
    for (let i = 0; i < (cfg.Executioner||0); i++) rolePool.push('Executioner');
    for (let i = 0; i < (cfg.Copycat||0); i++) rolePool.push('Copycat');
    while (rolePool.length < players.length) rolePool.push('Villager');
    rolePool = shuffle(rolePool);
  }

  const shuffledPlayers = shuffle([...players]);
  room.roles = {};
  shuffledPlayers.forEach((p, i) => room.roles[p] = rolePool[i]);
  room.alive = {};
  players.forEach(p => room.alive[p] = true);
  room.deceased = [];
  room.wolfVotes = {};
  room.doctorChoice = null;
  room.dousedPlayer = null;
  room.dousedNextMorning = false;
  room.arsonistAlive = true;
  room.jesterVotedOut = false;
  room.pendingSkip = {};
  room.skippedTurn = {};
  room.nightActionsComplete = {};
  room.dayVotes = {};
  room.phase = 'role_reveal';
  room.notepads = {};
  room.ghostChat = [];
  room.executionerTargets = {}; // executionerName -> targetName
  room.copycatState = {};       // copycatName -> { chosenPlayer, actionReady }
  players.forEach(p => room.notepads[p] = '');

  // Assign Executioner targets (random living non-executioner player)
  players.forEach(p => {
    if (room.roles[p] === 'Executioner') {
      const pool = players.filter(t => t !== p && room.roles[t] !== 'Executioner');
      room.executionerTargets[p] = pool[Math.floor(Math.random() * pool.length)];
    }
    if (room.roles[p] === 'Copycat') {
      room.copycatState[p] = { chosenPlayer: null, actionReady: false };
    }
  });

  // Send each player their role
  room.clients.forEach(({ ws, name }) => {
    const role = room.roles[name];
    let extra = null;
    if (role === 'Ally' || role === 'Werewolf') {
      const wolves = players.filter(p => room.roles[p] === 'Werewolf');
      extra = { wolves };
    }
    if (role === 'Executioner') {
      extra = { target: room.executionerTargets[name] };
    }
    sendTo(ws, { type: 'game_start', role, extra, players });
  });

  broadcastAll(room, { type: 'phase', phase: 'role_reveal' });
}

function startNight(room) {
  room.phase = 'night';
  room.wolfVotes = {};
  room.doctorChoice = null;
  room.nightActionsComplete = {};
  room.skippedTurn = Object.assign({}, room.pendingSkip);
  room.pendingSkip = {};

  // Tell each player their night action
  const players = room.clients.map(c => c.name);
  room.clients.forEach(({ ws, name }) => {
    if (!room.alive[name]) {
      sendTo(ws, { type: 'night_action', action: 'dead', ghostChat: room.ghostChat });
      return;
    }
    // Check skip first — if skipped, send only the skipped message and nothing else
    if (room.skippedTurn[name]) {
      delete room.skippedTurn[name];
      sendTo(ws, { type: 'night_action', action: 'skipped' });
      return;
    }

    const role = room.roles[name];
    if (role === 'Werewolf') {
      const targets = players.filter(p => room.alive[p] && !isEvil(room.roles[p]));
      // allies = other evil players + Ally role players
      const allies = players.filter(p => room.alive[p] && p !== name && (isEvil(room.roles[p]) || room.roles[p] === 'Ally'));
      sendTo(ws, { type: 'night_action', action: 'wolf', targets, allies });
    } else if (role === 'Arsonist') {
      const targets = players.filter(p => room.alive[p]);
      const allies = players.filter(p => room.alive[p] && (room.roles[p] === 'Werewolf'));
      sendTo(ws, { type: 'night_action', action: 'arsonist', targets, allies, dousedPlayer: room.dousedPlayer });
    } else if (role === 'Ally') {
      const wolves = players.filter(p => room.alive[p] && room.roles[p] === 'Werewolf');
      sendTo(ws, { type: 'night_action', action: 'ally', wolves });
    } else if (role === 'Detective') {
      const targets = players.filter(p => p !== name && room.alive[p]);
      sendTo(ws, { type: 'night_action', action: 'detective', targets });
    } else if (role === 'Doctor') {
      const targets = players.filter(p => room.alive[p]);
      sendTo(ws, { type: 'night_action', action: 'doctor', targets });
    } else if (role === 'Time Keeper') {
      const targets = players.filter(p => p !== name && room.alive[p]);
      sendTo(ws, { type: 'night_action', action: 'timekeeper', targets });
    } else if (role === 'Medium') {
      sendTo(ws, { type: 'night_action', action: 'medium', deceased: room.deceased, ghostChat: room.ghostChat });
    } else if (role === 'Executioner') {
      // Executioner has no night action — just remind them of their target
      const target = room.executionerTargets[name];
      sendTo(ws, { type: 'night_action', action: 'executioner', target });
    } else if (role === 'Copycat') {
      const state = room.copycatState[name];
      if (!state.chosenPlayer) {
        // Night 1 (or hasn't chosen yet): pick a player to copy
        const targets = players.filter(p => p !== name && room.alive[p]);
        sendTo(ws, { type: 'night_action', action: 'copycat_pick', targets });
      } else if (state.actionReady) {
        // Night 2+: perform the stolen action
        const copiedRole = room.roles[state.chosenPlayer];
        if (isEvil(copiedRole) || copiedRole === 'Ally') {
          // Evil target — tell them it was a villager, give no action
          sendTo(ws, { type: 'night_action', action: 'copycat_blocked', chosenPlayer: state.chosenPlayer });
        } else {
          // Perform the copied role's action
          const actionTargets = players.filter(p => p !== name && room.alive[p]);
          sendTo(ws, { type: 'night_action', action: 'copycat_act', copiedRole, targets: actionTargets });
        }
      } else {
        // Waiting for action to become ready (shouldn't normally happen)
        sendTo(ws, { type: 'night_action', action: 'villager' });
      }
    } else {
      // Villager, King Tez, Jester, Hunter, and any other roles with no night action
      sendTo(ws, { type: 'night_action', action: 'villager' });
    }
  });
}

function checkAllNightDone(room) {
  const activePlayers = room.clients.filter(c => room.alive[c.name]);
  return activePlayers.every(c => room.nightActionsComplete[c.name]);
}

function resolveNight(room) {
  const votes = Object.values(room.wolfVotes);
  let victim = null;
  if (votes.length > 0) {
    const counts = {};
    votes.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const max = Math.max(...Object.values(counts));
    const leaders = Object.keys(counts).filter(p => counts[p] === max);
    victim = leaders[Math.floor(Math.random() * leaders.length)];
  }

  let msgs = [];
  if (!victim) {
    msgs.push('No one was attacked by the Werewolves.');
  } else if (victim === room.doctorChoice) {
    msgs.push(`${victim} was attacked but saved by the Doctor.`);
  } else {
    markDeadRoom(room, victim);
    msgs.push(`${victim} was killed during the night.`);
    // If victim was an Executioner's target, convert that Executioner to Jester
    Object.entries(room.executionerTargets).forEach(([exec, target]) => {
      if (target === victim && room.alive[exec]) {
        room.roles[exec] = 'Jester';
        delete room.executionerTargets[exec];
        const execWs = room.clients.find(c => c.name === exec)?.ws;
        if (execWs) sendTo(execWs, { type: 'role_changed', newRole: 'Jester', reason: 'Your target died at night — you are now a Jester!' });
      }
    });
  }

  let burnMsg = null;
  if (room.dousedNextMorning && room.dousedPlayer && room.arsonistAlive) {
    if (room.alive[room.dousedPlayer]) {
      markDeadRoom(room, room.dousedPlayer);
      burnMsg = `🔥 ${room.dousedPlayer} burned to death!`;
    }
    room.dousedPlayer = null;
    room.dousedNextMorning = false;
  } else if (room.dousedPlayer && room.arsonistAlive) {
    room.dousedNextMorning = true;
    burnMsg = `🔥 ${room.dousedPlayer} smells like gasoline...`;
  }

  room.doctorChoice = null;

  if (checkWinRoom(room)) return;

  // Collect notepads of players who just died this night (for reveal)
  const deceasedNotepads = {};
  room.deceased.forEach(d => {
    if (room.notepads[d.name]) deceasedNotepads[d.name] = room.notepads[d.name];
  });

  broadcastAll(room, {
    type: 'morning',
    messages: msgs,
    burnMsg,
    alive: room.alive,
    deceased: room.deceased,
    deceasedNotepads
  });
  room.phase = 'morning';
}

function markDeadRoom(room, p) {
  if (room.alive[p]) {
    room.alive[p] = false;
    room.deceased.push({ name: p, role: room.roles[p] });
  }
}

function checkWinRoom(room) {
  const players = room.clients.map(c => c.name);
  const living = players.filter(p => room.alive[p]);
  const evilAlive = living.filter(p => isEvil(room.roles[p]));
  const goodAlive = living.filter(p => !isEvil(room.roles[p]));

  if (evilAlive.length > 0 && evilAlive.length >= goodAlive.length) {
    endGame(room, 'evil'); return true;
  }
  if (evilAlive.length === 0) {
    endGame(room, 'good'); return true;
  }
  return false;
}

function endGame(room, winner, winnerName = null) {
  room.phase = 'ended';
  broadcastAll(room, {
    type: 'game_end',
    winner,
    winnerName,
    roles: room.roles,
    alive: room.alive,
    jesterVotedOut: room.jesterVotedOut,
    executionerTargets: room.executionerTargets
  });
}

function startVoting(room) {
  room.phase = 'voting';
  room.dayVotes = {};
  const living = room.clients.map(c => c.name).filter(p => room.alive[p]);
  broadcastAll(room, { type: 'phase', phase: 'voting', living, duration: 120 });
}

function resolveVoting(room) {
  const votes = Object.values(room.dayVotes);
  const living = room.clients.map(c => c.name).filter(p => room.alive[p]);

  if (votes.length === 0) {
    broadcastAll(room, { type: 'vote_result', eliminated: null, skipped: true });
    return;
  }

  const counts = {};
  votes.forEach(v => counts[v] = (counts[v] || 0) + 1);

  // If 'skip' gets strict majority of living players, skip the vote
  const skipCount = counts['skip'] || 0;
  if (skipCount > living.length / 2) {
    broadcastAll(room, { type: 'vote_result', eliminated: null, skipped: true, skipVotes: skipCount, total: living.length });
    return;
  }

  // Remove skip from player vote counts before finding the leader
  delete counts['skip'];
  if (Object.keys(counts).length === 0) {
    broadcastAll(room, { type: 'vote_result', eliminated: null, skipped: true });
    return;
  }

  const max = Math.max(...Object.values(counts));
  const leaders = Object.keys(counts).filter(p => counts[p] === max);
  // Tie = no elimination
  if (leaders.length > 1) {
    broadcastAll(room, { type: 'vote_result', eliminated: null, tied: true, counts });
    return;
  }
  const eliminated = leaders[0];
  markDeadRoom(room, eliminated);

  if (room.roles[eliminated] === 'Arsonist') {
    room.arsonistAlive = false;
    room.dousedPlayer = null;
    room.dousedNextMorning = false;
  }
  if (room.roles[eliminated] === 'Jester') {
    room.jesterVotedOut = true;
    endGame(room, 'jester');
    return;
  }

  // Check if any Executioner's target was just voted out
  const executionerWinner = Object.entries(room.executionerTargets)
    .find(([exec, target]) => target === eliminated && room.alive[exec]);
  if (executionerWinner) {
    const [execName] = executionerWinner;
    endGame(room, 'executioner', execName);
    return;
  }

  broadcastAll(room, {
    type: 'vote_result',
    eliminated,
    role: room.roles[eliminated],
    counts,
    alive: room.alive,
    deceasedNotepads: { [eliminated]: room.notepads[eliminated] || '' }
  });

  if (checkWinRoom(room)) return;

  // If hunter, they get to shoot
  if (room.roles[eliminated] === 'Hunter') {
    const targets = room.clients.map(c => c.name).filter(p => room.alive[p]);
    const hunterWs = room.clients.find(c => c.name === eliminated)?.ws;
    if (hunterWs) sendTo(hunterWs, { type: 'hunter_shoot', targets });
    room.phase = 'hunter';
    return;
  }
}

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerName = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const code = generateCode();
      rooms[code] = {
        code,
        hostName: msg.name,
        gameMode: msg.gameMode || 'custom',
        roleConfig: msg.roleConfig || { Werewolf: 2, Detective: 1 },
        clients: [],
        phase: 'lobby',
        roles: {}, alive: {}, deceased: [],
        wolfVotes: {}, doctorChoice: null,
        dousedPlayer: null, dousedNextMorning: false,
        arsonistAlive: true, jesterVotedOut: false,
        pendingSkip: {}, skippedTurn: {},
        nightActionsComplete: {}, dayVotes: {},
        notepads: {},
        ghostChat: [],
        executionerTargets: {},
        copycatState: {},
        dayTimer: null
      };
      playerRoom = rooms[code];
      playerName = msg.name;
      playerRoom.clients.push({ ws, name: msg.name });
      sendTo(ws, { type: 'room_created', code });
      broadcastAll(playerRoom, getLobbyState(playerRoom));
    }

    else if (msg.type === 'join_room') {
      const room = rooms[msg.code];
      if (!room) { sendTo(ws, { type: 'error', message: 'Room not found.' }); return; }
      if (room.phase !== 'lobby') { sendTo(ws, { type: 'error', message: 'Game already started.' }); return; }
      if (room.clients.find(c => c.name === msg.name)) {
        sendTo(ws, { type: 'error', message: 'Name already taken in this room.' }); return;
      }
      playerRoom = room;
      playerName = msg.name;
      room.clients.push({ ws, name: msg.name });
      room.notepads[msg.name] = '';
      sendTo(ws, { type: 'room_joined', code: msg.code, hostName: room.hostName });
      broadcastAll(room, getLobbyState(room));
    }

    else if (msg.type === 'start_game') {
      if (!playerRoom || playerName !== playerRoom.hostName) return;
      if (playerRoom.clients.length < 3) {
        sendTo(ws, { type: 'error', message: 'Need at least 3 players.' }); return;
      }
      startGame(playerRoom);
    }

    else if (msg.type === 'role_seen') {
      if (!playerRoom) return;
      // All players confirm they've seen their role, then start night
      playerRoom.nightActionsComplete[playerName] = true;
      if (playerRoom.clients.every(c => playerRoom.nightActionsComplete[c.name])) {
        playerRoom.nightActionsComplete = {};
        startNight(playerRoom);
      }
    }

    else if (msg.type === 'night_done') {
      if (!playerRoom) return;
      // Process the night action result
      if (msg.action === 'wolf') {
        playerRoom.wolfVotes[playerName] = msg.target;
      } else if (msg.action === 'arsonist') {
        if (msg.target) playerRoom.dousedPlayer = msg.target;
      } else if (msg.action === 'doctor') {
        playerRoom.doctorChoice = msg.target;
      } else if (msg.action === 'timekeeper') {
        if (msg.target) playerRoom.pendingSkip[msg.target] = true;
      } else if (msg.action === 'detective') {
        // Send result only to detective
        if (msg.target) {
          const role = playerRoom.roles[msg.target];
          const result = (role === 'Villager' || role === 'Ally') ? 'a Villager' : 'NOT a Villager';
          sendTo(ws, { type: 'detective_result', target: msg.target, result });
          return; // don't mark done yet — client sends night_done again after seeing result
        }
      } else if (msg.action === 'copycat_pick') {
        // Copycat has chosen who to copy — store it, action fires next night
        if (msg.target && playerRoom.copycatState[playerName]) {
          playerRoom.copycatState[playerName].chosenPlayer = msg.target;
          playerRoom.copycatState[playerName].actionReady = true;
        }
      } else if (msg.action === 'copycat_act') {
        // Copycat is executing the stolen role action
        if (playerRoom.copycatState[playerName]) {
          const copiedRole = playerRoom.roles[playerRoom.copycatState[playerName].chosenPlayer];
          // Apply the effect of the copied role
          if (copiedRole === 'Doctor') {
            playerRoom.doctorChoice = msg.target;
          } else if (copiedRole === 'Time Keeper') {
            if (msg.target) playerRoom.pendingSkip[msg.target] = true;
          } else if (copiedRole === 'Detective') {
            if (msg.target) {
              const targetRole = playerRoom.roles[msg.target];
              const result = (targetRole === 'Villager' || targetRole === 'Ally') ? 'a Villager' : 'NOT a Villager';
              sendTo(ws, { type: 'detective_result', target: msg.target, result });
              return; // wait for copycat to confirm result like detective does
            }
          }
          // Reset copycat so they pick again next night
          playerRoom.copycatState[playerName] = { chosenPlayer: null, actionReady: false };
        }
      }
      playerRoom.nightActionsComplete[playerName] = true;
      if (checkAllNightDone(playerRoom)) {
        resolveNight(playerRoom);
      }
    }

    else if (msg.type === 'morning_continue') {
      if (!playerRoom || playerName !== playerRoom.hostName) return;
      startVoting(playerRoom);
    }

    else if (msg.type === 'submit_vote') {
      if (!playerRoom || playerRoom.phase !== 'voting') return;
      if (!playerRoom.alive[playerName]) return;
      // 'skip' is a valid target alongside player names
      playerRoom.dayVotes[playerName] = msg.target;
      broadcastAll(playerRoom, {
        type: 'vote_update',
        voter: playerName,
        votedFor: msg.target,
        count: Object.keys(playerRoom.dayVotes).length,
        total: Object.keys(playerRoom.alive).filter(p => playerRoom.alive[p]).length
      });
      // Resolve immediately if all living players have voted
      const living = playerRoom.clients.map(c => c.name).filter(p => playerRoom.alive[p]);
      if (living.every(p => playerRoom.dayVotes[p])) {
        if (playerRoom.dayTimer) clearTimeout(playerRoom.dayTimer);
        resolveVoting(playerRoom);
      }
    }

    else if (msg.type === 'vote_timeout') {
      if (!playerRoom || playerName !== playerRoom.hostName) return;
      resolveVoting(playerRoom);
    }

    else if (msg.type === 'hunter_pick') {
      if (!playerRoom) return;
      const target = msg.target;
      if (isEvil(playerRoom.roles[target])) {
        markDeadRoom(playerRoom, target);
        if (playerRoom.roles[target] === 'Arsonist') {
          playerRoom.arsonistAlive = false;
          playerRoom.dousedPlayer = null;
        }
      }
      broadcastAll(playerRoom, {
        type: 'hunter_result',
        hunter: playerName,
        target,
        targetRole: playerRoom.roles[target],
        alive: playerRoom.alive
      });
      if (!checkWinRoom(playerRoom)) startNight(playerRoom);
    }

    else if (msg.type === 'vote_result_continue') {
      if (!playerRoom || playerName !== playerRoom.hostName) return;
      startNight(playerRoom);
    }

    else if (msg.type === 'save_notepad') {
      if (!playerRoom) return;
      playerRoom.notepads[playerName] = msg.text;
      sendTo(ws, { type: 'notepad_saved' });
    }

    else if (msg.type === 'ghost_chat') {
      if (!playerRoom) return;
      const role = playerRoom.roles[playerName];
      const isDead = !playerRoom.alive[playerName];
      const isMediumAtNight = role === 'Medium' && playerRoom.phase === 'night';
      if (!isDead && !isMediumAtNight) return; // only ghosts and medium at night can chat
      const entry = { name: playerName, text: msg.text, time: Date.now(), isMedium: role === 'Medium' };
      playerRoom.ghostChat.push(entry);
      // Send to all dead players and the medium (if night)
      playerRoom.clients.forEach(({ ws: cws, name: cname }) => {
        const cRole = playerRoom.roles[cname];
        const canSee = !playerRoom.alive[cname] || (cRole === 'Medium' && playerRoom.phase === 'night');
        if (canSee) sendTo(cws, { type: 'ghost_chat_msg', entry });
      });
    }

    else if (msg.type === 'update_room_config') {
      if (!playerRoom || playerName !== playerRoom.hostName) return;
      playerRoom.gameMode = msg.gameMode || playerRoom.gameMode;
      if (msg.roleConfig) playerRoom.roleConfig = msg.roleConfig;
      broadcastAll(playerRoom, getLobbyState(playerRoom));
    }

    else if (msg.type === 'play_again') {
      if (!playerRoom || playerName !== playerRoom.hostName) return;
      // Reset room to lobby state, keep all currently connected clients
      playerRoom.phase = 'lobby';
      playerRoom.roles = {}; playerRoom.alive = {}; playerRoom.deceased = [];
      playerRoom.wolfVotes = {}; playerRoom.doctorChoice = null;
      playerRoom.dousedPlayer = null; playerRoom.dousedNextMorning = false;
      playerRoom.arsonistAlive = true; playerRoom.jesterVotedOut = false;
      playerRoom.pendingSkip = {}; playerRoom.skippedTurn = {};
      playerRoom.nightActionsComplete = {}; playerRoom.dayVotes = {};
      playerRoom.ghostChat = [];
      playerRoom.notepads = {};
      playerRoom.executionerTargets = {};
      playerRoom.copycatState = {};
      playerRoom.clients.forEach(c => { playerRoom.notepads[c.name] = ''; });
      broadcastAll(playerRoom, { type: 'play_again' });
      broadcastAll(playerRoom, getLobbyState(playerRoom));
    }
  });

  ws.on('close', () => {
    if (!playerRoom) return;
    const room = playerRoom;
    const name = playerName;

    room.clients = room.clients.filter(c => c.ws !== ws);

    if (room.clients.length === 0) {
      delete rooms[room.code];
      return;
    }

    // In lobby: transfer host if needed, update lobby
    if (room.phase === 'lobby') {
      if (name === room.hostName) room.hostName = room.clients[0].name;
      broadcastAll(room, getLobbyState(room));
      return;
    }

    // In game: eliminate disconnected player, keep game going
    if (room.phase !== 'ended') {
      broadcastAll(room, { type: 'player_left', name, eliminated: true });
      if (room.alive && room.alive[name]) {
        markDeadRoom(room, name);
        // Mark done for night phase so the night can still resolve
        if (room.phase === 'night') {
          room.nightActionsComplete[name] = true;
          if (checkAllNightDone(room)) resolveNight(room);
          return;
        }
        // Remove their pending vote slot
        if (room.phase === 'voting') {
          delete room.dayVotes[name];
          const living = room.clients.map(c => c.name).filter(p => room.alive[p]);
          if (living.length > 0 && living.every(p => room.dayVotes[p])) {
            if (room.dayTimer) clearTimeout(room.dayTimer);
            resolveVoting(room);
          }
          return;
        }
        checkWinRoom(room);
      }
      // If disconnected player was host mid-game, transfer host
      if (name === room.hostName && room.clients.length > 0) {
        room.hostName = room.clients[0].name;
        broadcastAll(room, { type: 'host_changed', newHost: room.hostName });
      }
    }
  });
});

console.log('Werewolf server running on port', process.env.PORT || 8080);
