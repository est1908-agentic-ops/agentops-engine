import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { AgentsPage } from './pages/Agents';
import { DevCycleRunDetailPage } from './pages/DevCycleRunDetailPage';
import { HomePage } from './pages/HomePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunDetailPage } from './pages/RunDetailPage';

export function App() {
  return (
    <BrowserRouter>
      <nav className="top-nav">
        <Link to="/">Console</Link>
        <Link to="/projects">Projects</Link>
        <Link to="/agents">Agents</Link>
      </nav>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:workflowId" element={<RunDetailPage />} />
        <Route path="/dev-runs/:workflowId" element={<DevCycleRunDetailPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
