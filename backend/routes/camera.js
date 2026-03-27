const express = require("express");
const {
  saveLatestFrame,
  captureFrame,
  emitCameraFrame,
  getCameraStatus,
} = require("../services/camera");

module.exports = function cameraRouter(io) {
  const router = express.Router();

  router.post("/frame", (req, res) => {
    const frame = req.body?.frame;
    if (!frame) {
      return res.status(400).json({ message: "frame (base64 image) is required" });
    }

    const saved = saveLatestFrame(frame);
    if (!saved) {
      return res.status(400).json({ message: "Invalid frame payload" });
    }

    emitCameraFrame(io);

    return res.json({
      message: "Frame accepted",
      frame: captureFrame(),
    });
  });

  router.get("/status", (req, res) => {
    return res.json(getCameraStatus());
  });

  return router;
};
