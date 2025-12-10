// server.js - 낭만의 땅 MUD
// - 기본 강타 스킬(smash)
// - 직업별 회피율
// - 몬스터(PvE) 전투
// - 결투(PvP) + 스킬 전체(버프/디버프/슬로우/회피/DoT/공격/힐/소매치기) 적용

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

// ───────────────────────────────────────
// 설정 및 파일 경로
// ───────────────────────────────────────
const PORT = 4000;

const DATA_DIR = path.join(__dirname, 'DAT');
const GDAT_DIR = path.join(DATA_DIR, 'gdat');

const USER_FILE = path.join(DATA_DIR, 'user.json');
const JOB_FILE = path.join(GDAT_DIR, 'job.json');
const SKILL_FILE = path.join(GDAT_DIR, 'skilllist.json');
const DUNGEON_FILE = path.join(GDAT_DIR, 'dungeons.json');
const LOBBY_FILE = path.join(GDAT_DIR, 'lobby.json');
const NPC_FILE = path.join(GDAT_DIR, 'npc.json');
const MONSTER_FILE = path.join(GDAT_DIR, 'monsters.json');
const ITEM_FILE = path.join(GDAT_DIR, 'items.json');
const GEOMAP_FILE = path.join(GDAT_DIR, 'geomap.json');

// 기본 제공 스킬: 강타
const DEFAULT_SKILL_ID = 'smash';

// 직업별 기본 회피률(0~1)
const jobEvasionTable = {
  novice: 0.03,
  warrior: 0.05,
  mage: 0.06,
  priest: 0.07,
  rogue: 0.15,
  bard: 0.10,
  admin: 0.20
};

function getJobEvasionChance(jobId) {
  return jobEvasionTable[jobId] ?? 0.03;
}

// ★ PvP용 전역 상태
// 로그인한 유저 이름 -> socket
const socketsByName = new Map();
// 결투 신청: key = "신청 받은 사람", value = "신청 보낸 사람"
const duelRequests = new Map();

// ───────────────────────────────────────
// 유틸: JSON 읽기/쓰기
// ───────────────────────────────────────
function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, 'utf8');
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch (e) {
    console.error('safeReadJson error', file, e);
    return fallback;
  }
}

function safeWriteJson(file, data) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('safeWriteJson error', file, e);
  }
}

// ───────────────────────────────────────
// 데이터 로딩
// ───────────────────────────────────────
let users = safeReadJson(USER_FILE, {}); // username -> userData
let jobs = safeReadJson(JOB_FILE, []);
let skills = safeReadJson(SKILL_FILE, []);
let dungeons = safeReadJson(DUNGEON_FILE, []);
let lobby = safeReadJson(LOBBY_FILE, { startMap: 'plaza', maps: [] });
let npcs = safeReadJson(NPC_FILE, []);
let monsters = safeReadJson(MONSTER_FILE, []);
let items = safeReadJson(ITEM_FILE, []);
let geomaps = safeReadJson(GEOMAP_FILE, {});

function saveUsers() {
  safeWriteJson(USER_FILE, users);
}

// 모든 유저에게 기본 스킬 강타 존재 보장
function ensureBaseSkills(user) {
  if (!user.skills) user.skills = [];
  if (!user.skills.includes(DEFAULT_SKILL_ID)) {
    user.skills.push(DEFAULT_SKILL_ID);
  }
}

// 서버 시작 시 전체 유저에 대해 마이그레이션
Object.values(users).forEach(ensureBaseSkills);
saveUsers();

// ───────────────────────────────────────
// 게임 데이터 헬퍼
// ───────────────────────────────────────
function getStartMapId() {
  return lobby.startMap || 'plaza';
}
function getMapById(id) {
  return lobby.maps.find(m => m.id === id) || null;
}
function getDungeonForMap(mapId) {
  return dungeons.find(d => d.mapId === mapId) || null;
}
function getMonsterById(id) {
  return monsters.find(m => m.id === id) || null;
}
function getJobById(id) {
  return jobs.find(j => j.id === id) || null;
}
function getSkillById(id) {
  return skills.find(s => s.id === id) || null;
}
function getItemById(id) {
  return items.find(i => i.id === id) || null;
}
function getGeomap(mapId) {
  return geomaps[mapId] || null;
}

function isWalkableCell(mapId, x, y) {
  const g = getGeomap(mapId);
  if (!g || !g.grid || g.grid.length === 0) return true;
  const height = g.grid.length;
  const width = g.grid[0].length;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (y < 0 || y >= height) return false;
  if (x < 0 || x >= width) return false;
  const ch = g.grid[y][x];
  if (ch === '#') return false;
  return true;
}

function getSpawnForMap(mapId) {
  const g = getGeomap(mapId);
  if (!g || !g.spawn) return { x: 1, y: 1 };
  return { x: g.spawn.x, y: g.spawn.y };
}

// 맵별 필드 몬스터 인스턴스
const mapMonsters = new Map(); // mapId -> [inst...]
let monsterInstanceSeq = 1;

function getPlayersInMap(mapId) {
  const arr = [];
  for (const [name, u] of Object.entries(users)) {
    if (u.location === mapId) {
      arr.push({ id: name, user: u });
    }
  }
  return arr;
}
function getNpcsInMapWithPos(mapId) {
  return npcs.filter(n => n.mapId === mapId && typeof n.x === 'number' && typeof n.y === 'number');
}
function getMonstersInMap(mapId) {
  return mapMonsters.get(mapId) || [];
}

// ───────────────────────────────────────
// 몬스터 스폰
// ───────────────────────────────────────
function spawnRandomMonster(mapId) {
  const dungeon = getDungeonForMap(mapId);
  if (!dungeon || !dungeon.monsters || dungeon.monsters.length === 0) return null;
  const g = getGeomap(mapId);
  if (!g || !g.grid || g.grid.length === 0) return null;

  const height = g.grid.length;
  const width = g.grid[0].length;

  let totalRate = 0;
  dungeon.monsters.forEach(m => (totalRate += m.rate || 1));
  let r = Math.random() * totalRate;
  let chosen = dungeon.monsters[0];
  for (const m of dungeon.monsters) {
    r -= m.rate || 1;
    if (r <= 0) {
      chosen = m;
      break;
    }
  }

  const base = getMonsterById(chosen.id);
  if (!base) return null;

  const playersHere = getPlayersInMap(mapId);
  const npcsHere = getNpcsInMapWithPos(mapId);
  const monstersHere = getMonstersInMap(mapId);

  function isFree(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    if (!isWalkableCell(mapId, x, y)) return false;
    if (playersHere.some(p => p.user.posX === x && p.user.posY === y)) return false;
    if (npcsHere.some(n => n.x === x && n.y === y)) return false;
    if (monstersHere.some(m => m.x === x && m.y === y)) return false;
    return true;
  }

  let x = 0,
    y = 0,
    tries = 100;
  while (tries-- > 0) {
    x = Math.floor(Math.random() * width);
    y = Math.floor(Math.random() * height);
    if (isFree(x, y)) break;
  }
  if (!isFree(x, y)) return null;

  const inst = {
    instanceId: monsterInstanceSeq++,
    monsterId: base.id,
    name: base.name,
    x,
    y,
    hp: base.baseHp,
    maxHp: base.baseHp,
    attack: base.attack,
    exp: base.exp,
    goldMin: base.goldMin,
    goldMax: base.goldMax,
    dropItems: base.dropItems || []
  };

  monstersHere.push(inst);
  mapMonsters.set(mapId, monstersHere);
  return inst;
}

function ensureMonstersForMap(mapId) {
  const dungeon = getDungeonForMap(mapId);
  if (!dungeon) return;
  const maxCount = dungeon.maxMonsters || 6;
  const list = getMonstersInMap(mapId);
  if (list.length >= maxCount) return;
  if (Math.random() < 0.4) spawnRandomMonster(mapId);
}

// ───────────────────────────────────────
// 서버/소켓 설정
// ───────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ───────────────────────────────────────
// 유저 생성/레벨업 헬퍼
// ───────────────────────────────────────
function createNewUser(name, password, jobId, isAdmin) {
  const startMap = getStartMapId();
  const spawn = getSpawnForMap(startMap);

  const user = {
    name,
    password,
    jobId,
    level: 1,
    exp: 0,
    hp: 100,
    maxHp: 100,
    mp: 30,
    maxMp: 30,
    gold: 0,
    location: startMap,
    posX: spawn.x,
    posY: spawn.y,
    skills: [],
    items: [],
    isAdmin: !!isAdmin,
    banned: false
  };
  ensureBaseSkills(user);
  return user;
}

function expToNextLevel(user) {
  return user.level * 20;
}

function autoLearnSkillsByLevel(user) {
  if (user.level % 100 !== 0) return;
  for (const sk of skills) {
    if (user.skills.includes(sk.id)) continue;
    const unlock = sk.unlock || {};
    if (unlock.requiredJob && unlock.requiredJob !== user.jobId) continue;
    const minLevel = unlock.minLevel || 0;
    if (user.level >= minLevel) {
      user.skills.push(sk.id);
    }
  }
}

function handleLevelUp(user, send) {
  let leveled = 0;
  while (user.exp >= expToNextLevel(user)) {
    user.exp -= expToNextLevel(user);
    user.level += 1;
    user.maxHp += 10;
    user.maxMp += 5;
    user.hp = user.maxHp;
    user.mp = user.maxMp;
    leveled++;
    autoLearnSkillsByLevel(user);
    ensureBaseSkills(user);
  }
  if (leveled > 0 && send) {
    send(`레벨이 ${leveled}번 상승하여 현재 레벨은 ${user.level} 입니다.`, 'lime');
  }
}

// ───────────────────────────────────────
// 맵 렌더링
// ───────────────────────────────────────
function ensureUserPosition(user) {
  if (!user.location) user.location = getStartMapId();
  if (typeof user.posX !== 'number' || typeof user.posY !== 'number') {
    const spawn = getSpawnForMap(user.location);
    user.posX = spawn.x;
    user.posY = spawn.y;
  }
}

function renderMapForUser(user, socket) {
  const mapId = user.location || getStartMapId();
  const g = getGeomap(mapId);
  if (!g || !g.grid || g.grid.length === 0) {
    socket.emit('console_output', { msg: '(이 맵에 대한 16x16 지도가 없습니다.)', color: 'gray' });
    return;
  }

  const height = g.grid.length;
  const width = g.grid[0].length;
  const gridChars = g.grid.map(row => row.split(''));

  const npcsHere = getNpcsInMapWithPos(mapId);
  const monstersHere = getMonstersInMap(mapId);
  const playersHere = getPlayersInMap(mapId);

  for (const n of npcsHere) {
    if (n.y >= 0 && n.y < height && n.x >= 0 && n.x < width) {
      gridChars[n.y][n.x] = 'N';
    }
  }
  for (const m of monstersHere) {
    if (m.y >= 0 && m.y < height && m.x >= 0 && m.x < width) {
      gridChars[m.y][m.x] = 'M';
    }
  }
  for (const p of playersHere) {
    const u = p.user;
    ensureUserPosition(u);
    const x = u.posX;
    const y = u.posY;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (u === user) {
      gridChars[y][x] = '@';
    } else {
      if (gridChars[y][x] === '@') continue;
      gridChars[y][x] = 'p';
    }
  }

  const lines = gridChars.map(row => row.join(''));
  const title = `=== ${g.name} (${mapId}) ===`;
  socket.emit('console_output', { msg: title, color: 'cyan' });
  socket.emit('console_output', { msg: lines.join('\n'), color: 'white' });
}

// ───────────────────────────────────────
// 전투/스킬 공용 로직 (PvE)
// ───────────────────────────────────────
function rollDamage(baseAttack, targetDefense) {
  const dmg = Math.max(1, baseAttack - Math.floor(targetDefense / 3));
  const variance = Math.floor(Math.random() * 4);
  return dmg + variance;
}

function applySkillEffectInPvE(user, combat, skill, targetName, send) {
  const eff = skill.effect || {};
  const monster = combat.monster;

  switch (eff.kind) {
    case 'heal': {
      let targetUser = user;
      if (targetName) {
        const other = Object.values(users).find(u => u.name === targetName);
        if (other) targetUser = other;
      }
      const amount = eff.value || 20;
      targetUser.hp = Math.min(targetUser.maxHp, targetUser.hp + amount);
      send(`${skill.effectText || skill.name} (HP +${amount})`, 'aqua');
      break;
    }
    case 'attack': {
      const dmg = eff.value || rollDamage(15, 0);
      monster.hp -= dmg;
      send(`${skill.effectText || skill.name} (적에게 ${dmg} 피해)`, 'orange');
      break;
    }
    case 'sacrificeAttack': {
      const hpCost = eff.hpCost || 10;
      user.hp = Math.max(1, user.hp - hpCost);
      const dmg = eff.value || 40;
      monster.hp -= dmg;
      send(`${skill.effectText || skill.name} (HP ${hpCost}을(를) 지불하고 ${dmg} 피해)`, 'red');
      break;
    }
    case 'buff': {
      combat.playerBuff = {
        attackModifier: eff.attackModifier || 0,
        defenseModifier: eff.defenseModifier || 0,
        turns: eff.durationTurns || 3
      };
      send(skill.effectText || skill.name, 'lightgreen');
      break;
    }
    case 'debuff': {
      combat.monsterDebuff = {
        attackModifier: eff.attackModifier || 0,
        defenseModifier: eff.defenseModifier || 0,
        turns: eff.durationTurns || 3
      };
      send(skill.effectText || skill.name, 'violet');
      break;
    }
    case 'overTime':
    case 'attackOverTime': {
      combat.monsterDot = {
        hpPerTick: eff.hpPerTick || 5,
        turns: eff.durationTurns || 3
      };
      send(skill.effectText || skill.name, 'orange');
      break;
    }
    case 'evasionBuff': {
      combat.playerEvasion = {
        chance: eff.evasionChance || 0.3,
        turns: eff.durationTurns || 2
      };
      send(skill.effectText || skill.name, 'lightblue');
      break;
    }
    case 'slowDebuff': {
      combat.monsterSlow = {
        skipChance: eff.skipTurnChance || 0.3,
        turns: eff.durationTurns || 2
      };
      send(skill.effectText || skill.name, 'lightblue');
      break;
    }
    case 'steal': {
      const amount = Math.floor(Math.random() * (eff.maxGold || 10));
      user.gold += amount;
      send(`${skill.effectText || skill.name} (골드 ${amount} 획득)`, 'gold');
      break;
    }
    default:
      send('이 스킬은 아직 구현되지 않았습니다.', 'yellow');
  }
}

// ───────────────────────────────────────
// 소켓 연결
// ───────────────────────────────────────
io.on('connection', socket => {
  let currentName = null;

  function getUser() {
    if (!currentName) return null;
    return users[currentName] || null;
  }

  function send(msg, color) {
    socket.emit('console_output', { msg, color });
  }

  function sendToUserByName(name, msg, color) {
    const s = socketsByName.get(name);
    if (s) {
      s.emit('console_output', { msg, color });
    }
  }

  // ───────────────────────────────────
  // PvP 도트/버프/슬로우 처리 헬퍼
  // ───────────────────────────────────
  function finishDuelWithWinner(winnerName, loserName, sendFromWinner) {
    const winner = users[winnerName];
    const loser = users[loserName];
    if (!winner || !loser) return;

    sendFromWinner(`${loserName} 와(과)의 결투에서 승리했습니다!`, 'lightgreen');
    sendToUserByName(loserName, `${winnerName} 와(과)의 결투에서 패배했습니다.`, 'red');

    const spawn = getSpawnForMap(getStartMapId());
    loser.location = getStartMapId();
    loser.posX = spawn.x;
    loser.posY = spawn.y;
    loser.hp = Math.floor(loser.maxHp * 0.7);

    if (loser.combat && loser.combat.type === 'pvp') {
      loser.combat = null;
    }
    if (winner.combat && winner.combat.type === 'pvp') {
      winner.combat = null;
    }
    saveUsers();
  }

  // 자기 턴 시작 시 적용되는 효과(PvP)
  function processPvPTurnStart(user, send) {
    const c = user.combat;
    if (!c || c.type !== 'pvp') return { ended: false };

    // 도트 데미지
    if (c.dot && c.dot.turns > 0) {
      const dmg = c.dot.hpPerTick || 0;
      if (dmg > 0) {
        user.hp -= dmg;
        send(`지속 피해로 ${dmg} 피해를 입었습니다. (HP ${Math.max(0, user.hp)}/${user.maxHp})`, 'orange');
      }
      c.dot.turns--;
      if (c.dot.turns <= 0) c.dot = null;

      // 도트로 죽으면 상대 승리
      if (user.hp <= 0) {
        const oppName = c.opponent;
        const opp = users[oppName];
        if (opp) {
          finishDuelWithWinner(
            oppName,
            user.name,
            (msg, color) => sendToUserByName(oppName, msg, color)
          );
        }
        return { ended: true };
      }
    }

    // 버프/디버프/회피 지속 턴 감소
    if (c.atkBuffTurns && c.atkBuffTurns > 0) {
      c.atkBuffTurns--;
      if (c.atkBuffTurns <= 0) c.atkBuff = 0;
    }
    if (c.defBuffTurns && c.defBuffTurns > 0) {
      c.defBuffTurns--;
      if (c.defBuffTurns <= 0) c.defBuff = 0;
    }
    if (c.evasionTurns && c.evasionTurns > 0) {
      c.evasionTurns--;
      if (c.evasionTurns <= 0) c.evasionBuff = 0;
    }

    return { ended: false };
  }

  // PvP용 스킬 처리
  function applySkillEffectInPvP(user, skill, send) {
    const eff = skill.effect || {};
    const c = user.combat;
    if (!c || c.type !== 'pvp') return { ended: false };

    const oppName = c.opponent;
    const opp = users[oppName];
    if (!opp) {
      send('상대가 더 이상 존재하지 않습니다. 결투를 종료합니다.', 'yellow');
      user.combat = null;
      saveUsers();
      return { ended: true };
    }
    const oppCombat = (opp.combat && opp.combat.type === 'pvp') ? opp.combat : null;

    switch (eff.kind) {
      case 'attack': {
        const atk = 15 + (c.atkBuff || 0);
        const def = oppCombat ? (oppCombat.defBuff || 0) : 0;
        const baseDmg = eff.value || rollDamage(atk, def);
        const dmg = Math.max(1, baseDmg);
        opp.hp -= dmg;
        send(
          `${skill.effectText || skill.name} (${oppName} 에게 ${dmg} 피해) (상대 HP ${Math.max(
            0,
            opp.hp
          )}/${opp.maxHp})`,
          'orange'
        );
        sendToUserByName(
          oppName,
          `${user.name} 이(가) ${skill.name} 을(를) 사용하여 ${dmg} 피해를 입혔습니다. (HP ${Math.max(
            0,
            opp.hp
          )}/${opp.maxHp})`,
          'red'
        );
        if (opp.hp <= 0) {
          finishDuelWithWinner(user.name, oppName, send);
          return { ended: true };
        }
        break;
      }
      case 'sacrificeAttack': {
        const hpCost = eff.hpCost || 10;
        const atk = 20 + (c.atkBuff || 0);
        const def = oppCombat ? (oppCombat.defBuff || 0) : 0;
        const baseDmg = eff.value || rollDamage(atk, def);
        const dmg = Math.max(1, baseDmg);

        user.hp = Math.max(1, user.hp - hpCost);
        opp.hp -= dmg;

        send(
          `${skill.effectText || skill.name} (HP ${hpCost}을(를) 지불하고 ${oppName} 에게 ${dmg} 피해)`,
          'red'
        );
        sendToUserByName(
          oppName,
          `${user.name} 이(가) ${skill.name} 을(를) 사용하여 ${dmg} 피해를 입혔습니다. (HP ${Math.max(
            0,
            opp.hp
          )}/${opp.maxHp})`,
          'red'
        );

        if (opp.hp <= 0) {
          finishDuelWithWinner(user.name, oppName, send);
          return { ended: true };
        }
        break;
      }
      case 'overTime':
      case 'attackOverTime': {
        if (!oppCombat) {
          send('상대 전투 상태가 올바르지 않습니다.', 'yellow');
          break;
        }
        const dot = {
          hpPerTick: eff.hpPerTick || 5,
          turns: eff.durationTurns || 3
        };
        oppCombat.dot = dot;
        send(`${skill.effectText || skill.name} (상대에게 지속 피해를 남겼습니다.)`, 'orange');
        sendToUserByName(
          oppName,
          `${user.name} 의 ${skill.name} 때문에 지속 피해를 입게 됩니다.`,
          'orange'
        );
        break;
      }
      case 'buff': {
        const atkMod = eff.attackModifier || 0;
        const defMod = eff.defenseModifier || 0;
        const dur = eff.durationTurns || 3;
        c.atkBuff = (c.atkBuff || 0) + atkMod;
        c.defBuff = (c.defBuff || 0) + defMod;
        c.atkBuffTurns = dur;
        c.defBuffTurns = dur;
        send(skill.effectText || skill.name, 'lightgreen');
        break;
      }
      case 'debuff': {
        if (!oppCombat) {
          send('상대 전투 상태가 올바르지 않습니다.', 'yellow');
          break;
        }
        const atkMod = eff.attackModifier || 0;
        const defMod = eff.defenseModifier || 0;
        const dur = eff.durationTurns || 3;
        oppCombat.atkBuff = (oppCombat.atkBuff || 0) + atkMod;
        oppCombat.defBuff = (oppCombat.defBuff || 0) + defMod;
        oppCombat.atkBuffTurns = dur;
        oppCombat.defBuffTurns = dur;
        send(skill.effectText || skill.name, 'violet');
        sendToUserByName(
          oppName,
          `${user.name} 의 스킬로 공격/방어 능력이 약화되었습니다.`,
          'violet'
        );
        break;
      }
      case 'evasionBuff': {
        const chance = eff.evasionChance || 0.3;
        const dur = eff.durationTurns || 2;
        c.evasionBuff = chance;
        c.evasionTurns = dur;
        send(skill.effectText || skill.name, 'lightblue');
        break;
      }
      case 'slowDebuff': {
        if (!oppCombat) {
          send('상대 전투 상태가 올바르지 않습니다.', 'yellow');
          break;
        }
        const sc = eff.skipTurnChance || 0.3;
        const dur = eff.durationTurns || 2;
        oppCombat.slow = { skipChance: sc, turns: dur };
        send(skill.effectText || skill.name, 'lightblue');
        sendToUserByName(
          oppName,
          `${user.name} 의 스킬로 몸이 무거워져 턴을 잃을 수 있습니다.`,
          'lightblue'
        );
        break;
      }
      case 'steal': {
        const maxGold = eff.maxGold || 10;
        const amount = Math.min(
          opp.gold,
          Math.floor(Math.random() * (maxGold + 1))
        );
        if (amount <= 0) {
          send('훔칠 골드가 없습니다.', 'yellow');
        } else {
          opp.gold -= amount;
          user.gold += amount;
          send(`${skill.effectText || skill.name} (상대 골드 ${amount} 을(를) 훔쳤습니다.)`, 'gold');
          sendToUserByName(
            oppName,
            `${user.name} 에게 골드 ${amount} 을(를) 소매치기 당했습니다...`,
            'gold'
          );
        }
        break;
      }
      default:
        send('이 스킬 효과는 아직 결투에서 구현되지 않았습니다.', 'yellow');
    }

    saveUsers();
    return { ended: false };
  }

  // 위치 설명 + 맵 출력
  function describeLocation() {
    const user = getUser();
    if (!user) return;
    const mapId = user.location || getStartMapId();
    const map = getMapById(mapId);
    if (!map) {
      send('어딘지 알 수 없는 공간에 서 있습니다. (맵 설정 오류)', 'red');
      return;
    }
    const lines = [];
    lines.push(`=== ${map.name} (${map.id}) ===`);
    if (map.description) lines.push(map.description);
    lines.push('');
    send(lines.join('\n'), 'cyan');

    ensureUserPosition(user);
    ensureMonstersForMap(mapId);
    renderMapForUser(user, socket);
  }

  // 맵 이동
  function enterMap(mapId, silent = false) {
    const user = getUser();
    if (!user) return;
    const map = getMapById(mapId);
    if (!map) {
      send('그런 장소는 존재하지 않습니다.', 'red');
      return;
    }
    if (user.location) socket.leave(`map:${user.location}`);
    user.location = mapId;
    socket.join(`map:${mapId}`);
    ensureUserPosition(user);
    ensureMonstersForMap(mapId);
    saveUsers();
    if (!silent) describeLocation();
  }

  // 여기 있는 것들 보기
  function hereCommand() {
    const user = getUser();
    if (!user) return;
    const mapId = user.location || getStartMapId();
    const g = getGeomap(mapId);

    const playersHere = getPlayersInMap(mapId);
    const npcsHere = getNpcsInMapWithPos(mapId);
    const monstersHere = getMonstersInMap(mapId);

    const lines = [];
    lines.push(`=== 이 맵에 있는 존재들 (${g ? g.name : mapId}) ===`);

    if (playersHere.length === 0) {
      lines.push('- 플레이어: 없음');
    } else {
      lines.push('- 플레이어:');
      playersHere.forEach(p => {
        const u = p.user;
        ensureUserPosition(u);
        lines.push(`  · ${u.name} (x=${u.posX}, y=${u.posY})${u === user ? ' <- 나' : ''}`);
      });
    }

    if (npcsHere.length === 0) {
      lines.push('- NPC: 없음');
    } else {
      lines.push('- NPC:');
      npcsHere.forEach(n => {
        const t = n.type === 'shop' ? '상인' : 'NPC';
        lines.push(`  · [${t}] ${n.name} (${n.id}) (x=${n.x}, y=${n.y})`);
      });
    }

    if (monstersHere.length === 0) {
      lines.push('- 몬스터: 없음');
    } else {
      lines.push('- 몬스터:');
      monstersHere.forEach(m => {
        lines.push(`  · ${m.name} (x=${m.x}, y=${m.y})`);
      });
    }

    send(lines.join('\n'), 'silver');
  }

  // 걷기
  function walkCommand(args) {
    const user = getUser();
    if (!user) return;

    if (user.combat && user.combat.type === 'pve') {
      send('전투 중에는 자유롭게 이동할 수 없습니다.', 'yellow');
      return;
    }

    if (args.length === 0) {
      send('사용법: /walk up|down|left|right 또는 /walk w|s|a|d', 'yellow');
      return;
    }

    ensureUserPosition(user);
    const dir = args[0].toLowerCase();
    let dx = 0,
      dy = 0;
    if (dir === 'up' || dir === 'w') dy = -1;
    else if (dir === 'down' || dir === 's') dy = 1;
    else if (dir === 'left' || dir === 'a') dx = -1;
    else if (dir === 'right' || dir === 'd') dx = 1;
    else {
      send('방향은 up/down/left/right 또는 w/s/a/d 중 하나여야 합니다.', 'yellow');
      return;
    }

    const mapId = user.location || getStartMapId();
    const nx = user.posX + dx;
    const ny = user.posY + dy;
    if (!isWalkableCell(mapId, nx, ny)) {
      send('그 방향으로는 더 이상 나아갈 수 없습니다.', 'yellow');
      return;
    }

    user.posX = nx;
    user.posY = ny;

    ensureMonstersForMap(mapId);

    let monstersHere = getMonstersInMap(mapId);
    const hitIndex = monstersHere.findIndex(m => m.x === nx && m.y === ny);
    if (hitIndex >= 0) {
      const inst = monstersHere[hitIndex];
      monstersHere.splice(hitIndex, 1);
      mapMonsters.set(mapId, monstersHere);

      user.combat = {
        type: 'pve',
        monster: {
          id: inst.monsterId,
          name: inst.name,
          hp: inst.hp,
          maxHp: inst.maxHp,
          attack: inst.attack,
          exp: inst.exp,
          goldMin: inst.goldMin,
          goldMax: inst.goldMax,
          dropItems: inst.dropItems || []
        },
        turn: 'player',
        playerBuff: null,
        monsterDebuff: null,
        monsterDot: null,
        playerEvasion: null,
        monsterSlow: null
      };
      send(`당신은 ${inst.name} 과(와) 조우했습니다!`, 'yellow');
      send(`HP: ${inst.hp} / ${inst.maxHp}`, 'yellow');
    }

    saveUsers();
    renderMapForUser(user, socket);
  }

  // 상태/스킬/인벤
  function showStats() {
    const u = getUser();
    if (!u) return;
    const lines = [];
    const job = getJobById(u.jobId);
    lines.push(`=== ${u.name} 의 상태 ===`);
    lines.push(`직업: ${job ? job.name : u.jobId}`);
    lines.push(`레벨: ${u.level} (EXP ${u.exp}/${expToNextLevel(u)})`);
    lines.push(`HP: ${u.hp}/${u.maxHp}  MP: ${u.mp}/${u.maxMp}`);
    lines.push(`골드: ${u.gold}`);
    lines.push(`기본 회피율: ${(getJobEvasionChance(u.jobId) * 100).toFixed(1)}%`);
    send(lines.join('\n'), 'lightgreen');
  }

  function showSkills() {
    const u = getUser();
    if (!u) return;
    if (!u.skills || u.skills.length === 0) {
      send('습득한 스킬이 없습니다.', 'yellow');
      return;
    }
    const lines = [];
    lines.push('=== 보유 스킬 ===');
    u.skills.forEach(id => {
      const s = getSkillById(id);
      if (!s) {
        lines.push(`- ${id} (정의되지 않은 스킬)`);
        return;
      }
      lines.push(`- ${s.id}: ${s.name}`);
    });
    send(lines.join('\n'), 'lightblue');
  }

  function showInventory() {
    const u = getUser();
    if (!u) return;
    const inv = u.items || [];
    if (inv.length === 0) {
      send('소지한 아이템이 없습니다.', 'yellow');
      return;
    }
    const lines = [];
    lines.push('=== 인벤토리 ===');
    inv.forEach(it => {
      const base = getItemById(it.id);
      const name = base ? base.name : it.id;
      lines.push(`- ${it.id} (${name}) x${it.qty}`);
    });
    send(lines.join('\n'), 'lightyellow');
  }

  // 아이템
  function addItemToUser(user, itemId, qty) {
    if (!user.items) user.items = [];
    let slot = user.items.find(i => i.id === itemId);
    if (!slot) {
      slot = { id: itemId, qty: 0 };
      user.items.push(slot);
    }
    slot.qty += qty;
    if (slot.qty <= 0) {
      user.items = user.items.filter(i => i.qty > 0);
    }
  }

  function useItemCommand(args) {
    const u = getUser();
    if (!u) return;
    if (args.length === 0) {
      send('사용법: /use 아이템ID', 'yellow');
      return;
    }
    const itemId = args[0];
    const slot = (u.items || []).find(i => i.id === itemId);
    if (!slot || slot.qty <= 0) {
      send('그런 아이템을 가지고 있지 않습니다.', 'yellow');
      return;
    }
    const base = getItemById(itemId);
    if (!base) {
      send('알 수 없는 아이템입니다.', 'yellow');
      return;
    }

    if (base.type === 'skillbook') {
      const skillId = base.skillId;
      if (!skillId) {
        send('이 스킬서는 아직 내용이 비어 있습니다.', 'yellow');
        return;
      }
      if (u.skills && u.skills.includes(skillId)) {
        send('이미 습득한 스킬입니다.', 'yellow');
        return;
      }
      u.skills.push(skillId);
      slot.qty -= 1;
      if (slot.qty <= 0) {
        u.items = u.items.filter(i => i.qty > 0);
      }
      const sk = getSkillById(skillId);
      send(`스킬 ${sk ? sk.name : skillId} 을(를) 습득했습니다.`, 'lightgreen');
      saveUsers();
      return;
    }

    if (base.type === 'consumable') {
      const heal = base.healAmount || 30;
      u.hp = Math.min(u.maxHp, u.hp + heal);
      slot.qty -= 1;
      if (slot.qty <= 0) {
        u.items = u.items.filter(i => i.qty > 0);
      }
      send(`${base.name} 을(를) 사용했습니다. HP가 ${heal} 회복됩니다.`, 'lightgreen');
      saveUsers();
      return;
    }

    send('이 아이템은 아직 특별한 사용 효과가 없습니다.', 'yellow');
  }

  function giveItemCommand(args) {
    const u = getUser();
    if (!u) return;
    if (args.length < 3) {
      send('사용법: /give 대상이름 아이템ID 수량', 'yellow');
      return;
    }
    const targetName = args[0];
    const itemId = args[1];
    const qty = parseInt(args[2], 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      send('수량은 1 이상의 숫자여야 합니다.', 'yellow');
      return;
    }
    const target = users[targetName];
    if (!target) {
      send('그런 유저는 존재하지 않습니다.', 'yellow');
      return;
    }
    const slot = (u.items || []).find(i => i.id === itemId);
    if (!slot || slot.qty < qty) {
      send('그만큼의 아이템을 가지고 있지 않습니다.', 'yellow');
      return;
    }
    slot.qty -= qty;
    if (slot.qty <= 0) {
      u.items = u.items.filter(i => i.qty > 0);
    }
    addItemToUser(target, itemId, qty);
    saveUsers();
    send(`${targetName} 에게 ${itemId} x${qty} 을(를) 건넸습니다.`, 'lightgreen');
  }

  // 공격 명령 (PvE + PvP)
  function attackCommand() {
    const u = getUser();
    if (!u) return;
    const combat = u.combat;
    if (!combat) {
      send('현재 전투 중이 아닙니다.', 'yellow');
      return;
    }

    // ───────────── PVE (몬스터) ─────────────
    if (combat.type === 'pve') {
      if (combat.turn !== 'player') {
        send('아직 당신의 턴이 아닙니다.', 'yellow');
        return;
      }

      let playerAtk = 15;
      let monsterDef = 0;

      if (combat.playerBuff) {
        playerAtk += combat.playerBuff.attackModifier || 0;
        combat.playerBuff.turns--;
        if (combat.playerBuff.turns <= 0) combat.playerBuff = null;
      }
      if (combat.monsterDebuff) {
        monsterDef += combat.monsterDebuff.defenseModifier || 0;
        combat.monsterDebuff.turns--;
        if (combat.monsterDebuff.turns <= 0) combat.monsterDebuff = null;
      }

      const dmg = rollDamage(playerAtk, monsterDef);
      combat.monster.hp -= dmg;
      send(
        `당신의 공격! ${combat.monster.name} 에게 ${dmg} 피해를 입혔습니다. (HP ${Math.max(
          0,
          combat.monster.hp
        )}/${combat.monster.maxHp})`,
        'orange'
      );

      if (combat.monster.hp <= 0) {
        const gainedExp = combat.monster.exp;
        const gold =
          combat.monster.goldMin +
          Math.floor(Math.random() * (combat.monster.goldMax - combat.monster.goldMin + 1));
        u.exp += gainedExp;
        u.gold += gold;
        send(`${combat.monster.name} 을(를) 쓰러뜨렸습니다! EXP ${gainedExp}, 골드 ${gold} 획득.`, 'lightgreen');

        (combat.monster.dropItems || []).forEach(d => {
          if (Math.random() < (d.chance || 0)) {
            addItemToUser(u, d.itemId, 1);
            const base = getItemById(d.itemId);
            send(`아이템 드랍: ${base ? base.name : d.itemId}`, 'lightyellow');
          }
        });

        u.combat = null;
        handleLevelUp(u, send);
        saveUsers();
        return;
      }

      if (combat.monsterDot) {
        const dotDmg = combat.monsterDot.hpPerTick || 5;
        combat.monster.hp -= dotDmg;
        send(
          `지속 피해로 ${combat.monster.name} 에게 ${dotDmg} 추가 피해! (HP ${Math.max(
            0,
            combat.monster.hp
          )}/${combat.monster.maxHp})`,
          'orange'
        );
        combat.monsterDot.turns--;
        if (combat.monsterDot.turns <= 0) combat.monsterDot = null;
        if (combat.monster.hp <= 0) {
          const gainedExp = combat.monster.exp;
          const gold =
            combat.monster.goldMin +
            Math.floor(Math.random() * (combat.monster.goldMax - combat.monster.goldMin + 1));
          u.exp += gainedExp;
          u.gold += gold;
          send(`${combat.monster.name} 을(를) 쓰러뜨렸습니다! EXP ${gainedExp}, 골드 ${gold} 획득.`, 'lightgreen');
          (combat.monster.dropItems || []).forEach(d => {
            if (Math.random() < (d.chance || 0)) {
              addItemToUser(u, d.itemId, 1);
              const base = getItemById(d.itemId);
              send(`아이템 드랍: ${base ? base.name : d.itemId}`, 'lightyellow');
            }
          });
          u.combat = null;
          handleLevelUp(u, send);
          saveUsers();
          return;
        }
      }

      combat.turn = 'monster';

      if (combat.monsterSlow && Math.random() < (combat.monsterSlow.skipChance || 0.3)) {
        send(`${combat.monster.name} 의 움직임이 둔해져 턴을 넘깁니다.`, 'lightblue');
        combat.monsterSlow.turns--;
        if (combat.monsterSlow.turns <= 0) combat.monsterSlow = null;
        combat.turn = 'player';
        return;
      }

      const jobEv = getJobEvasionChance(u.jobId);
      const evasionBuff = combat.playerEvasion ? combat.playerEvasion.chance || 0 : 0;
      const totalEvChance = Math.min(0.9, jobEv + evasionBuff);
      const evaded = Math.random() < totalEvChance;

      if (combat.playerEvasion) {
        combat.playerEvasion.turns--;
        if (combat.playerEvasion.turns <= 0) combat.playerEvasion = null;
      }

      if (evaded) {
        send('당신은 재빠르게 공격을 회피했습니다!', 'lightblue');
        combat.turn = 'player';
        return;
      }

      const enemyAtk = combat.monster.attack + ((combat.monsterDebuff && combat.monsterDebuff.attackModifier) || 0);
      const enemyDmg = rollDamage(enemyAtk, 0);
      u.hp -= enemyDmg;
      send(
        `${combat.monster.name} 의 공격! 당신은 ${enemyDmg} 피해를 입었습니다. (HP ${Math.max(
          0,
          u.hp
        )}/${u.maxHp})`,
        'red'
      );
      if (u.hp <= 0) {
        send('당신은 쓰러졌습니다. 낭만의 광장으로 돌아갑니다.', 'red');
        const spawn = getSpawnForMap(getStartMapId());
        u.hp = Math.floor(u.maxHp * 0.7);
        u.location = getStartMapId();
        u.posX = spawn.x;
        u.posY = spawn.y;
        u.combat = null;
        enterMap(u.location, true);
        describeLocation();
      } else {
        combat.turn = 'player';
      }
      saveUsers();
      return;
    }

    // ───────────── PVP (결투) ─────────────
    if (combat.type === 'pvp') {
      if (combat.turn !== 'self') {
        send('아직 당신의 턴이 아닙니다.', 'yellow');
        return;
      }

      // 턴 시작 효과(도트/버프 지속 시간 감소 등)
      const startResult = processPvPTurnStart(u, send);
      if (startResult.ended) return;

      const oppName = combat.opponent;
      const opp = users[oppName];
      if (!opp) {
        send('상대가 더 이상 존재하지 않습니다. 결투를 종료합니다.', 'yellow');
        u.combat = null;
        saveUsers();
        return;
      }
      const oppCombat = (opp.combat && opp.combat.type === 'pvp') ? opp.combat : null;

      // 슬로우(내 몸이 느린 상태) → 턴 스킵
      if (combat.slow && combat.slow.turns > 0) {
        if (Math.random() < (combat.slow.skipChance || 0.3)) {
          send('몸이 무겁게 느껴져, 이번 턴은 제대로 움직일 수 없었습니다.', 'lightblue');
          combat.slow.turns--;
          if (combat.slow.turns <= 0) combat.slow = null;

          if (oppCombat) oppCombat.turn = 'self';
          combat.turn = 'opponent';
          saveUsers();
          return;
        } else {
          combat.slow.turns--;
          if (combat.slow.turns <= 0) combat.slow = null;
        }
      }

      // 상대 회피율 = 기본 + 회피 버프
      let enemyEv = getJobEvasionChance(opp.jobId);
      if (oppCombat && oppCombat.evasionBuff) {
        enemyEv = Math.min(0.9, enemyEv + oppCombat.evasionBuff);
      }
      const evaded = Math.random() < enemyEv;

      if (evaded) {
        send(`당신의 공격! 하지만 ${oppName} 이(가) 회피했습니다.`, 'lightblue');
        sendToUserByName(oppName, `${u.name} 의 공격을 회피했습니다!`, 'lightblue');

        if (oppCombat) oppCombat.turn = 'self';
        combat.turn = 'opponent';
        saveUsers();
        return;
      }

      const atk = 15 + (combat.atkBuff || 0);
      const def = oppCombat ? (oppCombat.defBuff || 0) : 0;
      const dmg = rollDamage(atk, def);
      opp.hp -= dmg;

      send(
        `당신의 공격! ${oppName} 에게 ${dmg} 피해를 입혔습니다. (상대 HP ${Math.max(0, opp.hp)}/${opp.maxHp})`,
        'orange'
      );
      sendToUserByName(
        oppName,
        `${u.name} 의 공격으로 ${dmg} 피해를 입었습니다. (HP ${Math.max(0, opp.hp)}/${opp.maxHp})`,
        'red'
      );

      if (opp.hp <= 0) {
        finishDuelWithWinner(u.name, oppName, send);
        return;
      }

      if (oppCombat) oppCombat.turn = 'self';
      combat.turn = 'opponent';
      saveUsers();
      return;
    }
  }

  // 스킬 사용 (힐: 언제나 / 나머지: PvE+PvP 전투 중)
  function skillCommand(args) {
    const u = getUser();
    if (!u) return;
    if (args.length === 0) {
      showSkills();
      return;
    }
    const skillId = args[0];
    const targetName = args[1];

    if (!u.skills || !u.skills.includes(skillId)) {
      send('그런 스킬을 습득하지 않았습니다.', 'yellow');
      return;
    }
    const skill = getSkillById(skillId);
    if (!skill) {
      send('알 수 없는 스킬입니다. (skilllist.json 에 정의 필요)', 'yellow');
      return;
    }
    const eff = skill.effect || {};
    const mpCost = skill.mpCost || 0;

    // 힐 스킬: 전투 여부 상관 없이, 자기/다른 유저에게 사용 가능
    if (eff.kind === 'heal') {
      if (u.mp < mpCost) {
        send('MP가 부족합니다.', 'yellow');
        return;
      }
      u.mp -= mpCost;
      let targetUser = u;
      if (targetName) {
        const other = Object.values(users).find(x => x.name === targetName);
        if (other) targetUser = other;
      }
      const amount = eff.value || 25;
      targetUser.hp = Math.min(targetUser.maxHp, targetUser.hp + amount);
      send(`${skill.effectText || skill.name} (HP +${amount})`, 'aqua');
      saveUsers();
      return;
    }

    // 나머지 스킬은 전투 중에만
    const combat = u.combat;
    if (!combat) {
      send('이 스킬은 전투 중에만 사용할 수 있습니다.', 'yellow');
      return;
    }

    // 턴 체크
    if (combat.type === 'pve' && combat.turn !== 'player') {
      send('아직 당신의 턴이 아닙니다.', 'yellow');
      return;
    }
    if (combat.type === 'pvp' && combat.turn !== 'self') {
      send('아직 당신의 턴이 아닙니다.', 'yellow');
      return;
    }

    if (u.mp < mpCost) {
      send('MP가 부족합니다.', 'yellow');
      return;
    }
    u.mp -= mpCost;

    // ───── PvE 스킬 ─────
    if (combat.type === 'pve') {
      applySkillEffectInPvE(u, combat, skill, targetName, send);

      if (combat.monster.hp <= 0) {
        const gainedExp = combat.monster.exp;
        const gold =
          combat.monster.goldMin +
          Math.floor(Math.random() * (combat.monster.goldMax - combat.monster.goldMin + 1));
        u.exp += gainedExp;
        u.gold += gold;
        send(`${combat.monster.name} 을(를) 쓰러뜨렸습니다! EXP ${gainedExp}, 골드 ${gold} 획득.`, 'lightgreen');
        (combat.monster.dropItems || []).forEach(d => {
          if (Math.random() < (d.chance || 0)) {
            addItemToUser(u, d.itemId, 1);
            const base = getItemById(d.itemId);
            send(`아이템 드랍: ${base ? base.name : d.itemId}`, 'lightyellow');
          }
        });
        u.combat = null;
        handleLevelUp(u, send);
        saveUsers();
        return;
      }

      combat.turn = 'monster';

      if (combat.monsterSlow && Math.random() < (combat.monsterSlow.skipChance || 0.3)) {
        send(`${combat.monster.name} 의 움직임이 둔해져 턴을 넘깁니다.`, 'lightblue');
        combat.monsterSlow.turns--;
        if (combat.monsterSlow.turns <= 0) combat.monsterSlow = null;
        combat.turn = 'player';
        saveUsers();
        return;
      }

      const jobEv = getJobEvasionChance(u.jobId);
      const evasionBuff = combat.playerEvasion ? combat.playerEvasion.chance || 0 : 0;
      const totalEvChance = Math.min(0.9, jobEv + evasionBuff);
      const evaded = Math.random() < totalEvChance;

      if (combat.playerEvasion) {
        combat.playerEvasion.turns--;
        if (combat.playerEvasion.turns <= 0) combat.playerEvasion = null;
      }

      if (evaded) {
        send('당신은 재빠르게 공격을 회피했습니다!', 'lightblue');
        combat.turn = 'player';
        saveUsers();
        return;
      }

      const enemyAtk = combat.monster.attack + ((combat.monsterDebuff && combat.monsterDebuff.attackModifier) || 0);
      const enemyDmg = rollDamage(enemyAtk, 0);
      u.hp -= enemyDmg;
      send(
        `${combat.monster.name} 의 공격! 당신은 ${enemyDmg} 피해를 입었습니다. (HP ${Math.max(
          0,
          u.hp
        )}/${u.maxHp})`,
        'red'
      );
      if (u.hp <= 0) {
        send('당신은 쓰러졌습니다. 낭만의 광장으로 돌아갑니다.', 'red');
        const spawn = getSpawnForMap(getStartMapId());
        u.hp = Math.floor(u.maxHp * 0.7);
        u.location = getStartMapId();
        u.posX = spawn.x;
        u.posY = spawn.y;
        u.combat = null;
        enterMap(u.location, true);
        describeLocation();
      } else {
        combat.turn = 'player';
      }
      saveUsers();
      return;
    }

    // ───── PvP 스킬 ─────
    if (combat.type === 'pvp') {
      // 턴 시작 효과
      const startResult = processPvPTurnStart(u, send);
      if (startResult.ended) return;

      const c = u.combat;
      const oppName = c.opponent;
      const opp = users[oppName];
      if (!opp) {
        send('상대가 더 이상 존재하지 않습니다. 결투를 종료합니다.', 'yellow');
        u.combat = null;
        saveUsers();
        return;
      }
      const oppCombat = (opp.combat && opp.combat.type === 'pvp') ? opp.combat : null;

      // 슬로우(내 몸이 느린 상태) → 턴 스킵
      if (c.slow && c.slow.turns > 0) {
        if (Math.random() < (c.slow.skipChance || 0.3)) {
          send('몸이 무겁게 느껴져, 이번 턴은 제대로 움직일 수 없었습니다.', 'lightblue');
          c.slow.turns--;
          if (c.slow.turns <= 0) c.slow = null;

          if (oppCombat) oppCombat.turn = 'self';
          c.turn = 'opponent';
          saveUsers();
          return;
        } else {
          c.slow.turns--;
          if (c.slow.turns <= 0) c.slow = null;
        }
      }

      const result = applySkillEffectInPvP(u, skill, send);
      if (result && result.ended) {
        return;
      }

      if (oppCombat) oppCombat.turn = 'self';
      c.turn = 'opponent';
      saveUsers();
      return;
    }
  }

  // 맵 이동(/go)
  function goCommand(args) {
    const u = getUser();
    if (!u) return;
    if (args.length === 0) {
      send('사용법: /go 맵ID', 'yellow');
      return;
    }
    const target = args[0];
    const map = getMapById(target);
    if (!map) {
      send('그런 맵ID는 존재하지 않습니다.', 'yellow');
      return;
    }
    enterMap(target, false);
  }

  // 회원가입
  function signupCommand(args) {
    if (args.length < 3) {
      send('사용법: /signup 아이디 비밀번호 직업ID또는코드', 'yellow');
      send('예: /signup hero123 1234 warrior', 'yellow');
      return;
    }
    const [name, password, jobCode] = args;
    if (users[name]) {
      send('이미 존재하는 아이디입니다.', 'yellow');
      return;
    }

    let chosenJobId = null;
    let job = jobs.find(j => !j.hidden && j.id === jobCode);
    if (job) {
      chosenJobId = job.id;
    } else {
      job = jobs.find(j => j.hidden && j.unlockCode === jobCode);
      if (job) chosenJobId = job.id;
    }
    if (!chosenJobId) {
      send('직업ID 또는 비밀코드가 올바르지 않습니다.', 'yellow');
      return;
    }

    const isFirstUser = Object.keys(users).length === 0;
    const isAdmin = isFirstUser || job.id === 'admin';

    const user = createNewUser(name, password, chosenJobId, isAdmin);
    users[name] = user;
    saveUsers();
    send('회원가입 완료! 이제 /login 아이디 비밀번호 로 로그인하세요.', 'lightgreen');
  }

  // 로그인
  function loginCommand(args) {
    if (args.length < 2) {
      send('사용법: /login 아이디 비밀번호', 'yellow');
      return;
    }
    const [name, password] = args;
    const u = users[name];
    if (!u || u.password !== password) {
      send('아이디 또는 비밀번호가 올바르지 않습니다.', 'yellow');
      return;
    }
    if (u.banned) {
      send('이 계정은 밴 처리되었습니다.', 'red');
      return;
    }

    currentName = name;
    ensureBaseSkills(u);
    ensureUserPosition(u);
    socket.join(`map:${u.location}`);

    socketsByName.set(name, socket);

    saveUsers();

    send(`${name} 님, 낭만의 땅에 오신 것을 환영합니다.`, 'lightgreen');
    describeLocation();
  }

  // 유저 목록
  function whoCommand() {
    const names = Object.keys(users);
    const lines = [];
    lines.push('=== 등록된 유저 ===');
    names.forEach(n => {
      const u = users[n];
      lines.push(`- ${n} (레벨 ${u.level}, 직업 ${u.jobId}${u.isAdmin ? ', 운영자' : ''})`);
    });
    send(lines.join('\n'), 'lightblue');
  }

  // 운영자 밴
  function adminBanCommand(args) {
    const me = getUser();
    if (!me || !me.isAdmin) {
      send('운영자만 사용할 수 있는 명령입니다.', 'red');
      return;
    }
    if (args.length < 1) {
      send('사용법: /ban 유저이름', 'yellow');
      return;
    }
    const targetName = args[0];
    const target = users[targetName];
    if (!target) {
      send('그런 유저는 존재하지 않습니다.', 'yellow');
      return;
    }
    target.banned = true;
    saveUsers();
    send(`${targetName} 계정을 밴했습니다.`, 'red');
  }

  // 도움말
  function helpCommand() {
    const lines = [
      '=== 명령어 목록 ===',
      '/signup id pw jobOrCode     - 회원가입 (처음 가입자는 자동 운영자)',
      '/login id pw               - 로그인',
      '/help                      - 이 도움말',
      '/who                       - 등록된 유저 목록',
      '/stats                     - 내 상태 보기',
      '/skills                    - 보유 스킬 보기',
      '/items                     - 인벤토리 보기',
      '/use 아이템ID              - 아이템/스킬서 사용',
      '/give 대상 아이템ID 수량   - 아이템 전달',
      '/go 맵ID                   - 특정 맵으로 이동',
      '/walk 방향(w/a/s/d)        - 16x16 맵 위에서 한 칸 이동',
      '/here                      - 현재 맵의 유저/NPC/몬스터 목록',
      '/attack                    - 전투에서 기본 공격',
      '/skill 스킬ID [대상]       - 스킬 사용 (힐은 다른 유저도 지정 가능)',
      '/say 메시지                - 맵 채팅 (/없이 입력해도 동일)',
      '/duel 대상                 - 결투 신청',
      '/accept 대상               - 결투 수락',
      '/decline 대상              - 결투 거절',
      '/ban 유저명                - 운영자 전용 밴 명령',
      '',
      '※ 기본 스킬: smash(강타)는 모든 유저에게 자동으로 제공됩니다.',
      '※ 스킬 정의는 DAT/gdat/skilllist.json 에서 관리합니다.'
    ];
    send(lines.join('\n'), 'lightblue');
  }

  // 맵 채팅
  function sayCommand(args) {
    const u = getUser();
    if (!u) {
      send('먼저 /login 으로 로그인하세요.', 'yellow');
      return;
    }
    const msg = args.join(' ');
    if (!msg) return;
    const mapId = u.location || getStartMapId();
    const line = `[${mapId}] ${u.name}: ${msg}`;
    io.to(`map:${mapId}`).emit('console_output', { msg: line, color: 'white' });
  }

  // ─── 결투 명령들 ───
  function duelCommand(args) {
    const u = getUser();
    if (!u) {
      send('먼저 /login 으로 로그인하세요.', 'yellow');
      return;
    }
    if (args.length < 1) {
      send('사용법: /duel 대상유저이름', 'yellow');
      return;
    }

    const targetName = args[0];
    if (targetName === u.name) {
      send('자기 자신에게는 결투를 신청할 수 없습니다.', 'yellow');
      return;
    }
    const target = users[targetName];
    if (!target) {
      send('그런 유저는 존재하지 않습니다.', 'yellow');
      return;
    }
    if (u.combat) {
      send('이미 전투(결투 포함) 중입니다.', 'yellow');
      return;
    }
    if (target.combat) {
      send('상대가 이미 전투(결투 포함) 중입니다.', 'yellow');
      return;
    }

    duelRequests.set(targetName, u.name);
    send(`${targetName} 에게 결투를 신청했습니다.`, 'lightblue');
    sendToUserByName(
      targetName,
      `${u.name} 이(가) 당신에게 결투를 신청했습니다. /accept ${u.name} 또는 /decline ${u.name} 로 응답하세요.`,
      'lightblue'
    );
  }

  function acceptDuelCommand(args) {
    const u = getUser();
    if (!u) return;
    if (args.length < 1) {
      send('사용법: /accept 상대이름', 'yellow');
      return;
    }
    const challengerName = args[0];
    const from = duelRequests.get(u.name);
    if (from !== challengerName) {
      send('해당 유저에게서 온 결투 신청이 없습니다.', 'yellow');
      return;
    }
    const challenger = users[challengerName];
    if (!challenger) {
      send('그 유저는 더 이상 존재하지 않습니다.', 'yellow');
      duelRequests.delete(u.name);
      return;
    }
    if (u.combat || challenger.combat) {
      send('이미 전투 중 상태입니다.', 'yellow');
      duelRequests.delete(u.name);
      return;
    }

    duelRequests.delete(u.name);

    if (u.hp <= 0) u.hp = Math.floor(u.maxHp * 0.7);
    if (challenger.hp <= 0) challenger.hp = Math.floor(challenger.maxHp * 0.7);

    u.combat = {
      type: 'pvp',
      opponent: challengerName,
      turn: 'self',
      atkBuff: 0,
      atkBuffTurns: 0,
      defBuff: 0,
      defBuffTurns: 0,
      evasionBuff: 0,
      evasionTurns: 0,
      dot: null,
      slow: null
    };
    challenger.combat = {
      type: 'pvp',
      opponent: u.name,
      turn: 'opponent',
      atkBuff: 0,
      atkBuffTurns: 0,
      defBuff: 0,
      defBuffTurns: 0,
      evasionBuff: 0,
      evasionTurns: 0,
      dot: null,
      slow: null
    };

    send(`${challengerName} 과(와)의 결투를 시작합니다!`, 'yellow');
    sendToUserByName(challengerName, `${u.name} 이(가) 결투 신청을 수락했습니다!`, 'yellow');
  }

  function declineDuelCommand(args) {
    const u = getUser();
    if (!u) return;
    if (args.length < 1) {
      send('사용법: /decline 상대이름', 'yellow');
      return;
    }
    const challengerName = args[0];
    const from = duelRequests.get(u.name);
    if (from !== challengerName) {
      send('해당 유저에게서 온 결투 신청이 없습니다.', 'yellow');
      return;
    }

    duelRequests.delete(u.name);
    send(`${challengerName} 의 결투 신청을 거절했습니다.`, 'yellow');
    sendToUserByName(challengerName, `${u.name} 이(가) 당신의 결투 신청을 거절했습니다.`, 'yellow');
  }

  // ───────────────────────────────────────
  // 입력 처리
  // ───────────────────────────────────────
  socket.on('console_input', ({ text }) => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      switch (cmd) {
        case 'help':
          helpCommand();
          break;
        case 'signup':
          signupCommand(args);
          break;
        case 'login':
          loginCommand(args);
          break;
        case 'who':
          whoCommand();
          break;
        case 'stats':
          showStats();
          break;
        case 'skills':
          showSkills();
          break;
        case 'items':
          showInventory();
          break;
        case 'use':
          useItemCommand(args);
          break;
        case 'give':
          giveItemCommand(args);
          break;
        case 'go':
          goCommand(args);
          break;
        case 'walk':
        case 'step':
          walkCommand(args);
          break;
        case 'here':
          hereCommand();
          break;
        case 'attack':
          attackCommand();
          break;
        case 'skill':
          skillCommand(args);
          break;
        case 'say':
          sayCommand(args);
          break;
        case 'ban':
          adminBanCommand(args);
          break;
        case 'duel':
          duelCommand(args);
          break;
        case 'accept':
          acceptDuelCommand(args);
          break;
        case 'decline':
          declineDuelCommand(args);
          break;
        default:
          send('알 수 없는 명령입니다. /help 로 확인하세요.', 'yellow');
      }
    } else {
      sayCommand(trimmed.split(/\s+/));
    }
  });

  socket.on('disconnect', () => {
    if (currentName) {
      socketsByName.delete(currentName);
    }
  });

  send('낭만의 땅에 오신 것을 환영합니다.', 'lightblue');
  send('먼저 /signup 또는 /login 을 입력하세요.', 'lightblue');
});

// ───────────────────────────────────────
// 서버 시작
// ───────────────────────────────────────
server.listen(PORT, () => {
  console.log(`낭만의 땅 MUD 서버가 포트 ${PORT} 에서 실행 중입니다.`);
});
