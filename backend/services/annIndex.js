const INDEX_ENGINE = String(process.env.RECOGNITION_INDEX_ENGINE || "coarse").toLowerCase();
const PREFILTER_MULTIPLIER = Number(process.env.RECOGNITION_PREFILTER_MULTIPLIER || 6);

let state = {
  engine: INDEX_ENGINE,
  templates: [],
  version: "",
  builtAt: null,
  studentCentroids: new Map(),
  studentTemplateCounts: new Map(),
};

function normalizeDescriptor(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function descriptorDistance(left, right) {
  const a = normalizeDescriptor(left);
  const b = normalizeDescriptor(right);

  if (!a.length || !b.length) {
    return Number.POSITIVE_INFINITY;
  }

  const len = Math.min(a.length, b.length);
  let sum = 0;

  for (let index = 0; index < len; index += 1) {
    const diff = a[index] - b[index];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

function averageDescriptors(descriptors = []) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    return [];
  }

  const normalized = descriptors.map(normalizeDescriptor).filter((item) => item.length > 0);
  if (normalized.length === 0) {
    return [];
  }

  const dimension = Math.min(...normalized.map((item) => item.length));
  const sum = new Array(dimension).fill(0);

  normalized.forEach((descriptor) => {
    for (let index = 0; index < dimension; index += 1) {
      sum[index] += descriptor[index];
    }
  });

  return sum.map((value) => value / normalized.length);
}

function resetState() {
  state = {
    engine: INDEX_ENGINE,
    templates: [],
    version: "",
    builtAt: null,
    studentCentroids: new Map(),
    studentTemplateCounts: new Map(),
  };
}

function buildIndex({ templates = [], version = "" } = {}) {
  resetState();

  const normalizedTemplates = templates
    .map((template, index) => {
      const descriptor = normalizeDescriptor(template.descriptor);
      if (!descriptor.length) {
        return null;
      }

      return {
        studentId: String(template.studentId || ""),
        studentName: String(template.studentName || "Unknown"),
        templateIndex: Number.isFinite(Number(template.templateIndex))
          ? Number(template.templateIndex)
          : index,
        descriptor,
      };
    })
    .filter(Boolean);

  const byStudent = new Map();
  normalizedTemplates.forEach((template) => {
    if (!byStudent.has(template.studentId)) {
      byStudent.set(template.studentId, []);
    }

    byStudent.get(template.studentId).push(template.descriptor);
  });

  for (const [studentId, descriptors] of byStudent.entries()) {
    state.studentTemplateCounts.set(studentId, descriptors.length);
    state.studentCentroids.set(studentId, averageDescriptors(descriptors));
  }

  state.templates = normalizedTemplates;
  state.version = String(version || "");
  state.builtAt = new Date().toISOString();

  return {
    engine: state.engine,
    builtAt: state.builtAt,
    templates: state.templates.length,
    students: state.studentCentroids.size,
    version: state.version,
  };
}

function aggregateByStudent(scoredTemplates = [], confidenceFromDistance = (distance) => distance) {
  const byStudent = new Map();

  scoredTemplates.forEach((item) => {
    const studentId = String(item.studentId || "");
    if (!studentId) {
      return;
    }

    const current = byStudent.get(studentId);
    if (!current || item.distance < current.distance) {
      byStudent.set(studentId, { ...item });
    }
  });

  return Array.from(byStudent.values())
    .map((item) => {
      const templateCount = Number(state.studentTemplateCounts.get(String(item.studentId)) || 1);
      const baseConfidence = Number(confidenceFromDistance(item.distance) || 0);
      const templateBonus = Math.min(0.06, Math.max(0, templateCount - 1) * 0.015);
      const templatePenalty = templateCount <= 1 ? 0.03 : 0;
      const confidence = Math.max(0, Math.min(1, baseConfidence + templateBonus - templatePenalty));

      return {
        ...item,
        confidence: Number(confidence.toFixed(3)),
        templateCount,
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

function pickStudentPrefilter(queryDescriptor = [], topK = 3) {
  if (state.engine === "exact") {
    return {
      selectedStudents: null,
      prefilterCount: state.studentCentroids.size,
      source: "exact",
    };
  }

  const centroidScores = Array.from(state.studentCentroids.entries())
    .map(([studentId, centroid]) => ({
      studentId,
      distance: descriptorDistance(queryDescriptor, centroid),
    }))
    .sort((a, b) => a.distance - b.distance);

  const requested = Math.max(5, Math.min(centroidScores.length, topK * Math.max(2, PREFILTER_MULTIPLIER)));
  const selectedStudents = new Set(
    centroidScores.slice(0, requested).map((entry) => String(entry.studentId || ""))
  );

  return {
    selectedStudents,
    prefilterCount: requested,
    source: "coarse-centroid",
  };
}

function search({ queryDescriptor, topK = 3, confidenceFromDistance } = {}) {
  const query = normalizeDescriptor(queryDescriptor);
  if (!query.length) {
    return {
      engine: state.engine,
      candidates: [],
      searchSpace: {
        templatesScored: 0,
        totalTemplates: state.templates.length,
        studentsConsidered: 0,
        prefilterSource: state.engine,
      },
    };
  }

  const safeTopK = Math.max(1, Math.min(50, Number(topK) || 3));
  const prefilter = pickStudentPrefilter(query, safeTopK);

  const templatesToScore = prefilter.selectedStudents
    ? state.templates.filter((template) => prefilter.selectedStudents.has(String(template.studentId || "")))
    : state.templates;

  const scoredTemplates = templatesToScore
    .map((template) => ({
      studentId: template.studentId,
      studentName: template.studentName,
      templateIndex: template.templateIndex,
      distance: descriptorDistance(query, template.descriptor),
    }))
    .sort((a, b) => a.distance - b.distance);

  const candidates = aggregateByStudent(scoredTemplates, confidenceFromDistance).slice(0, safeTopK);

  return {
    engine: state.engine,
    candidates,
    searchSpace: {
      templatesScored: scoredTemplates.length,
      totalTemplates: state.templates.length,
      studentsConsidered: prefilter.selectedStudents
        ? prefilter.selectedStudents.size
        : state.studentCentroids.size,
      prefilterSource: prefilter.source,
    },
  };
}

function getIndexSummary() {
  return {
    engine: state.engine,
    builtAt: state.builtAt,
    templates: state.templates.length,
    students: state.studentCentroids.size,
    version: state.version,
  };
}

module.exports = {
  buildIndex,
  search,
  getIndexSummary,
};
