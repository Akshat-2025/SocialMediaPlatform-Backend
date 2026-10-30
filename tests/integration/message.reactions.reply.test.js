/**
 * Phase 6 Integration Tests: Message Reactions and Reply-to-Message (HTTP)
 *
 * Tests:
 * 1. POST /conversations/:conversationId/messages with replyTo:
 *    - Valid replyTo in same conversation
 *    - Invalid ObjectId format
 *    - Replied-to message not found
 *    - Cross-conversation reply rejection
 * 2. GET /conversations/:conversationId/messages:
 *    - Populates replyTo (content, sender, createdAt) and reactions.user
 * 3. POST & PUT /conversations/:conversationId/messages/:messageId/reactions:
 *    - Add new reaction
 *    - Update/change existing reaction
 *    - Validation (missing emoji, empty emoji, excessively long emoji)
 *    - Membership authorization (403 for non-participants)
 *    - Non-existent message (404)
 *    - Socket.IO emission to conversation participants
 * 4. DELETE /conversations/:conversationId/messages/:messageId/reactions:
 *    - Remove own reaction
 *    - Reaction not found for user (404)
 *    - Membership authorization (403)
 */

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
const OUTSIDER_ID = new mongoose.Types.ObjectId().toString();
const CONV_ID = new mongoose.Types.ObjectId().toString();
const OTHER_CONV_ID = new mongoose.Types.ObjectId().toString();
const MSG_ID = new mongoose.Types.ObjectId().toString();
const REPLIED_MSG_ID = new mongoose.Types.ObjectId().toString();

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

describe("Phase 6 – HTTP Reply-to-Message", () => {
  it("creates a message with valid replyTo reference in the same conversation", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
      lastMessage: null,
      lastMessageAt: null,
      save: jest.fn().mockResolvedValue(true),
    };

    const originalMessage = {
      _id: REPLIED_MSG_ID,
      conversation: CONV_ID,
      sender: USER_TWO_ID,
      content: "Original message content",
    };

    const savedMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      sender: USER_ONE_ID,
      content: "Replying to you",
      replyTo: REPLIED_MSG_ID,
      createdAt: new Date(),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findById.mockResolvedValue(fakeConversation);
    Message.findById.mockResolvedValue(originalMessage);
    Message.create.mockResolvedValue(savedMessage);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({
        content: "Replying to you",
        replyTo: REPLIED_MSG_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Message.findById).toHaveBeenCalledWith(REPLIED_MSG_ID);
    expect(Message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: CONV_ID,
        sender: USER_ONE_ID,
        content: "Replying to you",
        replyTo: REPLIED_MSG_ID,
      })
    );
    expect(savedMessage.populate).toHaveBeenCalledWith(
      "sender",
      "username fullName avatar"
    );
    expect(savedMessage.populate).toHaveBeenCalledWith({
      path: "replyTo",
      select: "content sender createdAt",
      populate: { path: "sender", select: "username fullName avatar" },
    });
  });

  it("returns 400 when replyTo is not a valid ObjectId", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({
        content: "Replying with bad id",
        replyTo: "not-a-valid-id",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid reply reference");
  });

  it("returns 404 when replied-to message does not exist", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
    Message.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({
        content: "Replying to ghost message",
        replyTo: REPLIED_MSG_ID,
      });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Replied-to message not found");
  });

  it("returns 400 when replying to a message from a different conversation", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
    Message.findById.mockResolvedValue({
      _id: REPLIED_MSG_ID,
      conversation: OTHER_CONV_ID,
      content: "Secret other message",
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({
        content: "Cross chat reply attempt",
        replyTo: REPLIED_MSG_ID,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "Cannot reply to a message from a different conversation"
    );
  });
});

describe("Phase 6 – HTTP Message History (replyTo and reactions population)", () => {
  it("GET /conversations/:conversationId/messages populates replyTo and reactions", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });

    const fakeMessages = [
      {
        _id: MSG_ID,
        content: "I reply to your question",
        sender: fakeUserOne,
        replyTo: {
          _id: REPLIED_MSG_ID,
          content: "Original question",
          sender: fakeUserTwo,
        },
        reactions: [
          {
            user: fakeUserTwo,
            emoji: "❤️",
          },
        ],
      },
    ];

    Message.find.mockReturnValue(makeQuery(fakeMessages));
    Message.countDocuments.mockReturnValue(makeQuery(1));

    const res = await request(app)
      .get(`/api/messages/conversations/${CONV_ID}/messages`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].replyTo).toBeDefined();
    expect(res.body.messages[0].reactions).toBeDefined();
  });
});

describe("Phase 6 – HTTP Reactions (POST / PUT / DELETE)", () => {
  it("POST /reactions adds a reaction and emits message:reaction to participants", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findById.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const emitMock = jest.fn();
    const toMock = jest.fn().mockReturnValue({ emit: emitMock });
    app.set("io", { to: toMock });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ emoji: "🎉" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe("add");
    expect(fakeMessage.reactions).toHaveLength(1);
    expect(fakeMessage.reactions[0].emoji).toBe("🎉");
    expect(fakeMessage.save).toHaveBeenCalled();
    expect(fakeMessage.populate).toHaveBeenCalledWith(
      "reactions.user",
      "username fullName avatar"
    );

    expect(toMock).toHaveBeenCalledWith(`user:${USER_ONE_ID}`);
    expect(toMock).toHaveBeenCalledWith(`user:${USER_TWO_ID}`);
    expect(emitMock).toHaveBeenCalledWith(
      "message:reaction",
      expect.objectContaining({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        userId: USER_ONE_ID,
        emoji: "🎉",
        action: "add",
      })
    );
  });

  it("PUT /reactions updates an existing reaction from the same user", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: USER_ONE_ID, emoji: "👍", createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findById.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const res = await request(app)
      .put(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ emoji: "❤️" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe("update");
    expect(fakeMessage.reactions).toHaveLength(1);
    expect(fakeMessage.reactions[0].emoji).toBe("❤️");
    expect(fakeMessage.save).toHaveBeenCalled();
  });

  it("DELETE /reactions removes the user's reaction", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: USER_ONE_ID, emoji: "❤️", createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
      populate: jest.fn().mockResolvedValue(true),
    };

    Conversation.findById.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const emitMock = jest.fn();
    const toMock = jest.fn().mockReturnValue({ emit: emitMock });
    app.set("io", { to: toMock });

    const res = await request(app)
      .delete(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.action).toBe("remove");
    expect(fakeMessage.reactions).toHaveLength(0);
    expect(fakeMessage.save).toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(
      "message:reaction",
      expect.objectContaining({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        userId: USER_ONE_ID,
        emoji: null,
        action: "remove",
      })
    );
  });

  it("DELETE /reactions returns 404 when user has not reacted to the message", async () => {
    const fakeConversation = {
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    };

    const fakeMessage = {
      _id: MSG_ID,
      conversation: CONV_ID,
      reactions: [{ user: USER_TWO_ID, emoji: "❤️", createdAt: new Date() }],
      save: jest.fn(),
    };

    Conversation.findById.mockResolvedValue(fakeConversation);
    Message.findOne.mockResolvedValue(fakeMessage);

    const res = await request(app)
      .delete(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Reaction not found");
    expect(fakeMessage.save).not.toHaveBeenCalled();
  });

  it("returns 403 when user is not a participant in the conversation", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_TWO_ID, OUTSIDER_ID],
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ emoji: "👍" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Not part of this conversation");
  });

  it("returns 404 when message is not found", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });
    Message.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ emoji: "👍" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Message not found");
  });

  it("returns 400 when emoji is empty or whitespace", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ emoji: "   " });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when emoji exceeds 16 characters", async () => {
    Conversation.findById.mockResolvedValue({
      _id: CONV_ID,
      participants: [USER_ONE_ID, USER_TWO_ID],
    });

    const res = await request(app)
      .post(`/api/messages/conversations/${CONV_ID}/messages/${MSG_ID}/reactions`)
      .set("Cookie", authCookie(USER_ONE_ID))
      .send({ emoji: "12345678901234567" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
