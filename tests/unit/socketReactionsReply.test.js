/**
 * Phase 6 Unit Tests: Message Reactions and Reply-to-Message (Socket.IO)
 *
 * Tests:
 * 1. `message:send` with `replyTo` (valid, invalid ID, not found, cross-conversation)
 * 2. `message:react` (add, update, remove via null/empty, membership, validation)
 * 3. `message:reaction:remove` (remove own reaction, reaction not found, membership)
 */

const mongoose = require("mongoose");

jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");
jest.mock("../../src/models/Message.model");

const Conversation = require("../../src/models/Conversation.model");
const Message = require("../../src/models/Message.model");
const { initSocket, onlineUsers, typingTimers } = require("../../src/sockets/index");

const SENDER_ID = new mongoose.Types.ObjectId().toString();
const RECIPIENT_ID = new mongoose.Types.ObjectId().toString();
const OUTSIDER_ID = new mongoose.Types.ObjectId().toString();
const CONV_ID = new mongoose.Types.ObjectId().toString();
const OTHER_CONV_ID = new mongoose.Types.ObjectId().toString();
const MSG_ID = new mongoose.Types.ObjectId().toString();
const REPLIED_MSG_ID = new mongoose.Types.ObjectId().toString();

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
    on: jest.fn((event, fn) => {
      handlers[event] = fn;
    }),
    _handlers: handlers,
    _toEmit: socketToEmit,
  };
};

const buildIo = (socket) => {
  const ioToEmit = jest.fn();
  const io = {
    use: jest.fn(),
    on: jest.fn((event, fn) => {
      if (event === "connection") fn(socket);
    }),
    emit: jest.fn(),
    to: jest.fn().mockReturnValue({ emit: ioToEmit }),
    _toEmit: ioToEmit,
  };
  return io;
};

describe("Phase 6 – Socket reply-to-message (message:send)", () => {
  let io, socket;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();

    socket = buildSocket(SENDER_ID);
    io = buildIo(socket);
    initSocket(io);
  });

  it("SR1: sends message with valid replyTo in same conversation", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
      lastMessage: null,
      lastMessageAt: null,
      save: jest.fn().mockResolvedValue(true),
    };

    const originalMessage = {
      _id: REPLIED_MSG_ID,
      conversation: CONV_ID,
      sender: RECIPIENT_ID,
      content: "Original question?",
    };

    const createdMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: SENDER_ID,
      content: "My answer",
      replyTo: REPLIED_MSG_ID,
      createdAt: new Date(),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findById.mockResolvedValue(fakeConversation);
    Message.findById.mockResolvedValue(originalMessage);
    Message.create.mockResolvedValue(createdMessage);

    const ack = jest.fn();
    await socket._handlers["message:send"](
      {
        conversationId: CONV_ID,
        content: "My answer",
        replyTo: REPLIED_MSG_ID,
      },
      ack
    );

    expect(Message.findById).toHaveBeenCalledWith(REPLIED_MSG_ID);
    expect(Message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: CONV_ID,
        sender: SENDER_ID,
        content: "My answer",
        replyTo: REPLIED_MSG_ID,
      })
    );
    expect(createdMessage.populate).toHaveBeenCalledWith(
      "sender",
      "username fullName avatar"
    );
    expect(createdMessage.populate).toHaveBeenCalledWith({
      path: "replyTo",
      select: "content sender createdAt",
      populate: { path: "sender", select: "username fullName avatar" },
    });
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: createdMessage })
    );
  });

  it("SR2: rejects replyTo if not a valid ObjectId", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });

    const ack = jest.fn();
    await socket._handlers["message:send"](
      {
        conversationId: CONV_ID,
        content: "Replying...",
        replyTo: "invalid-id",
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Invalid reply reference",
    });
    expect(Message.create).not.toHaveBeenCalled();
  });

  it("SR3: returns error ack if replied-to message is not found", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });
    Message.findById.mockResolvedValue(null);

    const ack = jest.fn();
    await socket._handlers["message:send"](
      {
        conversationId: CONV_ID,
        content: "Replying...",
        replyTo: REPLIED_MSG_ID,
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Replied-to message not found",
    });
    expect(Message.create).not.toHaveBeenCalled();
  });

  it("SR4: returns error ack if replied-to message is from a different conversation", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });
    Message.findById.mockResolvedValue({
      _id: REPLIED_MSG_ID,
      conversation: OTHER_CONV_ID,
      content: "Message in another chat",
    });

    const ack = jest.fn();
    await socket._handlers["message:send"](
      {
        conversationId: CONV_ID,
        content: "Replying across chats...",
        replyTo: REPLIED_MSG_ID,
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Cannot reply to a message from a different conversation",
    });
    expect(Message.create).not.toHaveBeenCalled();
  });
});

describe("Phase 6 – Socket message:react event", () => {
  let io, socket;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();

    socket = buildSocket(SENDER_ID);
    io = buildIo(socket);
    initSocket(io);
  });

  it("R1: adds new reaction, saves message, and emits to all participants", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findOne.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        emoji: "🔥",
      },
      ack
    );

    expect(fakeMessage.reactions).toHaveLength(1);
    expect(fakeMessage.reactions[0].emoji).toBe("🔥");
    expect(fakeMessage.save).toHaveBeenCalled();
    expect(fakeMessage.populate).toHaveBeenCalledWith(
      "reactions.user",
      "username fullName avatar"
    );

    expect(io.to).toHaveBeenCalledWith(`user:${SENDER_ID}`);
    expect(io.to).toHaveBeenCalledWith(`user:${RECIPIENT_ID}`);
    expect(io._toEmit).toHaveBeenCalledWith(
      "message:reaction",
      expect.objectContaining({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        userId: SENDER_ID,
        emoji: "🔥",
        action: "add",
      })
    );

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, action: "add" })
    );
  });

  it("R2: changes/updates reaction when user reacts with a different emoji", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: SENDER_ID, emoji: "👍", createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findOne.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        emoji: "❤️",
      },
      ack
    );

    expect(fakeMessage.reactions).toHaveLength(1);
    expect(fakeMessage.reactions[0].emoji).toBe("❤️");
    expect(fakeMessage.save).toHaveBeenCalled();

    expect(io._toEmit).toHaveBeenCalledWith(
      "message:reaction",
      expect.objectContaining({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        userId: SENDER_ID,
        emoji: "❤️",
        action: "update",
      })
    );
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, action: "update" })
    );
  });

  it("R3: removes reaction when emoji is null or empty string", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: SENDER_ID, emoji: "👍", createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findOne.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        emoji: "",
      },
      ack
    );

    expect(fakeMessage.reactions).toHaveLength(0);
    expect(fakeMessage.save).toHaveBeenCalled();
    expect(io._toEmit).toHaveBeenCalledWith(
      "message:reaction",
      expect.objectContaining({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        userId: SENDER_ID,
        emoji: null,
        action: "remove",
      })
    );
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, action: "remove" })
    );
  });

  it("R4: rejects non-participant calling message:react", async () => {
    Conversation.findOne.mockResolvedValue(null);

    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        emoji: "👍",
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Not part of this conversation",
    });
    expect(Message.findOne).not.toHaveBeenCalled();
  });

  it("R5: returns error when message is not found", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });
    Message.findOne.mockResolvedValue(null);

    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        emoji: "👍",
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Message not found",
    });
  });

  it("R6: rejects invalid messageId or conversationId", async () => {
    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: "invalid",
        messageId: MSG_ID,
        emoji: "👍",
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Invalid conversation id",
    });
  });

  it("R7: rejects emoji that exceeds maximum length", async () => {
    Conversation.findOne.mockResolvedValue({
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    });
    Message.findOne.mockResolvedValue({
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [],
    });

    const ack = jest.fn();
    await socket._handlers["message:react"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
        emoji: "this-is-far-too-long-for-an-emoji",
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Emoji is too long",
    });
  });
});

describe("Phase 6 – Socket message:reaction:remove event", () => {
  let io, socket;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    typingTimers.clear();

    socket = buildSocket(SENDER_ID);
    io = buildIo(socket);
    initSocket(io);
  });

  it("RM1: removes user's own reaction and broadcasts to participants", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: SENDER_ID, emoji: "👍", createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findOne.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const ack = jest.fn();
    await socket._handlers["message:reaction:remove"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
      },
      ack
    );

    expect(fakeMessage.reactions).toHaveLength(0);
    expect(fakeMessage.save).toHaveBeenCalled();
    expect(io._toEmit).toHaveBeenCalledWith(
      "message:reaction",
      expect.objectContaining({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        userId: SENDER_ID,
        emoji: null,
        action: "remove",
      })
    );
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, action: "remove" })
    );
  });

  it("RM2: returns error when user has not reacted to the message", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [SENDER_ID, RECIPIENT_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: RECIPIENT_ID, emoji: "❤️", createdAt: new Date() }],
      save: jest.fn(),
    };

    Conversation.findOne.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const ack = jest.fn();
    await socket._handlers["message:reaction:remove"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
      },
      ack
    );

    expect(fakeMessage.save).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Reaction not found",
    });
  });

  it("RM3: rejects non-participant calling message:reaction:remove", async () => {
    Conversation.findOne.mockResolvedValue(null);

    const ack = jest.fn();
    await socket._handlers["message:reaction:remove"](
      {
        conversationId: CONV_ID,
        messageId: MSG_ID,
      },
      ack
    );

    expect(ack).toHaveBeenCalledWith({
      success: false,
      message: "Not part of this conversation",
    });
  });
});
