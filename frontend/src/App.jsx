import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import RouteLoadingScreen from "./components/RouteLoadingScreen";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Search = lazy(() => import("./pages/Search"));
const Trail = lazy(() => import("./pages/Trail"));
const StudentsOverview = lazy(() => import("./pages/StudentsOverview"));
const StudentDetail = lazy(() => import("./pages/StudentDetail"));

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteLoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/search" element={<Search />} />
          <Route path="/trail" element={<Trail />} />
          <Route path="/students" element={<StudentsOverview />} />
          <Route path="/students/:studentId" element={<StudentDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
