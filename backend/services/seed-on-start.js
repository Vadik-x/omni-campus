const Student = require("../models/Student");

const PLACEHOLDER_PHOTO =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgkM8nwsAAAAASUVORK5CYII=";

const seedData = [
  { studentId: "OC1001", name: "Aarav Sharma", program: "B.Tech CSE", year: 2, phone: "9876501201" },
  { studentId: "OC1002", name: "Ishita Verma", program: "B.Tech CSE", year: 3, phone: "9876501202" },
  { studentId: "OC1003", name: "Rohan Kulkarni", program: "B.Tech CSE", year: 1, phone: "9876501203" },
  { studentId: "OC1004", name: "Meera Nair", program: "B.Tech ECE", year: 4, phone: "9876501204" },
  { studentId: "OC1005", name: "Karthik Reddy", program: "B.Tech ECE", year: 2, phone: "9876501205" },
  { studentId: "OC1006", name: "Sana Qureshi", program: "B.Tech ECE", year: 1, phone: "9876501206" },
  { studentId: "OC1007", name: "Aditya Menon", program: "MBA", year: 1, phone: "9876501207" },
  { studentId: "OC1008", name: "Priya Deshpande", program: "MBA", year: 2, phone: "9876501208" },
  { studentId: "OC1009", name: "Harsh Jain", program: "MBA", year: 1, phone: "9876501209" },
  { studentId: "OC1010", name: "Ananya Iyer", program: "B.Sc Physics", year: 3, phone: "9876501210" },
  { studentId: "OC1011", name: "Dev Patel", program: "B.Sc Physics", year: 2, phone: "9876501211" },
  { studentId: "OC1012", name: "Neha Bansal", program: "B.Sc Physics", year: 1, phone: "9876501212" },
  { studentId: "OC1013", name: "Rahul Tripathi", program: "MBBS", year: 3, phone: "9876501213" },
  { studentId: "OC1014", name: "Sneha Kapoor", program: "MBBS", year: 2, phone: "9876501214" },
  { studentId: "OC1015", name: "Vikram Singh", program: "MBBS", year: 1, phone: "9876501215" },
  { studentId: "OC1016", name: "Tanya Chawla", program: "B.Arch", year: 4, phone: "9876501216" },
  { studentId: "OC1017", name: "Arjun Bhatt", program: "B.Arch", year: 3, phone: "9876501217" },
  { studentId: "OC1018", name: "Nidhi Rao", program: "B.Arch", year: 2, phone: "9876501218" },
  { studentId: "OC1019", name: "Yash Gupta", program: "B.Tech CSE", year: 4, phone: "9876501219" },
  { studentId: "OC1020", name: "Pooja Mishra", program: "B.Tech ECE", year: 3, phone: "9876501220" },
].map((student) => ({
  ...student,
  photo: PLACEHOLDER_PHOTO,
  status: "offline",
  isOnCampus: false,
  locationHistory: [],
}));

async function seedStudents() {
  const existing = await Student.countDocuments();
  if (existing > 0) {
    return;
  }

  await Student.insertMany(seedData);
  console.log(`Seeded ${seedData.length} students`);
}

module.exports = seedStudents;
