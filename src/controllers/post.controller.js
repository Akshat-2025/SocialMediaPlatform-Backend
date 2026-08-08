const { Readable } = require("stream");
const Post = require("../models/Post.model");
const Comment = require("../models/Comment.model");
const cloudinary = require("../config/cloudinary");
const { notify } = require("../utils/notify");

const AUTHOR_SELECT = "username fullName avatar";

const uploadImageBuffer = (buffer) =>
  new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "social-media/posts", resource_type: "image" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    Readable.from(buffer).pipe(uploadStream);
  });

// @route  POST /api/posts
const createPost = async (req, res, next) => {
  try {
    const { content } = req.body;
    const files = req.files || [];

    if (!content && files.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Post must have content or at least one image" });
    }

    const images = await Promise.all(
      files.map(async (file) => {
        const result = await uploadImageBuffer(file.buffer);
        return { url: result.secure_url, publicId: result.public_id };
      })
    ); 

    const post = await Post.create({
      author: req.user._id,
      content,
      images,
    });

    await post.populate("author", AUTHOR_SELECT);

    res.status(201).json({ success: true, message: "Post created", post });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/posts?page=1&limit=10
const getFeed = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      Post.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", AUTHOR_SELECT),
      Post.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/posts/user/:userId
const getUserPosts = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      Post.find({ author: req.params.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", AUTHOR_SELECT),
      Post.countDocuments({ author: req.params.userId }),
    ]);

    res.status(200).json({
      success: true,
      posts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/posts/:id
const getPostById = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id).populate("author", AUTHOR_SELECT);

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    res.status(200).json({ success: true, post });
  } catch (error) {
    next(error);
  }
};

// @route  PATCH /api/posts/:id
// Body: { content?, removeImageIds?: string[] } + optional new `images` files (multipart)
const updatePost = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized to edit this post" });
    }

    if (req.body.content !== undefined) {
      post.content = req.body.content;
    }

    // Remove specific existing images by publicId, if requested
    let removeImageIds = req.body.removeImageIds;
    if (removeImageIds) {
      if (typeof removeImageIds === "string") removeImageIds = [removeImageIds];
      await Promise.all(
        removeImageIds.map((publicId) => cloudinary.uploader.destroy(publicId).catch(() => {}))
      );
      post.images = post.images.filter((img) => !removeImageIds.includes(img.publicId));
    }

    // Append any newly uploaded images
    const files = req.files || [];
    if (files.length > 0) {
      const newImages = await Promise.all(
        files.map(async (file) => {
          const result = await uploadImageBuffer(file.buffer);
          return { url: result.secure_url, publicId: result.public_id };
        })
      );
      post.images.push(...newImages);
    }

    if (post.images.length > 4) {
      return res.status(400).json({ success: false, message: "A post can have at most 4 images" });
    }

    if (!post.content && post.images.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Post must have content or at least one image" });
    }

    await post.save();
    await post.populate("author", AUTHOR_SELECT);

    res.status(200).json({ success: true, message: "Post updated", post });
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/posts/:id
const deletePost = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this post" });
    }

    // Best-effort cleanup of Cloudinary images
    await Promise.all(
      post.images.map((img) => cloudinary.uploader.destroy(img.publicId).catch(() => {}))
    );

    await Comment.deleteMany({ post: post._id });
    await post.deleteOne();

    res.status(200).json({ success: true, message: "Post deleted" });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/posts/:id/like  (toggles like/unlike)
const toggleLike = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const userId = req.user._id.toString();
    const alreadyLiked = post.likes.some((id) => id.toString() === userId);

    if (alreadyLiked) {
      post.likes = post.likes.filter((id) => id.toString() !== userId);
    } else {
      post.likes.push(req.user._id);
    }

    await post.save();

    if (!alreadyLiked) {
      await notify(req, {
        recipientId: post.author,
        senderId: req.user._id,
        type: "like",
        postId: post._id,
      });
    }

    res.status(200).json({
      success: true,
      liked: !alreadyLiked,
      likesCount: post.likes.length,
    });
  } catch (error) {
    next(error);
  }
};

// @route  POST /api/posts/:id/comments
const addComment = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const comment = await Comment.create({
      post: post._id,
      author: req.user._id,
      content: req.body.content,
    });

    post.commentsCount += 1;
    await post.save();

    await comment.populate("author", AUTHOR_SELECT);

    await notify(req, {
      recipientId: post.author,
      senderId: req.user._id,
      type: "comment",
      postId: post._id,
      commentId: comment._id,
    });

    res.status(201).json({ success: true, message: "Comment added", comment });
  } catch (error) {
    next(error);
  }
};

// @route  GET /api/posts/:id/comments?page=1&limit=20
const getComments = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const [comments, total] = await Promise.all([
      Comment.find({ post: req.params.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", AUTHOR_SELECT),
      Comment.countDocuments({ post: req.params.id }),
    ]);

    res.status(200).json({
      success: true,
      comments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// @route  PATCH /api/posts/:postId/comments/:commentId
const updateComment = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    if (comment.author.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized to edit this comment" });
    }

    comment.content = req.body.content;
    await comment.save();
    await comment.populate("author", AUTHOR_SELECT);

    res.status(200).json({ success: true, message: "Comment updated", comment });
  } catch (error) {
    next(error);
  }
};

// @route  DELETE /api/posts/:postId/comments/:commentId
const deleteComment = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.commentId);

    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    if (comment.author.toString() !== req.user._id.toString()) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized to delete this comment" });
    }

    await comment.deleteOne();
    await Post.findByIdAndUpdate(req.params.postId, { $inc: { commentsCount: -1 } });

    res.status(200).json({ success: true, message: "Comment deleted" });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createPost,
  getFeed,
  getUserPosts,
  getPostById,
  updatePost,
  deletePost,
  toggleLike,
  addComment,
  getComments,
  updateComment,
  deleteComment,
};
