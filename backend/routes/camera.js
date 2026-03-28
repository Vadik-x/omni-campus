const express = require("express");
const http = require("http");
const https = require("https");

const router = express.Router();
const TEST_TIMEOUT_MS = 5000;

function parseTargetUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function getHttpClient(urlObject) {
  return urlObject.protocol === "https:" ? https : http;
}

router.get("/stream", (req, res) => {
  const targetUrl = parseTargetUrl(req.query?.url);
  if (!targetUrl) {
    return res.status(400).json({ message: "Invalid or missing url query parameter" });
  }

  console.log(`Proxying stream from ${targetUrl.href}`);

  res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=--BoundaryString");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const client = getHttpClient(targetUrl);
  let sourceResponse = null;

  const sourceRequest = client.get(targetUrl, (upstreamRes) => {
    sourceResponse = upstreamRes;

    const statusCode = Number(upstreamRes.statusCode || 0);
    if (statusCode >= 400) {
      upstreamRes.resume();
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    upstreamRes.on("error", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });

    upstreamRes.on("end", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });

    upstreamRes.on("close", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });

    upstreamRes.pipe(res);
  });

  sourceRequest.on("error", () => {
    if (!res.writableEnded) {
      res.end();
    }
  });

  req.on("close", () => {
    sourceRequest.destroy();
    if (sourceResponse) {
      sourceResponse.destroy();
    }
  });
});

router.get("/snapshot", (req, res) => {
  const targetUrl = parseTargetUrl(req.query?.url);
  if (!targetUrl) {
    return res.status(400).json({ message: "Invalid or missing url query parameter" });
  }

  const client = getHttpClient(targetUrl);
  const request = client.get(targetUrl, (upstreamRes) => {
    const statusCode = Number(upstreamRes.statusCode || 0);
    if (statusCode >= 400) {
      upstreamRes.resume();
      return res.status(502).json({ message: `Snapshot upstream status ${statusCode}` });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", upstreamRes.headers["content-type"] || "image/jpeg");
    res.setHeader("Cache-Control", "no-cache");

    upstreamRes.on("error", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });

    upstreamRes.pipe(res);
  });

  request.setTimeout(TEST_TIMEOUT_MS, () => {
    request.destroy(new Error("Snapshot request timed out"));
  });

  request.on("error", (error) => {
    if (!res.headersSent) {
      return res.status(502).json({ message: error.message || "Snapshot proxy failed" });
    }

    if (!res.writableEnded) {
      res.end();
    }
  });

  req.on("close", () => {
    request.destroy();
  });
});

router.get("/test", (req, res) => {
  const targetUrl = parseTargetUrl(req.query?.url);
  if (!targetUrl) {
    return res.json({ success: false, error: "Invalid or missing url query parameter" });
  }

  const client = getHttpClient(targetUrl);
  let completed = false;

  const finish = (payload) => {
    if (completed) {
      return;
    }

    completed = true;
    res.json(payload);
  };

  const request = client.get(targetUrl, (upstreamRes) => {
    const statusCode = Number(upstreamRes.statusCode || 0);
    if (statusCode >= 400) {
      upstreamRes.resume();
      finish({ success: false, error: `Upstream status ${statusCode}` });
      return;
    }

    // A successful connection is enough for the test endpoint.
    upstreamRes.destroy();
    finish({ success: true, error: "" });
  });

  request.setTimeout(TEST_TIMEOUT_MS, () => {
    request.destroy(new Error("Connection timed out"));
  });

  request.on("error", (error) => {
    finish({ success: false, error: error.message || "Connection failed" });
  });

  req.on("close", () => {
    request.destroy();
  });
});

module.exports = router;
