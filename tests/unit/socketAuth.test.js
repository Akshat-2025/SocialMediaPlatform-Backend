const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");

const User = require("../../src/models/User.model");
const Conversation = require("../../src/models/Conversation.model");
const { initSocket, onlineUsers } = require("../../src/sockets/index");
const { makeQuery } = require("../helpers/mockQuery");

const USER_ID = new mongoose.Types.ObjectId().toString();
const OTHER_USER_ID = new mongoose.Types.ObjectId().toString();
const CONV_ID = new mongoose.Types.ObjectId().toString();

const fakeUser = {
  _id: USER_ID,
  username: "chatuser",
  fullName: "Chat User",
  avatar: { url: "", publicId: "" },
};

describe("Socket.IO Initialization and Authentication", () => {
  let ioMock;
  let middleware;
  let connectionHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    onlineUsers.clear();

    ioMock = {
      use: jest.fn((fn) => {
        middleware = fn;
      }),
      on: jest.fn((event, fn) => {
        if (event === "connection") {
          connectionHandler = fn;
        }
      }),
      emit: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    };

    initSocket(ioMock);
  });

  describe("Authentication Middleware", () => {
    it("rejects connection when no cookie or token is provided", async () => {
      const socket = {
        handshake: {
          headers: {},
          auth: {},
        },
      };
      const next = jest.fn();

      await middleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication required");
    });

    it("rejects connection when token is invalid or expired", async () => {
      const socket = {
        handshake: {
          headers: {
            cookie: `${process.env.JWT_COOKIE_NAME}=invalid-token-string`,
          },
          auth: {},
        },
      };
      const next = jest.fn();

      await middleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Invalid or expired token");
    });

    it("rejects connection when user is not found in database", async () => {
      const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET);
      const socket = {
        handshake: {
          headers: {
            cookie: `${process.env.JWT_COOKIE_NAME}=${token}`,
          },
          auth: {},
        },
      };
      const next = jest.fn();

      User.findById.mockReturnValue(makeQuery(null));

      await middleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("User no longer exists");
    });

    it("authenticates successfully via HTTP-only cookie and attaches user context", async () => {
      const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET);
      const socket = {
        handshake: {
          headers: {
            cookie: `${process.env.JWT_COOKIE_NAME}=${token}`,
          },
          auth: {},
        },
      };
      const next = jest.fn();

      User.findById.mockReturnValue(makeQuery(fakeUser));

      await middleware(socket, next);

      expect(next).toHaveBeenCalledWith();
      expect(socket.userId).toBe(USER_ID);
      expect(socket.user).toEqual(fakeUser);
    });

    it("authenticates successfully via handshake auth.token fallback", async () => {
      const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET);
      const socket = {
        handshake: {
          headers: {},
          auth: { token },
        },
      };
      const next = jest.fn();

      User.findById.mockReturnValue(makeQuery(fakeUser));

      await middleware(socket, next);

      expect(next).toHaveBeenCalledWith();
      expect(socket.userId).toBe(USER_ID);
    });

    it("authenticates successfully via Authorization Bearer header fallback", async () => {
      const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET);
      const socket = {
        handshake: {
          headers: {
            authorization: `Bearer ${token}`,
          },
          auth: {},
        },
      };
      const next = jest.fn();

      User.findById.mockReturnValue(makeQuery(fakeUser));

      await middleware(socket, next);

      expect(next).toHaveBeenCalledWith();
      expect(socket.userId).toBe(USER_ID);
    });
  });

  describe("Socket Connection and Event Routing", () => {
    let socket;
    let eventHandlers;

    beforeEach(() => {
      eventHandlers = {};
      socket = {
        id: "socket-123",
        userId: USER_ID,
        user: fakeUser,
        join: jest.fn(),
        leave: jest.fn(),
        on: jest.fn((event, fn) => {
          eventHandlers[event] = fn;
        }),
      };

      connectionHandler(socket);
    });

    it("joins user's personal room and broadcasts online status", () => {
      expect(socket.join).toHaveBeenCalledWith(`user:${USER_ID}`);
      expect(ioMock.emit).toHaveBeenCalledWith("user:online", { userId: USER_ID });
      expect(onlineUsers.has(USER_ID)).toBe(true);
      expect(onlineUsers.get(USER_ID).has("socket-123")).toBe(true);
    });

    it("allows joining conversation room when user is a verified participant", async () => {
      Conversation.findOne.mockResolvedValue({
        _id: CONV_ID,
        participants: [USER_ID, OTHER_USER_ID],
      });

      await eventHandlers["conversation:join"]({ conversationId: CONV_ID });

      expect(Conversation.findOne).toHaveBeenCalledWith({
        _id: CONV_ID,
        participants: USER_ID,
      });
      expect(socket.join).toHaveBeenCalledWith(`conv:${CONV_ID}`);
    });

    it("does not join conversation room when user is not a participant", async () => {
      Conversation.findOne.mockResolvedValue(null);

      await eventHandlers["conversation:join"]({ conversationId: CONV_ID });

      expect(socket.join).not.toHaveBeenCalledWith(`conv:${CONV_ID}`);
    });

    it("relays typing indicator to recipient's personal room", () => {
      const recipientEmit = jest.fn();
      ioMock.to.mockReturnValue({ emit: recipientEmit });

      eventHandlers["message:typing"]({
        conversationId: CONV_ID,
        recipientId: OTHER_USER_ID,
      });

      expect(ioMock.to).toHaveBeenCalledWith(`user:${OTHER_USER_ID}`);
      expect(recipientEmit).toHaveBeenCalledWith("message:typing", {
        conversationId: CONV_ID,
        userId: USER_ID,
      });
    });

    it("handles disconnect and broadcasts offline status when user has no active sockets", () => {
      eventHandlers["disconnect"]();

      expect(onlineUsers.has(USER_ID)).toBe(false);
      expect(ioMock.emit).toHaveBeenCalledWith("user:offline", { userId: USER_ID });
    });
  });
});
