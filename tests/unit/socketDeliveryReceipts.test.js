/**
 * Phase 5 Unit Tests: Message Delivery Status and Read Receipts
 *
 * Tests the `message:delivered` socket event and the extended
 * `markConversationRead` HTTP endpoint with real-time status notifications.
 *
 * All Mongoose models are mocked — no real database or network.
 */

const mongoose = require("mongoose");

jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");
jest.mock("../../src/models/Message.model");

const Conversation = require("../../src/models/Conversation.model");
const Message = require("../../src/models/Message.model");
const { initSocket, onlineUsers, typingTimers } = require("../../src/sockets/index");

// ─── Shared IDs ──────────────────────────────────────────────────────────────
const SENDER_ID = new mongoose.Types.ObjectId().toString();
const RECIPIENT_ID = new mongoose.Types.ObjectId().toString();
const OUTSIDER_ID = new mongoose.Types.ObjectId().toString();
const CONV_ID = new mongoose.Types.ObjectId().toString();
const MSG_ID = new mongoose.Types.ObjectId().toString();

// ─── Socket / IO mock helpers ─────────────────────────────────────────────────
const buildSocket = (userId, socketId = "socket-1") => {
  const handlers = {};
  const socketToEmit = jest.fn();
  return {
    id: socketId,
    userId,
    join: jest.fn(),
    leave: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: socketToEmit }),
    emit: jest.fn(),
    on: jest.fn((event, fn) => { handlers[event] = fn; }),
    _handlers: handlers,
    _toEmit: socketToEmit,
  };
};

const buildIo = (socket) => {
  const ioToEmit = jest.fn();
  const io = {
    use: jest.fn(),
    on: jest.fn((event, fn) => { if (event === "connection") fn(socket); }),
    emit: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: ioToEmit }),
    _toEmit: ioToEmit,
  };
  return io;
};

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: message:delivered socket event
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 5 – message:delivered socket event", () => {
  let io, socket;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();
    Conversation.find.mockResolvedValue([]);
    Message.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    // Connect the RECIPIENT's socket
    socket = buildSocket(RECIPIENT_ID);
    io = buildIo(socket);
    initSocket(io);
  });

  // ── D1: happy path — recipient acks delivery ──────────────────────────────
  it("D1: valid ack marks message as delivered and notifies the sender", async () => {
    Message.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID,
        deliveredTo: [], // not yet delivered
      }),
    });

    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });

    const ack = jest.fn();
    await socket._handlers["message:delivered"]({ messageId: MSG_ID }, ack);

    // DB write happened
    expect(Message.updateOne).toHaveBeenCalledWith(
      { _id: MSG_ID },
      { $addToSet: { deliveredTo: RECIPIENT_ID } }
    );

    // Sender notified
    expect(io.to).toHaveBeenCalledWith(`user:${SENDER_ID}`);
    expect(io._toEmit).toHaveBeenCalledWith("message:status", {
      conversationId: CONV_ID.toString(),
      messageIds: [MSG_ID.toString()],
      status: "delivered",
      byUserId: RECIPIENT_ID,
    });

    expect(ack).toHaveBeenCalledWith({ success: true });
  });

  // ── D2: duplicate ack — no extra DB write, sender still notified ──────────
  it("D2: duplicate ack skips DB write but still notifies the sender", async () => {
    Message.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID,
        deliveredTo: [{ toString: () => RECIPIENT_ID }], // already delivered
      }),
    });

    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });

    const ack = jest.fn();
    await socket._handlers["message:delivered"]({ messageId: MSG_ID }, ack);

    // No extra DB write for duplicate
    expect(Message.updateOne).not.toHaveBeenCalled();

    // Sender still notified (UI may need the refresh)
    expect(io._toEmit).toHaveBeenCalledWith("message:status", expect.objectContaining({
      status: "delivered",
    }));

    expect(ack).toHaveBeenCalledWith({ success: true });
  });

  // ── D3: sender cannot ack their own message ───────────────────────────────
  it("D3: sender is rejected when trying to ack their own message", async () => {
    // Connect as the SENDER
    const senderSocket = buildSocket(SENDER_ID, "socket-sender");
    const senderIo = buildIo(senderSocket);
    initSocket(senderIo);

    Message.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID, // same as socket.userId
        deliveredTo: [],
      }),
    });

    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });

    const ack = jest.fn();
    await senderSocket._handlers["message:delivered"]({ messageId: MSG_ID }, ack);

    expect(Message.updateOne).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Cannot acknowledge your own message",
    });
  });

  // ── D4: outsider cannot ack a message they're not party to ───────────────
  it("D4: non-participant ack is rejected", async () => {
    const outsiderSocket = buildSocket(OUTSIDER_ID, "socket-out");
    const outsiderIo = buildIo(outsiderSocket);
    initSocket(outsiderIo);

    Message.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID,
        deliveredTo: [],
      }),
    });

    // Outsider is not in participants
    Conversation.findOne.mockResolvedValue(null);

    const ack = jest.fn();
    await outsiderSocket._handlers["message:delivered"]({ messageId: MSG_ID }, ack);

    expect(Message.updateOne).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Not part of this conversation",
    });
  });

  // ── D5: invalid messageId format ──────────────────────────────────────────
  it("D5: invalid messageId format returns error without hitting the DB", async () => {
    const ack = jest.fn();
    await socket._handlers["message:delivered"]({ messageId: "not-an-id" }, ack);

    expect(Message.findById).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Invalid message id",
    });
  });

  // ── D6: non-existent message returns error ────────────────────────────────
  it("D6: non-existent messageId returns not-found error", async () => {
    Message.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });

    const ack = jest.fn();
    await socket._handlers["message:delivered"]({ messageId: MSG_ID }, ack);

    expect(Message.updateOne).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Message not found",
    });
  });

  // ── D7: null payload is rejected cleanly ─────────────────────────────────
  it("D7: null payload returns error", async () => {
    const ack = jest.fn();
    await socket._handlers["message:delivered"](null, ack);

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Invalid payload",
    });
  });

  // ── D8: missing messageId field ───────────────────────────────────────────
  it("D8: missing messageId field returns error", async () => {
    const ack = jest.fn();
    await socket._handlers["message:delivered"]({}, ack);

    expect(Message.findById).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Invalid message id",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: message:send socket path — deliveredTo initialisation
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 5 – message:send socket creates message with deliveredTo", () => {
  let io, socket, ioToEmit;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();
    Conversation.find.mockResolvedValue([]);

    ioToEmit = jest.fn();
    socket = buildSocket(SENDER_ID);
    io = {
      use: jest.fn(),
      on: jest.fn((event, fn) => { if (event === "connection") fn(socket); }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: ioToEmit }),
    };
    initSocket(io);
  });

  it("S1: message:send creates message with deliveredTo containing sender", async () => {
    const fakeConv = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
      save: jest.fn().mockResolvedValue(true),
    };
    Conversation.findById.mockResolvedValue(fakeConv);

    const fakeMsg = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: SENDER_ID,
      content: "hello",
      readBy: [SENDER_ID],
      deliveredTo: [SENDER_ID], // sender pre-populated
      createdAt: new Date(),
      populate: jest.fn().mockResolvedValue(undefined),
    };
    Message.create.mockResolvedValue(fakeMsg);

    const ack = jest.fn();
    await socket._handlers["message:send"](
      { conversationId: CONV_ID, content: "hello" },
      ack
    );

    expect(Message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveredTo: [SENDER_ID],
      })
    );
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: markConversationRead HTTP — real-time status notification
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 5 – markConversationRead HTTP emits message:status", () => {
  // We test the controller directly rather than through supertest because
  // the markConversationRead function is pure async Express — easy to unit-test.
  const { markConversationRead } = require("../../src/controllers/message.controller");

  const makeRes = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  };

  const makeReq = (overrides = {}) => ({
    params: { conversationId: CONV_ID },
    user: { _id: RECIPIENT_ID },
    app: {
      get: jest.fn().mockReturnValue(null), // io = null by default
    },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("R1: marks messages read and emits message:status to senders", async () => {
    // loadOwnedConversation calls Conversation.findById
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [
        { toString: () => SENDER_ID },
        { toString: () => RECIPIENT_ID },
      ],
    });

    const unread = [
      { _id: MSG_ID, sender: { toString: () => SENDER_ID } },
    ];
    Message.find.mockReturnValue({
      select: jest.fn().mockResolvedValue(unread),
    });
    Message.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const ioEmit = jest.fn();
    const fakeIo = { to: jest.fn().mockReturnValue({ emit: ioEmit }) };

    const req = makeReq({
      app: { get: jest.fn().mockReturnValue(fakeIo) },
    });
    const res = makeRes();
    const next = jest.fn();

    await markConversationRead(req, res, next);

    // DB updated
    expect(Message.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [MSG_ID] } },
      { $addToSet: { readBy: RECIPIENT_ID, deliveredTo: RECIPIENT_ID } }
    );

    // Sender notified
    expect(fakeIo.to).toHaveBeenCalledWith(`user:${SENDER_ID}`);
    expect(ioEmit).toHaveBeenCalledWith("message:status", {
      conversationId: CONV_ID.toString(),
      messageIds: [MSG_ID.toString()],
      status: "read",
      byUserId: RECIPIENT_ID.toString(),
    });

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("R2: when all messages already read, returns 200 without DB write", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [
        { toString: () => SENDER_ID },
        { toString: () => RECIPIENT_ID },
      ],
    });

    // No unread messages
    Message.find.mockReturnValue({
      select: jest.fn().mockResolvedValue([]),
    });

    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await markConversationRead(req, res, next);

    expect(Message.updateMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("R3: no io instance — still marks read, just no socket emit", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [
        { toString: () => SENDER_ID },
        { toString: () => RECIPIENT_ID },
      ],
    });

    Message.find.mockReturnValue({
      select: jest.fn().mockResolvedValue([
        { _id: MSG_ID, sender: { toString: () => SENDER_ID } },
      ]),
    });
    Message.updateMany.mockResolvedValue({ modifiedCount: 1 });

    // io is null (no socket server)
    const req = makeReq({ app: { get: jest.fn().mockReturnValue(null) } });
    const res = makeRes();
    const next = jest.fn();

    await markConversationRead(req, res, next);

    expect(Message.updateMany).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    // No socket errors thrown
    expect(next).not.toHaveBeenCalled();
  });

  it("R4: non-participant gets 403 — no DB write", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [
        { toString: () => SENDER_ID },
        { toString: () => OUTSIDER_ID },
      ],
    });

    const req = makeReq({
      user: { _id: RECIPIENT_ID }, // RECIPIENT_ID not in participants
    });
    const res = makeRes();
    const next = jest.fn();

    await markConversationRead(req, res, next);

    expect(Message.updateMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("R5: multiple messages from the same sender are grouped into one event", async () => {
    const MSG_ID_2 = new mongoose.Types.ObjectId().toString();

    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [
        { toString: () => SENDER_ID },
        { toString: () => RECIPIENT_ID },
      ],
    });

    Message.find.mockReturnValue({
      select: jest.fn().mockResolvedValue([
        { _id: MSG_ID, sender: { toString: () => SENDER_ID } },
        { _id: MSG_ID_2, sender: { toString: () => SENDER_ID } },
      ]),
    });
    Message.updateMany.mockResolvedValue({ modifiedCount: 2 });

    const ioEmit = jest.fn();
    const fakeIo = { to: jest.fn().mockReturnValue({ emit: ioEmit }) };

    const req = makeReq({ app: { get: jest.fn().mockReturnValue(fakeIo) } });
    const res = makeRes();
    const next = jest.fn();

    await markConversationRead(req, res, next);

    // Only ONE emission with both message IDs
    expect(fakeIo.to).toHaveBeenCalledTimes(1);
    expect(ioEmit).toHaveBeenCalledWith("message:status", expect.objectContaining({
      messageIds: expect.arrayContaining([MSG_ID.toString(), MSG_ID_2.toString()]),
      status: "read",
    }));
  });

  it("R6: invalid conversationId returns 400 without hitting Message", async () => {
    const req = {
      params: { conversationId: "bad-id" },
      user: { _id: RECIPIENT_ID },
      app: { get: jest.fn() },
    };
    const res = makeRes();
    await markConversationRead(req, res, jest.fn());

    expect(Message.updateMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Status derivation semantics (documented contract)
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 5 – Status derivation semantics", () => {
  /**
   * Status is derived from deliveredTo/readBy, never stored as an enum.
   * These tests verify the logic a client or helper would use to derive status.
   */

  const deriveStatus = (message, recipientId) => {
    const rid = recipientId.toString();
    if (message.readBy.map(String).includes(rid)) return "read";
    if (message.deliveredTo.map(String).includes(rid)) return "delivered";
    return "sent";
  };

  it("SD1: message in neither array → sent", () => {
    const msg = { readBy: [], deliveredTo: [] };
    expect(deriveStatus(msg, RECIPIENT_ID)).toBe("sent");
  });

  it("SD2: message in deliveredTo only → delivered", () => {
    const msg = { readBy: [], deliveredTo: [RECIPIENT_ID] };
    expect(deriveStatus(msg, RECIPIENT_ID)).toBe("delivered");
  });

  it("SD3: message in readBy → read (regardless of deliveredTo)", () => {
    const msg = { readBy: [RECIPIENT_ID], deliveredTo: [RECIPIENT_ID] };
    expect(deriveStatus(msg, RECIPIENT_ID)).toBe("read");
  });

  it("SD4: message in readBy without deliveredTo → still read", () => {
    // readBy implies delivered; deliveredTo needn't be populated separately
    const msg = { readBy: [RECIPIENT_ID], deliveredTo: [] };
    expect(deriveStatus(msg, RECIPIENT_ID)).toBe("read");
  });

  it("SD5: sender's own message → sent (sender should be excluded from status checks)", () => {
    const msg = { readBy: [SENDER_ID], deliveredTo: [SENDER_ID] };
    // From the perspective of RECIPIENT_ID (who hasn't touched it)
    expect(deriveStatus(msg, RECIPIENT_ID)).toBe("sent");
  });
});
