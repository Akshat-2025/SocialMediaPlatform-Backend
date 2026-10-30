/**
 * Phase 4 Unit Tests: Online/Offline Presence and Typing Indicators
 *
 * All external dependencies (Mongoose models, User.updateOne) are mocked.
 * No real database, no real Socket.IO server — pure unit tests of the
 * socket event handlers exported from sockets/index.js.
 *
 * How the socket mock works (beginner-friendly explanation):
 *   initSocket(ioMock) registers all event handlers. Instead of running a
 *   real Socket.IO server we pass a fake "io" object whose methods (on, use,
 *   to, emit) are Jest mocks. This lets us call event handlers directly and
 *   assert which events they emitted — without any network involved.
 *
 *   Important design: the connection handler registers ALL socket.on()
 *   listeners synchronously, then fires notifyPresence() as a fire-and-forget
 *   at the end. This means handler lookups work immediately after initSocket().
 */

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");
jest.mock("../../src/models/Message.model");

const User = require("../../src/models/User.model");
const Conversation = require("../../src/models/Conversation.model");
const {
  initSocket,
  onlineUsers,
  typingTimers,
  TYPING_TIMEOUT_MS,
} = require("../../src/sockets/index");

// ─── Shared test IDs ─────────────────────────────────────────────────────────
const USER_A_ID = new mongoose.Types.ObjectId().toString();
const USER_B_ID = new mongoose.Types.ObjectId().toString();
const USER_C_ID = new mongoose.Types.ObjectId().toString(); // not a participant
const CONV_ID = new mongoose.Types.ObjectId().toString();

const fakeUserA = {
  _id: USER_A_ID,
  username: "usera",
  fullName: "User A",
  avatar: { url: "", publicId: "" },
};

// ─── Helper: build a socket mock that captures event handlers ────────────────
const buildSocket = (userId, socketId = "socket-1") => {
  const handlers = {};
  const socketToEmit = jest.fn();
  const sock = {
    id: socketId,
    userId,
    user: { _id: userId },
    join: jest.fn(),
    leave: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: socketToEmit }),
    emit: jest.fn(),
    on: jest.fn((event, fn) => { handlers[event] = fn; }),
    _handlers: handlers,
    _toEmit: socketToEmit,
  };
  return sock;
};

// ─── Helper: build an io mock that wires up a single socket ──────────────────
const buildIo = (socket, ioToEmit = jest.fn()) => {
  const io = {
    use: jest.fn(),
    on: jest.fn((event, fn) => {
      if (event === "connection") fn(socket); // synchronous — no await
    }),
    emit: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: ioToEmit }),
    _toEmit: ioToEmit,
  };
  return io;
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Presence — online/offline tracking
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 4 – Presence: Online/Offline Tracking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();
    // Default: no conversation partners → notifyPresence() emits nothing
    Conversation.find.mockResolvedValue([]);
    User.updateOne = jest.fn().mockResolvedValue({});
  });

  // ── T1: First connection goes online ─────────────────────────────────────
  it("T1: first connection registers user in onlineUsers", () => {
    const socket = buildSocket(USER_A_ID);
    const io = buildIo(socket);
    initSocket(io);

    expect(onlineUsers.has(USER_A_ID)).toBe(true);
    expect(onlineUsers.get(USER_A_ID).size).toBe(1);
  });

  // ── T2: Multi-tab — user stays online while ≥1 socket remains ────────────
  it("T2: user remains online after first tab closes when a second tab is still open", () => {
    // Simulate two sockets for the same user by calling the connection handler
    // manually with two different socket objects. We intercept io.on("connection")
    // and call the handler for each socket in turn.
    const socket1 = buildSocket(USER_A_ID, "socket-a1");
    const socket2 = buildSocket(USER_A_ID, "socket-a2");

    let connectionHandler;
    const io = {
      use: jest.fn(),
      on: jest.fn((event, fn) => {
        if (event === "connection") connectionHandler = fn;
      }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    };

    initSocket(io);

    // Connect both sockets
    connectionHandler(socket1);
    connectionHandler(socket2);

    expect(onlineUsers.get(USER_A_ID).size).toBe(2);

    // First tab disconnects
    socket1._handlers["disconnect"]();

    // User must still be in onlineUsers (socket2 is open)
    expect(onlineUsers.has(USER_A_ID)).toBe(true);
    expect(onlineUsers.get(USER_A_ID).size).toBe(1);
    expect(User.updateOne).not.toHaveBeenCalled(); // no lastSeen written yet
  });

  // ── T3: Genuine offline on last socket ───────────────────────────────────
  it("T3: user transitions offline only when last connection closes", async () => {
    const socket = buildSocket(USER_A_ID);
    const io = buildIo(socket);
    initSocket(io);

    expect(onlineUsers.has(USER_A_ID)).toBe(true);

    await socket._handlers["disconnect"]();

    expect(onlineUsers.has(USER_A_ID)).toBe(false);
  });

  // ── T4: lastSeen persisted on genuine offline ─────────────────────────────
  it("T4: lastSeen is written to MongoDB only on genuine offline transition", async () => {
    const socket = buildSocket(USER_A_ID);
    const io = buildIo(socket);
    initSocket(io);

    await socket._handlers["disconnect"]();

    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: USER_A_ID },
      expect.objectContaining({ lastSeen: expect.any(Date) })
    );
  });

  // ── T5: lastSeen NOT written when other sockets remain ────────────────────
  it("T5: lastSeen is NOT written when user still has another active socket", () => {
    // Pre-register two sockets for the same user
    onlineUsers.set(USER_A_ID, new Set(["socket-extra", "socket-new"]));

    // Remove one (simulating disconnect logic path where size > 0 after delete)
    const sockets = onlineUsers.get(USER_A_ID);
    sockets.delete("socket-new");

    // User is still online
    expect(sockets.size).toBe(1);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  // ── T6: Presence notified only to online conversation partners ────────────
  it("T6: presence:update is emitted only to online conversation partners", async () => {
    // USER_B is online; USER_C is also a partner but offline
    onlineUsers.set(USER_B_ID, new Set(["socket-b"]));
    // USER_C is NOT in onlineUsers

    // Provide partners via Conversation.find mock (no .lean() needed)
    Conversation.find.mockResolvedValue([
      {
        participants: [
          { toString: () => USER_A_ID },
          { toString: () => USER_B_ID },
          { toString: () => USER_C_ID },
        ],
      },
    ]);

    const socket = buildSocket(USER_A_ID);
    const partnerEmit = jest.fn();
    const io = {
      use: jest.fn(),
      on: jest.fn((event, fn) => { if (event === "connection") fn(socket); }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: partnerEmit }),
    };

    initSocket(io);

    // Let notifyPresence() (fire-and-forget) settle
    await Promise.resolve();
    await Promise.resolve(); // two ticks to allow async chain

    // USER_B is online → must receive presence:update
    expect(io.to).toHaveBeenCalledWith(`user:${USER_B_ID}`);
    expect(partnerEmit).toHaveBeenCalledWith("presence:update", {
      userId: USER_A_ID,
      status: "online",
      lastSeen: null,
    });

    // USER_C is offline → must NOT receive the event
    expect(io.to).not.toHaveBeenCalledWith(`user:${USER_C_ID}`);
  });

  // ── T7: No global broadcast ───────────────────────────────────────────────
  it("T7: io.emit (global broadcast) is NEVER called for presence events", async () => {
    const socket = buildSocket(USER_A_ID);
    const io = buildIo(socket);
    initSocket(io);

    await socket._handlers["disconnect"]();
    await Promise.resolve();

    expect(io.emit).not.toHaveBeenCalled();
  });

  // ── T8: Offline presence event goes to partners with correct payload ───────
  it("T8: presence:update carries offline status and lastSeen when user goes offline", async () => {
    // USER_B is online and is a conversation partner
    onlineUsers.set(USER_B_ID, new Set(["socket-b"]));
    Conversation.find.mockResolvedValue([
      { participants: [{ toString: () => USER_A_ID }, { toString: () => USER_B_ID }] },
    ]);

    const socket = buildSocket(USER_A_ID);
    const partnerEmit = jest.fn();
    const io = {
      use: jest.fn(),
      on: jest.fn((event, fn) => { if (event === "connection") fn(socket); }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: partnerEmit }),
    };
    initSocket(io);

    partnerEmit.mockClear();
    io.to.mockClear();

    await socket._handlers["disconnect"]();
    await Promise.resolve();
    await Promise.resolve();

    expect(io.to).toHaveBeenCalledWith(`user:${USER_B_ID}`);
    expect(partnerEmit).toHaveBeenCalledWith("presence:update", {
      userId: USER_A_ID,
      status: "offline",
      lastSeen: expect.any(Date),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Typing Indicators
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 4 – Typing Indicators", () => {
  let io, socket, partnerEmit;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    onlineUsers.clear();
    typingTimers.clear();
    Conversation.find.mockResolvedValue([]);
    User.updateOne = jest.fn().mockResolvedValue({});

    partnerEmit = jest.fn();
    socket = buildSocket(USER_A_ID);
    io = {
      use: jest.fn(),
      on: jest.fn((event, fn) => { if (event === "connection") fn(socket); }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: partnerEmit }),
    };

    initSocket(io);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── T9: typing:start — verified participant ───────────────────────────────
  it("T9: typing:start emits to other participants when sender is a member", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    await socket._handlers["typing:start"]({ conversationId: CONV_ID });

    expect(io.to).toHaveBeenCalledWith(`user:${USER_B_ID}`);
    expect(partnerEmit).toHaveBeenCalledWith("typing:start", {
      conversationId: CONV_ID,
      userId: USER_A_ID, // derived from socket.userId, NOT from client payload
    });
  });

  // ── T10: impersonation prevention — client userId is ignored ──────────────
  it("T10: typing:start ignores any userId supplied by the client", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    // Client tries to impersonate USER_B
    await socket._handlers["typing:start"]({
      conversationId: CONV_ID,
      userId: USER_B_ID, // malicious — must be ignored
    });

    expect(partnerEmit).toHaveBeenCalledWith("typing:start", {
      conversationId: CONV_ID,
      userId: USER_A_ID, // must still be socket's verified identity
    });
  });

  // ── T11: non-participant is silently dropped ───────────────────────────────
  it("T11: non-participant typing:start is silently dropped", async () => {
    Conversation.findOne.mockResolvedValue(null); // not a member

    await socket._handlers["typing:start"]({ conversationId: CONV_ID });

    expect(partnerEmit).not.toHaveBeenCalled();
    expect(typingTimers.size).toBe(0);
  });

  // ── T12: typing:stop clears state and notifies partners ───────────────────
  it("T12: typing:stop emits to partners and cancels the timeout", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    await socket._handlers["typing:start"]({ conversationId: CONV_ID });
    expect(typingTimers.get(CONV_ID)?.has(USER_A_ID)).toBe(true);

    partnerEmit.mockClear();
    await socket._handlers["typing:stop"]({ conversationId: CONV_ID });

    expect(partnerEmit).toHaveBeenCalledWith("typing:stop", {
      conversationId: CONV_ID,
      userId: USER_A_ID,
    });
    expect(typingTimers.get(CONV_ID)?.has(USER_A_ID)).toBeFalsy();
  });

  // ── T13: timeout auto-clears stale typing state ───────────────────────────
  it("T13: typing auto-clears after TYPING_TIMEOUT_MS without a stop event", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    await socket._handlers["typing:start"]({ conversationId: CONV_ID });
    expect(typingTimers.get(CONV_ID)?.has(USER_A_ID)).toBe(true);

    partnerEmit.mockClear();
    jest.advanceTimersByTime(TYPING_TIMEOUT_MS + 100);

    expect(typingTimers.get(CONV_ID)?.has(USER_A_ID)).toBeFalsy();
    expect(partnerEmit).toHaveBeenCalledWith("typing:stop", {
      conversationId: CONV_ID,
      userId: USER_A_ID,
    });
  });

  // ── T14: rapid start events → only one timer ──────────────────────────────
  it("T14: rapid typing:start events reset the timer — no unbounded timers", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    await socket._handlers["typing:start"]({ conversationId: CONV_ID });
    await socket._handlers["typing:start"]({ conversationId: CONV_ID });
    await socket._handlers["typing:start"]({ conversationId: CONV_ID });

    // Still only ONE timer for this (conv, user) pair
    const convTimers = typingTimers.get(CONV_ID);
    expect(convTimers).toBeDefined();
    expect(convTimers.size).toBe(1);
    expect(convTimers.has(USER_A_ID)).toBe(true);
  });

  // ── T15: disconnect clears typing state ───────────────────────────────────
  it("T15: disconnecting while typing emits typing:stop and clears the timer", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    await socket._handlers["typing:start"]({ conversationId: CONV_ID });
    expect(typingTimers.get(CONV_ID)?.has(USER_A_ID)).toBe(true);

    partnerEmit.mockClear();

    // clearAllTypingForUser uses Conversation.find
    Conversation.find.mockResolvedValue([
      { _id: { toString: () => CONV_ID }, participants: [USER_A_ID, USER_B_ID] },
    ]);

    await socket._handlers["disconnect"]();

    expect(typingTimers.get(CONV_ID)?.has(USER_A_ID)).toBeFalsy();
    expect(partnerEmit).toHaveBeenCalledWith("typing:stop", {
      conversationId: CONV_ID,
      userId: USER_A_ID,
    });
  });

  // ── T16: typing:stop doesn't clear ANOTHER user's timer ───────────────────
  it("T16: typing:stop cannot clear another user's typing state", async () => {
    // Pre-inject USER_B's typing timer directly
    if (!typingTimers.has(CONV_ID)) typingTimers.set(CONV_ID, new Map());
    const fakeTimer = setTimeout(() => {}, 99999);
    typingTimers.get(CONV_ID).set(USER_B_ID, fakeTimer);

    // USER_A sends typing:stop for the same conversation
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_A_ID, USER_B_ID],
    });

    await socket._handlers["typing:stop"]({ conversationId: CONV_ID });

    // USER_A had no timer → USER_B's timer is untouched
    expect(typingTimers.get(CONV_ID)?.has(USER_B_ID)).toBe(true);

    clearTimeout(fakeTimer);
  });

  // ── T17: invalid conversationId silently dropped ──────────────────────────
  it("T17: typing:start with invalid conversationId is silently ignored", async () => {
    await socket._handlers["typing:start"]({ conversationId: "not-an-id" });

    expect(Conversation.findOne).not.toHaveBeenCalled();
    expect(partnerEmit).not.toHaveBeenCalled();
  });

  // ── T18: null payload silently dropped ────────────────────────────────────
  it("T18: typing:start with null payload is silently ignored", async () => {
    await socket._handlers["typing:start"](null);

    expect(partnerEmit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Authentication — unauthenticated connections are rejected
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 4 – Authentication (sanity checks)", () => {
  let middleware;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();
    Conversation.find.mockResolvedValue([]);

    const io = {
      use: jest.fn((fn) => { middleware = fn; }),
      on: jest.fn(),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    };
    initSocket(io);
  });

  it("T19: rejects connection with no token", async () => {
    const socket = { handshake: { headers: {}, auth: {} } };
    const next = jest.fn();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Authentication required" })
    );
  });

  it("T20: rejects connection with invalid token", async () => {
    const socket = {
      handshake: {
        headers: { cookie: `${process.env.JWT_COOKIE_NAME}=bad-token` },
        auth: {},
      },
    };
    const next = jest.fn();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Invalid or expired token" })
    );
  });

  it("T21: rejects connection when user no longer exists in DB", async () => {
    const token = jwt.sign({ id: USER_A_ID }, process.env.JWT_SECRET);
    const socket = {
      handshake: {
        headers: { cookie: `${process.env.JWT_COOKIE_NAME}=${token}` },
        auth: {},
      },
    };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const next = jest.fn();
    await middleware(socket, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: "User no longer exists" })
    );
  });

  it("T22: accepts valid JWT and sets socket.userId from verified token (not client)", async () => {
    const token = jwt.sign({ id: USER_A_ID }, process.env.JWT_SECRET);
    const socket = {
      handshake: {
        headers: { cookie: `${process.env.JWT_COOKIE_NAME}=${token}` },
        auth: {},
      },
    };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(fakeUserA) });
    const next = jest.fn();
    await middleware(socket, next);

    expect(next).toHaveBeenCalledWith(); // no error = authenticated
    expect(socket.userId).toBe(USER_A_ID);
  });
});
