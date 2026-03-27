const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
  {
    buildingId: { type: String, required: true },
    buildingName: { type: String, required: true },
    detectedBy: {
      type: String,
      enum: [
        "camera",
        "wifi",
        "rfid",
        "fusion",
        "CAMERA",
        "WIFI-RF",
        "SYSTEM",
      ],
      required: true,
    },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const studentSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    program: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1, max: 6 },
    phone: { type: String, required: true, trim: true },
    photo: { type: String, default: "" },
    status: {
      type: String,
      enum: ["online", "offline", "alert"],
      default: "offline",
    },
    currentLocation: {
      buildingId: { type: String },
      buildingName: { type: String },
      detectedBy: {
        type: String,
        enum: [
          "camera",
          "wifi",
          "rfid",
          "fusion",
          "CAMERA",
          "WIFI-RF",
          "SYSTEM",
        ],
      },
      lastSeen: { type: Date },
    },
    locationHistory: { type: [locationSchema], default: [] },
    isOnCampus: { type: Boolean, default: false },
  },
  { timestamps: true }
);

studentSchema.index({ name: "text", studentId: "text", program: "text" });

module.exports = mongoose.model("Student", studentSchema);
