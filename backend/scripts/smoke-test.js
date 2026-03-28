const DEFAULT_BASES = [
  "http://localhost:5000",
  "http://localhost:5001",
  "http://localhost:5002",
  "http://localhost:5003",
  "http://localhost:5004",
  "http://localhost:5005",
];

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) {
    error.details = details;
  }
  throw error;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    fail(`HTTP ${response.status} on ${path}`, body);
  }

  return body;
}

async function detectBaseUrl() {
  const envBase = process.env.SMOKE_BASE_URL;
  const candidates = envBase ? [envBase] : DEFAULT_BASES;

  for (const baseUrl of candidates) {
    try {
      const health = await requestJson(baseUrl, "/health", { method: "GET" });
      if (health && health.status === "ok" && health.mode === "file-store") {
        return { baseUrl, health };
      }
    } catch (error) {
      // Try next candidate.
    }
  }

  fail(
    "No file-store backend found. Start this backend first (npm start) or set SMOKE_BASE_URL."
  );
}

async function run() {
  const { baseUrl, health } = await detectBaseUrl();
  const studentsBase = `${baseUrl}/api/students`;

  console.log(`[smoke] Using backend ${baseUrl}`);
  console.log(`[smoke] Health mode=${health.mode} students=${health.students}`);

  const post = (path, body) =>
    requestJson(baseUrl, path, {
      method: "POST",
      body: JSON.stringify(body),
    });

  const patch = (path, body) =>
    requestJson(baseUrl, path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });

  const get = (path) => requestJson(baseUrl, path, { method: "GET" });

  const del = (path) => requestJson(baseUrl, path, { method: "DELETE" });

  await post("/api/students/import", []);

  const create = await post("/api/students", {
    studentId: "SMOKE-001",
    name: "Smoke Test",
    program: "QA",
    year: 1,
    phone: "000",
  });
  if (create.studentId !== "SMOKE-001") {
    fail("Create failed", create);
  }

  const listAfterCreate = asArray(await get("/api/students"));
  if (listAfterCreate.length !== 1) {
    fail("List after create should have 1 student", listAfterCreate);
  }

  const fetched = await get("/api/students/SMOKE-001");
  if (fetched.name !== "Smoke Test") {
    fail("Get by id returned unexpected name", fetched);
  }

  const updated = await patch("/api/students/SMOKE-001", {
    phone: "111",
    year: 2,
  });
  if (updated.phone !== "111" || updated.year !== 2) {
    fail("Patch failed", updated);
  }

  const moved = await patch("/api/students/SMOKE-001/location", {
    buildingId: "lab-a",
    buildingName: "Lab A",
    detectedBy: "CAMERA",
  });
  if (moved.currentLocation?.buildingName !== "Lab A") {
    fail("Location patch failed", moved);
  }

  const exportedAfterMove = asArray(await get("/api/students/export"));
  if (exportedAfterMove.length !== 1) {
    fail("Export after move should have 1 student", exportedAfterMove);
  }

  const removed = await del("/api/students/SMOKE-001");
  if (removed.student?.studentId !== "SMOKE-001") {
    fail("Delete failed", removed);
  }

  const imported = await post("/api/students/import", [
    {
      studentId: "SMOKE-002",
      name: "Import Test",
      program: "IT",
      year: 3,
    },
  ]);
  if (imported.count !== 1) {
    fail("Import failed", imported);
  }

  const exportedAfterImport = asArray(await get("/api/students/export"));
  if (exportedAfterImport.length !== 1) {
    fail("Export after import should have 1 student", exportedAfterImport);
  }

  await post("/api/students/import", []);
  const finalList = asArray(await get("/api/students"));
  if (finalList.length !== 0) {
    fail("Final list should be empty after reset", finalList);
  }

  const finalHealth = await get("/health");
  if (finalHealth.status !== "ok") {
    fail("Final health check failed", finalHealth);
  }

  console.log("[smoke] PASS: CRUD, location, import/export, and reset checks succeeded.");
}

run().catch((error) => {
  console.error("[smoke] FAIL:", error.message);
  if (error.details !== undefined) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exit(1);
});
