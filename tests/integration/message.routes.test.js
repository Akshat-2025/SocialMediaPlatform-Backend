const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../src/config/cloudinary");
jest.mock("../../src/models/User.model");
jest.mock("../../src/models/Conversation.model");
jest.mock("../../src/models/Message.model");

const User = require("../../src/models/User.model");
const Conversation = require("../../src/models/Conversation.model");
const Message = require("../../src/models/Message.model");
const { makeQuery } = require("../helpers/mockQuery");

const app = require("../../src/app");

const USER_ONE_ID = new mongoose.Types.ObjectId().toString();
const USER_TWO_ID = new mongoose.Types.ObjectId().toString();
const USER_THREE_ID = new mongoose.Types.ObjectId().toString();
const CONV_ID = new mongoose.Types.ObjectId().toString();
const MSG_ID = new mongoose.Types.ObjectId().toString();

const fakeUserOne = {
  _id: USER_ONE_ID,
  username: "userone",
  fullName: "User One",
  avatar: { url: "", publicId: "" },
};

const fakeUserTwo = {
  _id: USER_TWO_ID,
  username: "usertwo",
  fullName: "User Two",
  avatar: { url: "", publicId: "" },
};

const authCookie = (userId = USER_ONE_ID) => {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "15m" });
  return `${process.env.JWT_COOKIE_NAME}=${token}`;
};

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue(makeQuery(fakeUserOne));
});

describe("GET /api/messages/conversations", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/messages/conversations");
    expect(res.status).toBe(401);
  });

  it("returns 200 with paginated conversations for authenticated user", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [fakeUserOne, fakeUserTwo],
      lastMessage: null,
      lastMessageAt: new Date(),
    };

    Conversation.find.mockReturnValue(makeQuery([fakeConversation]));
    Conversation.countDocuments.mockReturnValue(makeQuery(1));

    const res = await request(app)
      .get("/api/messages/conversations?page=1&limit=20")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.conversations)).toBe(true);
    expect(res.body.conversations.length).toBe(1);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.total).toBe(1);
  });
});

describe("POST /api/messages/conversations/:userId", () => {
  it("returns 400 when invalid user id provided", async () => {
    const res = await request(app)
      .post("/api/messages/conversations/not-a-valid-id")
      .set("Cookie", authCookie());

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid user id/i);
  });

  it("returns 400 when trying to message yourself", async () => {
    const res = await request(app)
      .post(`/api/messages/conversations/${USER_ONE_ID}`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot message yourself/i);
  });

  it("creates a new conversation if none exists", async () => {
    Conversation.findOne.mockReturnValue(makeQuery(null));

    const createdConv = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      populate: jest.fn().mockResolvedValue(true),
    };
    Conversation.create.mockResolvedValue(createdConv);

    const res = await request(app)
      .post(`/api/messages/conversations/${USER_TWO_ID}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Conversation.create).toHaveBeenCalledWith({
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
  });

  it("returns existing conversation without creating a new one", async () => {
    const existingConv = {
      _id: CONV_ID,
      participants: [fakeUserOne, fakeUserTwo],
    };
    Conversation.findOne.mockReturnValue(makeQuery(existingConv));

    const res = await request(app)
      .post(`/api/messages/conversations/${USER_TWO_ID}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Conversation.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/messages/conversations/:conversationId/messages", () => {
  it("returns 400 when conversationId is not a valid ObjectId", async () => {
    const res = await request(app)
      .get("/api/messages/conversations/not-a-valid-id/messages")
      .set("Cookie", authCookie());

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid conversation id/i);
  });

  it("returns 404 when conversation not found", async () => {
    Conversation.findById.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(404);
  });

  it("returns 403 when user is not a participant in conversation", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_TWO_ID, USER_THREE_ID],
    });

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not part of this conversation/i);
  });

  it("returns 200 with paginated messages for a participant and handles invalid pagination params", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: fakeUserOne,
      content: "Hello there",
      readBy: [USER_ONE_ID],
      createdAt: new Date(),
    };

    Message.find.mockReturnValue(makeQuery([fakeMessage]));
    Message.countDocuments.mockReturnValue(makeQuery(1));

    // Request with invalid/negative page and limit
    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}/messages?page=-5&limit=1000`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages.length).toBe(1);
    expect(res.body.messages[0].content).toBe("Hello there");
    // Normalizes limit to maximum 50 and page to 1
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(50);
  });

  it("allows a previously disconnected recipient to retrieve saved message history", async () => {
    // User Two retrieves messages in a conversation where User One sent a message
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });

    const persistedMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: fakeUserOne,
      content: "Message sent while User Two was offline",
      readBy: [USER_ONE_ID],
      createdAt: new Date(Date.now() - 60000),
    };

    Message.find.mockReturnValue(makeQuery([persistedMessage]));
    Message.countDocuments.mockReturnValue(makeQuery(1));

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_TWO_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages.length).toBe(1);
    expect(res.body.messages[0].content).toBe("Message sent while User Two was offline");
  });
});

describe("POST /api/messages/conversations/:conversationId/messages", () => {
  it("returns 400 when conversationId is invalid", async () => {
    const res = await request(app)
      .post("/api/messages/conversations/not-a-valid-id/messages")
      .set("Cookie", authCookie())
      .send({ content: "Valid text" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid conversation id/i);
  });

  it("returns 400 when content is empty", async () => {
    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie())
      .send({ content: "" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/validation failed/i);
  });

  it("returns 400 when content is whitespace only", async () => {
    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie())
      .send({ content: "     " });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/validation failed/i);
  });

  it("returns 400 when content exceeds 2000 characters", async () => {
    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie())
      .send({ content: "a".repeat(2001) });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/validation failed/i);
  });

  it("returns 404 when conversation not found", async () => {
    Conversation.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie())
      .send({ content: "Hello" });

    expect(res.status).toBe(404);
  });

  it("returns 403 when sender is not a participant", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_TWO_ID, USER_THREE_ID],
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ content: "Unauthorized message" });

    expect(res.status).toBe(403);
  });

  it("creates a message and emits message:new to participants", async () => {
    const mockSaveConv = jest.fn().mockResolvedValue(true);
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      save: mockSaveConv,
    });

    const mockPopulate = jest.fn().mockResolvedValue(true);
    const createdMsg = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: USER_ONE_ID,
      content: "Hi User Two!",
      readBy: [USER_ONE_ID],
      createdAt: new Date(),
      populate: mockPopulate,
    };
    Message.create.mockResolvedValue(createdMsg);

    const emitMock = jest.fn();
    const ioMock = {
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    };
    app.set("io", ioMock);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ content: "Hi User Two!" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message.content).toBe("Hi User Two!");
    expect(mockSaveConv).toHaveBeenCalled();
    expect(ioMock.to).toHaveBeenCalledWith(`user:${USER_TWO_ID}`);
    expect(emitMock).toHaveBeenCalledWith("message:new", expect.objectContaining({
      conversationId: CONV_ID,
    }));
  });

  it("handles database save failure without emitting socket events", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      save: jest.fn(),
    });

    Message.create.mockRejectedValue(new Error("Database connection lost"));

    const emitMock = jest.fn();
    const ioMock = {
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    };
    app.set("io", ioMock);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ content: "This will fail in DB" });

    expect(res.status).toBe(500);
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/messages/conversations/:conversationId/read", () => {
  it("marks messages in conversation as read for current user", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
    Message.updateMany.mockResolvedValue({ modifiedCount: 3 });

    const res = await request(app)
      .patch(`/api/messages/conversations/${CONV_ID}/read`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Message.updateMany).toHaveBeenCalledWith(
      { conversation: CONV_ID, readBy: { $ne: USER_ONE_ID } },
      { $addToSet: { readBy: USER_ONE_ID } }
    );
  });
});
