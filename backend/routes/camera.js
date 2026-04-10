const express = require("express");
const http = require("http");
const https = require("https");
const logger = require("../services/logger");

const router = express.Router();
const TEST_TIMEOUT_MS = 5000;
const STREAM_TIMEOUT_MS = 12000;

const DEFAULT_PROXY_HEADERS = {
  Accept: "multipart/x-mixed-replace,image/jpeg,*/*;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Connection: "keep-alive",
  "User-Agent": "OmniCampusCameraProxy/1.0",
};

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

function buildRequestOptions(urlObject) {
  const pathname = String(urlObject.pathname || "/");
  const search = String(urlObject.search || "");
  const auth = urlObject.username
    ? `${decodeURIComponent(urlObject.username)}:${decodeURIComponent(urlObject.password || "")}`
    : undefined;

  return {
    protocol: urlObject.protocol,
    hostname: urlObject.hostname,
    port: urlObject.port || undefined,
    path: `${pathname}${search}`,
    method: "GET",
    auth,
    headers: {
      ...DEFAULT_PROXY_HEADERS,
      Host: urlObject.host,
    },
  };
}

router.get("/stream", (req, res) => {
  const targetUrl = parseTargetUrl(req.query?.url);
  if (!targetUrl) {
    return res.status(400).json({ message: "Invalid or missing url query parameter" });
  }

  logger.info({
    service: "camera",
    event: "camera.proxy_stream_start",
    cameraId: targetUrl.host,
    message: `Proxying stream from ${targetUrl.href}`,
  });

  const client = getHttpClient(targetUrl);
  const options = buildRequestOptions(targetUrl);
  let sourceResponse = null;

  const sourceRequest = client.request(options, (upstreamRes) => {
    sourceResponse = upstreamRes;

    const statusCode = Number(upstreamRes.statusCode || 0);
    if (statusCode >= 400) {
      logger.warn({
        service: "camera",
        event: "camera.proxy_stream_upstream_error",
        cameraId: targetUrl.host,
        message: `Proxy stream upstream status ${statusCode}`,
      });

      upstreamRes.resume();
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const upstreamContentType = String(upstreamRes.headers["content-type"] || "").trim();

    res.status(statusCode || 200);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", String(upstreamRes.headers["cache-control"] || "no-cache"));
    res.setHeader("Pragma", String(upstreamRes.headers.pragma || "no-cache"));
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (upstreamContentType) {
      res.setHeader("Content-Type", upstreamContentType);
    }

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
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

  sourceRequest.setTimeout(STREAM_TIMEOUT_MS, () => {
    sourceRequest.destroy(new Error("Stream request timed out"));
  });

  sourceRequest.end();

  sourceRequest.on("error", (error) => {
    logger.warn({
      service: "camera",
      event: "camera.proxy_stream_error",
      cameraId: targetUrl.host,
      message: `Proxy stream request failed: ${error.message || "request error"}`,
    });

    if (!res.headersSent) {
      return res.status(502).json({ message: error.message || "Proxy stream request failed" });
    }

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
  const options = buildRequestOptions(targetUrl);
  const request = client.request(options, (upstreamRes) => {
    const statusCode = Number(upstreamRes.statusCode || 0);
    if (statusCode >= 400) {
      logger.warn({
        service: "camera",
        event: "camera.proxy_snapshot_upstream_error",
        cameraId: targetUrl.host,
        message: `Snapshot upstream status ${statusCode}`,
      });

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

  request.end();

  request.on("error", (error) => {
    logger.warn({
      service: "camera",
      event: "camera.proxy_snapshot_error",
      cameraId: targetUrl.host,
      message: `Snapshot proxy failed: ${error.message || "request error"}`,
    });

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
  const options = buildRequestOptions(targetUrl);
  let completed = false;

  const finish = (payload) => {
    if (completed) {
      return;
    }

    completed = true;
    res.json(payload);
  };

  const request = client.request(options, (upstreamRes) => {
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

  request.end();

  request.on("error", (error) => {
    logger.warn({
      service: "camera",
      event: "camera.proxy_test_error",
      cameraId: targetUrl.host,
      message: `Camera test failed: ${error.message || "Connection failed"}`,
    });

    finish({ success: false, error: error.message || "Connection failed" });
  });

  req.on("close", () => {
    request.destroy();
  });
});

module.exports = router;
