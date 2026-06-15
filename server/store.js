const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DATA_FILE = path.resolve(process.cwd(), "data/dev-db.json");
const INITIAL_ADMIN_EMAIL = process.env.INITIAL_ADMIN_EMAIL || "admin@example.com";
const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD;
const PUBLIC_BOARD_USER_EMAIL = "board-guest@system.local";

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = password;
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, storedPassword] = String(stored).split(":");
  if (!salt || !storedPassword) return false;
  return password === storedPassword;
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, sessions, pendingOtp, pendingVerification, emailVerification, ...safe } = user;
  return safe;
}

function createSeed() {
  if (!INITIAL_ADMIN_PASSWORD) {
    throw new Error("INITIAL_ADMIN_PASSWORD is required before creating the initial admin account");
  }
  const adminId = id("usr");
  return {
    users: [
      {
        id: adminId,
        email: INITIAL_ADMIN_EMAIL,
        passwordHash: hashPassword(INITIAL_ADMIN_PASSWORD),
        role: "admin",
        status: "verified",
        englishName: "Platform Admin",
        chineseName: "Admin",
        grade: 12,
        classNo: 1,
        bio: "Initial platform administrator",
        createdAt: now(),
        updatedAt: now()
      },
      {
        id: id("usr"),
        email: PUBLIC_BOARD_USER_EMAIL,
        passwordHash: null,
        role: "student",
        status: "verified",
        englishName: "Board Guest",
        chineseName: "",
        grade: null,
        classNo: null,
        bio: "System guest account for public board posts.",
        createdAt: now(),
        updatedAt: now()
      }
    ],
    posts: [],
    sessions: [],
    reports: [],
    conversations: [],
    notifications: [],
    auditLogs: [],
    stories: [],
    reels: [],
    follows: [],
    qna: [],
    suggestions: [],
    bans: []
  };
}

class Store {
  constructor(filePath = DEFAULT_DATA_FILE) {
    this.filePath = path.resolve(filePath);
    this.data = null;
    this.indexes = {
      usersById: new Map(),
      usersByEmail: new Map(),
      sessionsByDigest: new Map()
    };
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.data = createSeed();
      this.save();
      return this.data;
    }
    this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    this.migrate();
    this.rebuildIndexes();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
    this.rebuildIndexes();
  }

  migrate() {
    this.data.sessions ||= [];
    this.data.notifications ||= [];
    this.data.auditLogs ||= [];
    this.data.stories ||= [];
    this.data.reels ||= [];
    this.data.follows ||= [];
    this.data.qna ||= [];
    this.data.suggestions ||= [];
    this.data.bans ||= [];
    this.data.conversations ||= [];
    for (const conversation of this.data.conversations) {
      if (conversation.participants && !conversation.members) {
        conversation.members = conversation.participants;
        delete conversation.participants;
      }
      conversation.members ||= [];
      conversation.messages ||= [];
      if (conversation.group === undefined) {
        conversation.group = conversation.members.length > 2;
      }
    }
    for (const user of this.data.users) {
      if (Array.isArray(user.sessions)) {
        for (const legacySession of user.sessions) {
          this.data.sessions.push({
            id: id("ses"),
            userId: user.id,
            tokenDigest: legacySession.tokenDigest || legacySession.tokenHash,
            legacyPasswordHash: Boolean(legacySession.tokenHash),
            expiresAt: legacySession.expiresAt,
            createdAt: legacySession.createdAt || now()
          });
        }
        delete user.sessions;
      }
    }
    if (!this.data.users.some((user) => user.email === PUBLIC_BOARD_USER_EMAIL)) {
      this.data.users.push({
        id: id("usr"),
        email: PUBLIC_BOARD_USER_EMAIL,
        passwordHash: null,
        role: "student",
        status: "verified",
        englishName: "Board Guest",
        chineseName: "",
        grade: null,
        classNo: null,
        bio: "System guest account for public board posts.",
        createdAt: now(),
        updatedAt: now()
      });
    }
  }

  rebuildIndexes() {
    this.indexes.usersById = new Map(this.data.users.map((user) => [user.id, user]));
    this.indexes.usersByEmail = new Map(this.data.users.map((user) => [user.email, user]));
    this.indexes.sessionsByDigest = new Map();
    for (const session of this.data.sessions || []) {
      if (new Date(session.expiresAt).getTime() > Date.now() && !session.legacyPasswordHash) {
        this.indexes.sessionsByDigest.set(session.tokenDigest, session);
      }
    }
  }

  findUserById(userId) {
    return this.indexes.usersById.get(userId) || null;
  }

  findUserByEmail(email) {
    return this.indexes.usersByEmail.get(email) || null;
  }

  audit(actorId, action, metadata = {}) {
    this.data.auditLogs.push({
      id: id("aud"),
      actorId,
      action,
      metadata,
      createdAt: now()
    });
  }

  createSession(user, ttlHours) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
    this.data.sessions.push({
      id: id("ses"),
      userId: user.id,
      tokenDigest: tokenDigest(token),
      expiresAt,
      createdAt: now()
    });
    this.pruneExpiredSessions();
    user.updatedAt = now();
    this.audit(user.id, "session_created");
    this.save();
    return { token, expiresAt };
  }

  findUserByToken(token) {
    const digest = tokenDigest(token);
    const indexedSession = this.indexes.sessionsByDigest.get(digest);
    if (indexedSession) return this.findUserById(indexedSession.userId);

    const legacySession = (this.data.sessions || []).find((session) => {
      return session.legacyPasswordHash && new Date(session.expiresAt).getTime() > Date.now() && verifyPassword(token, session.tokenDigest);
    });
    if (legacySession) {
      legacySession.tokenDigest = digest;
      legacySession.legacyPasswordHash = false;
      this.save();
      return this.findUserById(legacySession.userId);
    }
    return null;
  }

  pruneExpiredSessions() {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
    return before - this.data.sessions.length;
  }

  revokeSessionByToken(token) {
    const digest = tokenDigest(token);
    const next = this.data.sessions.filter((session) => session.tokenDigest !== digest);
    if (next.length === this.data.sessions.length) return false;
    this.data.sessions = next;
    this.save();
    return true;
  }
}

module.exports = {
  Store,
  createSeed,
  hashPassword,
  verifyPassword,
  tokenDigest,
  publicUser,
  id,
  now
};
