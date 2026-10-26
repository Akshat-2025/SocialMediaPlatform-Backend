const mongoose = require("mongoose");

jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");
jest.mock("../../src/models/Message.model");

const Conversation = require("../../src/models/Conversation.model");
const Message = require("../../src/models/Message.model");
const { initSocket, onlineUsers } = require("../../src/sockets/index");

const SENDER_ID = new mongoose.Types.ObjectId().toString();
const RECIPIENT_ID = new mongoose.Types.ObjectId().toString();
const THIRD_PARTY_ID = new mongoose.Types.ObjectId().toString();
const CONV_ID = new mongoose.Types.ObjectId().toString();
const MSG_ID = new mongoose.Types.ObjectId().toString();

describe("Socket Real-Time Messaging (message:send)", () => {
  let ioMock;
  let socket;
  let eventHandlers;
  let ioToEmitMock;
  let socketToEmitMock;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();
    eventHandlers = {};

    ioToEmitMock = jest.fn();
    socketToEmitMock = jest.fn();

    ioMock = {
      use: jest.fn(),
      on: jest.fn((event, fn) => {
        if (event === "connection") {
          // Connect socket
          socket = {
            id: "socket-sender-1",
            userId: SENDER_ID,
            join: jest.fn(),
            leave: jest.fn(),
            to: jest.fn().mockReturnValue({ emit: socketToEmitMock }),
            emit: jest.fn(),
            on: jest.fn((evt, handler) => {
              eventHandlers[evt] = handler;
            }),
          };
          fn(socket);
        }
      }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: ioToEmitMock }),
    };

    initSocket(ioMock);
  });

  describe("Validation & Authorization", () => {
    it("rejects invalid payload (null or non-object)", async () => {
      const ack = jest.fn();
      await eventHandlers["message:send"](null, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Invalid payload",
      });
      expect(Message.create).not.toHaveBeenCalled();
    });

    it("rejects when conversationId is missing or invalid ObjectId", async () => {
      const ack = jest.fn();
      await eventHandlers["message:send"]({ conversationId: "not-a-valid-id", content: "Hi" }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Invalid conversation id",
      });
      expect(Message.create).not.toHaveBeenCalled();
    });

    it("rejects empty or whitespace-only message content", async () => {
      const ack = jest.fn();
      await eventHandlers["message:send"]({ conversationId: CONV_ID, content: "    " }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Message cannot be empty",
      });
      expect(Message.create).not.toHaveBeenCalled();
    });

    it("rejects excessively long message (>2000 chars)", async () => {
      const ack = jest.fn();
      const longMessage = "a".repeat(2001);
      await eventHandlers["message:send"]({ conversationId: CONV_ID, content: longMessage }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Message is too long",
      });
      expect(Message.create).not.toHaveBeenCalled();
    });

    it("returns error acknowledgement when conversation is not found", async () => {
      Conversation.findById.mockResolvedValue(null);

      const ack = jest.fn();
      await eventHandlers["message:send"]({ conversationId: CONV_ID, content: "Hello" }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Conversation not found",
      });
      expect(Message.create).not.toHaveBeenCalled();
    });

    it("rejects when sender is not a participant of the conversation", async () => {
      Conversation.findById.mockResolvedValue({
        _id: CONV_ID,
        participants: [RECIPIENT_ID, THIRD_PARTY_ID], // SENDER_ID is missing
      });

      const ack = jest.fn();
      await eventHandlers["message:send"]({ conversationId: CONV_ID, content: "Unauthorized message" }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Not part of this conversation",
      });
      expect(Message.create).not.toHaveBeenCalled();
      expect(ioMock.to).not.toHaveBeenCalled();
    });
  });

  describe("Successful Message Persistence & Real-Time Broadcast", () => {
    it("saves message to MongoDB, updates conversation, emits to recipients, and invokes ack", async () => {
      const mockSaveConv = jest.fn().mockResolvedValue(true);
      const conversationDoc = {
        _id: CONV_ID,
        participants: [SENDER_ID, RECIPIENT_ID],
        lastMessage: null,
        lastMessageAt: null,
        save: mockSaveConv,
      };
      Conversation.findById.mockResolvedValue(conversationDoc);

      const mockPopulate = jest.fn().mockResolvedValue(true);
      const savedMessage = {
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID,
        content: "Hello recipient!",
        readBy: [SENDER_ID],
        createdAt: new Date(),
        populate: mockPopulate,
      };
      Message.create.mockResolvedValue(savedMessage);

      const ack = jest.fn();
      await eventHandlers["message:send"](
        { conversationId: CONV_ID, content: "  Hello recipient!  " },
        ack
      );

      // 1. Message created with trimmed content and authenticated socket userId
      expect(Message.create).toHaveBeenCalledWith({
        conversation: CONV_ID,
        sender: SENDER_ID,
        content: "Hello recipient!",
        readBy: [SENDER_ID],
      });

      // 2. Conversation metadata updated and saved
      expect(conversationDoc.lastMessage).toBe(MSG_ID);
      expect(conversationDoc.lastMessageAt).toEqual(savedMessage.createdAt);
      expect(mockSaveConv).toHaveBeenCalled();

      // 3. Sender populated
      expect(mockPopulate).toHaveBeenCalledWith("sender", "username fullName avatar");

      // 4. Emitted to recipient's personal room
      expect(ioMock.to).toHaveBeenCalledWith(`user:${RECIPIENT_ID}`);
      expect(ioToEmitMock).toHaveBeenCalledWith("message:new", {
        conversationId: CONV_ID,
        message: savedMessage,
      });

      // 5. Emitted to sender's other connected sockets (excluding current socket)
      expect(socket.to).toHaveBeenCalledWith(`user:${SENDER_ID}`);
      expect(socketToEmitMock).toHaveBeenCalledWith("message:new", {
        conversationId: CONV_ID,
        message: savedMessage,
      });

      // 6. Current socket itself received the success acknowledgement
      expect(ack).toHaveBeenCalledWith({
        success: true,
        message: savedMessage,
      });
    });

    it("gracefully completes without error if client omitted the ack callback", async () => {
      const mockSaveConv = jest.fn().mockResolvedValue(true);
      Conversation.findById.mockResolvedValue({
        _id: CONV_ID,
        participants: [SENDER_ID, RECIPIENT_ID],
        save: mockSaveConv,
      });

      Message.create.mockResolvedValue({
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID,
        content: "No ack callback test",
        createdAt: new Date(),
        populate: jest.fn().mockResolvedValue(true),
      });

      // Omit callback argument entirely
      await expect(
        eventHandlers["message:send"]({ conversationId: CONV_ID, content: "No ack callback test" })
      ).resolves.not.toThrow();

      expect(ioMock.to).toHaveBeenCalledWith(`user:${RECIPIENT_ID}`);
    });
  });

  describe("Failure and Rollback Handling", () => {
    it("does not broadcast when database save fails and returns failure ack", async () => {
      Conversation.findById.mockResolvedValue({
        _id: CONV_ID,
        participants: [SENDER_ID, RECIPIENT_ID],
        save: jest.fn(),
      });

      Message.create.mockRejectedValue(new Error("Mongo network error"));

      const ack = jest.fn();
      await eventHandlers["message:send"]({ conversationId: CONV_ID, content: "Will fail" }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Failed to send message",
      });

      // No message:new broadcast
      expect(ioMock.to).not.toHaveBeenCalled();
      expect(socket.to).not.toHaveBeenCalled();
    });

    it("does not broadcast when conversation metadata update fails", async () => {
      const mockSaveConv = jest.fn().mockRejectedValue(new Error("Mongo write error"));
      Conversation.findById.mockResolvedValue({
        _id: CONV_ID,
        participants: [SENDER_ID, RECIPIENT_ID],
        save: mockSaveConv,
      });

      Message.create.mockResolvedValue({
        _id: MSG_ID,
        conversation: CONV_ID,
        sender: SENDER_ID,
        content: "Will fail on conv save",
        createdAt: new Date(),
        populate: jest.fn().mockResolvedValue(true),
      });

      const ack = jest.fn();
      await eventHandlers["message:send"]({ conversationId: CONV_ID, content: "Will fail on conv save" }, ack);

      expect(ack).toHaveBeenCalledWith({
        success: false,
        message: "Failed to send message",
      });

      expect(ioMock.to).not.toHaveBeenCalled();
      expect(socket.to).not.toHaveBeenCalled();
    });
  });
});
